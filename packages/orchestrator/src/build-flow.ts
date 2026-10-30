/**
 * An approved plan, carried out.
 *
 * Build on a branch, prove the build is green, publish, review it with a
 * different vendor's model, let the reviewer correct what it found or send it
 * back, open a pull request, and stop. A human merges.
 *
 * Three things here are deliberate and worth stating, because each is a place
 * the obvious implementation would have been wrong.
 *
 * **Nothing is published until the checks pass.** The builder runs them in its
 * own worktree and a failing run goes back to the builder with the output
 * attached, rather than onward to a reviewer. Reviewing a branch whose build is
 * broken spends a second model on a question the first one could have answered.
 *
 * **A reviewer that fixes does so in a separate task.** Rule 2 says a verifier
 * holds no write grant, and that is enforced unchanged — the verify task really
 * cannot write. When the reviewer asks to fix, a produce-kind task is created
 * under the same agent's identity with the grants its role's `fix` block
 * declares. The audit shows a verify task that judged and a produce task that
 * wrote, and no single task ever did both.
 *
 * **The final state says who verified the final content.** A branch the
 * reviewer passed ends in `awaiting_admission`: an agent verified it, a human
 * merges it. A branch the reviewer fixed ends in `awaiting_verification`,
 * because no agent has verified what is now on it — the human reading the pull
 * request is the verifier. That distinction is the cost of letting the reviewer
 * fix, and it is recorded rather than glossed.
 */

import type { Pool } from 'pg';
import {
  VerdictInputSchema,
  acceptVerdict,
  afterVerdict,
  asJsonSchema,
  fixRoleOf,
  selectVerifier,
  transition,
  type AcceptedVerdict,
  type ActorIdentity,
  type ArtifactState,
  type Decision,
  type RoleDefinition,
  type ToolName,
  type VerifierCandidate,
} from '@shura/core';
import type {
  AgentRuntime,
  ChangeRequestRef,
  Tracker,
  TrackerState,
  Vcs,
} from '@shura/ports';
import { agentIdentity } from '@shura/git';
import { Worktree } from '@shura/sandbox';
import { PgAuditSink, PgClaims, PgEffectStore, PgPlans, type StoredPlan } from '@shura/db';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@shura/tool-gateway';
import { fixerHandlers, producerHandlers, verifierHandlers } from './handlers.js';
import { drive, limitsOf, modelOf } from './drive.js';
import { recorder, type StreamEvent } from './stream.js';

/** What GitHub can do beyond the port, when the run is on GitHub. */
export interface PullRequestSurface {
  postVerdict?(ref: ChangeRequestRef, body: string, approved: boolean): Promise<void>;
  urlOf?(ref: ChangeRequestRef): Promise<string>;
}

export interface BuildRequest {
  readonly pool: Pool;
  readonly repoDir: string;
  readonly checkCommand: readonly string[];
  readonly plan: StoredPlan;
  readonly builder: { readonly runtime: AgentRuntime; readonly role: RoleDefinition; readonly name: string };
  readonly reviewer: { readonly runtime: AgentRuntime; readonly role: RoleDefinition; readonly name: string };
  readonly vcs: Vcs & { readonly base?: string } & PullRequestSurface;
  readonly loopCap?: number;
  /**
   * Stop once the branch is published, before any review.
   *
   * For testing one agent at a time. A builder that is working and a reviewer
   * that is working are two findings; a flow that failed somewhere in the
   * middle is none, and that is what the first run against a real repository
   * gave us.
   */
  readonly stopAfter?: 'push';
  readonly tracker?: Tracker;
  readonly onEvent?: (e: StreamEvent) => void;
}

export interface BuildOutcome {
  readonly state: ArtifactState;
  readonly attempts: number;
  readonly branch: string;
  readonly changeRequest?: { readonly id: string; readonly url?: string };
  readonly decision?: Decision;
  /** True when part of what is on the branch was written by the reviewer. */
  readonly reviewerFixed: boolean;
  readonly reason?: string;
  readonly usd: number;
}

