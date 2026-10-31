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
 * One way this repository verifies itself, in its own words.
 *
 * `proves` is the field that matters and the one a human would skip. A green
 * `npm run build` on a repo whose `tsconfig.json` is `{"files": [], …}` proves
 * that Vite bundled, and nothing at all about types — we asserted otherwise on
 * 30 October and it cost two verdicts and three builder passes. So the planner
 * has to say what a pass establishes, and say it narrowly.
 *
 * `greenOnBase` is measured, not assumed. A repository whose lint has been red
 * for a year is normal, and a gate that demands green there can never pass;
 * knowing which checks are already failing is what makes "no new failures"
 * expressible later.
 */
export const SurveyCheckSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .describe("A short name in the project's own terms: build, unit tests, typecheck, lint"),
  command: z
    .string()
    .min(1)
    .max(500)
    .describe('The shell command, exactly as this repository runs it'),
  proves: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'What a passing run establishes — and narrowly. "it compiles" is not "it works", and a ' +
        'build that type-checks nothing must not claim to type-check',
    ),
  greenOnBase: z
    .boolean()
    .describe(
      'Whether it passes right now on the base branch, before any change. Run it and find out. ' +
        'A repository with long-red lint is ordinary, and pretending otherwise produces a gate ' +
        'nothing can satisfy',
    ),
  usableAsGate: z
    .boolean()
    .describe(
      'Whether a machine can run this unattended and learn something from the result. False if ' +
        'it needs a person, a browser or a running server; if it needs configuration the ' +
        'repository does not contain; if it leaves a process behind; or if it passes without ' +
        'asserting anything. A suite with no tests exits 0 and proves nothing — that is false, ' +
        'not true',
    ),
});
export type SurveyCheck = z.infer<typeof SurveyCheckSchema>;

/**
 * How this repository builds and verifies itself, derived rather than declared.
 *
 * The platform must know nothing about any ecosystem — not npm, not cargo, not
 * go — and an operator must not have to maintain facts about a repository that
 * change without telling them. `--checks` was that: a hand-authored per-repo
 * fact, which `docs/STATE.md` called "the one thing you must get right per
 * repo", and which we got wrong on the only repository we tried it on.
 *
 * So the planner reports what it found. It already does the work — it reads the
 * manifest, installs, and runs whatever the project has — and used to throw the
 * findings away.
 */
export const RepoSurveySchema = z.object({
  install: z
    .string()
    .max(500)
    .optional()
    .describe('How dependencies are installed, if this repository has any'),
  checks: z
    .array(SurveyCheckSchema)
    .max(10)
    .describe(
      'Every command this repository has for verifying itself. An empty list is a legitimate ' +
        'and useful answer: it says nobody can be told the change is safe by running something',
    ),
  readFiles: z
    .array(RepoPath)
    .max(50)
    .describe(
      'The files you read to work this out. They are hashed, so the survey can be re-derived ' +
        'when they change rather than going quietly stale',
    ),
});
export type RepoSurvey = z.infer<typeof RepoSurveySchema>;

/**
 * The gate a surveyed repository can actually hold itself to.
 *
 * Two conditions, and green is only the first. A check already failing cannot be
 * a gate — demanding green from a project whose lint has been red for a year
 * produces a gate nothing can ever pass, which is how a run loops to its cap on
 * something no edit could fix.
 *
 * The second condition was learned from a real survey. Pointed at a C# API, the
 * planner found three green checks and this function would have strung all
 * three together:
 *
 *   dotnet build … && dotnet test … && dotnet run --project … & curl localhost
 *
 * `dotnet test` was green and vacuous — the planner said so in as many words,
 * "exits 0 having discovered and run zero tests" — and the third starts a
 * server, needs configuration the repository deliberately does not contain, and
 * leaves a process behind; the `&` would have backgrounded everything before it
 * and curled a port nothing was listening on yet. All three facts were in the
 * survey as prose, which no amount of code can read. So the planner states
 * `usableAsGate` and this trusts it.
 *
 * An empty result is meaningful and must not be papered over: it says nothing
 * here can tell you the change is safe, so the reviewer's judgement is the only
 * check there is. The caller should say so out loud.
 */
export function gateFromSurvey(survey: RepoSurvey | undefined): readonly string[] {
  const usable = (survey?.checks ?? [])
    .filter((c) => c.greenOnBase && c.usableAsGate)
    .map((c) => c.command);
  return usable.length === 0 ? [] : ['sh', '-c', usable.join(' && ')];
}

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
  survey: RepoSurveySchema.describe(
    'How this repository builds and verifies itself, as you found it. Required: you ran these ' +
      'commands to understand the repository anyway, and nothing downstream can discover them ' +
      'for itself',
  ),
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
