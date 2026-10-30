import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeGuard } from './guard.js';

/**
 * The hook is Shura's gateway for the tools it does not own.
 *
 * A CLI agent reads and writes through Claude Code's own tools, which never
 * reach `McpToolGateway` — so without this, the refusal to read a credential
 * file silently stops applying on the CLI path. It happened for real on the
 * API path first: an agent read a `.env` a repository had committed, and its
 * contents went to a model vendor.
 *
 * These run the generated script as a real process, because that is how it
 * executes. A unit test of the logic would not catch a script that does not
 * parse.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WORKDIR = '/tmp/shura-wt-test';

/** Runs the guard exactly as the CLI does, and reports its verdict. */
function runGuard(
  scriptPath: string,
  toolName: string,
  input: Record<string, unknown>,
): { blocked: boolean; said: string } {
  try {
    execFileSync('node', [scriptPath], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: input,
        cwd: WORKDIR,
      }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { blocked: false, said: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { blocked: e.status === 2, said: e.stderr ?? '' };
  }
}

/** The common case: a guard built for WORKDIR, asked about one call. */
function ask(toolName: string, input: Record<string, unknown>): { blocked: boolean; said: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shura-guard-test-'));
  dirs.push(dir);
  return runGuard(writeGuard({ workdir: WORKDIR, dir }).scriptPath, toolName, input);
}

describe('refusing credential files', () => {
  it.each([
    ['.env', 'Read'],
    ['.env.local', 'Read'],
    ['apps/web/.env', 'Read'],
    ['/tmp/shura-wt-test/.env.production', 'Read'],
    ['id_rsa', 'Read'],
    ['certs/server.pem', 'Read'],
    ['.npmrc', 'Read'],
  ])('blocks %s', (path, tool) => {
    const r = ask(tool, { file_path: path });
    expect(r.blocked).toBe(true);
    expect(r.said).toMatch(/credentials/i);
  });

  // The agent is told why, and what to read instead. A refusal with no
  // direction just gets retried.
  it('tells the agent what to read instead', () => {
    expect(ask('Read', { file_path: '.env' }).said).toMatch(/\.env\.example/);
  });

  it('still allows the example files, which exist to be read', () => {
    for (const p of ['.env.example', '.env.sample', 'apps/web/.env.template']) {
      expect(ask('Read', { file_path: p }).blocked, p).toBe(false);
    }
  });

  it('refuses to write one as well as read it', () => {
    expect(ask('Write', { file_path: '.env' }).blocked).toBe(true);
  });

  it('leaves ordinary source files alone', () => {
    for (const p of ['src/app.ts', 'docs/keys.md', 'src/environment.ts']) {
      expect(ask('Read', { file_path: `${WORKDIR}/${p}` }).blocked, p).toBe(false);
    }
  });
});

describe('keeping writes inside the worktree', () => {
  it('blocks a write to an absolute path outside it', () => {
    const r = ask('Write', { file_path: '/etc/hosts' });
    expect(r.blocked).toBe(true);
    expect(r.said).toMatch(/outside the checked-out repository/);
  });

  it('allows a write inside it', () => {
    expect(ask('Write', { file_path: `${WORKDIR}/src/a.ts` }).blocked).toBe(false);
  });

  it('allows a relative write, which resolves inside it', () => {
    expect(ask('Edit', { file_path: 'src/a.ts' }).blocked).toBe(false);
  });

  /**
   * Reads outside are allowed on purpose: an agent may legitimately read a
   * system header or an installed dependency, and the worktree is where the
   * damage would be done.
   */
  it('does not block reading outside the worktree', () => {
    expect(ask('Read', { file_path: '/usr/include/stdio.h' }).blocked).toBe(false);
  });

  it('covers the notebook tool, which names its path differently', () => {
    expect(ask('NotebookEdit', { notebook_path: '/etc/x.ipynb' }).blocked).toBe(true);
  });
});

/**
 * Bash reaches the filesystem without naming a path in its input, so the path
 * checks never see it. A live planner holding no Write tool still ran
 * `npm install` and wrote node_modules — harmless in itself, but the same
 * shell could have read a credential file.
 *
 * This is not a sandbox. A shell is Turing-complete and an agent set on
 * evading this would. It stops the accident, which is the failure that
 * actually happened.
 */
describe('refusing credential files through a shell', () => {
  it.each([
    'cat .env',
    'cat ./.env',
    'head -5 apps/web/.env.local',
    'grep SECRET .env && echo found',
    'cat id_rsa',
    'cat certs/server.pem | head',
  ])('blocks: %s', (command) => {
    const r = ask('Bash', { command });
    expect(r.blocked).toBe(true);
    expect(r.said).toMatch(/credentials/i);
  });

  it('still allows the example file through a shell', () => {
    expect(ask('Bash', { command: 'cat .env.example' }).blocked).toBe(false);
  });

  it('leaves ordinary commands alone', () => {
    for (const c of ['pnpm test', 'npm install', 'ls -la src', 'git status', 'cat package.json']) {
      expect(ask('Bash', { command: c }).blocked, c).toBe(false);
    }
  });
});

/**
 * On macOS `/var` is a symlink to `/private/var`, and the CLI reports whichever
 * form it resolved — sometimes both within one run. Comparing literally meant
 * the guard refused legitimate writes to its own worktree: a live builder was
 * denied twice before stumbling onto the spelling that matched.
 */
describe('a worktree reached by its other name', () => {
  /** A real symlinked directory, the shape macOS temp paths actually have. */
  function symlinked(): { real: string; via: string } {
    const parent = mkdtempSync(join(tmpdir(), 'shura-link-'));
    dirs.push(parent);
    const real = join(parent, 'real');
    mkdirSync(real);
    const via = join(parent, 'via');
    symlinkSync(real, via);
    return { real, via };
  }

  it('allows a write arriving by the resolved path', () => {
    const { real, via } = symlinked();
    const dir = mkdtempSync(join(tmpdir(), 'shura-guard-test-'));
    dirs.push(dir);
    const { scriptPath } = writeGuard({ workdir: via, dir });

    // The guard was configured with the symlink; the CLI reports the real path.
    const r = runGuard(scriptPath, 'Write', { file_path: join(real, 'a.ts') });
    expect(r.blocked).toBe(false);
  });

  it('still refuses a write genuinely outside it', () => {
    const { via } = symlinked();
    const dir = mkdtempSync(join(tmpdir(), 'shura-guard-test-'));
    dirs.push(dir);
    const { scriptPath } = writeGuard({ workdir: via, dir });
    expect(runGuard(scriptPath, 'Write', { file_path: '/etc/hosts' }).blocked).toBe(true);
  });
});

describe('when the guard cannot tell', () => {
  /**
   * Fails open, deliberately. A guard that crashed the run on a tool shape it
   * did not recognise would be a worse failure than the one it prevents, and
   * the tools it exists to stop are named explicitly.
   */
  it('allows a call it cannot parse rather than killing the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shura-guard-test-'));
    dirs.push(dir);
    const { scriptPath } = writeGuard({ workdir: WORKDIR, dir });
    expect(() =>
      execFileSync('node', [scriptPath], { input: 'not json', encoding: 'utf8' }),
    ).not.toThrow();
  });

  it('allows a tool that names no path at all', () => {
    expect(ask('Bash', { command: 'pnpm test' }).blocked).toBe(false);
  });
});

describe('the settings it generates', () => {
  it('installs itself for every tool, not a list we thought of', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shura-guard-test-'));
    dirs.push(dir);
    const { settings } = writeGuard({ workdir: WORKDIR, dir });
    const parsed = JSON.parse(settings) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(parsed.hooks.PreToolUse[0]!.matcher).toBe('*');
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.command).toMatch(/^node .*shura-guard\.mjs$/);
  });
});
