/**
 * Version control against a local bare repository.
 *
 * This exists so the whole loop runs with no external credentials, and so the
 * GitHub adapter built after it has to satisfy an interface that already has a
 * second implementation — which is the only way to find out whether a port is a
 * real abstraction or a wrapper around one vendor.
 *
 * Note what is absent: no merge. The capability lives on MergeQueue, under a
 * separate identity, and is not reachable from anything an agent holds.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Pool } from 'pg';
import { Git, agentIdentity } from '@forge/git';
import { Worktree } from '@forge/sandbox';
import type { ChangeRequestRef, CheckRun, Diff, MergeOutcome, MergeQueue, Vcs } from '@forge/ports';

export interface LocalVcsOptions {
  /** The bare repository every branch and merge lands in. */
  readonly repoDir: string;
  readonly pool: Pool;
  /** How checks are run, inside a worktree of the branch under test. */
  readonly checkCommand: readonly string[];
  readonly defaultBase?: string;
}

export class LocalVcs implements Vcs {
  readonly #opts: LocalVcsOptions;
  readonly #git: Git;

  constructor(opts: LocalVcsOptions) {
    this.#opts = opts;
    this.#git = new Git(opts.repoDir);
  }

  get base(): string {
    return this.#opts.defaultBase ?? 'main';
  }

  async createBranch(from: string, name: string): Promise<void> {
    const existing = await this.#git.tryRun('rev-parse', '--verify', `refs/heads/${name}`);
    if (existing.ok) return;
    await this.#git.run('branch', name, from);
  }

  async commit(): Promise<string> {
    // Commits happen inside the worktree, where the files are and where the
    // agent identity is bound. Exposing a commit() here would invite the
    // control plane to write code, which is not its job.
    throw new Error('commit happens in the worktree, under the agent identity');
  }

  async openChangeRequest(input: {
    branch: string;
    base: string;
    title: string;
    body: string;
    author?: string;
    workItemId?: string;
  }): Promise<ChangeRequestRef> {
    const { rows } = await this.#opts.pool.query<{ id: string; number: string }>(
      `INSERT INTO change_requests (work_item_id, branch, base, title, body, author)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, number`,
      [
        input.workItemId ?? null,
        input.branch,
        input.base,
        input.title,
        input.body,
        input.author ?? 'unknown',
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('failed to open change request');
    return { id: row.id, branch: input.branch, base: input.base };
  }

  async getDiff(ref: ChangeRequestRef): Promise<Diff> {
    // Three dots: what the branch changed relative to where it forked, not
    // everything that happened on the base since.
    const range = `${ref.base}...${ref.branch}`;
    const { stdout: text } = await this.#git.run('diff', range);
    const { stdout: names } = await this.#git.run('diff', '--name-only', range);
    return { text, files: names.split('\n').filter((f) => f !== '') };
  }

  async runChecks(ref: ChangeRequestRef): Promise<CheckRun> {
    const wt = await Worktree.create({
      repoDir: this.#opts.repoDir,
      branch: ref.branch,
      taskId: `checks-${ref.id.slice(0, 8)}`,
    });
    try {
      const [command, ...args] = this.#opts.checkCommand;
      if (command === undefined) return { ok: true, summary: 'no checks configured', output: '' };
      const result = await wt.exec(command, args);
      return {
        ok: result.code === 0,
        summary: result.code === 0 ? 'checks passed' : `checks failed (exit ${result.code})`,
        output: `${result.stdout}\n${result.stderr}`.trim(),
      };
    } finally {
      await wt.destroy();
    }
  }
}

/**
 * Admission.
 *
 * Rebases on the current base, re-runs the checks, merges only if still green.
 * That is the property a directly-merging reviewer gives up: two change
 * requests can each be green alone and break the base together.
 *
 * Deterministic code, no model. The merge identity is its own, so the merge
 * commit names neither the producer nor the reviewer.
 */
export class LocalMergeQueue implements MergeQueue {
  static readonly IDENTITY = agentIdentity('merge-queue', 'admit', 'deterministic');

  readonly #opts: LocalVcsOptions;
  readonly #vcs: LocalVcs;

