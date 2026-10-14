/**
 * Finding a git that actually works.
 *
 * `git` being on PATH does not mean it runs. On macOS, /usr/bin/git is a shim
 * that routes through xcode-select, and a damaged developer toolchain makes it
 * fail at load time while the real binaries behind it are perfectly fine. So
 * every candidate is verified by running it, never by testing for existence.
 *
 * The platform resolves git explicitly rather than inheriting whatever the
 * operator's shell happens to have, which is also what makes this survive into
 * a container where the path differs again.
 */

import { execFileSync } from 'node:child_process';

/** Searched in order. The first that actually executes wins. */
export const GIT_CANDIDATES = [
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  '/usr/bin/git',
] as const;

export interface GitResolution {
  readonly path: string;
  readonly version: string;
  /** How it was found, for `shura doctor` to explain itself. */
  readonly source: 'SHURA_GIT' | 'PATH' | 'well-known';
}

export class GitNotFound extends Error {
  constructor(readonly tried: readonly string[]) {
    super(
      `no working git found. Tried: ${tried.join(', ')}. ` +
        'Set SHURA_GIT to a git binary that runs, or install one (brew install git).',
    );
    this.name = 'GitNotFound';
  }
}

function probe(path: string): string | undefined {
  try {
    const out = execFileSync(path, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim().startsWith('git version') ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

let cached: GitResolution | undefined;

export function resolveGit(opts: { refresh?: boolean } = {}): GitResolution {
  if (cached !== undefined && opts.refresh !== true) return cached;

  const tried: string[] = [];

  const override = process.env.SHURA_GIT;
  if (override !== undefined && override !== '') {
    tried.push(override);
    const version = probe(override);
    // An explicit override that does not work is an error, not something to
    // quietly route around — the operator meant that binary.
    if (version === undefined) throw new GitNotFound(tried);
    cached = { path: override, version, source: 'SHURA_GIT' };
    return cached;
  }

  tried.push('git (PATH)');
  const onPath = probe('git');
  if (onPath !== undefined) {
    cached = { path: 'git', version: onPath, source: 'PATH' };
    return cached;
  }

  for (const candidate of GIT_CANDIDATES) {
    tried.push(candidate);
    const version = probe(candidate);
    if (version !== undefined) {
      cached = { path: candidate, version, source: 'well-known' };
      return cached;
    }
  }

  throw new GitNotFound(tried);
}

export function tryResolveGit(): GitResolution | undefined {
  try {
    return resolveGit();
  } catch {
    return undefined;
  }
}

/** Test seam. */
export function clearGitCache(): void {
  cached = undefined;
}