export async function buildApprovedPlan(req: BuildRequest): Promise<BuildOutcome> {
  const plan = req.plan;
  const emit = recorder(req.pool, plan.workItemKey, req.onEvent ?? (() => {}));
  const cap = req.loopCap ?? 3;
  const base = req.vcs.base ?? 'main';
  const branch = `shura/${plan.workItemKey.toLowerCase()}`;

  const plans = new PgPlans(req.pool);
  const audit = new PgAuditSink(req.pool);
  const effects = new PgEffectStore(req.pool);
  const claims = new PgClaims(req.pool);

  const criteria = plan.criteria;
  const approvedPlan = {
    understanding: plan.understanding,
    approach: plan.approach,
    files: plan.files,
    outOfScope: plan.outOfScope,
    ...(plan.openQuestions.length === 0
      ? {}
      : {
          answeredQuestions: plan.openQuestions
            .map((question, i) => ({ question, answer: plan.answers[i] ?? '' }))
            .filter((q) => q.answer.trim() !== ''),
        }),
  };

  const note = async (body: string): Promise<void> => {
    if (req.tracker === undefined) return;
    try {
      await req.tracker.comment(plan.workItemKey, body);
    } catch (err) {
      emit({ kind: 'note', text: `tracker comment failed: ${(err as Error).message}` });
    }
  };
  const move = async (to: TrackerState): Promise<void> => {
    if (req.tracker === undefined) return;
    try {
      const ok = await req.tracker.transition(plan.workItemKey, to);
      emit({
        kind: 'note',
        text: ok ? `tracker -> ${to}` : `tracker has no transition to ${to}; left as is`,
      });
    } catch (err) {
      emit({ kind: 'note', text: `tracker transition failed: ${(err as Error).message}` });
    }
  };

  const builderActor: ActorIdentity = {
    agentId: req.builder.name,
    role: req.builder.role.id,
    kind: 'produce',
    ...(req.builder.runtime.vendor === undefined ? {} : { vendor: req.builder.runtime.vendor }),
    ...(req.builder.role.model === undefined ? {} : { model: req.builder.role.model.model }),
  };
  const reviewerCandidate: VerifierCandidate = {
    agentId: req.reviewer.name,
    role: req.reviewer.role.id,
    kind: 'verify',
    vendor: req.reviewer.runtime.vendor,
    ...(req.reviewer.role.model === undefined ? {} : { model: req.reviewer.role.model.model }),
    grants: req.reviewer.role.tools as ToolName[],
  };
  // The grants a fixing reviewer would hold, resolved now rather than when the
  // verdict asks for them: a role whose fix block is unsafe must fail before
  // anything is spent, not halfway through a review.
  const fixRole = fixRoleOf(req.reviewer.role);

  let state: ArtifactState = 'draft';
  let usd = 0;
  let priorFindings: unknown[] = [];
  let buildFailure: string | undefined;
  let reviewerFixed = false;

  await plans.building(plan.id, branch);
  await move('in_progress');

  for (let attempt = 1; attempt <= cap; attempt++) {
    /* ------------------------------------------------------------- build */
    state = attempt === 1 ? transition(state, 'start_production') : transition(state, 'rework_start');
    emit({
      kind: 'phase',
      state,
      detail: `${req.builder.name}  attempt ${attempt}/${cap}  (${builderActor.vendor}/${modelOf(req.builder.role)})`,
    });

    const buildTaskId = await createTask(req.pool, plan.workItemId, 'produce', req.builder.role.id, attempt);
    const claimed = await claims.acquire({
      agentId: req.builder.name,
      taskId: buildTaskId,
      branch,
      fileGlobs: [],
    });
    if (!claimed.granted) {
      emit({ kind: 'note', text: `cannot start: ${claimed.reason} (held by ${claimed.heldBy})` });
      return { state, attempts: attempt, branch, reviewerFixed, reason: claimed.reason, usd };
    }
    const beat = setInterval(() => {
      void claims.heartbeat(claimed.claimId).catch(() => {});
    }, 60_000);

    await req.vcs.createBranch(base, branch);

    const wt = await Worktree.create({
      repoDir: req.repoDir,
      branch,
      taskId: buildTaskId,
      identity: agentIdentity(req.builder.name, req.builder.role.id, modelOf(req.builder.role)),
      claimedBranches: [branch],
    });

    let checks: { ok: boolean; summary: string; output: string };
    try {
      const gateway = new McpToolGateway({
        handlers: producerHandlers({
          worktree: wt,
          pool: req.pool,
          workItemId: plan.workItemId,
          workItemKey: plan.workItemKey,
          checkCommand: req.checkCommand,
          criterionCount: criteria.length,
          onComment: (body) => emit({ kind: 'note', text: `${req.builder.name}: ${body}` }),
          claims: {
            claim: async (_claimBranch, fileGlobs) => {
              const r = await claims.acquire({
                agentId: req.builder.name,
                taskId: buildTaskId,
                branch,
                fileGlobs,
              });
              return r.granted
                ? { ok: true as const, expiresAt: r.expiresAt }
                : { ok: false as const, reason: `${r.reason}; held by ${r.heldBy}` };
            },
          },
        }) as Map<ToolName, ToolHandler>,
        audit,
        effects,
        grantsFor: () => resolveGrants(req.builder.role),
      });

      const ran = await drive(req.builder.runtime, {
        role: req.builder.role,
        context: {
          workItemKey: plan.workItemKey,
          title: plan.title,
          artifactType: 'code_change',
          acceptanceCriteria: criteria,
          plan: approvedPlan,
          attempt,
          ...(priorFindings.length === 0 ? {} : { priorFindings }),
          ...(buildFailure === undefined ? {} : { buildFailure }),
        },
        tools: req.builder.role.tools,
        limits: limitsOf(req.builder.role),
        workdir: wt.dir,
        taskId: buildTaskId,
        agentId: req.builder.name,
        kind: 'produce',
        gateway,
        emit: (e) => emit({ kind: 'agent', actor: req.builder.name, event: e }),
      });
      usd += ran.usd;

      // An agent that stopped badly has not finished, and its half-written
      // change must not be published as though it had.
      //
      // This is not hypothetical: a builder hit its spend ceiling partway
      // through, the checks passed anyway — half a change often does — and a
      // branch carrying one test file and nothing else was pushed as complete
      // work. Green checks say "nothing is broken", never "the work is done".
      if (ran.error !== undefined) {
        await finishTask(req.pool, buildTaskId, 'failed');
        emit({ kind: 'note', text: `${req.builder.name} stopped: ${ran.error}` });
        emit({ kind: 'note', text: 'not publishing a part-written change' });
        state = transition(state, 'human_requested');
        await note(
          `${req.builder.name} stopped before finishing: ${ran.error}\n` +
            'Nothing was published. The branch is untouched.' +
            (ran.error.includes('ceiling')
              ? '\n\nRaise `budgets.per_task_usd` in shura.config.yaml, or narrow the request ' +
                'so there is less to read.'
              : ''),
        );
        return {
          state,
          attempts: attempt,
          branch,
          reviewerFixed,
          reason: ran.error,
          usd,
        };
      }

      // The gate the user asked for: the build is proved green in the same
      // worktree the code was written in, before anything leaves it. The
      // builder is told to run the checks itself, but being told is not the
      // same as having done it, so this runs regardless.
      emit({ kind: 'note', text: 'verifying the build before publishing' });
      checks = await runChecks(wt, req.checkCommand);
      emit({ kind: 'note', text: checks.summary });

      if (!checks.ok) {
        buildFailure = checks.output;
        priorFindings = [];
        await finishTask(req.pool, buildTaskId, 'failed');
        emit({
          kind: 'note',
          text: `not publishing: ${checks.summary}. Sending it back to ${req.builder.name}.`,
        });
        continue;
      }

      const dirty = await wt.git.tryRun('status', '--porcelain');
      if (dirty.stdout.trim() === '') {
        const onBranch = whatAnEmptyWorktreeMeans(
          await wt.git.tryRun('rev-list', '--count', `${base}..HEAD`),
        );

        if (onBranch.send === 'human') {
          await finishTask(req.pool, buildTaskId, 'failed');
          emit({ kind: 'note', text: 'the builder changed nothing, and the branch is empty' });
          state = transition(state, 'human_requested');
          return {
            state,
            attempts: attempt,
            branch,
            reviewerFixed,
            reason: 'the builder changed nothing',
            usd,
          };
        }

        await finishTask(req.pool, buildTaskId, 'succeeded');
        emit({
          kind: 'note',
          text:
            `${req.builder.name} wrote nothing this attempt, but ${branch} is ` +
            `${onBranch.ahead} commit(s) ahead of ${base} and the checks pass — ` +
            'reviewing what is on it',
        });
      } else {
        const discarded = await stageWork(wt);
        if (discarded.length > 0) {
          emit({
            kind: 'note',
            text: `left ${discarded.join(', ')} as it was — the checks rewrote it, the agent did not`,
          });
        }
        await wt.git.run('commit', '-q', '-m', commitMessage(plan, attempt));
        await finishTask(req.pool, buildTaskId, 'succeeded');
      }
    } finally {
      clearInterval(beat);
      await wt.destroy();
      await claims.release(claimed.claimId);
    }

    buildFailure = undefined;
    await req.vcs.publishBranch(branch);
    emit({ kind: 'note', text: `published ${branch}` });

    if (req.stopAfter === 'push') {
      state = transition(state, 'production_complete');
      emit({
        kind: 'phase',
        state,
        detail: `stopping after the push, as asked — nothing has reviewed ${branch}`,
      });
      return { state, attempts: attempt, branch, reviewerFixed, usd };
    }

    const changed = await req.vcs.getDiff({ id: 'probe', branch, base });
    state = transition(state, 'production_complete');
    emit({
      kind: 'phase',
      state,
      detail: `${changed.files.length} file(s) changed · ${checks.summary}`,
    });
    await note(
      `${req.builder.name} (${req.builder.role.id}) pushed ${branch}\n` +
        `${changed.files.length} file(s) changed · ${checks.summary}\n` +
        `attempt ${attempt} of ${cap}; the build was verified before publishing.`,
    );
    await move('in_review');

    /* ------------------------------------------------------------ review */
    // The one place a verify task is created, so rule 1 cannot be bypassed.
    const chosen = selectVerifier(builderActor, [reviewerCandidate]);
    state = transition(state, 'verifier_scheduled');
    emit({
      kind: 'phase',
      state,
      detail: `${chosen.agentId}  (vendor ${chosen.vendor} != ${builderActor.vendor})`,
    });

    const review = await reviewBranch({
      pool: req.pool,
      repoDir: req.repoDir,
      checkCommand: req.checkCommand,
      reviewer: req.reviewer,
      plan,
      attempt,
      branch,
      criteria,
      diff: changed.text,
      checks,
      audit,
      effects,
      emit,
    });
    usd += review.usd;

    if (review.verdict === undefined) {
      // Say why. "No verdict" and "ran out of money before reaching one" are
      // different problems with different fixes, and the branch is already
      // pushed either way — a human has to decide what to do with it.
      const why = review.error ?? 'it finished without submitting one';
      emit({ kind: 'note', text: `no verdict from ${req.reviewer.name}: ${why}` });
      state = transition(state, 'verdict_blocked');
      await note(
        `${req.reviewer.name} reached no verdict on ${branch}: ${why}\n` +
          'The branch is pushed and the build is green, but no agent has judged it. ' +
          'No pull request was opened.',
      );
      await move('blocked');
      return { state, attempts: attempt, branch, reviewerFixed, reason: `no verdict: ${why}`, usd };
    }

    const v = review.verdict;
    await recordVerdict(req.pool, review.taskId, v, builderActor, chosen);
    emit({
      kind: 'verdict',
      decision: v.decision,
      detail: v.overridden ? `overridden — ${v.reason}` : summarise(v),
    });
    await note(
      `${chosen.agentId} (${req.reviewer.role.id}, ${chosen.vendor}/${chosen.model}) reviewed ${branch}.\n` +
        `Verdict: ${v.decision}${v.overridden ? ` (rewritten from its own findings — ${v.reason})` : ''}\n` +
        describeFindings(v),
    );

    if (v.decision === 'PASS') {
      state = transition(state, 'verdict_pass');
      const opened = await openPullRequest({
        req,
        branch,
        base,
        plan,
        verdict: v,
        reviewer: chosen,
        checks,
        reviewerFixed,
        emit,
      });
      await move('in_review');
      return {
        state,
        attempts: attempt,
        branch,
        reviewerFixed,
        decision: v.decision,
        ...(opened === undefined ? {} : { changeRequest: opened }),
        usd,
      };
    }

    const next = afterVerdict(v.decision, attempt, cap);
    state = next.next;

    if (v.decision === 'BLOCKED') {
      // A draft pull request, not a bare branch. The work needs a person, and a
      // person needs somewhere to read the diff beside the reason it stopped —
      // which a branch name in a terminal that has already scrolled away is
      // not. A draft cannot be merged until someone marks it ready, so nothing
      // is admitted on an agent's word by opening one.
      const parked = await openPullRequest({
        req,
        branch,
        base,
        plan,
        verdict: v,
        reviewer: chosen,
        checks,
        reviewerFixed,
        draft: true,
        emit,
      });
      await note(
        `The reviewer could not reach a verdict: ${v.submission.blockedReason ?? 'no reason given'}\n` +
          'A human is needed. The branch is pushed and a draft pull request is open for it.',
      );
      await move('blocked');
      return {
        state,
        attempts: attempt,
        branch,
        reviewerFixed,
        decision: v.decision,
        reason: v.submission.blockedReason ?? 'blocked',
        ...(parked === undefined ? {} : { changeRequest: parked }),
        usd,
      };
    }

    /* --------------------------------------------------------------- fix */
    const wantsFix = v.submission.action === 'fix';
    if (wantsFix && fixRole === undefined) {
      emit({
        kind: 'note',
        text:
          `${chosen.agentId} asked to fix it, but role "${req.reviewer.role.id}" declares no ` +
          'fix capability. Sending it back to the builder instead.',
      });
    }

    if (wantsFix && fixRole !== undefined) {
      // A produce task, under the reviewer's identity, with the reviewer's fix
      // grants. The verify task that just ran held no write and still does not.
      state = transition(state, 'rework_start');
      emit({
        kind: 'phase',
        state,
        detail: `${chosen.agentId} fixing its own findings  (produce task, ${fixRole.tools.join(', ')})`,
      });

      const fixed = await applyReviewerFix({
        req,
        fixRole,
        attempt,
        branch,
        criteria,
        verdict: v,
        approvedPlan,
        claims,
        audit,
        effects,
        emit,
      });
      usd += fixed.usd;

      if (fixed.ok) {
        reviewerFixed = true;
        await req.vcs.publishBranch(branch);
        state = transition(state, 'production_complete');
        emit({
          kind: 'note',
          text: `${chosen.agentId} fixed it and the build is green; no agent has reviewed the fix`,
        });
        await note(
          `${chosen.agentId} corrected its own findings on ${branch} and the build is green.\n` +
            'Those commits were written by the reviewer, so no agent reviewed them. ' +
            'The pull request names them.',
        );
        const opened = await openPullRequest({
          req,
          branch,
          base,
          plan,
          verdict: v,
          reviewer: chosen,
          checks: fixed.checks,
          reviewerFixed: true,
          ...(fixed.summary === undefined ? {} : { fixSummary: fixed.summary }),
          emit,
        });
        return {
          state,
          attempts: attempt,
          branch,
          reviewerFixed,
          decision: v.decision,
          ...(opened === undefined ? {} : { changeRequest: opened }),
          usd,
        };
      }

      emit({
        kind: 'note',
        text: `the fix did not hold: ${fixed.reason}. Sending it back to ${req.builder.name}.`,
      });
      if (fixed.checkOutput !== undefined) buildFailure = fixed.checkOutput;
      // Back to where the verdict left it, so the builder reworks it — which is
      // what "or assign back" means when the reviewer's own attempt fails. The
      // decision is recomputed rather than assigned, because on the last attempt
      // this is an escalation and the branch below has to see that.
      state = afterVerdict(v.decision, attempt, cap).next;
    }

    if (state === 'escalated') {
      // Same reasoning as BLOCKED: give up on the loop, not on the human. The
      // branch is green and pushed and carries real work that simply did not
      // satisfy every criterion; a draft pull request puts that work, the
      // verdict and the unmet criteria where someone can act on them.
      const parked = await openPullRequest({
        req,
        branch,
        base,
        plan,
        verdict: v,
        reviewer: chosen,
        checks,
        reviewerFixed,
        draft: true,
        emit,
      });
      await note(
        `Escalated: ${cap} attempt(s) without a passing verdict. A human is needed.\n` +
          `The branch ${branch} is pushed and a draft pull request is open for it.`,
      );
      await move('blocked');
      return {
        state,
        attempts: attempt,
        branch,
        reviewerFixed,
        decision: v.decision,
        reason: `loop cap reached at attempt ${attempt}`,
        ...(parked === undefined ? {} : { changeRequest: parked }),
        usd,
      };
    }

    priorFindings = [
      ...v.submission.criteria.filter((c) => c.status === 'not_met'),
      ...v.submission.extraFindings.map((f) => ({ index: -1, status: 'not_met', finding: f })),
    ];
  }

  return {
    state: 'escalated',
    attempts: cap,
    branch,
    reviewerFixed,
    reason: `loop cap of ${cap} reached`,
    usd,
  };
}

