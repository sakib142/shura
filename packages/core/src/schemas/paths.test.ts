import { describe, expect, it } from 'vitest';
import { RepoPath, isSecretPath } from './paths.js';

const ok = (p: string): boolean => RepoPath.safeParse(p).success;

describe('repo paths', () => {
  it('accepts an ordinary source path', () => {
    expect(ok('src/components/OrderList.tsx')).toBe(true);
  });

  it('refuses escaping the workspace', () => {
    expect(ok('/etc/passwd')).toBe(false);
    expect(ok('../../secrets')).toBe(false);
    expect(ok('.git/config')).toBe(false);
  });
});

/**
 * A real run read a .env the target repository had committed, and its contents
 * went to a model vendor. The repository should not have committed it — but
 * repositories do, and "should not have" is no comfort afterwards.
 */
describe('files holding credentials', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'apps/web/.env',
    '.npmrc',
    '.netrc',
    'id_rsa',
    'certs/server.pem',
    'private.key',
    'secrets.yaml',
    'config/secrets.json',
  ])('refuses %s', (path) => {
    expect(isSecretPath(path)).toBe(true);
    expect(ok(path)).toBe(false);
  });

  // These exist to be read. An agent that cannot see them cannot learn what
  // configuration the project expects.
  it.each(['.env.example', '.env.sample', '.env.template', 'apps/web/.env.example'])(
    'still allows %s',
    (path) => {
      expect(isSecretPath(path)).toBe(false);
      expect(ok(path)).toBe(true);
    },
  );

  it('does not refuse innocent names that merely resemble one', () => {
    for (const p of ['src/environment.ts', 'docs/keys.md', 'src/lib/credentials.test.ts']) {
      expect(ok(p), p).toBe(true);
    }
  });

  // The refusal must cover writing too, not just reading.
  it('is enforced on every tool that takes a path', async () => {
    const { validateToolArgs } = await import('./tools.js');
    expect(() => validateToolArgs('repo.read', { path: '.env' })).toThrow();
    expect(() => validateToolArgs('repo.write', { path: '.env', content: 'x' })).toThrow();
    expect(() => validateToolArgs('docs.read', { path: '.env' })).toThrow();
  });
});
