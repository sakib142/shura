/**
 * The planning phase, and the gate it stops at.
 *
 * The agent reads the repository, works out what the request means in it, and
 * submits a plan. Then the run ends. Nothing is written, no branch exists, and
 * a human decides whether this is the work they asked for before any of it is
 * built.
 *
 * Two things make the gate real rather than decorative:
 *
 *   - the planner holds no write grant, so it cannot begin building while it is
 *     supposed to be deciding what to build;
 *   - the plan and its approval are rows in Postgres, so the stop survives the
 *     process exiting — which is the point of stopping.
 *
 * The plan is also where the acceptance criteria come from. Free-form
 * instructions cannot be judged; "Given an order list, when the range is set to
 * April, then only April orders are listed" can. Everything downstream judges
 * against what this step produced.
 */

import type { Pool } from 'pg';
import {
  PlanInputSchema,
  acceptPlan,
  asJsonSchema,
  type PlanInput,
  type PlanSubmission,
  type RoleDefinition,
  type ToolName,
} from '@shura/core';
import type { AgentRuntime } from '@shura/ports';
import { Worktree } from '@shura/sandbox';
import { PgAuditSink, PgEffectStore, PgPlans, type PlanSource, type StoredPlan } from '@shura/db';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@shura/tool-gateway';
import { plannerHandlers } from './handlers.js';
import { drive, limitsOf, modelOf } from './drive.js';
import { recorder, type StreamEvent } from './stream.js';

export interface PlanRequest {
  readonly pool: Pool;
  /** The local clone the planner reads. Never written to. */
  readonly repoDir: string;
  /** The branch to plan against, which is the base — there is no branch yet. */
  readonly base: string;
  readonly checkCommand: readonly string[];
  readonly workItem: { readonly id: string; readonly key: string; readonly title: string };
  readonly source: PlanSource;
  readonly planner: { readonly runtime: AgentRuntime; readonly role: RoleDefinition; readonly name: string };
  readonly onEvent?: (e: StreamEvent) => void;
}

export type PlanOutcome =
  | { readonly ok: true; readonly planId: string; readonly plan: PlanSubmission; readonly usd: number }
  | { readonly ok: false; readonly reason: string; readonly usd: number };

