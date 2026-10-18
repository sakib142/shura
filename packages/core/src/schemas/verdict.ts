/**
 * The verdict contract.
 *
 * Admission is a machine decision, so a verdict is structured criterion by
 * criterion rather than written as prose. Three things are enforced here and
 * nowhere else:
 *
 *   - every acceptance criterion is addressed, so a verifier cannot pass an
 *     artifact by quietly ignoring the hard one;
 *   - `decision` is recomputed from the findings rather than trusted, so a
 *     verifier cannot declare PASS while listing a blocker;
 *   - a criterion marked not_met carries a finding, so a rejection is always
 *     actionable by the producer.
 */

import { z } from 'zod';
import { nullsAsAbsent } from './tools.js';
import {
  CRITERION_STATUSES,
  DECISIONS,
  REVIEWER_ACTIONS,
  SEVERITIES,
  VENDORS,
  type Decision,
} from '../vocabulary.js';

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  /** What is wrong, in one sentence. */
  claim: z.string().min(1),
  /** Why the verifier believes it — the part a producer can check. */
  evidence: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CriterionVerdictSchema = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(CRITERION_STATUSES),
    finding: FindingSchema.optional(),
  })
  .refine((c) => c.status !== 'not_met' || c.finding !== undefined, {
    message: 'a criterion marked not_met must carry a finding',
    path: ['finding'],
  })
  .refine((c) => c.status !== 'met' || c.finding === undefined, {
    message: 'a criterion marked met must not carry a finding',
    path: ['finding'],
  });
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/**
 * What a verifier is asked to produce.
 *
 * Deliberately excludes `verifier` and `cost`: the platform knows which agent
 * ran and what it spent, and asking a model to self-report them invites it to
 * be wrong about its own identity. They are attached on submission instead.
 */
export const VerdictInputSchema = z.object({
  artifactId: z.string().min(1).describe('The artifact under review, as given in the task'),
  decision: z
    .enum(DECISIONS)
    .describe('PASS, CHANGES_REQUESTED, or BLOCKED if you could not reach a verdict'),
  criteria: z
    .array(CriterionVerdictSchema)
    .describe('One entry per acceptance criterion, by index. Every criterion must appear'),
  extraFindings: z
    .array(FindingSchema)
    .default([])
    .describe('Defects outside the acceptance criteria'),
  blockedReason: z.string().min(1).optional().describe('Required when the decision is BLOCKED'),
  action: z
    .enum(REVIEWER_ACTIONS)
    .optional()
    .describe(
      'Only when you are not passing it: "return" sends the work back to the agent that wrote ' +
        'it, "fix" means you would rather correct it yourself. Choose "fix" for defects you can ' +
        'settle from the diff; choose "return" when the work needs a decision you should not be ' +
        'making alone. Ignored if your role cannot fix',
    ),
});
export type VerdictInput = z.infer<typeof VerdictInputSchema>;

export const VerdictSubmissionSchema = z.object({
  artifactId: z.string().min(1),
  /** What the verifier claims. Advisory only — see resolveDecision. */
  decision: z.enum(DECISIONS),
  criteria: z.array(CriterionVerdictSchema),
  extraFindings: z.array(FindingSchema).default([]),
  /** Set only with BLOCKED: what stopped the verifier from reaching a verdict. */
  blockedReason: z.string().min(1).optional(),
  /** What the verifier asks for. Honoured only if its role declares a `fix`. */
  action: z.enum(REVIEWER_ACTIONS).optional(),
  verifier: z.object({
    agent: z.string().min(1),
    vendor: z.enum(VENDORS),
    model: z.string().min(1),
  }),
  cost: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
});
export type VerdictSubmission = z.infer<typeof VerdictSubmissionSchema>;

export class VerdictRejected extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    // The detail goes in the message on purpose. This error is returned to the
    // verifier so it can correct itself, and "failed schema validation" with
    // the reason hidden in a property it cannot see is not correctable.
    super(detail === undefined ? message : `${message}: ${describe(detail)}`);
    this.name = 'VerdictRejected';
  }
}

