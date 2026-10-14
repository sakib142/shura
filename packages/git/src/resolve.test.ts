import { afterEach, describe, expect, it } from 'vitest';
import { GitNotFound, clearGitCache, resolveGit, tryResolveGit } from './resolve.js';

afterEach(() => {
  delete process.env.FORGE_GIT;
  clearGitCache();
});

describe('resolving git', () => {
  it('finds a git that runs on this machine', () => {
    const git = resolveGit({ refresh: true });
    expect(git.version).toMatch(/^git version/);
  });

  // The whole point: /usr/bin/git exists on this machine and does not run.
  // Existence is not evidence, so every candidate is executed.
  it('rejects a binary that exists but does not work', () => {
    process.env.FORGE_GIT = '/bin/ls';
    clearGitCache();
    expect(() => resolveGit({ refresh: true })).toThrow(GitNotFound);
  });

  it('rejects a path that is not there at all', () => {
    process.env.FORGE_GIT = '/nonexistent/git';
    clearGitCache();
    expect(() => resolveGit({ refresh: true })).toThrow(GitNotFound);
  });

  // An operator who names a binary means that binary; silently using another
  // would run their agents against a git they did not choose.
  it('does not fall back when an explicit override fails', () => {
    process.env.FORGE_GIT = '/bin/ls';
    clearGitCache();
    try {
      resolveGit({ refresh: true });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as GitNotFound).tried).toEqual(['/bin/ls']);
    }
  });

  it('names everything it tried when it finds nothing', () => {
    process.env.FORGE_GIT = '/nonexistent/git';
    clearGitCache();
    expect(() => resolveGit({ refresh: true })).toThrow(/Set FORGE_GIT/);
  });

  it('tryResolveGit reports absence rather than throwing', () => {
    process.env.FORGE_GIT = '/bin/ls';
    clearGitCache();
    expect(tryResolveGit()).toBeUndefined();
  });

  it('caches, so a resolution is not re-probed per call', () => {
    const a = resolveGit({ refresh: true });
    const b = resolveGit();
    expect(b).toBe(a);
  });
});