export async function planWorkItem(req: PlanRequest): Promise<PlanOutcome> {
  // Recorded as well as streamed, the same way the build flow does it. Without
  // this the planner's whole run existed only in one terminal's scrollback:
  // nothing to look at afterwards, and nothing for the live view to show while
  // it happened.
  const emit = recorder(req.pool, req.workItem.key, req.onEvent ?? (() => {}));
  const plans = new PgPlans(req.pool);
  const audit = new PgAuditSink(req.pool);
  const effects = new PgEffectStore(req.pool);

  // Emitted before the task exists, so the run shows up the moment it starts.
  // The live view lists runs by joining on events and dropping anything with
  // none, so a work item that has not emitted yet is invisible — which was the
  // entire planning phase.
  emit({
    kind: 'phase',
    state: 'draft',
    detail: `${req.planner.name} planning  (${req.planner.runtime.vendor}/${modelOf(req.planner.role)})`,
  });
  emit({ kind: 'note', text: `reading ${req.source.repo} to work out what the request means` });

  const taskId = await createPlanTask(req.pool, req.workItem.id, req.planner.role.id);

  // On the base branch, with nothing claimed: the push guard refuses every
  // branch, and the planner holds no write tool to reach it with anyway.
  const wt = await Worktree.create({
    repoDir: req.repoDir,
    branch: req.base,
    taskId,
    claimedBranches: [],
    // Reading only. Holding the base branch would block the next run's fetch
    // into it for as long as this one lasts.
    detached: true,
  });

  let submitted: PlanSubmission | undefined;
  let spend = { tokensIn: 0, tokensOut: 0, usd: 0 };

  try {
    const gateway = new McpToolGateway({
      handlers: plannerHandlers({
        worktree: wt,
        pool: req.pool,
        workItemId: req.workItem.id,
        workItemKey: req.workItem.key,
        checkCommand: req.checkCommand,
        // No criteria exist yet. Producing them is this task's job.
        criterionCount: 0,
        onPlan: (p) => {
          submitted = p;
        },
        author: {
          agent: req.planner.name,
          vendor: req.planner.runtime.vendor,
          model: modelOf(req.planner.role),
          spent: () => spend,
        },
      }) as Map<ToolName, ToolHandler>,
      audit,
      effects,
      grantsFor: () => resolveGrants(req.planner.role),
    });

    const result = await drive(req.planner.runtime, {
      role: req.planner.role,
      context: {
        workItemKey: req.workItem.key,
        title: req.workItem.title,
        artifactType: 'plan',
        acceptanceCriteria: [],
        request: req.source.request,
        attempt: 1,
      },
      tools: req.planner.role.tools,
      limits: limitsOf(req.planner.role),
      workdir: wt.dir,
      // A CLI-driven planner cannot call plan.submit; its final answer carries
      // the plan instead, held to exactly the same shape.
      outputSchema: asJsonSchema(PlanInputSchema),
      taskId,
      agentId: req.planner.name,
      kind: 'produce',
      gateway,
      emit: (e) => {
        if (e.t === 'usage') {
          spend = {
            tokensIn: spend.tokensIn + e.tokensIn,
            tokensOut: spend.tokensOut + e.tokensOut,
            usd: e.usd,
          };
        }
        emit({ kind: 'agent', actor: req.planner.name, event: e });
      },
    });
    spend = { ...spend, usd: result.usd };

    // The structured answer, when the tool was not used. Identity and cost are
    // attached here rather than asked of the model, for the same reason the
    // tool handler attaches them: the platform knows which agent ran.
    if (submitted === undefined && result.output !== undefined) {
      try {
        submitted = acceptPlan({
          ...(result.output as Record<string, unknown>),
          author: {
            agent: req.planner.name,
            vendor: req.planner.runtime.vendor,
            model: modelOf(req.planner.role),
          },
          cost: spend,
        });
      } catch (err) {
        emit({ kind: 'note', text: `the plan was rejected: ${(err as Error).message}` });
      }
    }
    if (result.error !== undefined && submitted === undefined) {
      emit({ kind: 'note', text: `${req.planner.name} stopped: ${result.error}` });
    }
  } finally {
    await wt.destroy();
  }

  await finishTask(req.pool, taskId, submitted === undefined ? 'failed' : 'succeeded');

  if (submitted === undefined) {
    return { ok: false, reason: 'the planner finished without submitting a plan', usd: spend.usd };
  }

  const planId = await plans.record(req.workItem.id, taskId, req.source, submitted);
  emit({
    kind: 'note',
    text:
      `plan ${planId.slice(0, 8)} recorded — ${submitted.criteria.length} criteria, ` +
      `${submitted.files.length} file(s), ${submitted.openQuestions.length} open question(s)`,
  });
  return { ok: true, planId, plan: submitted, usd: spend.usd };
}

export interface RevisePlanRequest {
  readonly pool: Pool;
  /** The local clone the planner re-reads. Never written to. */
  readonly repoDir: string;
  readonly plan: StoredPlan;
  /** One per open question, in the order they were asked. */
  readonly answers: readonly string[];
  readonly planner: {
    readonly runtime: AgentRuntime;
    readonly role: RoleDefinition;
    readonly name: string;
  };
  readonly onEvent?: (e: StreamEvent) => void;
}

export interface ReviseSpend {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
}

export type ReviseOutcome =
  | { readonly ok: true; readonly revised: PlanInput; readonly spend: ReviseSpend }
  | { readonly ok: false; readonly reason: string; readonly spend: ReviseSpend };

