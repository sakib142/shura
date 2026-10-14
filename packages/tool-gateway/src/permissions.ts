/**
 * Where rule 2 is enforced.
 *
 * The grant list is resolved from the role here and nowhere else, so an agent
 * cannot widen its own permissions by asking, and a caller cannot pass a
 * hand-made list that happens to contain repo.write.
 */

import {
  assertVerifierGrantsAreReadOnly,
  denialReason,
  parseRole,
  type RoleDefinition,
  type TaskKind,
  type ToolName,
} from '@shura/core';

export interface ResolvedGrants {
  readonly roleId: string;
  readonly kind: TaskKind;
  readonly tools: readonly ToolName[];
}

/**
 * The authoritative grant list for a role. Re-runs the invariant rather than
 * trusting that whoever loaded the role file did.
 */
export function resolveGrants(role: RoleDefinition | unknown): ResolvedGrants {
  const parsed = isRole(role) ? role : parseRole(role);
  if (parsed.kind === 'verify') {
    assertVerifierGrantsAreReadOnly(parsed.id, parsed.tools);
  }
  return { roleId: parsed.id, kind: parsed.kind, tools: parsed.tools as ToolName[] };
}

function isRole(v: unknown): v is RoleDefinition {
  return typeof v === 'object' && v !== null && 'kind' in v && 'tools' in v && 'id' in v;
}

/**
 * The decision for one call. Returns a reason when denied, so the denial can be
 * recorded and shown rather than silently swallowed.
 *
 * Note the kind check runs even when the tool appears in the grant list: a
 * mis-written role must not be able to hand a verifier a write.
 */
export function checkCall(grants: ResolvedGrants, tool: string): string | undefined {
  return denialReason(grants.kind, grants.tools, tool);
}
