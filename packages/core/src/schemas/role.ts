/**
 * Role definitions. Field names follow section 6 of the architecture doc so the
 * examples already written there stay valid.
 *
 * The `never` list is documentation of intent. The enforcement is that a
 * forbidden tool is absent from `tools` and the gateway denies anything
 * ungranted — which is why parsing a role runs the invariant rather than
 * trusting the file.
 */

import { z } from 'zod';
import { TASK_KINDS, VENDORS } from '../vocabulary.js';
import { TOOL_CATALOG } from './tools.js';
import {
  InvariantViolation,
  assertVerifierGrantsAreReadOnly,
} from '../invariant.js';

const TOOL_NAMES = Object.keys(TOOL_CATALOG) as [string, ...string[]];

export const ModelRefSchema = z.object({
  runtime: z.enum(VENDORS),
  model: z.string().min(1),
  /** "vendor/model". Must resolve to a different vendor from the producer's. */
  fallback: z.string().min(1).optional(),
});

export const RoleDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  /** Absent for an admit role: admission is deterministic code (rule 3). */
  model: ModelRefSchema.optional(),
  tools: z.array(z.enum(TOOL_NAMES)).default([]),
  limits: z
    .object({
      max_minutes: z.number().positive(),
      max_tokens: z.number().int().positive(),
      max_usd: z.number().positive(),
    })
    .default({ max_minutes: 30, max_tokens: 400_000, max_usd: 2 }),
  instructions: z.string().min(1),
  output: z.record(z.string(), z.unknown()).default({}),
  never: z.array(z.string()).default([]),
});
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export class RoleInvalid extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RoleInvalid';
  }
}

/**
 * Parses a role and runs the invariant over it, so an unsafe role fails at load
 * rather than at the moment an agent reaches for a tool it should not have.
 */
export function parseRole(raw: unknown): RoleDefinition {
  const parsed = RoleDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RoleInvalid('role failed schema validation', parsed.error.issues);
  }
  const role = parsed.data;

  if (role.kind === 'admit' && role.model !== undefined) {
    throw new RoleInvalid(
      `admit role "${role.id}" declares a model; admission must be deterministic (rule 3)`,
    );
  }
  if (role.kind !== 'admit' && role.model === undefined) {
    throw new RoleInvalid(`role "${role.id}" is kind "${role.kind}" but declares no model`);
  }
  if (role.kind === 'verify') {
    assertVerifierGrantsAreReadOnly(role.id, role.tools);
  }

  const contradiction = role.never.filter((t) => role.tools.includes(t));
  if (contradiction.length > 0) {
    throw new RoleInvalid(
      `role "${role.id}" grants [${contradiction.join(', ')}] while listing them under "never"`,
    );
  }
  return role;
}

export { InvariantViolation };
