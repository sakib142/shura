/**
 * The seam between the web surface and the agents.
 *
 * The server is transport: it parses requests, checks they came from its own
 * page, and renders. It knows nothing about vendors, roles, budgets or git —
 * those arrive as a `JobRunner` built by whoever started it.
 *
 * That split is why `apps/api` still depends only on the database driver. It
 * also keeps `shura watch` what it was: start the server without a runner and
 * every mutating route refuses, so the read-only dashboard cannot be turned
 * into a spending one by a stray request.
 */

/** What a run will cost at most, shown before anything is clicked. */
export interface CostEstimate {
  /** "anthropic/claude-sonnet-5", for the page to name who is being called. */
  readonly planner: string;
  readonly builder: string;
  readonly reviewer: string;
  /** Ceilings, not forecasts. The run stops at these. */
  readonly planUsd: number;
  readonly buildUsd: number;
  readonly loopCap: number;
}

export type JobPhase = 'idle' | 'planning' | 'building';

export interface JobState {
  readonly phase: JobPhase;
  readonly workItemKey?: string;
  readonly repo?: string;
  readonly startedAt?: string;
  /** Set when the last job ended badly, and cleared when the next one starts. */
  readonly lastError?: string;
  /** Where the last finished build landed. */
  readonly lastPullRequest?: string;
}

export type JobResult =
  | { readonly ok: true; readonly planId?: string; readonly url?: string }
  | { readonly ok: false; readonly error: string };

/**
 * One job at a time, deliberately.
 *
 * Two agents on one branch is the collision the claims table exists to refuse,
 * and refusing it here as well means the user gets a sentence rather than a
 * claim error from inside a run they did not know had started.
 */
export interface JobRunner {
  estimate(): CostEstimate;
  state(): JobState;
  /** Reads the repo and submits a plan. Returns once the plan is recorded. */
  plan(input: { repo: string; task: string }): Promise<JobResult>;
  /** Carries out an approved plan: build, review, pull request. */
  build(planId: string): Promise<JobResult>;
}
