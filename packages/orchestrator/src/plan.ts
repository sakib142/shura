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
