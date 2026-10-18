/**
 * The closed sets the whole platform agrees on. Everything else derives from here.
 */

/** Model vendors. Rule 1 compares these, so the value must come from a runtime
 *  adapter rather than from configuration a client could mistype. */
export const VENDORS = ['anthropic', 'openai', 'google', 'local'] as const;
export type Vendor = (typeof VENDORS)[number];

/** Artifact types the pipeline carries. The pipeline itself is generic over these:
 *  adding one must not require a change to the state machine or the invariant. */
export const ARTIFACT_TYPES = [
  'design_brief',
  'story',
  'api_contract',
  'code_change',
  'test',
  'release_note',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The three things a task can be. `admit` is never performed by a model. */
export const TASK_KINDS = ['produce', 'verify', 'admit'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  'pending',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A verdict's decision. BLOCKED means the verifier could not verify — it escalates
 *  to a human rather than admitting or rejecting. */
export const DECISIONS = ['PASS', 'CHANGES_REQUESTED', 'BLOCKED'] as const;
export type Decision = (typeof DECISIONS)[number];

export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CRITERION_STATUSES = ['met', 'not_met', 'not_applicable'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/**
 * What a tool does, which is what rule 2 is enforced against.
 *
 * 'read'    — observes state
 * 'execute' — runs something without changing the artifact (a test run)
 * 'write'   — changes state outside the agent
 */
export type ToolEffect = 'read' | 'execute' | 'write';

/** The tool a verifier submits its finding through. The single `write` effect a
 *  verify role is permitted to hold, because it is the verifier's own output
 *  channel rather than a way to touch the artifact under review. */
export const VERIFIER_OUTPUT_TOOL = 'verdict.submit';

/**
 * What a verifier asks for when it has found something.
 *
 * 'return' sends the work back to the producer, which is the default and the
 * only option for a reviewer that cannot write.
 *
 * 'fix' means the reviewer would rather correct it itself. Honouring that does
 * NOT give the verify task a write grant — rule 2 is unchanged. It schedules a
 * separate `produce` task under the reviewer's identity, so the audit shows a
 * verify task that judged and a produce task that wrote, and no single task
 * ever did both.
 */
export const REVIEWER_ACTIONS = ['fix', 'return'] as const;
export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

/* The catalog, its argument schemas and ToolName live in schemas/tools.ts. */
