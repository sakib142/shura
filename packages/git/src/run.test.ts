import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git, GitError, agentIdentity } from './run.js';

const dirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'forge-git-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('running git', () => {
  it('commits under the identity it was given', async () => {
    const dir = workspace();
    const identity = agentIdentity('dev-01', 'backend-developer', 'claude-sonnet-5');
    const git = new Git(dir, identity);

    await git.run('init', '-q', '-b', 'main', '.');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    await git.run('add', 'a.txt');
    await git.run('commit', '-q', '-m', 'first');

    const { stdout } = await git.run('log', '--format=%an <%ae>', '-1');
    expect(stdout.trim()).toBe('dev-01 (backend-developer) <dev-01+claude-sonnet-5@agents.forge.local>');
  });

  // An agent commit authored by whoever owns the laptop makes the trail useless.
  it('ignores the machine git config entirely', async () => {
    const dir = workspace();
    const git = new Git(dir, { name: 'rev-01 (code-reviewer)', email: 'rev-01@agents.forge.local' });
    await git.run('init', '-q', '-b', 'main', '.');
    writeFileSync(join(dir, 'a.txt'), 'x');
    await git.run('add', 'a.txt');
    await git.run('commit', '-q', '-m', 'c');
    const { stdout } = await git.run('log', '--format=%ae', '-1');
    expect(stdout.trim()).not.toContain('sakib');
    expect(stdout.trim()).toContain('agents.forge.local');
  });

  it('throws with the command and stderr when git fails', async () => {
    const git = new Git(workspace());
    await expect(git.run('log')).rejects.toThrow(GitError);
  });

  it('tryRun reports failure rather than throwing', async () => {
    const r = await new Git(workspace()).tryRun('log');
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/not a git repository/i);
  });
});
