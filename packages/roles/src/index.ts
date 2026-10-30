/**
 * Loads role definitions from disk and runs the invariant over each one, so an
 * unsafe role fails at startup rather than at the moment an agent reaches for a
 * tool it should never have held.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseRole, type RoleDefinition } from '@shura/core';

export const DEFINITIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'definitions');

export function loadRoleFile(path: string): RoleDefinition {
  return parseRole(parse(readFileSync(path, 'utf8')));
}

/**
 * Resolves `instructions` from a path into the prompt itself.
 *
 * The role file names a markdown file; the runtime needs its contents. Leaving
 * this unresolved sends the model the string "prompts/code-reviewer.md" as its
 * entire system prompt, which fails silently — the agent still runs, just with
 * no instructions at all.
 */
export class DomainUnknown extends Error {
  constructor(domain: string, available: readonly string[]) {
    super(
      `no domain "${domain}". Available: ${available.join(', ') || '(none)'}\n` +
        'A domain is a markdown file in packages/roles/domains/ — adding one is ' +
        'how a new kind of codebase gets its house rules.',
    );
    this.name = 'DomainUnknown';
  }
}

/** The domains that ship, by filename. */
export function availableDomains(dir: string = DEFINITIONS_DIR): string[] {
  try {
    return readdirSync(join(dir, '..', 'domains'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolves `instructions` from a path into the prompt itself, plus the domain
 * overlay when one is asked for.
 *
 * Two things are joined here, and they are deliberately different kinds of
 * thing. The role prompt describes the POSITION — what planning is, what
 * reviewing is — and is what the grants are built around. The overlay describes
 * the DOMAIN — the house rules of a kind of codebase — and changes nothing a
 * tool gateway can check.
 *
 * Keeping them separate is why there are three roles rather than three per
 * domain, and why adding `mobile` is one file rather than three.
 *
 * A missing domain throws rather than silently running without it: an agent
 * quietly missing its house rules produces work that looks right and is not,
 * which is the expensive kind of wrong.
 */
export function withPrompt(
  role: RoleDefinition,
  dir: string = DEFINITIONS_DIR,
  domain?: string,
): RoleDefinition {
  const read = (relative: string): string => readFileSync(join(dir, '..', relative), 'utf8');

  let overlay = '';
  if (domain !== undefined && domain !== '') {
    const available = availableDomains(dir);
    if (!available.includes(domain)) throw new DomainUnknown(domain, available);
    overlay = `\n\n${read(join('domains', `${domain}.md`))}`;
  }

  return {
    ...role,
    instructions: read(role.instructions) + overlay,
    // A reviewer that may fix carries a second prompt for the fixing task, and
    // it has to be resolved here too: fixRoleOf reads it straight through, so
    // leaving it as a path sends the model the string "prompts/x.md" as its
    // entire system prompt — the same silent failure this function exists for.
    //
    // The overlay goes on both. A reviewer that knows the house rules while
    // judging and forgets them while fixing would write the thing it just
    // flagged.
    ...(role.fix === undefined
      ? {}
      : { fix: { ...role.fix, instructions: read(role.fix.instructions) + overlay } }),
  };
}

export function loadAllRoles(dir: string = DEFINITIONS_DIR): Map<string, RoleDefinition> {
  const roles = new Map<string, RoleDefinition>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const role = loadRoleFile(join(dir, file));
    if (roles.has(role.id)) throw new Error(`duplicate role id "${role.id}" in ${file}`);
    roles.set(role.id, role);
  }
  return roles;
}
