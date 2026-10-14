/**
 * Loads role definitions from disk and runs the invariant over each one, so an
 * unsafe role fails at startup rather than at the moment an agent reaches for a
 * tool it should never have held.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseRole, type RoleDefinition } from '@forge/core';

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
export function withPrompt(role: RoleDefinition, dir: string = DEFINITIONS_DIR): RoleDefinition {
  const file = join(dir, '..', role.instructions);
  return { ...role, instructions: readFileSync(file, 'utf8') };
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
