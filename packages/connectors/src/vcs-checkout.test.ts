/**
 * Working in the repository the developer already has.
 *
 * The property these tests exist for is not that branching works — it is that
 * the developer's own checkout is untouched while it happens. Shura is being
 * pointed at a live working directory rather than a disposable clone, so the
 * current branch, the index and any uncommitted edits have to survive a run
 * exactly as they were. A tool that stashes your work to do its own is not one
 * anybody runs twice.
 *
 * No Postgres and no network: the "remote" is a bare repository on disk, which
 * is what origin is as far as git is concerned.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Git, agentIdentity } from '@shura/git';
import { CheckoutError, CheckoutVcs, slugFromRemote, type HostCli } from './vcs-checkout.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const who = agentIdentity('someone', 'human', 'none');

/** A checkout with an origin, the way a developer's machine has one. */
async function aCheckout(): Promise<{ dir: string; origin: string }> {
  const origin = mkdtempSync(join(tmpdir(), 'shura-origin-'));
  dirs.push(origin);
  await new Git(origin).run('init', '-q', '--bare', '-b', 'main');

  const dir = mkdtempSync(join(tmpdir(), 'shura-checkout-'));
  dirs.push(dir);
  const git = new Git(dir, who);
  await git.run('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'first');
  await git.run('remote', 'add', 'origin', origin);
  await git.run('push', '-q', 'origin', 'main');
  await git.run('fetch', '-q', 'origin');
  return { dir, origin };
}

const vcsFor = (dir: string, over: Record<string, unknown> = {}): CheckoutVcs =>
  new CheckoutVcs({ dir, base: 'main', checkCommand: ['true'], ...over });

/** The three things that must look identical before and after. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const git = new Git(dir);
  const read = async (...args: string[]): Promise<string> =>
    (await git.tryRun(...args)).stdout.trim();
  return {
    branch: await read('rev-parse', '--abbrev-ref', 'HEAD'),
    head: await read('rev-parse', 'HEAD'),
    status: await read('status', '--porcelain'),
  };
}

describe('the checkout VCS', () => {
  it('finds the repository from a path inside it', async () => {
    const { dir } = await aCheckout();
    expect(await vcsFor(dir).repoDir()).toContain('.git');
    expect(await vcsFor(dir).workingRoot()).toBeTruthy();
  });

  /*
   * The whole premise. If this fails, the mode is unusable regardless of what
   * else works: a developer cannot have their edits disturbed by a background
   * run.
   */
  it('leaves the current branch, HEAD and uncommitted work exactly as they were', async () => {
    const { dir } = await aCheckout();
    const git = new Git(dir, who);

    // A developer mid-task: their own branch, a commit of their own on it, and
    // unstaged edits on top. The commit matters — without it their branch and
    // the base share a sha, and "the new branch came from the base, not from
    // where you were standing" is not something the test can tell apart.
    await git.run('checkout', '-q', '-b', 'my-own-work');
    writeFileSync(join(dir, 'mine.ts'), 'export const mine = 1;\n');
    await git.run('add', '-A');
    await git.run('commit', '-q', '-m', 'my own work in progress');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2; // still editing\n');
    writeFileSync(join(dir, 'scratch.txt'), 'notes\n');

    const before = await snapshot(dir);
    await vcsFor(dir).createBranch('main', 'shura/shura-1');
    const after = await snapshot(dir);

    expect(after).toEqual(before);
    expect(after.branch).toBe('my-own-work');
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('still editing');
    // And the branch really was created, from the base rather than from the
    // commit the developer happened to be sitting on.
    const made = await git.tryRun('rev-parse', '--verify', 'refs/heads/shura/shura-1');
    expect(made.ok).toBe(true);
    expect(made.stdout.trim()).not.toBe(before.head);
    expect(made.stdout.trim()).toBe(
      (await git.tryRun('rev-parse', 'refs/remotes/origin/main')).stdout.trim(),
    );
  });

  it('reuses a branch that already exists, as a rework attempt must', async () => {
    const { dir } = await aCheckout();
    const git = new Git(dir, who);
    const vcs = vcsFor(dir);

    await vcs.createBranch('main', 'shura/shura-2');
    const first = (await git.tryRun('rev-parse', 'refs/heads/shura/shura-2')).stdout.trim();

    // Work lands on it, then the branch is "created" again.
    const wt = mkdtempSync(join(tmpdir(), 'shura-wt-'));
    dirs.push(wt);
    await git.run('worktree', 'add', '-q', wt, 'shura/shura-2');
    writeFileSync(join(wt, 'app.ts'), 'export const a = 3;\n');
    const inWt = new Git(wt, who);
    await inWt.run('add', '-A');
    await inWt.run('commit', '-q', '-m', 'work');
    await git.run('worktree', 'remove', '--force', wt);

    const moved = (await git.tryRun('rev-parse', 'refs/heads/shura/shura-2')).stdout.trim();
    await vcs.createBranch('main', 'shura/shura-2');
    expect((await git.tryRun('rev-parse', 'refs/heads/shura/shura-2')).stdout.trim()).toBe(moved);
    expect(moved).not.toBe(first);
  });

  /*
   * A developer's local base is behind as often as not. Branching from it
   * produces a diff full of other people's work, and a reviewer judging that
   * diff is judging the wrong thing.
   */
  it('branches from the remote base when the local one has drifted, and says so', async () => {
    const { dir, origin } = await aCheckout();
    const git = new Git(dir, who);

    // Someone else pushes to main. The local main does not move.
    const other = mkdtempSync(join(tmpdir(), 'shura-other-'));
    dirs.push(other);
    await new Git(other).run('clone', '-q', origin, other);
    const theirs = new Git(other, who);
    writeFileSync(join(other, 'theirs.ts'), 'export const b = 1;\n');
    await theirs.run('add', '-A');
    await theirs.run('commit', '-q', '-m', 'from someone else');
    await theirs.run('push', '-q', 'origin', 'main');

    const notes: string[] = [];
    await vcsFor(dir, { onNote: (t: string) => notes.push(t) }).createBranch('main', 'shura/shura-3');

    const made = (await git.tryRun('rev-parse', 'refs/heads/shura/shura-3')).stdout.trim();
    const remote = (await git.tryRun('rev-parse', 'refs/remotes/origin/main')).stdout.trim();
    const localMain = (await git.tryRun('rev-parse', 'refs/heads/main')).stdout.trim();

    expect(made).toBe(remote);
    expect(made).not.toBe(localMain);
    expect(notes.join(' ')).toMatch(/stale|not origin\/main/i);
  });

  // Shura has no merge(), and this is the one call a caller could misuse to
  // behave like one.
  it('refuses to push the base branch', async () => {
    const { dir } = await aCheckout();
    await expect(vcsFor(dir).publishBranch('main')).rejects.toThrow(/base branch/);
  });

  it('pushes a branch through the checkout\'s own remote', async () => {
    const { dir, origin } = await aCheckout();
    const vcs = vcsFor(dir);
    await vcs.createBranch('main', 'shura/shura-4');
    await vcs.publishBranch('shura/shura-4');
    const onOrigin = await new Git(origin).tryRun('rev-parse', '--verify', 'refs/heads/shura/shura-4');
    expect(onOrigin.ok).toBe(true);
  });

  it('diffs what the branch did, not what the base did since', async () => {
    const { dir } = await aCheckout();
    const git = new Git(dir, who);
    const vcs = vcsFor(dir);
    await vcs.createBranch('main', 'shura/shura-5');

    const wt = mkdtempSync(join(tmpdir(), 'shura-wt-'));
    dirs.push(wt);
    await git.run('worktree', 'add', '-q', wt, 'shura/shura-5');
    writeFileSync(join(wt, 'added.ts'), 'export const c = 1;\n');
    const inWt = new Git(wt, who);
    await inWt.run('add', '-A');
    await inWt.run('commit', '-q', '-m', 'add a file');
    await git.run('worktree', 'remove', '--force', wt);

    const diff = await vcs.getDiff({ id: 'probe', branch: 'shura/shura-5', base: 'main' });
    expect(diff.files).toEqual(['added.ts']);
    expect(diff.text).toContain('export const c = 1;');
  });

  it('refuses a branch carrying generated files rather than spending a review on them', async () => {
    const { dir } = await aCheckout();
    const git = new Git(dir, who);
    const vcs = vcsFor(dir);
    await vcs.createBranch('main', 'shura/shura-6');

    const wt = mkdtempSync(join(tmpdir(), 'shura-wt-'));
    dirs.push(wt);
    await git.run('worktree', 'add', '-q', wt, 'shura/shura-6');
    writeFileSync(join(wt, 'package-lock.json'), '{}\n');
    const inWt = new Git(wt, who);
    await inWt.run('add', '-A');
    await inWt.run('commit', '-q', '-m', 'oops');
    await git.run('worktree', 'remove', '--force', wt);

    await expect(
      vcs.getDiff({ id: 'probe', branch: 'shura/shura-6', base: 'main' }),
    ).rejects.toThrow(/generated file/);
  });

  // The host is asked; only the host knows whether that means gh, glab or tea.
  it('asks the host adapter to open the change request, draft and all', async () => {
    const { dir } = await aCheckout();
    const asked: Record<string, unknown>[] = [];
    const host: HostCli = {
      name: 'fake',
      async open(input) {
        asked.push({ ...input });
        return { id: '7', url: 'https://host/pr/7' };
      },
    };

    const ref = await vcsFor(dir, { host }).openChangeRequest({
      branch: 'shura/shura-7',
      base: 'main',
      title: 'SHURA-7: a thing',
      body: 'criteria',
      draft: true,
    });

    expect(ref).toMatchObject({ id: '7', branch: 'shura/shura-7', base: 'main' });
    expect(asked[0]).toMatchObject({ branch: 'shura/shura-7', base: 'main', draft: true });
  });

  it('says where it is not a repository rather than failing obscurely', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'shura-not-a-repo-'));
    dirs.push(outside);
    await expect(vcsFor(outside).repoDir()).rejects.toThrow(CheckoutError);
  });
});