/**
 * The plan, re-derived from the approver's answers.
 *
 * An open question is the planner saying the request did not settle something.
 * Answering it only moved the decision if the answer reaches the acceptance
 * criteria, because those are the only thing the reviewer is shown. Before this
 * existed the answers were passed to the builder as prose and the criteria
 * stood unchanged, so an approver who renamed a column got a plan whose
 * criteria still named the old one — and a reviewer that failed the builder for
 * doing as it was told. The gate asked a question and then overruled the answer.
 *
 * This runs at approval rather than at build time because `decide` is where the
 * criteria become the work item's contract. Revising anywhere later would leave
 * a window in which the stored contract and the approved answers disagree.
 *
 * It re-reads the repository, since an answer can send the plan somewhere it has
 * not looked — "show it on the public profile too" names files the original plan
 * had no reason to open. That costs a planner call, which is why the caller
 * confirms the spend first.
 */
export async function revisePlan(req: RevisePlanRequest): Promise<ReviseOutcome> {
  const emit = recorder(req.pool, req.plan.workItemKey, req.onEvent ?? (() => {}));
  const audit = new PgAuditSink(req.pool);
  const effects = new PgEffectStore(req.pool);

  emit({
    kind: 'phase',
    state: 'draft',
    detail: `${req.planner.name} revising the plan from ${req.answers.filter((a) => a.trim() !== '').length} answer(s)`,
  });

  const taskId = await createPlanTask(req.pool, req.plan.workItemId, req.planner.role.id);

  const wt = await Worktree.create({
    repoDir: req.repoDir,
    branch: req.plan.base,
    taskId,
    claimedBranches: [],
    detached: true,
  });

  let submitted: PlanSubmission | undefined;
  let spend: ReviseSpend = { tokensIn: 0, tokensOut: 0, usd: 0 };

  try {
    const gateway = new McpToolGateway({
      handlers: plannerHandlers({
        worktree: wt,
        pool: req.pool,
        workItemId: req.plan.workItemId,
        workItemKey: req.plan.workItemKey,
        checkCommand: req.plan.checks,
        // The criteria it is revising, so a submission that drops them all is
        // visible as a change rather than looking like a first draft.
        criterionCount: req.plan.criteria.length,
        onPlan: (pl) => {
          submitted = pl;
        },
        author: {
          agent: req.planner.name,
          vendor: req.planner.runtime.vendor,
          model: modelOf(req.planner.role),
          spent: () => spend,
        },
      }) as Map<ToolName, ToolHandler>,
      audit,
      effects,
      grantsFor: () => resolveGrants(req.planner.role),
    });

    const result = await drive(req.planner.runtime, {
      role: req.planner.role,
      context: {
        workItemKey: req.plan.workItemKey,
        title: req.plan.title,
        artifactType: 'plan',
        // What it is revising, not what it must satisfy.
        acceptanceCriteria: [],
        request: reviseBrief(req.plan, req.answers),
        attempt: 1,
      },
      tools: req.planner.role.tools,
      limits: limitsOf(req.planner.role),
      workdir: wt.dir,
      outputSchema: asJsonSchema(PlanInputSchema),
      taskId,
      agentId: req.planner.name,
      kind: 'produce',
      gateway,
      emit: (e) => {
        if (e.t === 'usage') {
          spend = {
            tokensIn: spend.tokensIn + e.tokensIn,
            tokensOut: spend.tokensOut + e.tokensOut,
            usd: e.usd,
          };
        }
        emit({ kind: 'agent', actor: req.planner.name, event: e });
      },
    });
    spend = { ...spend, usd: result.usd };

    if (submitted === undefined && result.output !== undefined) {
      try {
        submitted = acceptPlan({
          ...(result.output as Record<string, unknown>),
          author: {
            agent: req.planner.name,
            vendor: req.planner.runtime.vendor,
            model: modelOf(req.planner.role),
          },
          cost: spend,
        });
      } catch (err) {
        emit({ kind: 'note', text: `the revision was rejected: ${(err as Error).message}` });
      }
    }
    if (result.error !== undefined && submitted === undefined) {
      emit({ kind: 'note', text: `${req.planner.name} stopped: ${result.error}` });
    }
  } finally {
    await wt.destroy();
  }

  await finishTask(req.pool, taskId, submitted === undefined ? 'failed' : 'succeeded');

  if (submitted === undefined) {
    return {
      ok: false,
      reason: 'the planner finished without submitting a revision',
      spend,
    };
  }

  // The identity and cost the submission carries belong to the plan row, which
  // already has them; what the caller needs back is the body.
  const { understanding, approach, files, outOfScope, criteria, openQuestions } = submitted;
  return {
    ok: true,
    revised: { understanding, approach, files, outOfScope, criteria, openQuestions },
    spend,
  };
}