/* -------------------------------------------------------------------- review */

/** What the reviewer is judging against, however it was produced. */
export interface ReviewContext {
  readonly workItemId: string;
  readonly workItemKey: string;
  readonly title: string;
  readonly understanding: string;
  readonly approach: string;
  readonly files: readonly { readonly path: string; readonly reason: string }[];
  readonly outOfScope: readonly string[];
}

/**
 * Everything a review needs, and nothing it does not.
 *
 * Flat rather than a whole `BuildRequest`, which dragged in a builder and a
 * VCS this never touches and made the step impossible to run on its own. It
 * takes the diff and the check results as data, so the branch can come from
 * anywhere — a build that just ran, a previous run, or a human.
 *
 * It needs no `plans` row either: `plan` here is an in-memory struct that is
 * only read.
 */
export interface ReviewArgs {
  readonly pool: Pool;
  readonly repoDir: string;
  readonly checkCommand: readonly string[];
  readonly reviewer: {
    readonly runtime: AgentRuntime;
    readonly role: RoleDefinition;
    readonly name: string;
  };
  readonly plan: ReviewContext;
  readonly attempt: number;
  readonly branch: string;
  readonly criteria: readonly string[];
  readonly diff: string;
  readonly checks: { readonly ok: boolean; readonly summary: string; readonly output: string };
  readonly audit: PgAuditSink;
  readonly effects: PgEffectStore;
  /** The recording emit, not onEvent: these events are persisted too. */
  readonly emit: (e: StreamEvent) => void;
}