/*
 * Naming the repository a plan was made against.
 *
 * This is an identity for a plan row, not a routing decision — which host it
 * is remains the adapter's business. It matters because a resume has to be able
 * to tell whether the checkout it is standing in is the one the plan was made
 * against.
 */
describe('naming a repository from its remote', () => {
  it('reads the usual ways a remote is written', () => {
    expect(slugFromRemote('https://github.com/owner/name.git')).toBe('owner/name');
    expect(slugFromRemote('https://github.com/owner/name')).toBe('owner/name');
    expect(slugFromRemote('git@github.com:owner/name.git')).toBe('owner/name');
    expect(slugFromRemote('ssh://git@github.com:2222/owner/name.git')).toBe('owner/name');
    expect(slugFromRemote('  https://gitlab.com/owner/name.git  ')).toBe('owner/name');
  });

  /*
   * A remote can be a path on disk — a sibling clone, or the bare repository
   * these very tests use as an origin. Those have no owner, and the last two
   * path segments are not one: "T/shura-origin-x1y2" in a plan row is worse
   * than no slug at all, because the caller falls back to the directory name.
   */
  it('declines to invent an owner for a path on disk', () => {
    expect(slugFromRemote('/tmp/shura-origin-abc')).toBeUndefined();
    expect(slugFromRemote('../sibling-clone')).toBeUndefined();
    expect(slugFromRemote('file:///tmp/whatever')).toBe(undefined);
  });

  it('declines what it cannot read rather than guessing', () => {
    expect(slugFromRemote('')).toBeUndefined();
    expect(slugFromRemote('https://github.com/')).toBeUndefined();
  });
});

