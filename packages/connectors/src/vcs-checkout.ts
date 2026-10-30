/**
 * The repository the developer already has, behind the same Vcs port.
 *
 * Nothing in the loop changes. A producer still works in a worktree, a verifier
 * still reads a diff, admission still happens in deterministic code, and there
 * is still no merge() anywhere on this port. What changes is that Shura stops
 * asking for a second set of credentials for a repository the developer is
 * already able to push to.
 *
 * The clone-and-token path exists because it has to: CI has no checkout and no
 * credential helper. But it should not be the road a newcomer walks. Getting
 * through it on 29–30 October took four round trips — a token scoped to the
 * wrong repository, then Contents read-only, then Contents still read-only —
 * each failure discovered only by running the real thing. The checkout sitting
 * on disk had working credentials the whole time.
 *
 * This is the same argument commit 081e7c8 made for model vendors, applied to
 * the git host: drive what the developer is already logged into.
 *
 * Three things this must never do, because it is operating in someone's live
 * working directory rather than a disposable clone:
 *
 *   - touch the working tree, the index, or the current branch. Every agent
 *     works in a worktree under the system temp directory, exactly as before;
 *     `git worktree add` runs against the checkout's git dir and leaves the
 *     checkout itself alone.
 *   - branch from a stale local base. `origin/<base>` after a fetch, with a
 *     warning when the local base has drifted, so work is never built on a tree
 *     the remote moved past.
 *   - push the base branch. Shura does not merge; that property is worth
 *     enforcing here too rather than trusting the caller.
 */

import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { Git, redactSecrets, tryResolveGit } from '@shura/git';
import { Worktree } from '@shura/sandbox';
import type { ChangeRequestRef, CheckRun, Diff, Vcs } from '@shura/ports';

/**
 * How a change request is opened, where "how" is a host's own CLI.
 *
 * The platform asks; only the adapter knows whether that means `gh`, `glab` or
 * `tea`. Injectable so the flow can be tested without a host, and so adding
 * GitLab is a file rather than a change here.
 */
export interface HostCli {
  readonly name: string;
  open(input: {
    readonly cwd: string;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
  }): Promise<{ readonly id: string; readonly url?: string }>;
  comment?(input: { readonly cwd: string; readonly id: string; readonly body: string }): Promise<void>;
  urlOf?(input: { readonly cwd: string; readonly id: string }): Promise<string | undefined>;
}

export interface CheckoutOptions {
  /** Any path inside the developer's checkout. */
  readonly dir: string;
  readonly base?: string;
  /** Checks run in a worktree, never in the developer's own tree. */
  readonly checkCommand: readonly string[];
  readonly remote?: string;
  readonly host?: HostCli;
  /** Reported to the caller rather than thrown, so a stale base is a warning. */
  readonly onNote?: (text: string) => void;
}

export class CheckoutError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail === undefined ? message : `${message}: ${detail}`);
    this.name = 'CheckoutError';
  }
}

export class CheckoutVcs implements Vcs {
  readonly #o: CheckoutOptions;
  #gitDir: string | undefined;
  #topLevel: string | undefined;

  constructor(options: CheckoutOptions) {
    this.#o = options;
  }

  get base(): string {
    return this.#o.base ?? 'main';
  }

  get remote(): string {
    return this.#o.remote ?? 'origin';
  }

