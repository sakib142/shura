import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git, agentIdentity } from '@forge/git';
import { PathEscape, Worktree } from './worktree.js';

const dirs: string[] = [];
const trees: Worktree[] = [];

async function repoWithCommit(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-repo-'));
  dirs.push(dir);
  const git = new Git(dir, { name: 'seed', email: 'seed@forge.local' });
  await git.run('init', '-q', '-b', 'main', '.');
  writeFileSync(join(dir, 'a.txt'), 'original\n');
  await git.run('add', 'a.txt');
  await git.run('commit', '-q', '-m', 'seed');
  return dir;
}

afterEach(async () => {
  for (const t of trees.splice(0)) await t.destroy();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function worktree(repo: string, branch = 'main'): Promise<Worktree> {
  const wt = await Worktree.create({
    repoDir: repo,
    branch,
    taskId: 'task-abc12345',
    identity: agentIdentity('dev-01', 'backend-developer', 'claude-sonnet-5'),
  });
  trees.push(wt);
  return wt;
}

describe('the worktree sandbox', () => {
  it('checks out the branch into its own directory', async () => {
    const wt = await worktree(await repoWithCommit());
    expect(await wt.read('a.txt')).toBe('original\n');
    expect(wt.dir).not.toBe('');
  });

  it('writes files, creating directories as needed', async () => {
    const wt = await worktree(await repoWithCommit());
    await wt.write('src/deep/new.ts', 'export const x = 1;\n');
    expect(await wt.read('src/deep/new.ts')).toContain('export const x');
  });

  // Defence in depth: the gateway schema already rejects these. The sandbox
  // does not trust that the layer above did its job.
  it.each(['../escape.txt', '../../etc/passwd', '/etc/passwd'])(
    'refuses to resolve %s',
    async (bad) => {
      const wt = await worktree(await repoWithCommit());
      expect(() => wt.resolve(bad)).toThrow(PathEscape);
    },
  );

  it('runs a command and returns its output', async () => {
    const wt = await worktree(await repoWithCommit());
    const r = await wt.exec('node', ['-e', 'console.log("hi")']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
  });

  // A failing test run is information the agent needs, not an exception.
  it('reports a non-zero exit rather than throwing', async () => {
    const wt = await worktree(await repoWithCommit());
    const r = await wt.exec('node', ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('commits under the agent identity, not the machine config', async () => {
    const wt = await worktree(await repoWithCommit());
    await wt.write('b.txt', 'written by an agent\n');
    await wt.git.run('add', 'b.txt');
    await wt.git.run('commit', '-q', '-m', 'agent commit');
    const { stdout } = await wt.git.run('log', '--format=%an <%ae>', '-1');
    expect(stdout.trim()).toContain('dev-01 (backend-developer)');
    expect(stdout).not.toContain('sakib');
  });

  it('leaves no worktree registered after destroy', async () => {
    const repo = await repoWithCommit();
    const wt = await Worktree.create({ repoDir: repo, branch: 'main', taskId: 'task-1' });
    const dir = wt.dir;
    await wt.destroy();
    const { stdout } = await new Git(repo).run('worktree', 'list');
    expect(stdout).not.toContain(dir);
  });

  it('is safe to destroy twice', async () => {
    const wt = await Worktree.create({ repoDir: await repoWithCommit(), branch: 'main', taskId: 't' });
    await wt.destroy();
    await expect(wt.destroy()).resolves.toBeUndefined();
  });
});

describe('the push guard', () => {
  it('rejects a push to a branch the task does not hold', async () => {
    const origin = await repoWithCommit();
    const wt = await Worktree.create({
      repoDir: origin,
      branch: 'main',
      taskId: 'task-1',
      identity: agentIdentity('dev-01', 'backend-developer', 'claude-sonnet-5'),
      claimedBranches: ['feature/ORD-12'],
    });
    trees.push(wt);

    const bare = mkdtempSync(join(tmpdir(), 'forge-bare-'));
    dirs.push(bare);
    await new Git(bare).run('init', '-q', '--bare', '.');
    await wt.git.run('remote', 'add', 'origin', bare);

    const push = await wt.git.tryRun('push', 'origin', 'HEAD:refs/heads/main');
    expect(push.ok).toBe(false);
    expect(push.stderr).toMatch(/does not hold a claim on 'main'/);
  });

  it('allows a push to a claimed branch', async () => {
    const origin = await repoWithCommit();
    const wt = await Worktree.create({
      repoDir: origin,
      branch: 'main',
      taskId: 'task-1',
      identity: agentIdentity('dev-01', 'backend-developer', 'claude-sonnet-5'),
      claimedBranches: ['feature/ORD-12'],
    });
    trees.push(wt);

    const bare = mkdtempSync(join(tmpdir(), 'forge-bare-'));
    dirs.push(bare);
    await new Git(bare).run('init', '-q', '--bare', '.');
    await wt.git.run('remote', 'add', 'origin', bare);

    const push = await wt.git.tryRun('push', 'origin', 'HEAD:refs/heads/feature/ORD-12');
    expect(push.ok).toBe(true);
  });
});
