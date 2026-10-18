/**
 * Verifying one change, for the eval harness.
 *
 * This is a thin wrapper over `reviewBranch` — the same function the real flow
 * calls — and that is the whole point of it. It used to be a parallel
 * implementation, and the two drifted: `reviewBranch` gained structured output
 * so a CLI-driven reviewer could return a verdict at all, and this did not. The
 * eval was measuring a path production had stopped using, and would have
 * reported every seeded fault as missed while the reviewer was working fine.
 *
 * A measurement that silently measures the wrong thing is worse than no
 * measurement, so there is now only one implementation and this adapts to it.
 */

import type { Pool } from 'pg';
import type { AcceptedVerdict, RoleDefinition } from '@shura/core';
import type { AgentRuntime, ChangeRequestRef, Vcs } from '@shura/ports';
import { PgAuditSink, PgEffectStore } from '@shura/db';
import { reviewBranch } from './build-flow.js';
import type { StreamEvent } from './stream.js';

export interface VerifyOptions {
  readonly pool: Pool;
  readonly repoDir: string;
  readonly checkCommand: readonly string[];
  /** Produces the diff and runs the checks. Any implementation of the port. */
  readonly vcs: Vcs;
  readonly ref: ChangeRequestRef;
  readonly workItem: { readonly id: string; readonly key: string; readonly criteria: readonly string[] };
  readonly verifier: { readonly runtime: AgentRuntime; readonly role: RoleDefinition; readonly name: string };
  // No taskId: reviewBranch creates and finishes its own verify task, so one
  // passed in here would be an orphan row and a parameter that lies.
  readonly attempt: number;
  readonly onEvent?: (e: StreamEvent) => void;
}

export interface VerifyResult {
  readonly verdict?: AcceptedVerdict;
  readonly checksPassed: boolean;
  readonly spend: { readonly tokensIn: number; readonly tokensOut: number; readonly usd: number };
  readonly error?: string;
}

export async function verifyChange(o: VerifyOptions): Promise<VerifyResult> {
  const emit = o.onEvent ?? ((): void => {});
  const diff = await o.vcs.getDiff(o.ref);
  const checks = await o.vcs.runChecks(o.ref);

  const review = await reviewBranch({
    pool: o.pool,
    repoDir: o.repoDir,
    checkCommand: o.checkCommand,
    reviewer: o.verifier,
    // A review needs something to judge against, not a plans row. The harness
    // seeds faults into a fixture rather than planning them, so this is the
    // context that work would have had.
    plan: {
      workItemId: o.workItem.id,
      workItemKey: o.workItem.key,
      title: o.workItem.key,
      understanding: 'A change to an existing repository, under review.',
      approach: 'Judge the diff against the acceptance criteria.',
      files: [],
      outOfScope: [],
    },
    attempt: o.attempt,
    branch: o.ref.branch,
    criteria: o.workItem.criteria,
    diff: diff.text,
    checks,
    audit: new PgAuditSink(o.pool),
    effects: new PgEffectStore(o.pool),
    emit,
  });

  return {
    ...(review.verdict === undefined ? {} : { verdict: review.verdict }),
    checksPassed: checks.ok,
    // reviewBranch reports what the run cost; the token split is not something
    // the harness divides by, so the dollar figure is what is carried through.
    spend: { tokensIn: 0, tokensOut: 0, usd: review.usd },
    ...(review.error === undefined ? {} : { error: review.error }),
  };
}
