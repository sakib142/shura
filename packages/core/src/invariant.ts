/**
 * The four rules. Everything else in this repository exists to make these
 * enforceable; nothing else is allowed to restate them.
 *
 *   1. A verifier's vendor must differ from its producer's.
 *   2. A verifier holds no write grant except its own output channel.
 *   3. Admission is performed by a third identity that is not a model.
 *   4. Every verdict carries full attribution.
 *
 * These are pure functions over plain values. They take no database, no clock
 * and no configuration, so they can be called from the scheduler, the API and
 * the tests alike, and they cannot be satisfied by a prompt.
 */

import { VERIFIER_OUTPUT_TOOL, type TaskKind, type Vendor } from './vocabulary.js';
import { isKnownTool, toolEffect, type ToolName } from './schemas/tools.js';

export type InvariantRule = 1 | 2 | 3 | 4;

export class InvariantViolation extends Error {
  readonly rule: InvariantRule;

  constructor(rule: InvariantRule, message: string) {
    super(`invariant rule ${rule}: ${message}`);
    this.name = 'InvariantViolation';
    this.rule = rule;
  }
}

/** The identity of whoever is about to act. */
export interface ActorIdentity {
  readonly agentId: string;
  readonly role: string;
  readonly kind: TaskKind;
  /** Absent for a deterministic actor — see rule 3. */
  readonly vendor?: Vendor;
  readonly model?: string;
}

/* ------------------------------------------------------------------ rule 1 */

/**
 * Rule 1. Called when a verify task is *scheduled*, not when it runs, so an
 * invalid pair costs nothing. Two agents sharing a vendor share its blind
 * spots, which is the failure this whole design exists to avoid.
 */
export function assertDistinctVendor(producer: ActorIdentity, verifier: ActorIdentity): void {
  if (producer.vendor === undefined) {
    throw new InvariantViolation(1, `producer ${producer.agentId} has no vendor; it cannot produce`);
  }
  if (verifier.vendor === undefined) {
    throw new InvariantViolation(1, `verifier ${verifier.agentId} has no vendor; it cannot verify`);
  }
  if (producer.vendor === verifier.vendor) {
    throw new InvariantViolation(
      1,
      `verifier ${verifier.agentId} and producer ${producer.agentId} are both on vendor ` +
        `"${producer.vendor}"; a verifier must run a different vendor's model`,
    );
  }
  if (producer.agentId === verifier.agentId) {
    throw new InvariantViolation(1, `agent ${producer.agentId} cannot verify its own work`);
  }
}

/** Non-throwing form, for a scheduler choosing among candidate verifiers. */
export function isValidPair(producer: ActorIdentity, verifier: ActorIdentity): boolean {
  try {
    assertDistinctVendor(producer, verifier);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ rule 2 */

/**
 * Rule 2. A verify role may hold no `write` tool other than the channel it
 * reports through. The point is structural: a verifier that cannot write
 * cannot be talked into writing.
 */
export function assertVerifierGrantsAreReadOnly(role: string, grants: readonly string[]): void {
  for (const grant of grants) {
    if (!isKnownTool(grant)) {
      throw new InvariantViolation(2, `role "${role}" is granted unknown tool "${grant}"`);
    }
    if (grant === VERIFIER_OUTPUT_TOOL) continue;
    if (toolEffect(grant) === 'write') {
      throw new InvariantViolation(
        2,
        `verify role "${role}" is granted "${grant}", which writes; a verifier may hold ` +
          `no write grant except "${VERIFIER_OUTPUT_TOOL}"`,
      );
    }
  }
}

/** Decides a single tool call at the gateway. Returns the reason for a denial. */
export function denialReason(
  kind: TaskKind,
  grants: readonly string[],
  tool: string,
): string | undefined {
  if (!isKnownTool(tool)) return `unknown tool "${tool}"`;
  if (!grants.includes(tool)) return `"${tool}" is not granted to this role`;
  if (kind === 'verify' && tool !== VERIFIER_OUTPUT_TOOL && toolEffect(tool) === 'write') {
    return `"${tool}" writes, and a verifier holds no write grant`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ rule 3 */

/**
 * Rule 3. Judgment happens in verification; admission is mechanical. An admit
 * actor carries no vendor and no model because it is deterministic code, and
 * it is neither the producer nor the verifier.
 */
export function assertAdmitterIsDeterministic(admitter: ActorIdentity): void {
  if (admitter.kind !== 'admit') {
    throw new InvariantViolation(3, `actor ${admitter.agentId} is not an admit actor`);
  }
  if (admitter.vendor !== undefined || admitter.model !== undefined) {
    throw new InvariantViolation(
      3,
      `admit actor ${admitter.agentId} carries a model; admission must be deterministic`,
    );
  }
}

export function assertAdmitterIsThirdParty(
  producer: ActorIdentity,
  verifier: ActorIdentity,
  admitter: ActorIdentity,
): void {
  assertAdmitterIsDeterministic(admitter);
  if (admitter.agentId === producer.agentId || admitter.agentId === verifier.agentId) {
    throw new InvariantViolation(
      3,
      `admit actor ${admitter.agentId} is also the producer or the verifier`,
    );
  }
}

/* ------------------------------------------------------------------ rule 4 */

export interface VerdictAttribution {
  readonly producerVendor: Vendor;
  readonly producerModel: string;
  readonly verifierVendor: Vendor;
  readonly verifierModel: string;
  readonly promptHash: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/**
 * Rule 4. A verdict nobody can trace is a verdict nobody can audit, and the
 * eval harness cannot attribute a catch or a miss to a vendor pair without it.
 */
export function assertVerdictAttributed(a: Partial<VerdictAttribution>): asserts a is VerdictAttribution {
  const missing = (
    [
      'producerVendor',
      'producerModel',
      'verifierVendor',
      'verifierModel',
      'promptHash',
    ] as const
  ).filter((k) => a[k] === undefined || a[k] === '');

  for (const k of ['tokensIn', 'tokensOut', 'costUsd'] as const) {
    if (typeof a[k] !== 'number' || Number.isNaN(a[k])) missing.push(k as never);
  }

  if (missing.length > 0) {
    throw new InvariantViolation(4, `verdict is missing attribution: ${missing.join(', ')}`);
  }
}

/* ------------------------------------------------------- scheduling helper */

export interface VerifierCandidate extends ActorIdentity {
  readonly grants: readonly ToolName[];
}

/**
 * The single place a verify task is allowed to come into existence. Rules 1 and
 * 2 are checked together here so no caller can satisfy one and skip the other.
 */
export function selectVerifier(
  producer: ActorIdentity,
  candidates: readonly VerifierCandidate[],
): VerifierCandidate {
  if (candidates.length === 0) {
    throw new InvariantViolation(1, 'no verifier candidates were offered');
  }
  const eligible = candidates.filter((c) => isValidPair(producer, c));
  if (eligible.length === 0) {
    const vendors = [...new Set(candidates.map((c) => c.vendor ?? 'none'))].join(', ');
    throw new InvariantViolation(
      1,
      `producer ${producer.agentId} is on "${producer.vendor}" and every candidate is on ` +
        `[${vendors}]; configure a verifier on a different vendor`,
    );
  }
  const chosen = eligible[0]!;
  assertDistinctVendor(producer, chosen);
  assertVerifierGrantsAreReadOnly(chosen.role, chosen.grants);
  return chosen;
}