/**
 * What the planner is told when it revises.
 *
 * The answers are stated as decisions rather than input, because a model shown
 * its own plan beside a contradicting answer will otherwise try to honour both.
 */
function reviseBrief(plan: StoredPlan, answers: readonly string[]): string {
  const lines: string[] = [
    'You are revising a plan you already wrote. Do not start a new one.',
    '',
    'The approver has answered your open questions. Their answers are decisions,',
    'not suggestions: wherever an answer contradicts what you planned, the answer',
    'wins and your earlier choice goes.',
    '',
    'Re-submit the whole plan with those decisions carried through everywhere they',
    'reach — above all into the acceptance criteria, which are the only thing the',
    'reviewer is shown. A criterion that still names a choice the approver',
    'overruled will fail the builder for doing exactly what it was told.',
    '',
    'Leave everything the answers do not touch as it stands, so the change is',
    'readable. Re-read the repository where an answer sends you somewhere you have',
    'not looked. Do not ask the same question again: raise a new one only if an',
    'answer cannot be acted on at all, and otherwise decide it and say so in what',
    'you put out of scope.',
    '',
    'THE ORIGINAL REQUEST',
    indent(plan.request),
    '',
    'WHAT YOU UNDERSTOOD IT TO BE',
    indent(plan.understanding),
    '',
    'HOW YOU PLANNED TO DO IT',
    indent(plan.approach),
    '',
    'THE FILES YOU NAMED',
    ...plan.files.map((f) => `  ${f.path} — ${f.reason}`),
  ];

  if (plan.outOfScope.length > 0) {
    lines.push('', 'WHAT YOU PUT OUT OF SCOPE', ...plan.outOfScope.map((o) => `  - ${o}`));
  }

  lines.push(
    '',
    'YOUR ACCEPTANCE CRITERIA, AS THEY STAND',
    ...plan.criteria.map((c, i) => `  [${i}] ${c}`),
    '',
    'YOUR QUESTIONS, AND THE ANSWERS YOU ARE BEING GIVEN',
  );

  plan.openQuestions.forEach((q, i) => {
    const a = (answers[i] ?? '').trim();
    lines.push(
      `  (${i}) ${q}`,
      a === ''
        ? '       ANSWER: none given — decide it yourself and record the decision'
        : `       ANSWER: ${a}`,
    );
  });

  return lines.join('\n');
}

/**
 * What the revision changed, for the approver to read before it becomes the
 * contract.
 *
 * Criteria are shown in full because they are what is being agreed to.
 * Understanding and approach are only reported as rewritten: they are prose
 * long enough that a line-level diff would bury the criteria underneath it.
 */
