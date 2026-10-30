/**
 * The plan contract.
 *
 * A plan is what the agent submits instead of writing code, and what a human
 * approves before it is allowed to. Three things are enforced here and nowhere
 * else:
 *
 *   - acceptance criteria are checkable, so the reviewer that judges against
 *     them later is judging something a test could settle rather than a wish;
 *   - a plan that names no file it will touch is not a plan, so the file list
 *     is non-empty — "I will look into it" is not approvable;
 *   - a plan carrying open questions cannot be approved silently. The questions
 *     are where the agent noticed the request did not settle something, and
 *     approving past them without an answer is how invented scope gets built.
 *
 * The criteria matter most. Free-form instructions are not checkable, so the
 * plan is the step that turns "add a date filter" into something a different
 * agent on a different vendor can later judge as met or not met.
 */

import { z } from 'zod';
import { RepoPath } from './paths.js';
import { nullsAsAbsent } from './tools.js';
import { VENDORS } from '../vocabulary.js';

export const PLAN_STATUSES = ['awaiting_approval', 'approved', 'rejected', 'built'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * A criterion must name a condition, an action and an outcome.
 *
 * The same three words the Jira description parser looks for, on purpose: a
 * criterion written here must survive a round trip through a ticket. A
 * criterion that is not checkable is worse than no criterion, because it
 * produces a verdict that reads as meaningful and is not.
 */
export const CheckableCriterion = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (c) => {
      const l = c.toLowerCase();
      return l.includes('given') && l.includes('when') && l.includes('then');
    },
    {
      message:
        'must be checkable: name the condition, the action and the outcome, in the form ' +
        '"Given <state>, when <action>, then <observable outcome>"',
    },
  );

export const PlannedFileSchema = z.object({
  path: RepoPath.describe('Repo-relative path you expect to create or change'),
  reason: z.string().min(1).max(500).describe('Why this file, in one line'),
});
export type PlannedFile = z.infer<typeof PlannedFileSchema>;

/**
 * What a planner is asked to produce.
 *
 * Deliberately excludes the author and the cost, for the same reason the
 * verdict contract does: the platform knows which agent ran and what it spent,
 * and asking a model to self-report its own identity invites it to be wrong.
 */
export const PlanInputSchema = z.object({
  understanding: z
    .string()
    .min(1)
    .max(4000)
    .describe('What you understand the task to be, in your own words, not a restatement of the request'),
  files: z
    .array(PlannedFileSchema)
    .min(1)
    .max(100)
    .describe('The files you expect to create or change. Name real paths you have read'),
  approach: z
    .string()
    .min(1)
    .max(8000)
    .describe('How you intend to do it, concretely enough that a reviewer could disagree with it'),
  outOfScope: z
    .array(z.string().min(1).max(500))
    .default([])
    .describe('What you decided not to do, and why. This is where a reviewer catches a misread'),
  criteria: z
    .array(CheckableCriterion)
    .min(1)
    .max(50)
    .describe('The acceptance criteria this work will be judged against, in Given/When/Then form'),
  openQuestions: z
    .array(z.string().min(1).max(1000))
    .default([])
    .describe('Anything the request does not settle. Ask rather than decide it yourself'),
});
export type PlanInput = z.infer<typeof PlanInputSchema>;

export const PlanSubmissionSchema = PlanInputSchema.extend({
  author: z.object({
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
export type PlanSubmission = z.infer<typeof PlanSubmissionSchema>;

export class PlanRejected extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    // The detail goes in the message on purpose: this error is returned to the
    // planner so it can correct itself, and "failed schema validation" with the
    // reason hidden in a property it cannot see is not correctable.
    super(detail === undefined ? message : `${message}: ${describe(detail)}`);
    this.name = 'PlanRejected';
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

/** The single door a plan enters through. */
export function acceptPlan(raw: unknown): PlanSubmission {
  // Nulls read as absence, for the same reason acceptVerdict does it: a strict
  // structured-output schema must name every key, so an unsupplied optional
  // arrives as an explicit null rather than missing.
  const parsed = PlanSubmissionSchema.safeParse(nullsAsAbsent(raw));
  if (!parsed.success) {
    throw new PlanRejected('plan failed schema validation', parsed.error.issues);
  }
  return parsed.data;
}

export interface ApprovalRequest {
  readonly openQuestions: readonly string[];
  /** Answers supplied by the approver, in the same order as the questions. */
  readonly answers?: readonly string[];
  /** The approver chose to go ahead with questions unanswered. */
  readonly ignoreQuestions?: boolean;
}

export type Approvability =
  | { readonly ok: true }
  | { readonly ok: false; readonly unanswered: readonly string[] };

/**
 * Whether a plan may be approved as it stands.
 *
 * An open question is the agent reporting that the request did not settle
 * something. Approving past it unanswered is a decision too, so it has to be
 * made deliberately rather than by pressing on — otherwise the gate becomes a
 * rubber stamp and the agent is back to inventing scope.
 */
export function approvability(req: ApprovalRequest): Approvability {
  if (req.openQuestions.length === 0) return { ok: true };
  if (req.ignoreQuestions === true) return { ok: true };

  const answers = req.answers ?? [];
  const unanswered = req.openQuestions.filter(
    (_q, i) => (answers[i] ?? '').trim() === '',
  );
  return unanswered.length === 0 ? { ok: true } : { ok: false, unanswered };
}
