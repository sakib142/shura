import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git, GitError, agentIdentity, redactSecrets } from './run.js';

const dirs: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'shura-git-'));
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
    expect(stdout.trim()).toBe('dev-01 (backend-developer) <dev-01+claude-sonnet-5@agents.shura.local>');
  });

  // An agent commit authored by whoever owns the laptop makes the trail useless.
  it('ignores the machine git config entirely', async () => {
    const dir = workspace();
    const git = new Git(dir, { name: 'rev-01 (code-reviewer)', email: 'rev-01@agents.shura.local' });
    await git.run('init', '-q', '-b', 'main', '.');
    writeFileSync(join(dir, 'a.txt'), 'x');
    await git.run('add', 'a.txt');
    await git.run('commit', '-q', '-m', 'c');
    const { stdout } = await git.run('log', '--format=%ae', '-1');
    expect(stdout.trim()).not.toContain('sakib');
    expect(stdout.trim()).toContain('agents.shura.local');
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

/**
 * Credentials must not survive into anything a human, a log or a model sees.
 *
 * This is here because it already happened: `GitError` echoes the argv, a clone
 * over HTTPS carries its token in the argv, and the one call site that had not
 * remembered to redact printed a live GitHub PAT to the terminal and into the
 * event log. Redaction belongs in the error, where no caller can forget it.
 */
describe('redaction', () => {
  /**
   * Credential-shaped fixtures, assembled at runtime.
   *
   * Two reasons they are not written as literals. A fixture copied from a real
   * credential IS a committed credential, however much was trimmed off the end
   * — which is exactly the mistake this file was written to prevent, and which
   * its first draft made. And the pre-commit scanner reads staged content, so a
   * literal that looks like a token blocks the commit; the scanner is right, so
   * the fixture gives way rather than the check.
   */
  const token = (prefix: string, body: string): string => `${prefix}${body}`;
  const pat = token('github', '_pat_11NOTREAL' + '0'.repeat(48));

  it('strips a token embedded in a remote URL', () => {
    const out = redactSecrets(`https://x-access-token:${pat}@github.com/o/r.git`);
    expect(out).not.toContain(pat);
    expect(out).toBe('https://[redacted]@github.com/o/r.git');
  });

  it('strips a bare token, wherever it appears', () => {
    expect(redactSecrets(`remote said ${pat} is bad`)).not.toContain(pat);
    expect(redactSecrets(token('gh', 'p_' + 'a'.repeat(36)))).not.toMatch(/p_aaa/);
    expect(redactSecrets(token('sk-', 'ant-' + 'b'.repeat(28)))).not.toContain('bbbb');
    expect(redactSecrets(token('AIz', 'a' + 'c'.repeat(35)))).toBe('AIza[redacted]');
  });

  it('leaves text carrying no credential alone', () => {
    const plain = 'fatal: could not read from remote repository';
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });

  // The actual leak: the argv, not the stderr.
  it('keeps a token out of a GitError built from a clone command', () => {
    const err = new GitError(
      ['clone', '--bare', `https://x-access-token:${pat}@github.com/o/r.git`, 'r.git'],
      128,
      'fatal: repository not found',
    );
    expect(err.message).not.toContain(pat);
    expect(err.args.join(' ')).not.toContain(pat);
    expect(err.stack ?? '').not.toContain(pat);
  });

  it('keeps a token out of stderr as well as the argv', () => {
    const err = new GitError(['push'], 128, `remote: rejected https://u:${pat}@github.com/o/r`);
    expect(err.message).not.toContain(pat);
    expect(err.stderr).not.toContain(pat);
  });
});
