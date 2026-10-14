/**
 * Loading and validating forge.config.yaml.
 *
 * Error messages are part of the product here. A newcomer's first encounter
 * with this project is likely to be a config they got slightly wrong, and
 * "invalid union discriminator" is not an answer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { ForgeConfigSchema, type ForgeConfig } from './schema.js';

export const CONFIG_FILENAME = 'forge.config.yaml';

export class ConfigInvalid extends Error {
  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    super(`${path}\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigInvalid';
  }
}

/**
 * Patterns that look like live credentials.
 *
 * This file is meant to be committed. A schema that merely advises against
 * pasting a token is one that will eventually have a token pasted into it, and
 * an open-source repo is exactly where that becomes everyone's problem.
 */
const SECRET_SHAPES: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{20}/, what: 'an Anthropic API key' },
  { re: /sk-proj-[A-Za-z0-9_-]{20}/, what: 'an OpenAI API key' },
  { re: /AIza[A-Za-z0-9_-]{30}/, what: 'a Google API key' },
  { re: /gh[pousr]_[A-Za-z0-9]{36}/, what: 'a GitHub token' },
  { re: /ATATT[A-Za-z0-9_\-=]{20}/, what: 'an Atlassian API token' },
  { re: /figd_[A-Za-z0-9_-]{20}/, what: 'a Figma token' },
];

export function assertNoSecrets(text: string, path: string): void {
  for (const { re, what } of SECRET_SHAPES) {
    if (re.test(text)) {
      throw new ConfigInvalid(path, [
        `this file contains what looks like ${what}.`,
        'Credentials are named here, not carried: set tokenEnv to the name of an',
        'environment variable and put the value in .env, which is gitignored.',
      ]);
    }
  }
}

export interface LoadedConfig {
  readonly config: ForgeConfig;
  readonly path: string;
  readonly dir: string;
}

/** Walks up from `from` looking for the config, the way git finds .git. */
export function findConfig(from: string = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(path?: string): LoadedConfig {
  const file = path ?? findConfig();
  if (file === undefined) {
    throw new ConfigInvalid(CONFIG_FILENAME, [
      'no config found in this directory or any parent.',
      'Run `forge init` to create one.',
    ]);
  }
  // An explicitly named file that is not there deserves the same answer as one
  // that could not be found by searching, not a raw ENOENT from readFileSync.
  if (!existsSync(file)) {
    throw new ConfigInvalid(file, ['no such file.', 'Run `forge init` to create one.']);
  }

  const text = readFileSync(file, 'utf8');
  assertNoSecrets(text, file);

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigInvalid(file, [`not valid YAML: ${(err as Error).message}`]);
  }

  const parsed = ForgeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigInvalid(file, parsed.error.issues.map(explain));
  }

  return { config: parsed.data, path: file, dir: dirname(file) };
}

/** Turns a zod issue into something a newcomer can act on. */
function explain(issue: { path: (string | number)[]; message: string; code: string }): string {
  const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
  if (issue.code === 'invalid_union_discriminator') {
    return `${where}: unknown type. Check the spelling against the documented options.`;
  }
  return `${where}: ${issue.message}`;
}

/** Resolves a config-relative path against the config's own directory. */
export function resolveFrom(loaded: LoadedConfig, path: string): string {
  return isAbsolute(path) ? path : resolve(loaded.dir, path);
}

export interface MissingCredential {
  readonly envVar: string;
  readonly neededBy: string;
}

/**
 * Which named credentials are not actually set.
 *
 * Reported rather than thrown: `forge doctor` should be able to say what is
 * missing without refusing to run at all.
 */
export function missingCredentials(config: ForgeConfig): MissingCredential[] {
  const missing: MissingCredential[] = [];
  const need = (envVar: string, neededBy: string): void => {
    if ((process.env[envVar] ?? '') === '') missing.push({ envVar, neededBy });
  };

  if (config.repo.type === 'github') need(config.repo.tokenEnv, 'GitHub');
  if (config.tracker.type === 'jira') {
    need(config.tracker.emailEnv, 'Jira');
    need(config.tracker.tokenEnv, 'Jira');
  }
  if (config.design.type === 'figma') need(config.design.tokenEnv, 'Figma');

  for (const agent of Object.values(config.agents)) {
    const envVar = VENDOR_KEY_ENV[agent.runtime];
    if (envVar !== undefined) need(envVar, `the ${agent.runtime} runtime`);
  }
  return missing;
}

export const VENDOR_KEY_ENV: Readonly<Record<string, string | undefined>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  local: undefined,
};