function describe(detail: unknown): string {
  if (Array.isArray(detail)) {
    return detail
      .map((i) => {
        const issue = i as { path?: unknown[]; message?: string };
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
        return `${path === '' ? '(root)' : path} ${issue.message ?? ''}`.trim();
      })
      .join('; ');
  }
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

/**
 * Every criterion index exactly once, none invented. A verifier that omits a
 * criterion is not making a judgment about it, so the submission is rejected
 * rather than read as approval.
 */
export function assertCoversAllCriteria(sub: VerdictSubmission, criterionCount: number): void {
  const seen = new Set<number>();
  for (const c of sub.criteria) {
    if (c.index >= criterionCount) {
      throw new VerdictRejected(
        `criterion index ${c.index} does not exist; the artifact has ${criterionCount}`,
      );
    }
    if (seen.has(c.index)) {
      throw new VerdictRejected(`criterion index ${c.index} is addressed more than once`);
    }
    seen.add(c.index);
  }
  const missing = Array.from({ length: criterionCount }, (_, i) => i).filter((i) => !seen.has(i));
  if (missing.length > 0) {
    throw new VerdictRejected(
      `verdict does not address criteria [${missing.join(', ')}]; every criterion must be judged`,
    );
  }
}

export interface ResolvedDecision {
  readonly decision: Decision;
  /** True when the verifier's claim disagreed with its own findings. */
  readonly overridden: boolean;
  readonly reason?: string;
}

/**
 * The decision is derived, never trusted. A verifier declaring PASS while
 * listing a blocker is rewritten — without this, the whole scheme rests on the
 * reviewer's self-consistency, which is exactly what it was built not to rely on.
 *
 * BLOCKED is honoured as claimed: it means the verifier could not reach a
 * verdict, which escalates to a human and so is never a way to admit anything.
 */
export function resolveDecision(sub: VerdictSubmission): ResolvedDecision {
  if (sub.decision === 'BLOCKED') {
    return { decision: 'BLOCKED', overridden: false };
  }

  const unmet = sub.criteria.filter((c) => c.status === 'not_met');
  const blockingExtras = sub.extraFindings.filter((f) => f.severity === 'blocker');

  let derived: Decision = 'PASS';
  let reason: string | undefined;

  if (unmet.length > 0) {
    derived = 'CHANGES_REQUESTED';
    reason = `criteria [${unmet.map((c) => c.index).join(', ')}] are not met`;
  } else if (blockingExtras.length > 0) {
    derived = 'CHANGES_REQUESTED';
    reason = `${blockingExtras.length} blocker finding(s) outside the acceptance criteria`;
  }

  const overridden = derived !== sub.decision;
  return overridden
    ? {
        decision: derived,
        overridden,
        reason: `verifier claimed ${sub.decision}, but ${reason ?? 'the findings do not support it'}`,
      }
    : { decision: derived, overridden: false };
}

export interface AcceptedVerdict extends ResolvedDecision {
  readonly submission: VerdictSubmission;
}

/** The single door a verdict enters through: parse, cover, then recompute. */
export function acceptVerdict(raw: unknown, criterionCount: number): AcceptedVerdict {
  // Nulls read as absence. A vendor's structured output says "not supplied"
  // with an explicit null — and must, under a strict schema that requires
  // every key — so a verdict arrives with `finding: null` on every criterion
  // that is met. Rejecting that would be rejecting a correct verdict.
  const parsed = VerdictSubmissionSchema.safeParse(nullsAsAbsent(raw));
  if (!parsed.success) {
    throw new VerdictRejected('verdict failed schema validation', parsed.error.issues);
  }
  const sub = parsed.data;

  if (sub.decision === 'BLOCKED' && sub.blockedReason === undefined) {
    throw new VerdictRejected('a BLOCKED verdict must say what blocked it');
  }
  if (sub.decision !== 'BLOCKED') {
    assertCoversAllCriteria(sub, criterionCount);
  }

  return { ...resolveDecision(sub), submission: sub };
}
