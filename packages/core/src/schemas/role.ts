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
import { TASK_KINDS, VENDORS, VERIFIER_OUTPUT_TOOL } from '../vocabulary.js';
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

/**
 * A verify role's optional second hat.
 *
 * Some reviewers are allowed to correct what they find rather than only
 * reporting it. That capability does not belong on the verify task: rule 2 says
 * a verifier holds no write grant, and weakening it to "except when we meant
 * it" would leave nothing to enforce.
 *
 * So the grants live here instead, and are only ever used by a separate
 * `produce` task created under the same agent's identity. The audit records a
 * verify task that judged and a produce task that wrote. No single task does
 * both, which is what rule 2 actually says.
 *
 * What this does give up: a fix written here is not itself reviewed by another
 * agent. The human approving the pull request is the only check on it, so the
 * pull request says which commits came from the reviewer.
 */
export const FixCapabilitySchema = z.object({
  tools: z.array(z.enum(TOOL_NAMES)).min(1),
  /** Path to the prompt for the fixing task, which is not the review prompt. */
  instructions: z.string().min(1),
});
export type FixCapability = z.infer<typeof FixCapabilitySchema>;

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
  /** Verify roles only: what this reviewer may do when it chooses to fix. */
  fix: FixCapabilitySchema.optional(),
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
  if (role.fix !== undefined) {
    if (role.kind !== 'verify') {
      throw new RoleInvalid(
        `role "${role.id}" is kind "${role.kind}" and declares a "fix"; only a verify role has ` +
          'something to fix, and a producer already holds its own write grants',
      );
    }
    // A fixing task writes code; it does not also get to judge it. Letting one
    // identity carry both in the same grant set is the thing rule 2 forbids,
    // and the separation only survives if the two grant sets stay disjoint.
    if (role.fix.tools.includes(VERIFIER_OUTPUT_TOOL)) {
      throw new RoleInvalid(
        `role "${role.id}" grants "${VERIFIER_OUTPUT_TOOL}" to its fixing task; a task that ` +
          'writes the code must not also record the verdict on it',
      );
    }
    const forbidden = role.fix.tools.filter((t) => role.never.includes(t));
    if (forbidden.length > 0) {
      throw new RoleInvalid(
        `role "${role.id}" grants [${forbidden.join(', ')}] to its fixing task while listing ` +
          'them under "never"',
      );
    }
  }

  const contradiction = role.never.filter((t) => role.tools.includes(t));
  if (contradiction.length > 0) {
    throw new RoleInvalid(
      `role "${role.id}" grants [${contradiction.join(', ')}] while listing them under "never"`,
    );
  }
  return role;
}

/**
 * The produce-kind role a reviewer wears when it fixes what it found.
 *
 * Same agent, same model, different task kind and different grants. Returns
 * undefined for a reviewer that may only report, which is every reviewer whose
 * definition does not say otherwise.
 */
export function fixRoleOf(role: RoleDefinition): RoleDefinition | undefined {
  if (role.fix === undefined) return undefined;
  const { fix: _fix, ...rest } = role;
  return {
    ...rest,
    // The id changes so the audit cannot confuse the two tasks, and so a role
    // lookup by id can never return this one as something to schedule.
    id: `${role.id}:fix`,
    kind: 'produce',
    tools: role.fix.tools,
    instructions: role.fix.instructions,
    output: {},
  };
}

export { InvariantViolation };