export async function reviewBranch(
  a: ReviewArgs,
): Promise<{ verdict?: AcceptedVerdict; taskId: string; usd: number; error?: string }> {
  const req = a;
  const taskId = await createTask(
    req.pool,
    a.plan.workItemId,
    'verify',
    req.reviewer.role.id,
    a.attempt,
  );

  // No identity and nothing claimed: this worktree cannot commit as anyone and
  // cannot push at all, which is the shape of a task that only reads.
  const wt = await Worktree.create({
    repoDir: req.repoDir,
    branch: a.branch,
    taskId,
    claimedBranches: [],
    // Reading only, like the planner — and a reviewer that held the branch
    // would block the builder's own rework of it.
    detached: true,
  });

  let verdict: AcceptedVerdict | undefined;
  let spend = { tokensIn: 0, tokensOut: 0, usd: 0 };
  let usd = 0;
  let error: string | undefined;

  try {
    const gateway = new McpToolGateway({
      handlers: verifierHandlers({
        worktree: wt,
        pool: req.pool,
        workItemId: a.plan.workItemId,
        workItemKey: a.plan.workItemKey,
        checkCommand: req.checkCommand,
        criterionCount: a.criteria.length,
        onVerdict: (v) => {
          verdict = v;
        },
        verifier: {
          agent: req.reviewer.name,
          vendor: req.reviewer.runtime.vendor,
          model: modelOf(req.reviewer.role),
          spent: () => spend,
        },
      }) as Map<ToolName, ToolHandler>,
      audit: a.audit,
      effects: a.effects,
      grantsFor: () => resolveGrants(req.reviewer.role),
    });

    const ran = await drive(req.reviewer.runtime, {
      role: req.reviewer.role,
      context: {
        workItemKey: a.plan.workItemKey,
        title: a.plan.title,
        artifactType: 'code_change',
        acceptanceCriteria: a.criteria,
        attempt: a.attempt,
        diff: a.diff,
        checkResults: { ok: a.checks.ok, summary: a.checks.summary, output: a.checks.output },
        // The reviewer sees the plan so it can catch work the plan said was out
        // of scope. It does not see the original request: the criteria are the
        // standard, and a reviewer with two standards has none.
        plan: {
          understanding: a.plan.understanding,
          approach: a.plan.approach,
          files: a.plan.files,
          outOfScope: a.plan.outOfScope,
        },
      },
      tools: req.reviewer.role.tools,
      limits: limitsOf(req.reviewer.role),
      workdir: wt.dir,
      // A CLI-driven reviewer cannot call verdict.submit; its final answer
      // carries the verdict, and acceptVerdict still recomputes the decision
      // from the findings rather than trusting what it claims.
      outputSchema: asJsonSchema(VerdictInputSchema),
      taskId,
      agentId: req.reviewer.name,
      kind: 'verify',
      gateway,
      emit: (e) => {
        if (e.t === 'usage') {
          spend = {
            tokensIn: spend.tokensIn + e.tokensIn,
            tokensOut: spend.tokensOut + e.tokensOut,
            usd: e.usd,
          };
        }
        a.emit({ kind: 'agent', actor: req.reviewer.name, event: e });
      },
    });
    usd = ran.usd;
    error = ran.error;

    if (verdict === undefined && ran.output !== undefined) {
      try {
        verdict = acceptVerdict(
          {
            ...(ran.output as Record<string, unknown>),
            verifier: {
              agent: req.reviewer.name,
              vendor: req.reviewer.runtime.vendor,
              model: modelOf(req.reviewer.role),
            },
            cost: spend,
          },
          a.criteria.length,
        );
      } catch (err) {
        // Returned rather than swallowed: a malformed verdict is not a passing
        // one, and the reason belongs in the log a human will read.
        error = `the verdict was rejected: ${(err as Error).message}`;
      }
    }
  } finally {
    await wt.destroy();
  }

  await finishTask(req.pool, taskId, verdict === undefined ? 'failed' : 'succeeded');
  return {
    ...(verdict === undefined ? {} : { verdict }),
    taskId,
    usd,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * An empty worktree, read correctly.
 *
 * A clean worktree means the builder wrote nothing *this attempt*. That is a
 * failure only if the branch has nothing on it either. When the branch is
 * already ahead of the base the work exists — put there by an earlier run of
 * this plan, or by the attempt before this one — and a builder writing nothing
 * is a builder agreeing there is nothing left to write.
 *
 * Collapsing those two cost a whole run. A re-run of a plan whose branch
 * already carried the change was reported as "the builder changed nothing" and
 * escalated to a human on attempt 1 — with a complete, green, pushed branch
 * sitting there that no reviewer had ever looked at. Sending it on costs one
 * review and settles it. Stopping costs a person, which is the thing this flow
 * exists to avoid spending.
 *
 * A `rev-list` that failed is read as "nothing on the branch" rather than
 * guessed at: publishing a branch we could not count is how an empty branch
 * reaches a reviewer and wastes its pass.
 */
export function whatAnEmptyWorktreeMeans(
  counted: { readonly ok: boolean; readonly stdout: string },
): { readonly send: 'review'; readonly ahead: number } | { readonly send: 'human' } {
  if (!counted.ok) return { send: 'human' };
  const ahead = Number.parseInt(counted.stdout.trim(), 10);
  if (!Number.isFinite(ahead) || ahead <= 0) return { send: 'human' };
  return { send: 'review', ahead };
}

/* ----------------------------------------------------------------------- fix */

interface FixArgs {
  req: BuildRequest;
  fixRole: RoleDefinition;
  attempt: number;
  branch: string;
  criteria: readonly string[];
  verdict: AcceptedVerdict;
  approvedPlan: NonNullable<Parameters<typeof drive>[1]['context']['plan']>;
  claims: PgClaims;
  audit: PgAuditSink;
  effects: PgEffectStore;
  emit: (e: StreamEvent) => void;
}

type FixResult =
  | {
      ok: true;
      usd: number;
      checks: { ok: boolean; summary: string; output: string };
      summary?: string;
    }
  | { ok: false; usd: number; reason: string; checkOutput?: string };

/**
 * The reviewer correcting what it found, as a produce task.
 *
 * Same agent, same model, different task kind, different grants. The grants
 * come from the role's `fix` block and include no verdict tool: the judgment
 * was recorded by the verify task that ran before this one, and a task that
 * writes the code does not also get to record the verdict on it.
 */
async function applyReviewerFix(a: FixArgs): Promise<FixResult> {
  const { req } = a;
  const taskId = await createTask(
    req.pool,
    req.plan.workItemId,
    'produce',
    a.fixRole.id,
    a.attempt,
  );

  const claimed = await a.claims.acquire({
    agentId: req.reviewer.name,
    taskId,
    branch: a.branch,
    fileGlobs: [],
  });
  if (!claimed.granted) {
    await finishTask(req.pool, taskId, 'failed');
    return { ok: false, usd: 0, reason: `could not claim ${a.branch}: ${claimed.reason}` };
  }
  const beat = setInterval(() => {
    void a.claims.heartbeat(claimed.claimId).catch(() => {});
  }, 60_000);

  // The reviewer's own git identity, so the pull request's commit list shows
  // which commits an agent reviewed and which one wrote itself.
  const wt = await Worktree.create({
    repoDir: req.repoDir,
    branch: a.branch,
    taskId,
    identity: agentIdentity(req.reviewer.name, req.reviewer.role.id, modelOf(req.reviewer.role)),
    claimedBranches: [a.branch],
  });

  let usd = 0;
  let summary: string | undefined;

  try {
    const gateway = new McpToolGateway({
      handlers: fixerHandlers({
        worktree: wt,
        pool: req.pool,
        workItemId: req.plan.workItemId,
        workItemKey: req.plan.workItemKey,
        checkCommand: req.checkCommand,
        criterionCount: a.criteria.length,
      }) as Map<ToolName, ToolHandler>,
      audit: a.audit,
      effects: a.effects,
      grantsFor: () => resolveGrants(a.fixRole),
    });

    const ran = await drive(req.reviewer.runtime, {
      role: a.fixRole,
      context: {
        workItemKey: req.plan.workItemKey,
        title: req.plan.title,
        artifactType: 'code_change',
        acceptanceCriteria: a.criteria,
        plan: a.approvedPlan,
        attempt: a.attempt,
        // Its own findings, which are the entire scope of this task.
        priorFindings: [
          ...a.verdict.submission.criteria.filter((c) => c.status === 'not_met'),
          ...a.verdict.submission.extraFindings.map((f) => ({
            index: -1,
            status: 'not_met',
            finding: f,
          })),
        ],
      },
      tools: a.fixRole.tools,
      limits: limitsOf(a.fixRole),
      workdir: wt.dir,
      taskId,
      agentId: req.reviewer.name,
      kind: 'produce',
      gateway,
      emit: (e) => a.emit({ kind: 'agent', actor: `${req.reviewer.name}:fix`, event: e }),
    });
    usd = ran.usd;
    summary = ran.finalText;

    if (ran.error !== undefined) {
      // Same rule as the builder: stopped is not finished. Leave the branch as
      // the builder left it rather than committing a half-applied fix.
      await wt.git.tryRun('reset', '--hard', 'HEAD');
      await finishTask(req.pool, taskId, 'failed');
      return { ok: false, usd, reason: `the reviewer stopped while fixing: ${ran.error}` };
    }

    const dirty = await wt.git.tryRun('status', '--porcelain');
    if (dirty.stdout.trim() === '') {
      await finishTask(req.pool, taskId, 'failed');
      return { ok: false, usd, reason: 'the reviewer changed nothing' };
    }

    const checks = await runChecks(wt, req.checkCommand);
    if (!checks.ok) {
      // Not published. A reviewer that broke the build while fixing it has made
      // things worse, and the branch should not carry that to a human.
      await wt.git.tryRun('reset', '--hard', 'HEAD');
      await finishTask(req.pool, taskId, 'failed');
      return {
        ok: false,
        usd,
        reason: `the reviewer's fix left the build failing (${checks.summary})`,
        checkOutput: checks.output,
      };
    }

    const discarded = await stageWork(wt);
    if (discarded.length > 0) {
      a.emit({
        kind: 'note',
        text: `left ${discarded.join(', ')} as it was — the checks rewrote it, the reviewer did not`,
      });
    }
    await wt.git.run(
      'commit',
      '-q',
      '-m',
      `${req.plan.workItemKey}: reviewer fixes\n\n` +
        `Written by ${req.reviewer.name} (${req.reviewer.role.id}) after its own review.\n` +
        'No agent reviewed these changes.',
    );
    await finishTask(req.pool, taskId, 'succeeded');
    return { ok: true, usd, checks, ...(summary === undefined ? {} : { summary }) };
  } finally {
    clearInterval(beat);
    await wt.destroy();
    await a.claims.release(claimed.claimId);
  }
}

/* ---------------------------------------------------------------- pull request */

interface OpenArgs {
  req: BuildRequest;
  branch: string;
  base: string;
  plan: StoredPlan;
  verdict: AcceptedVerdict;
  reviewer: ActorIdentity;
  checks: { ok: boolean; summary: string; output: string };
  reviewerFixed: boolean;
  fixSummary?: string;
  /**
   * Open it as a draft, for work a person has to take over.
   *
   * Set when the loop stops without a passing verdict. The plan is recorded as
   * parked rather than built, because the work did not reach the standard the
   * plan set and a row claiming otherwise would hide every escalation.
   */
  draft?: boolean;
  /** The recording emit, so the pull request lands in the event log too. */
  emit: (e: StreamEvent) => void;
}

async function openPullRequest(
  a: OpenArgs,
): Promise<{ id: string; url?: string } | undefined> {
  const { req } = a;
  try {
    const ref = await req.vcs.openChangeRequest({
      branch: a.branch,
      base: a.base,
      title: `${a.draft === true ? '[needs a human] ' : ''}${a.plan.workItemKey}: ${a.plan.title}`,
      body: pullRequestBody(a),
      author: req.builder.name,
      workItemId: a.plan.workItemId,
      ...(a.draft === true ? { draft: true } : {}),
    });

    // The verdict goes on the pull request too, as a comment and never as an
    // approval: a GitHub approval would carry the token owner's identity, and
    // an agent must not appear to have approved anything as a human.
    if (req.vcs.postVerdict !== undefined) {
      await req.vcs.postVerdict(ref, verdictComment(a), false);
    }
    const url = req.vcs.urlOf === undefined ? undefined : await req.vcs.urlOf(ref);

    const plans = new PgPlans(req.pool);
    await (a.draft === true
      ? plans.parked(a.plan.id, a.branch, ref.id)
      : plans.built(a.plan.id, a.branch, ref.id)
    ).catch(() => {});

    a.emit({
      kind: 'note',
      text:
        (a.draft === true ? 'pull request opened for a human to take over' : 'pull request open') +
        (url === undefined ? ` — ${ref.id}` : `: ${url}`),
    });

    if (req.tracker !== undefined) {
      await req.tracker
        .comment(
          a.plan.workItemKey,
          (a.draft === true
            ? `The loop stopped without a passing verdict. A pull request is open so the work ` +
              `and the findings are in one place for a person${url === undefined ? '' : `:\n${url}`}\n\n`
            : `A pull request is open for a human to review and merge${url === undefined ? '' : `:\n${url}`}\n\n`) +
            `Verdict: ${a.verdict.decision} from ${a.reviewer.agentId} ` +
            `(${a.reviewer.vendor}/${a.reviewer.model})\n` +
            (a.reviewerFixed
              ? 'Part of this branch was written by the reviewer after its own review, so no ' +
                'agent reviewed those commits. They are named in the pull request.\n'
              : '') +
            'Shura does not merge. Nothing lands until a person approves it.',
        )
        .catch(() => {});
    }
    return { id: ref.id, ...(url === undefined ? {} : { url }) };
  } catch (err) {
    a.emit({
      kind: 'note',
      text: `could not open the pull request: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function pullRequestBody(a: OpenArgs): string {
  const parts: string[] = [
    `**${a.plan.workItemKey}** — built by \`${a.req.builder.name}\` ` +
      `(${a.req.builder.role.id}, ${a.req.builder.runtime.vendor}/${modelOf(a.req.builder.role)}), ` +
      `reviewed by \`${a.reviewer.agentId}\` ` +
      `(${a.req.reviewer.role.id}, ${a.reviewer.vendor}/${a.reviewer.model}).`,
    '',
    '### What was asked for',
    '',
    blockquote(a.plan.request),
    '',
    '### The approved plan',
    '',
    a.plan.understanding,
    '',
    a.plan.approach,
  ];

  if (a.plan.outOfScope.length > 0) {
    parts.push('', '**Out of scope, by agreement:**', ...a.plan.outOfScope.map((o) => `- ${o}`));
  }
  if (a.plan.openQuestions.length > 0) {
    parts.push(
      '',
      '**Questions raised while planning, and the answers approved with the plan:**',
      ...a.plan.openQuestions.map(
        (q, i) => `- ${q}\n  - ${a.plan.answers[i]?.trim() === '' || a.plan.answers[i] === undefined ? '_approved without an answer_' : a.plan.answers[i]}`,
      ),
    );
  }

  parts.push(
    '',
    '### Acceptance criteria',
    '',
    'These came from the plan and are what the reviewer judged against.',
    '',
    ...a.plan.criteria.map((c, i) => {
      const judged = a.verdict.submission.criteria.find((x) => x.index === i);
      const mark = judged?.status === 'met' ? 'x' : ' ';
      const suffix = judged === undefined ? '' : judged.status === 'met' ? '' : ` — **${judged.status}**`;
      return `- [${mark}] ${c}${suffix}`;
    }),
    '',
    '### Review',
    '',
    `Verdict: **${a.verdict.decision}**` +
      (a.verdict.overridden ? ` (rewritten from the reviewer's own findings — ${a.verdict.reason})` : ''),
    '',
    `Checks: ${a.checks.summary}`,
  );

  const findings = [
    ...a.verdict.submission.criteria
      .filter((c) => c.finding !== undefined)
      .map((c) => `- \`${c.finding?.severity}\` [${c.index}] ${c.finding?.claim}\n  - ${c.finding?.evidence}`),
    ...a.verdict.submission.extraFindings.map(
      (f) => `- \`${f.severity}\` ${f.file ?? ''} ${f.claim}\n  - ${f.evidence}`,
    ),
  ];
  if (findings.length > 0) parts.push('', '**Findings:**', ...findings);

  if (a.reviewerFixed) {
    parts.push(
      '',
      '### ⚠ Part of this branch was written by the reviewer',
      '',
      `After reviewing, \`${a.reviewer.agentId}\` corrected its own findings rather than sending ` +
        'the work back. Those commits are authored by it — `git log --author=' +
        `"${a.reviewer.agentId}"` +
        '` — and **no agent reviewed them**. Every other commit here was written by one model ' +
        "and checked by a different vendor's model; these were not.",
      '',
      'Your review is the only check on them. Look hardest there.',
    );
    if (a.fixSummary !== undefined) {
      parts.push('', 'What it said it changed:', '', blockquote(a.fixSummary));
    }
  }

  parts.push(
    '',
    '---',
    '',
    `Shura does not merge. Plan \`${a.plan.id.slice(0, 8)}\` was approved by a human before any ` +
      'of this was written, and merging is a human decision too.',
  );
  return parts.join('\n');
}

function verdictComment(a: OpenArgs): string {
  const lines = [
    `**Verdict: ${a.verdict.decision}** — \`${a.reviewer.agentId}\` ` +
      `(${a.reviewer.vendor}/${a.reviewer.model})`,
    '',
    `${a.verdict.submission.criteria.filter((c) => c.status === 'met').length}/` +
      `${a.verdict.submission.criteria.length} acceptance criteria met · ${a.checks.summary}`,
  ];
  if (a.verdict.overridden) {
    lines.push('', `The submitted decision was rewritten from the findings: ${a.verdict.reason}`);
  }
  if (a.reviewerFixed) {
    lines.push(
      '',
      'This reviewer then fixed what it found, so the commits it wrote are reviewed by no agent.',
    );
  }
  return lines.join('\n');
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/* ------------------------------------------------------------------- helpers */

/**
 * Paths a build produces rather than an agent authoring them.
 *
 * Lockfiles are the one that bites: the check command installs dependencies,
 * which rewrites the lockfile, and `git add -A` then commits a change nobody
 * asked for. `GitHubVcs.getDiff` refuses a diff containing one — correctly, a
 * committed lockfile or `dist/` should stop a pull request — so the run would
 * die after the work was done and paid for.
 */
const GENERATED = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

/**
 * Stages the agent's work and nothing else.
 *
 * Incidental churn in a generated file is discarded rather than committed. A
 * generated file the agent *deliberately* wrote is still staged and will still
 * be caught downstream — this restores only what was already tracked, so a new
 * `dist/` directory the agent created is untouched by this and trips the
 * tripwire as it should.
 *
 * Returns what it discarded, for the log: silently reverting an agent's write
 * would be its own kind of lie.
 */
export async function stageWork(wt: Worktree): Promise<readonly string[]> {
  const discarded: string[] = [];
  for (const path of GENERATED) {
    const status = await wt.git.tryRun('status', '--porcelain', '--', path);
    if (!status.ok || status.stdout.trim() === '') continue;

    // Untracked means the install CREATED it — the repository does not commit a
    // lockfile and does not ignore one either. Reverting is meaningless here
    // because there is nothing to revert to, so it is removed instead.
    //
    // The first version of this only handled tracked-and-modified, and a real
    // run died on exactly this: `pnpm install` wrote a lockfile the repo had
    // never had, `add -A` committed it, and the diff was refused after the work
    // was done and paid for.
    const untracked = status.stdout.trimStart().startsWith('??');
    const undone = untracked
      ? await wt.git.tryRun('clean', '-f', '--', path)
      : await wt.git.tryRun('checkout', '--', path);
    if (undone.ok) discarded.push(path);
  }
  await wt.git.run('add', '-A');
  return discarded;
}

async function runChecks(
  wt: Worktree,
  checkCommand: readonly string[],
): Promise<{ ok: boolean; summary: string; output: string }> {
  const [command, ...args] = checkCommand;
  if (command === undefined) {
    return { ok: true, summary: 'no checks configured', output: '' };
  }
  const r = await wt.exec(command, args);
  return {
    ok: r.code === 0,
    summary: r.code === 0 ? 'checks passed' : `checks failed (exit ${r.code})`,
    output: `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-60).join('\n'),
  };
}

function commitMessage(plan: StoredPlan, attempt: number): string {
  return (
    `${plan.workItemKey}: ${plan.title}\n\n` +
    `${plan.understanding}\n\n` +
    `Built to the plan approved as ${plan.id.slice(0, 8)}` +
    (attempt > 1 ? `, attempt ${attempt}.` : '.')
  );
}

function describeFindings(v: AcceptedVerdict): string {
  const unmet = v.submission.criteria.filter((c) => c.status === 'not_met');
  const extra = v.submission.extraFindings;
  if (unmet.length === 0 && extra.length === 0) {
    return `All ${v.submission.criteria.length} acceptance criteria are met.`;
  }
  return [
    ...unmet.map(
      (c) => `[${c.index}] ${c.finding?.claim ?? 'not met'}\n    evidence: ${c.finding?.evidence ?? ''}`,
    ),
    ...extra.map((f) => `(${f.severity}) ${f.claim}\n    evidence: ${f.evidence}`),
  ].join('\n');
}

function summarise(v: AcceptedVerdict): string {
  const met = v.submission.criteria.filter((c) => c.status === 'met').length;
  return `${met}/${v.submission.criteria.length} criteria met`;
}

async function createTask(
  pool: Pool,
  workItemId: string,
  kind: string,
  role: string,
  attempt: number,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (work_item_id, artifact_type, kind, role, attempt, status)
     VALUES ($1, 'code_change', $2, $3, $4, 'running') RETURNING id`,
    [workItemId, kind, role, attempt],
  );
  return rows[0]!.id;
}

async function finishTask(pool: Pool, taskId: string, status: string): Promise<void> {
  await pool.query('UPDATE tasks SET status = $2, finished_at = now() WHERE id = $1', [
    taskId,
    status,
  ]);
}

export async function recordVerdict(
  pool: Pool,
  verifyTaskId: string,
  v: AcceptedVerdict,
  producer: ActorIdentity,
  verifier: ActorIdentity,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO artifacts (task_id, type, locator, content_hash)
     VALUES ($1, 'code_change', $2, 'n/a') RETURNING id`,
    [verifyTaskId, v.submission.artifactId],
  );
  const artifactId = rows[0]!.id;

  const { rows: vr } = await pool.query<{ id: string }>(
    `INSERT INTO verdicts (artifact_id, verifier_task_id, decision, overridden, findings,
                           producer_vendor, producer_model, verifier_vendor, verifier_model,
                           prompt_hash, tokens_in, tokens_out, cost_usd)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      artifactId,
      verifyTaskId,
      v.decision,
      v.overridden,
      JSON.stringify(v.submission.criteria),
      producer.vendor,
      producer.model,
      verifier.vendor,
      verifier.model,
      'sha256:prompt',
      v.submission.cost.tokensIn,
      v.submission.cost.tokensOut,
      v.submission.cost.usd,
    ],
  );
  return vr[0]!.id;
}
