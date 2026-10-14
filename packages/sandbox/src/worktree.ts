/**
 * The worktree sandbox.
 *
 * One git worktree per task: a fresh checkout of the claimed branch on its own
 * directory, destroyed when the task ends. It is isolation by filesystem rather
 * than by kernel, which is enough to prove the loop and nowhere near enough to
 * run agents unattended on shared infrastructure — that is what the Docker and
 * Kubernetes drivers are for, and they implement this same interface.
 *
 * Two things here are load-bearing rather than convenience:
 *
 *   - every path an agent gives is resolved and checked to be inside the
 *     worktree, so a traversal that slipped past the gateway's schema still
 *     cannot touch anything outside;
 *   - a pre-push hook rejects a push to a branch the task does not hold, which
 *     survives unchanged into the container drivers because it lives here.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Git, type GitIdentity } from '@forge/git';

const exec = promisify(execFile);

export class PathEscape extends Error {
  constructor(readonly attempted: string) {
    super(`path "${attempted}" resolves outside the worktree`);
    this.name = 'PathEscape';
  }
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorktreeOptions {
  readonly repoDir: string;
  readonly branch: string;
  readonly taskId: string;
  readonly identity?: GitIdentity;
  /** Branches this task is allowed to push. Anything else is rejected. */
  readonly claimedBranches?: readonly string[];
}

export class Worktree {
  readonly id: string;
  readonly dir: string;
  readonly branch: string;
  readonly git: Git;
  readonly #repoDir: string;
  #destroyed = false;

  private constructor(opts: {
    id: string;
    dir: string;
    branch: string;
    repoDir: string;
    identity?: GitIdentity;
  }) {
    this.id = opts.id;
    this.dir = opts.dir;
    this.branch = opts.branch;
    this.#repoDir = opts.repoDir;
    this.git = opts.identity === undefined ? new Git(opts.dir) : new Git(opts.dir, opts.identity);
  }

  static async create(opts: WorktreeOptions): Promise<Worktree> {
    const dir = await mkdtemp(join(tmpdir(), `forge-wt-${opts.taskId.slice(0, 8)}-`));
    const repo = new Git(opts.repoDir);
    await repo.run('worktree', 'add', '--force', dir, opts.branch);

    const wt = new Worktree({
      id: dir,
      dir,
      branch: opts.branch,
      repoDir: opts.repoDir,
      ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    });
    await wt.#installPushGuard(opts.claimedBranches ?? [opts.branch]);
    return wt;
  }

  /**
   * Resolves a repo-relative path inside this worktree, or refuses.
   *
   * The gateway's schema already rejects "..", so reaching this check means
   * something slipped past it. Defence in depth: the sandbox does not trust
   * that the layer above did its job.
   */
  resolve(repoRelative: string): string {
    const full = resolve(this.dir, repoRelative);
    const rel = relative(this.dir, full);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
      throw new PathEscape(repoRelative);
    }
    return full;
  }

  async read(repoRelative: string): Promise<string> {
    return readFile(this.resolve(repoRelative), 'utf8');
  }

  async write(repoRelative: string, content: string): Promise<void> {
    const full = this.resolve(repoRelative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  /** Runs a command in the worktree. Never throws on a non-zero exit — a failing
   *  test run is information the agent needs, not an exception. */
  async exec(command: string, args: readonly string[], timeoutMs = 120_000): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await exec(command, [...args], {
        cwd: this.dir,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
      };
    }
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const repo = new Git(this.#repoDir);
    await repo.tryRun('worktree', 'remove', '--force', this.dir);
    await rm(this.dir, { recursive: true, force: true });
    await repo.tryRun('worktree', 'prune');
  }

  /**
   * Rejects a push to any branch this task does not hold. Enforced in the
   * driver rather than in the orchestrator, so it survives into the Docker and
   * Kubernetes drivers without being rewritten.
   */
  async #installPushGuard(allowed: readonly string[]): Promise<void> {
    const { stdout } = await this.git.run('rev-parse', '--git-path', 'hooks');
    const hooks = resolve(this.dir, stdout.trim());
    await mkdir(hooks, { recursive: true });
    const hook = join(hooks, 'pre-push');
    const list = allowed.map((b) => `  "${b}"`).join('\n');
    await writeFile(
      hook,
      `#!/bin/sh
# Installed by the Forge sandbox. A task may push only branches it claimed.
allowed='
${list}
'
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  branch=\${remote_ref#refs/heads/}
  case "$allowed" in
    *"\\"$branch\\""*) ;;
    *) echo "pre-push: this task does not hold a claim on '$branch'" >&2; exit 1 ;;
  esac
done
exit 0
`,
      'utf8',
    );
    await chmod(hook, 0o755);
  }
}
