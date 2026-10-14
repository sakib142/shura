/**
 * GitHub, behind the same Vcs port as the local repository.
 *
 * Nothing in the loop changes: a producer still works in a worktree, a verifier
 * still reads a diff, and admission still happens in deterministic code. Only
 * the place branches and change requests live moves.
 *
 * Note what is still absent: no merge() on Vcs. Merging is on GitHubMergeQueue,
 * under its own credential, and is not reachable from anything an agent holds.
 */

import { Git, agentIdentity } from '@shura/git';
import { Worktree } from '@shura/sandbox';
import type { ChangeRequestRef, CheckRun, Diff, MergeOutcome, MergeQueue, Vcs } from '@shura/ports';

export interface GitHubOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly base?: string;
  /** Checks run locally, in a worktree. GitHub Actions is a separate concern. */
  readonly checkCommand: readonly string[];
  /** Where clones live. One per project, reused across runs. */
  readonly workDir: string;
  readonly fetch?: typeof fetch;
  /**
   * How the local clone is brought up to date with a ref.
   *
   * Injectable because the default does real git work against a real clone,
   * and the API behaviour is worth testing without one.
   */
  readonly syncRef?: (ref: string) => Promise<void>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly hint?: string,
  ) {
    super(`GitHub responded ${status}: ${detail}${hint === undefined ? '' : `\n${hint}`}`);
    this.name = 'GitHubError';
  }
}

