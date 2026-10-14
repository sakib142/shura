import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigInvalid, assertNoSecrets, findConfig, loadConfig, missingCredentials } from './load.js';
import { starterConfig } from './init.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ['GITHUB_TOKEN', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[k];
});

function withConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cfg-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'forge.config.yaml'), yaml);
  return join(dir, 'forge.config.yaml');
}

const MINIMAL = `
project: demo
repo:
  type: local
  path: ./app
`;

describe('loading', () => {
  // A newcomer's first config should be six lines, not sixty.
  it('accepts a minimal config and fills in the rest', () => {
    const { config } = loadConfig(withConfig(MINIMAL));
    expect(config.project).toBe('demo');
    expect(config.repo.base).toBe('main');
    expect(config.tracker.type).toBe('local');
    expect(config.budgets.loop_cap).toBe(3);
  });

  it('loads the starter config it generates', () => {
    const { config } = loadConfig(withConfig(starterConfig('demo')));
    expect(config.agents['backend-developer']?.runtime).toBe('anthropic');
    expect(config.agents['code-reviewer']?.runtime).toBe('openai');
  });

  it('finds the config from a subdirectory, the way git finds .git', () => {
    const path = withConfig(MINIMAL);
    const nested = join(path, '..', 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findConfig(nested)).toBe(path);
  });

  it('says what to do when there is no config at all', () => {
    expect(() => loadConfig(join(tmpdir(), 'nope', 'forge.config.yaml'))).toThrow(/forge init/);
  });
});

describe('errors a newcomer can act on', () => {
  it('names the field that is missing', () => {
    expect(() => loadConfig(withConfig('project: demo\n'))).toThrow(/repo/);
  });

  it('explains an unknown connector type instead of saying "union discriminator"', () => {
    const path = withConfig('project: demo\nrepo:\n  type: gitlab\n  path: ./app\n');
    expect(() => loadConfig(path)).toThrow(/unknown type/);
  });

  it('reports bad YAML as bad YAML', () => {
    expect(() => loadConfig(withConfig('project: [unclosed\n'))).toThrow(/not valid YAML/);
  });
});

describe('secrets never live in the config', () => {
  // This file is committed. A schema that merely advises will eventually have
  // a token pasted into it, and in an open-source repo that is everyone's
  // problem.
  // Assembled at runtime rather than written as literals. A repository-wide
  // secret scanner cannot tell a fixture from the real thing, and the answer
  // to that is not to weaken the scanner or to teach people --no-verify.
  const fake = (prefix: string, length: number): string => `${prefix}${'a'.repeat(length)}`;

  it.each([
    [fake('sk-' + 'ant-api03-', 24), 'Anthropic'],
    [fake('gh' + 'p_', 36), 'GitHub'],
    [fake('AIz' + 'aSy', 33), 'Google'],
  ])('refuses a config carrying one', (token) => {
    expect(() => assertNoSecrets(`token: ${token}`, 'x')).toThrow(ConfigInvalid);
  });

  it('explains how to do it properly', () => {
    expect(() => assertNoSecrets(`t: ${fake('gh' + 'p_', 36)}`, 'x')).toThrow(/tokenEnv/);
  });

  it('allows an environment variable name, which is the point', () => {
    expect(() => assertNoSecrets('tokenEnv: GITHUB_TOKEN', 'x')).not.toThrow();
  });
});

describe('missing credentials are reported, not thrown', () => {
  // doctor must be able to say what is missing without refusing to run.
  it('names the variable and what needs it', () => {
    const { config } = loadConfig(
      withConfig(`
project: demo
repo:
  type: github
  owner: me
  name: repo
tracker:
  type: jira
  site: https://x.atlassian.net
  project: P
`),
    );
    const missing = missingCredentials(config);
    expect(missing.map((m) => m.envVar)).toEqual(['GITHUB_TOKEN', 'JIRA_EMAIL', 'JIRA_API_TOKEN']);
    expect(missing[0]?.neededBy).toBe('GitHub');
  });

  it('reports nothing when a local setup needs nothing', () => {
    const { config } = loadConfig(withConfig(MINIMAL));
    expect(missingCredentials(config)).toEqual([]);
  });

  it('notices a credential that is set', () => {
    process.env['GITHUB_TOKEN'] = 'x';
    const { config } = loadConfig(
      withConfig('project: d\nrepo:\n  type: github\n  owner: o\n  name: n\n'),
    );
    expect(missingCredentials(config)).toEqual([]);
  });
});