  /**
   * The git directory worktrees are made from.
   *
   * `--git-common-dir` rather than `--git-dir`, so invoking Shura from inside a
   * linked worktree still finds the repository every other worktree shares.
   * `--git-dir` there points at a per-worktree directory, and worktrees cannot
   * be added from one.
   */
  async repoDir(): Promise<string> {
    if (this.#gitDir !== undefined) return this.#gitDir;
    const git = new Git(this.#o.dir);
    const common = await git.tryRun('rev-parse', '--path-format=absolute', '--git-common-dir');
    if (!common.ok) {
      throw new CheckoutError(
        `${this.#o.dir} is not inside a git repository`,
        redactSecrets(common.stderr),
      );
    }
    this.#gitDir = common.stdout.trim();
    return this.#gitDir;
  }

  /** Where host CLIs are run: they infer the repository from the remote here. */
  async workingRoot(): Promise<string> {
    if (this.#topLevel !== undefined) return this.#topLevel;
    const r = await new Git(this.#o.dir).tryRun('rev-parse', '--show-toplevel');
    this.#topLevel = r.ok ? r.stdout.trim() : this.#o.dir;
    return this.#topLevel;
  }

  /**
   * Creates the branch, from the remote's base rather than the local one.
   *
   * A developer's local `main` is behind as often as not, and building on it
   * produces a diff full of other people's work. So this fetches, branches from
   * `<remote>/<base>` when that exists, and says plainly when the two disagree
   * rather than silently picking one.
   *
   * An existing branch is left exactly as it is: a rework attempt reuses it,
   * the same reason the GitHub connector treats a 422 as success.
   */
  async createBranch(from: string, name: string): Promise<void> {
    const dir = await this.repoDir();
    const git = new Git(dir);

    const fetched = await git.tryRun('fetch', '--quiet', this.remote, from);
    if (!fetched.ok) {
      this.#o.onNote?.(
        `could not fetch ${this.remote}/${from}, so ${name} is branching from the local ` +
          `${from}: ${redactSecrets(fetched.stderr).split('\n')[0] ?? ''}`,
      );
    }

    const exists = await git.tryRun('rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
    if (exists.ok) return;

    const remoteRef = `refs/remotes/${this.remote}/${from}`;
    const hasRemote = await git.tryRun('rev-parse', '--verify', '--quiet', remoteRef);
    const start = hasRemote.ok ? remoteRef : from;

    if (hasRemote.ok) {
      const local = await git.tryRun('rev-parse', '--verify', '--quiet', `refs/heads/${from}`);
      if (local.ok && local.stdout.trim() !== hasRemote.stdout.trim()) {
        this.#o.onNote?.(
          `your local ${from} is not ${this.remote}/${from}; branching from ` +
            `${this.remote}/${from} so the work is not built on a stale tree`,
        );
      }
    }

    const made = await git.tryRun('branch', name, start);
    if (!made.ok) {
      throw new CheckoutError(`could not create ${name} from ${start}`, redactSecrets(made.stderr));
    }
  }

  async commit(): Promise<string> {
    throw new Error('commit happens in the worktree, under the agent identity');
  }

  /**
   * How this repository should be named in a plan.
   *
   * `owner/name` from the remote where that can be read, so a plan recorded
   * from a checkout is recognisable as the same project as one recorded from a
   * clone — and so a resume can tell whether the checkout it is standing in is
   * the one the plan was made against. The directory name is the fallback: a
   * repository with no remote can still be planned against, it just cannot be
   * pushed.
   */
  async slug(): Promise<string> {
    const r = await new Git(await this.repoDir()).tryRun('remote', 'get-url', this.remote);
    const fromRemote = r.ok ? slugFromRemote(r.stdout.trim()) : undefined;
    if (fromRemote !== undefined) return fromRemote;
    const root = await this.workingRoot();
    return root.split('/').filter((p) => p !== '').pop() ?? root;
  }

  /**
   * What the remote actually defaults to.
   *
   * Assuming "main" is how a repository that defaults to "master" fails on its
   * own base ref — the clone path asks GitHub the same question for the same
   * reason. Here it is a local ref, so the answer costs nothing: `origin/HEAD`
   * is what `git clone` recorded. Undefined when the ref is absent, which is
   * common in a repository created locally rather than cloned.
   */
  async remoteDefaultBranch(): Promise<string | undefined> {
    const r = await new Git(await this.repoDir()).tryRun(
      'symbolic-ref',
      '--short',
      `refs/remotes/${this.remote}/HEAD`,
    );
    if (!r.ok) return undefined;
    const name = r.stdout.trim().replace(new RegExp(`^${this.remote}/`), '');
    return name === '' ? undefined : name;
  }

  /**
   * Whether a push would be allowed, without pushing anything.
   *
   * `--dry-run` still connects and still negotiates, so a credential that
   * cannot write says so here rather than after a build has been paid for —
   * which is the whole point. The clone path learned this the hard way: a
   * read-only token passed every check and failed at the push with the budget
   * already spent.
   *
   * Returns the reason when a push would fail, and undefined when it would not.
   */
  async canPush(): Promise<string | undefined> {
    const dir = await this.repoDir();
    const git = new Git(dir);

    const head = await git.tryRun('rev-parse', '--verify', `refs/remotes/${this.remote}/${this.base}`);
    const sha = head.ok
      ? head.stdout.trim()
      : (await git.tryRun('rev-parse', 'HEAD')).stdout.trim();
    if (sha === '') return `could not resolve anything to probe a push with`;

    const probe = await git.tryRun(
      'push',
      '--dry-run',
      this.remote,
      `${sha}:refs/heads/shura-write-probe`,
    );
    if (probe.ok) return undefined;

    const first = redactSecrets(probe.stderr)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('To '))
      .shift();
    return (
      `${this.remote} refused a push: ${first ?? 'no reason given'}. ` +
      'A checkout that cannot push cannot open a pull request either.'
    );
  }

  /**
   * Pushes through the developer's own credential helper.
   *
   * Refuses the base branch outright. Shura has no merge() and this is the one
   * call that could be made to behave like one by a caller passing the wrong
   * branch, so the refusal lives here rather than in a comment.
   */
  async publishBranch(branch: string): Promise<void> {
    if (branch === this.base) {
      throw new CheckoutError(
        `refusing to push ${branch}, which is the base branch`,
        'Shura does not merge; a person does',
      );
    }
    const dir = await this.repoDir();
    const push = await new Git(dir).tryRun(
      'push',
      this.remote,
      `refs/heads/${branch}:refs/heads/${branch}`,
    );
    if (!push.ok) {
      throw new CheckoutError(
        `could not push ${branch} to ${this.remote}`,
        redactSecrets(push.stderr),
      );
    }
  }

  /**
   * The branch's own changes, as a three-dot diff.
   *
   * Three dots, not two: the question is what this branch did, not what has
   * happened on the base since it started.
   */
  async getDiff(ref: ChangeRequestRef): Promise<Diff> {
    const git = new Git(await this.repoDir());
    const range = `${ref.base}...${ref.branch}`;

    const names = await git.tryRun('diff', '--name-only', range);
    if (!names.ok) {
      throw new CheckoutError(`could not diff ${range}`, redactSecrets(names.stderr));
    }
    const files = names.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');

    // The same guard the GitHub connector applies, for the same reason: a
    // reviewer's whole context can be spent reading a lockfile.
    const generated = files.filter((f) =>
      /(^|\/)(node_modules|dist|coverage)\/|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(
        f,
      ),
    );
    if (generated.length > 0) {
      throw new CheckoutError(
        `${generated.length} generated file(s) are on this branch, starting with ` +
          `"${generated[0]}". Add a .gitignore covering node_modules, dist, coverage ` +
          'and lockfiles.',
      );
    }

    const text = await git.tryRun('diff', range);
    return { text: text.ok ? text.stdout : '(no textual diff)', files };
  }

  /** The project's own checks, in a worktree — never in the developer's tree. */
  async runChecks(ref: ChangeRequestRef): Promise<CheckRun> {
    const [command, ...args] = this.#o.checkCommand;
    if (command === undefined) return { ok: true, summary: 'no checks configured', output: '' };

    const wt = await Worktree.create({
      repoDir: await this.repoDir(),
      branch: ref.branch,
      taskId: `checks-${ref.id}`,
    });
    try {
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

  async openChangeRequest(input: {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<ChangeRequestRef> {
    const host = this.#o.host ?? ghCli();
    const opened = await host.open({
      cwd: await this.workingRoot(),
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft === true,
    });
    return { id: opened.id, branch: input.branch, base: input.base };
  }

  async postVerdict(ref: ChangeRequestRef, body: string): Promise<void> {
    const host = this.#o.host ?? ghCli();
    await host.comment?.({ cwd: await this.workingRoot(), id: ref.id, body });
  }

  async urlOf(ref: ChangeRequestRef): Promise<string | undefined> {
    const host = this.#o.host ?? ghCli();
    return host.urlOf?.({ cwd: await this.workingRoot(), id: ref.id });
  }
}

/**
 * GitHub through `gh`, using whatever login the developer already has.
 *
 * `gh` shells out to git for almost everything, so the resolved git goes on its
 * PATH. Without that it fails on a machine whose `/usr/bin/git` is a broken
 * Xcode shim — which is how `gh auth setup-git` failed here on 30 October,
 * reporting a dlopen error from CoreDevice rather than anything about GitHub.
 */
export function ghCli(bin = 'gh'): HostCli {
  return {
    name: bin,
    async open({ cwd, branch, base, title, body, draft }) {
      const argv = (withDraft: boolean): string[] => [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        base,
        '--title',
        title,
        '--body',
        body,
        ...(withDraft ? ['--draft'] : []),
      ];

      let r = await run(bin, argv(draft), cwd);

      // A draft is a nicety, not a requirement: private repositories on the
      // free plan refuse one. The caller asked for a draft because a person has
      // to take the work over, which an ordinary pull request serves far better
      // than none at all.
      if (!r.ok && draft && /draft/i.test(r.stderr)) {
        r = await run(bin, argv(false), cwd);
      }

      // An existing pull request for the branch is the rework case, and reusing
      // it is right. `gh` says so on stderr and prints the URL.
      if (!r.ok && /already exists/i.test(r.stderr)) {
        const found = await run(bin, ['pr', 'view', branch, '--json', 'number,url'], cwd);
        const parsed = asJson(found.stdout);
        if (parsed?.number !== undefined) {
          return { id: String(parsed.number), ...(parsed.url === undefined ? {} : { url: parsed.url }) };
        }
      }

      if (!r.ok) {
        throw new CheckoutError(
          `${bin} could not open a pull request`,
          redactSecrets(r.stderr.split('\n')[0] ?? r.stderr),
        );
      }

      // `gh pr create` prints the URL and nothing else worth parsing; the
      // number is its last path segment.
      const url = r.stdout.trim().split('\n').pop() ?? '';
      const id = url.split('/').pop() ?? '';
      return { id, ...(url === '' ? {} : { url }) };
    },

    async comment({ cwd, id, body }) {
      await run(bin, ['pr', 'comment', id, '--body', body], cwd);
    },

    async urlOf({ cwd, id }) {
      const r = await run(bin, ['pr', 'view', id, '--json', 'url'], cwd);
      return asJson(r.stdout)?.url;
    },
  };
}

/**
 * `owner/name` out of a remote URL, for any of the ways one can be written.
 *
 * Deliberately not host-aware: it is an identity for a plan row, not a routing
 * decision. Which host this is remains the adapter's business.
 */
export function slugFromRemote(url: string): string | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');

  // A remote can be a path on disk — a sibling clone, or a bare repository in
  // a temp directory. Those have no owner, and inventing one from the last two
  // path segments would put "T/shura-origin-x1y2" in a plan row.
  // `file://` is a scheme for a local path, so it is excluded with the bare
  // paths rather than counted as a host.
  const hosted =
    /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) || /^[^/\s]+@[^/\s]+:/.test(cleaned);
  if (!hosted) return undefined;

  // scp-style (git@host:owner/name) and URL-style (https://host/owner/name)
  const m = /(?:[:/])([^/:]+)\/([^/]+)$/.exec(cleaned);
  if (m === null) return undefined;
  const [, owner, name] = m;
  return owner === undefined || name === undefined || owner === '' || name === ''
    ? undefined
    : `${owner}/${name}`;
}

function asJson(text: string): { number?: number; url?: string } | undefined {
  try {
    return JSON.parse(text) as { number?: number; url?: string };
  } catch {
    return undefined;
  }
}

/**
 * Runs a host CLI with stdin closed and the resolved git on PATH.
 *
 * Stdin closed for the reason `shura smoke` learned the hard way: a CLI handed
 * an open stdin pipe that nothing ever ends can sit waiting on it until a
 * timeout, and report as broken while being perfectly healthy.
 */
function run(
  bin: string,
  args: readonly string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const git = tryResolveGit();
  const gitBin = git === undefined || git.path === 'git' ? undefined : dirname(git.path);
  const env =
    gitBin === undefined ? process.env : { ...process.env, PATH: `${gitBin}:${process.env.PATH ?? ''}` };

  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: `${bin} could not be run: ${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}