export class GitHubVcs implements Vcs {
  readonly #o: GitHubOptions;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get base(): string {
    return this.#o.base ?? 'main';
  }

  /** The local clone the worktrees come from. Cloned once, fetched after. */
  async repoDir(): Promise<string> {
    const dir = `${this.#o.workDir}/${this.#o.repo}.git`;
    const git = new Git(this.#o.workDir);
    const exists = await new Git(dir).tryRun('rev-parse', '--git-dir');
    if (exists.ok) return dir;
    // The token goes in the remote URL, which is why it is never logged: Git
    // errors echo the command, and a URL-embedded credential would land in the
    // audit trail.
    await git.run('clone', '--bare', '-q', this.#cloneUrl(), `${this.#o.repo}.git`);
    return dir;
  }

  /** Pulls every branch from GitHub into the local clone. */
  async refresh(): Promise<void> {
    await this.#sync('*');
  }

  async #sync(ref: string): Promise<void> {
    if (this.#o.syncRef !== undefined) return this.#o.syncRef(ref);
    const dir = await this.repoDir();
    const spec = ref === '*' ? '+refs/heads/*:refs/heads/*' : `+refs/heads/${ref}:refs/heads/${ref}`;
    await new Git(dir).run('fetch', '--prune', 'origin', spec);
  }

  async createBranch(from: string, name: string): Promise<void> {
    await this.refresh();
    const sha = await this.#shaOf(from);
    const res = await this.#call(`/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    });
    // 422 means it already exists, which is fine — a rework attempt reuses it.
    if (!res.ok && res.status !== 422) {
      throw new GitHubError(res.status, (await res.text()).slice(0, 300));
    }

    // The branch now exists on GitHub and the local clone has never heard of
    // it. Worktrees come from the clone, so without this the next step fails
    // with "invalid reference" for a branch that demonstrably exists.
    await this.#sync(name);
  }

  async commit(): Promise<string> {
    throw new Error('commit happens in the worktree, under the agent identity');
  }

  async publishBranch(branch: string): Promise<void> {
    const dir = await this.repoDir();
    const push = await new Git(dir).tryRun(
      'push', this.#cloneUrl(), `refs/heads/${branch}:refs/heads/${branch}`,
    );
    if (!push.ok) {
      // The URL carries the token, so it must never reach an error message.
      throw new GitHubError(0, `could not push ${branch}`, redactUrl(push.stderr));
    }
  }

  async openChangeRequest(input: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<ChangeRequestRef> {
    const res = await this.#call('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.base,
        body: input.body,
      }),
    });

    if (res.status === 422) {
      // Already open for this branch: reuse it rather than failing a rework.
      const open = await this.#call(
        `/pulls?head=${this.#o.owner}:${encodeURIComponent(input.branch)}&state=open`,
      );
      const [existing] = (await open.json()) as { number: number; html_url: string }[];
      if (existing !== undefined) {
        return { id: String(existing.number), branch: input.branch, base: input.base };
      }
    }
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        (await res.text()).slice(0, 300),
        'A pull request needs commits on the branch that are not on the base. ' +
          'If the branch was never pushed, there is nothing to open one for.',
      );
    }

    const pr = (await res.json()) as { number: number; html_url: string };
    return { id: String(pr.number), branch: input.branch, base: input.base };
  }

  async getDiff(ref: ChangeRequestRef): Promise<Diff> {
    // Compare, not the pull request's file list. The loop asks for a diff
    // before a pull request exists — to decide whether the producer changed
    // anything worth opening one for — and /pulls/{id}/files 404s on an id
    // that is not yet a number.
    const range = `${encodeURIComponent(ref.base)}...${encodeURIComponent(ref.branch)}`;
    const res = await this.#call(`/compare/${range}`);
    if (!res.ok) throw new GitHubError(res.status, (await res.text()).slice(0, 300));
    const list = ((await res.json()) as { files?: { filename: string; patch?: string }[] }).files ?? [];

    const generated = list.filter((f) =>
      /(^|\/)(node_modules|dist|coverage)\/|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(
        f.filename,
      ),
    );
    if (generated.length > 0) {
      throw new Error(
        `${generated.length} generated file(s) are in this pull request, starting with ` +
          `"${generated[0]?.filename}". Add a .gitignore covering node_modules, dist, ` +
          'coverage and lockfiles.',
      );
    }

    return {
      text: list.map((f) => `--- ${f.filename}\n${f.patch ?? '(no textual diff)'}`).join('\n\n'),
      files: list.map((f) => f.filename),
    };
  }

  /** Checks run locally: the agent's own test command, against the branch. */
  async runChecks(ref: ChangeRequestRef): Promise<CheckRun> {
    const dir = await this.repoDir();
    const wt = await Worktree.create({ repoDir: dir, branch: ref.branch, taskId: `checks-${ref.id}` });
    try {
      const [command, ...args] = this.#o.checkCommand;
      if (command === undefined) return { ok: true, summary: 'no checks configured', output: '' };
      const r = await wt.exec(command, args);
      return {
        ok: r.code === 0,
        summary: r.code === 0 ? 'checks passed' : `checks failed (exit ${r.code})`,
        output: `${r.stdout}\n${r.stderr}`.trim(),
      };
    } finally {
      await wt.destroy();
    }
  }

  /** Posts the verdict where a human will read it: on the pull request. */
  async postVerdict(ref: ChangeRequestRef, body: string, approved: boolean): Promise<void> {
    await this.#call(`/pulls/${ref.id}/reviews`, {
      method: 'POST',
      // COMMENT, never APPROVE: a GitHub approval would carry the token
      // owner's identity, and an agent must not appear to have approved
      // anything as a human.
      body: JSON.stringify({ body, event: 'COMMENT' }),
    });
    void approved;
  }

  async urlOf(ref: ChangeRequestRef): Promise<string> {
    return `https://github.com/${this.#o.owner}/${this.#o.repo}/pull/${ref.id}`;
  }

  #cloneUrl(): string {
    return `https://x-access-token:${this.#o.token}@github.com/${this.#o.owner}/${this.#o.repo}.git`;
  }

  async #shaOf(branch: string): Promise<string> {
    const res = await this.#call(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        (await res.text()).slice(0, 200),
        res.status === 404
          ? `Branch "${branch}" does not exist in ${this.#o.owner}/${this.#o.repo}. An empty ` +
            'repository has no branches at all — add a README so it has one.'
          : undefined,
      );
    }
    return ((await res.json()) as { object: { sha: string } }).object.sha;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(`https://api.github.com/repos/${this.#o.owner}/${this.#o.repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#o.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }
}

/**
 * Admission on GitHub.
 *
 * Still deterministic code with its own identity, and still re-runs the checks
 * against the merged result rather than trusting that the branch was green in
 * isolation — two pull requests can each pass alone and break the base once
 * combined.
 */
export class GitHubMergeQueue implements MergeQueue {
  static readonly IDENTITY = agentIdentity('merge-queue', 'admit', 'deterministic');

  readonly #vcs: GitHubVcs;
  readonly #o: GitHubOptions;
  readonly #queued: { ref: ChangeRequestRef; verdictId: string }[] = [];
  readonly #fetch: typeof fetch;

  constructor(options: GitHubOptions, vcs: GitHubVcs) {
    this.#o = options;
    this.#vcs = vcs;
    this.#fetch = options.fetch ?? fetch;
  }

  async enqueue(ref: ChangeRequestRef, verdictId: string): Promise<void> {
    const already = this.#queued.some((q) => q.ref.id === ref.id && q.verdictId === verdictId);
    if (!already) this.#queued.push({ ref, verdictId });
  }

  async tick(): Promise<readonly MergeOutcome[]> {
    const outcomes: MergeOutcome[] = [];
    for (const { ref } of this.#queued.splice(0)) {
      outcomes.push(await this.#merge(ref));
    }
    return outcomes;
  }

  async #merge(ref: ChangeRequestRef): Promise<MergeOutcome> {
    // Rebase onto the current base first, so the checks run against what will
    // actually land rather than against a stale fork point.
    const dir = await this.#vcs.repoDir();
    const wt = await Worktree.create({
      repoDir: dir,
      branch: ref.branch,
      taskId: `merge-${ref.id}`,
      identity: GitHubMergeQueue.IDENTITY,
      claimedBranches: [ref.branch],
    });

    try {
      const rebase = await wt.git.tryRun('rebase', `origin/${ref.base}`);
      if (!rebase.ok) {
        await wt.git.tryRun('rebase', '--abort');
        return { status: 'rejected', ref, reason: `conflicts with ${ref.base}` };
      }

      const [command, ...args] = this.#o.checkCommand;
      if (command !== undefined) {
        const checks = await wt.exec(command, args);
        if (checks.code !== 0) {
          return {
            status: 'rejected',
            ref,
            reason: `checks fail against the latest ${ref.base} (exit ${checks.code})`,
          };
        }
      }

      const push = await wt.git.tryRun('push', '--force-with-lease', 'origin', `HEAD:${ref.branch}`);
      if (!push.ok) return { status: 'rejected', ref, reason: `could not update the branch` };
    } finally {
      await wt.destroy();
    }

    const res = await this.#fetch(
      `https://api.github.com/repos/${this.#o.owner}/${this.#o.repo}/pulls/${ref.id}/merge`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.#o.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ merge_method: 'merge' }),
      },
    );

    if (!res.ok) {
      return { status: 'rejected', ref, reason: `GitHub refused the merge: ${res.status}` };
    }
    const merged = (await res.json()) as { sha: string };
    return { status: 'merged', ref, commit: merged.sha };
  }
}

/** Strips a token out of anything git echoed back. */
function redactUrl(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://[redacted]@');
}