export function renderRevision(before: StoredPlan, after: PlanInput): string {
  const lines: string[] = [
    'WHAT YOUR ANSWERS CHANGED',
    '  The criteria below are what the reviewer will judge against. Read them, not',
    '  the answers you gave — these are what the answers turned into.',
    '',
  ];

  const gone = before.criteria.filter((c) => !after.criteria.includes(c));
  const added = after.criteria.filter((c) => !before.criteria.includes(c));
  const kept = before.criteria.length - gone.length;

  lines.push(
    `ACCEPTANCE CRITERIA  ${before.criteria.length} -> ${after.criteria.length}` +
      ` (${kept} unchanged, ${gone.length} dropped, ${added.length} new)`,
  );
  if (gone.length === 0 && added.length === 0) {
    lines.push(
      '  unchanged — the answers did not reach the criteria. If you expected them to,',
      '  the revision disagreed with you: read the approach below before approving.',
    );
  }
  for (const c of gone) lines.push(`  - ${c}`);
  for (const c of added) lines.push(`  + ${c}`);

  const beforePaths = before.files.map((f) => f.path);
  const afterPaths = after.files.map((f) => f.path);
  const droppedFiles = beforePaths.filter((f) => !afterPaths.includes(f));
  const newFiles = after.files.filter((f) => !beforePaths.includes(f.path));
  if (droppedFiles.length > 0 || newFiles.length > 0) {
    lines.push('', `FILES  ${beforePaths.length} -> ${afterPaths.length}`);
    for (const f of droppedFiles) lines.push(`  - ${f}`);
    for (const f of newFiles) lines.push(`  + ${f.path}\n        ${f.reason}`);
  }

  const droppedScope = before.outOfScope.filter((o) => !after.outOfScope.includes(o));
  const newScope = after.outOfScope.filter((o) => !before.outOfScope.includes(o));
  if (droppedScope.length > 0 || newScope.length > 0) {
    lines.push('', 'OUT OF SCOPE');
    for (const o of droppedScope) lines.push(`  - ${o}`);
    for (const o of newScope) lines.push(`  + ${o}`);
  }

  const rewritten = [
    before.understanding === after.understanding ? undefined : 'understanding',
    before.approach === after.approach ? undefined : 'approach',
  ].filter((x): x is string => x !== undefined);
  if (rewritten.length > 0) {
    lines.push('', `REWRITTEN  ${rewritten.join(' and ')} — read with: shura plans ${before.id.slice(0, 8)}`);
  }

  if (after.openQuestions.length > 0) {
    lines.push(
      '',
      'STILL OPEN',
      '  The revision raised these rather than deciding them. They are recorded with',
      '  the plan and the builder will decide them.',
      ...after.openQuestions.map((q, i) => `  (${i}) ${q}`),
    );
  }

  return lines.join('\n');
}

/** Everything a human needs to read before approving, as plain text. */
export function renderPlan(p: StoredPlan): string {
  const lines: string[] = [
    `plan      ${p.id}`,
    `item      ${p.workItemKey}  ${p.title}`,
    `repo      ${p.repo}`,
    `author    ${p.author}  (${p.vendor}/${p.model})  $${p.costUsd.toFixed(4)}`,
    `status    ${p.status}`,
    '',
    'REQUEST',
    indent(p.request),
    '',
    'UNDERSTANDING',
    indent(p.understanding),
    '',
    'APPROACH',
    indent(p.approach),
    '',
    'FILES',
    ...p.files.map((f) => `  ${f.path}\n      ${f.reason}`),
  ];

  if (p.outOfScope.length > 0) {
    lines.push('', 'OUT OF SCOPE', ...p.outOfScope.map((o) => `  - ${o}`));
  }

  lines.push(
    '',
    'ACCEPTANCE CRITERIA',
    '  These are what the reviewer will judge against, and the only thing it will',
    '  judge against. The request above is not passed on.',
    '',
    ...p.criteria.map((c, i) => `  [${i}] ${c}`),
  );

  if (p.openQuestions.length > 0) {
    lines.push(
      '',
      'OPEN QUESTIONS',
      '  The plan could not settle these from the request or the code. Answer them,',
      '  or approve with --ignore-questions to let the agent decide.',
      '',
      ...p.openQuestions.map((q, i) => `  (${i}) ${q}`),
    );
  }
  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

async function createPlanTask(pool: Pool, workItemId: string, role: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (work_item_id, artifact_type, kind, role, attempt, status)
     VALUES ($1, 'plan', 'produce', $2, 1, 'running') RETURNING id`,
    [workItemId, role],
  );
  return rows[0]!.id;
}

async function finishTask(pool: Pool, taskId: string, status: string): Promise<void> {
  await pool.query('UPDATE tasks SET status = $2, finished_at = now() WHERE id = $1', [
    taskId,
    status,
  ]);
}