  constructor(opts: LocalVcsOptions, vcs: LocalVcs) {
    this.#opts = opts;
    this.#vcs = vcs;
  }

  async enqueue(ref: ChangeRequestRef, verdictId: string): Promise<void> {
    await this.#opts.pool.query(
      `INSERT INTO merge_queue (change_request_id, verdict_id)
       VALUES ($1, $2) ON CONFLICT (change_request_id, verdict_id) DO NOTHING`,
      [ref.id, verdictId],
    );
  }

  async tick(): Promise<readonly MergeOutcome[]> {
    const { rows } = await this.#opts.pool.query<{
      id: string;
      change_request_id: string;
      branch: string;
      base: string;
    }>(
      `SELECT q.id, q.change_request_id, c.branch, c.base
         FROM merge_queue q JOIN change_requests c ON c.id = q.change_request_id
        WHERE q.status = 'queued' AND c.status = 'open'
        ORDER BY q.queued_at`,
    );

    const outcomes: MergeOutcome[] = [];
    for (const row of rows) {
      const ref: ChangeRequestRef = {
        id: row.change_request_id,
        branch: row.branch,
        base: row.base,
      };
      const outcome = await this.#merge(ref);
      outcomes.push(outcome);

      if (outcome.status === 'merged') {
        await this.#opts.pool.query(
          `UPDATE merge_queue SET status='merged', settled_at=now() WHERE id=$1`,
          [row.id],
        );
        await this.#opts.pool.query(
          `UPDATE change_requests SET status='merged', merge_commit=$2, merged_at=now() WHERE id=$1`,
          [ref.id, outcome.commit],
        );
      } else {
        await this.#opts.pool.query(
          `UPDATE merge_queue SET status='rejected', reason=$2, settled_at=now() WHERE id=$1`,
          [row.id, outcome.reason],
        );
      }
    }
    return outcomes;
  }

  async #merge(ref: ChangeRequestRef): Promise<MergeOutcome> {
    const wt = await Worktree.create({
      repoDir: this.#opts.repoDir,
      branch: ref.base,
      taskId: `merge-${ref.id.slice(0, 8)}`,
      identity: LocalMergeQueue.IDENTITY,
      claimedBranches: [ref.base],
    });
    try {
      const merge = await wt.git.tryRun(
        'merge', '--no-ff', '--no-commit', ref.branch,
      );
      if (!merge.ok) {
        await wt.git.tryRun('merge', '--abort');
        return { status: 'rejected', ref, reason: `conflicts with ${ref.base}: ${merge.stderr.trim()}` };
      }

      // Re-run against the merged tree, not against the branch in isolation.
      const [command, ...args] = this.#opts.checkCommand;
      if (command !== undefined) {
        const checks = await wt.exec(command, args);
        if (checks.code !== 0) {
          await wt.git.tryRun('merge', '--abort');
          return {
            status: 'rejected',
            ref,
            reason: `checks fail against the latest ${ref.base} (exit ${checks.code})`,
          };
        }
      }

      await wt.git.run('commit', '-q', '-m', `Merge ${ref.branch} into ${ref.base}`);
      const { stdout } = await wt.git.run('rev-parse', 'HEAD');
      return { status: 'merged', ref, commit: stdout.trim() };
    } finally {
      await wt.destroy();
    }
  }
}

/** Creates the bare repository and seeds it from a directory of files. */
export async function initRepo(repoDir: string, seedFrom: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  await new Git(repoDir).run('init', '-q', '--bare', '-b', 'main', '.');

  const staging = `${repoDir}.seed`;
  await rm(staging, { recursive: true, force: true });

  const identity = agentIdentity('forge', 'bootstrap', 'none');
  await new Git(join(repoDir, '..'), identity).run('clone', '-q', repoDir, staging);

  await cp(seedFrom, staging, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}node_modules`) && !src.endsWith(`${sep}.git`),
  });

  const work = new Git(staging, identity);
  await work.run('add', '-A');
  await work.run('commit', '-q', '-m', 'Seed the target application');
  await work.run('push', '-q', 'origin', 'main');
  await rm(staging, { recursive: true, force: true });
}
