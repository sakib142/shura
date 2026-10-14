/**
 * One work item, from draft to admitted.
 *
 * This is the loop the whole project exists to prove: a producer builds, a
 * verifier on a different vendor judges, and a merge queue that is not a model
 * admits the result. The invariant is enforced here at the one point where a
 * verify task comes into existence — nowhere else is allowed to create one.
 */

import type { Pool } from 'pg';
import {
  InvariantViolation,
  afterVerdict,
  selectVerifier,
  transition,
  type AcceptedVerdict,
  type ActorIdentity,
  type ArtifactState,
  type RoleDefinition,
  type ToolName,
  type VerifierCandidate,
} from '@forge/core';
import type {
  Tracker,
  TrackerState,
  AgentEvent,
  AgentRuntime,
  ChangeRequestRef,
  RunLimits,
  TaskContext,
  ToolCallRequest,
} from '@forge/ports';
import { agentIdentity } from '@forge/git';
import { Worktree } from '@forge/sandbox';
import { LocalMergeQueue, LocalVcs } from '@forge/connectors';
import { PgAuditSink, PgEffectStore } from '@forge/db';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@forge/tool-gateway';
import { producerHandlers, verifierHandlers } from './handlers.js';

export type StreamEvent =
  | { readonly kind: 'phase'; readonly state: ArtifactState; readonly detail: string }
  | { readonly kind: 'agent'; readonly actor: string; readonly event: AgentEvent }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'verdict'; readonly decision: string; readonly detail: string };

export interface RunOptions {
  readonly pool: Pool;
  readonly repoDir: string;
  readonly checkCommand: readonly string[];
  readonly workItemKey: string;
  readonly producer: { runtime: AgentRuntime; role: RoleDefinition; name: string };
  readonly verifier: { runtime: AgentRuntime; role: RoleDefinition; name: string };
  readonly loopCap?: number;
  readonly onEvent?: (e: StreamEvent) => void;
  /**
   * When present, the work item is read from here and progress is written back.
   * Forge writes status and commentary only — the tracker owns the story
   * itself, so there is one writer per field and nothing to reconcile.
   */
  readonly tracker?: Tracker;
}

export interface RunOutcome {
  readonly state: ArtifactState;
  readonly attempts: number;
  readonly mergeCommit?: string;
  readonly reason?: string;
  readonly usd: number;
}

export async function runWorkItem(opts: RunOptions): Promise<RunOutcome> {
  const emit = opts.onEvent ?? (() => {});
  const cap = opts.loopCap ?? 3;
  const vcsOpts = { repoDir: opts.repoDir, pool: opts.pool, checkCommand: opts.checkCommand };
  const vcs = new LocalVcs(vcsOpts);
  const queue = new LocalMergeQueue(vcsOpts, vcs);
  const effects = new PgEffectStore(opts.pool);
  const audit = new PgAuditSink(opts.pool);

  const item = await loadWorkItem(opts.pool, opts.workItemKey);

  /** Best-effort: a tracker that is down must not fail a run that is working. */
  const note = async (body: string): Promise<void> => {
    if (opts.tracker === undefined) return;
    try {
      await opts.tracker.comment(opts.workItemKey, body);
    } catch (err) {
      emit({ kind: 'note', text: `tracker comment failed: ${(err as Error).message}` });
    }
  };
  const move = async (to: TrackerState): Promise<void> => {
    if (opts.tracker === undefined) return;
    try {
      const ok = await opts.tracker.transition(opts.workItemKey, to);
      emit({
        kind: 'note',
        text: ok ? `tracker -> ${to}` : `tracker has no transition to ${to}; left as is`,
      });
    } catch (err) {
      emit({ kind: 'note', text: `tracker transition failed: ${(err as Error).message}` });
    }
  };
  const branch = `feature/${opts.workItemKey}`;
  const base = vcs.base;

  const producerActor: ActorIdentity = {
    agentId: opts.producer.name,
    role: opts.producer.role.id,
    kind: 'produce',
    ...(opts.producer.runtime.vendor === undefined ? {} : { vendor: opts.producer.runtime.vendor }),
    ...(opts.producer.role.model === undefined ? {} : { model: opts.producer.role.model.model }),
  };
  const verifierCandidate: VerifierCandidate = {
    agentId: opts.verifier.name,
    role: opts.verifier.role.id,
    kind: 'verify',
    vendor: opts.verifier.runtime.vendor,
    ...(opts.verifier.role.model === undefined ? {} : { model: opts.verifier.role.model.model }),
    grants: opts.verifier.role.tools as ToolName[],
  };

  let state: ArtifactState = 'draft';
  let usd = 0;
  let ref: ChangeRequestRef | undefined;
  // Local, not module-level: two work items may run at once and must not see
  // each other's findings.
  let priorFindings: unknown[] = [];

  for (let attempt = 1; attempt <= cap; attempt++) {
    /* ------------------------------------------------------------ produce */
    state = attempt === 1 ? transition(state, 'start_production') : transition(state, 'rework_start');
    emit({ kind: 'phase', state, detail: `${opts.producer.name}  attempt ${attempt}/${cap}` });

    await move('in_progress');
    await vcs.createBranch(base, branch);
    const produceTaskId = await createTask(opts.pool, item.id, 'produce', opts.producer.role.id, attempt);

    const produceWt = await Worktree.create({
      repoDir: opts.repoDir,
      branch,
      taskId: produceTaskId,
      identity: agentIdentity(opts.producer.name, opts.producer.role.id, modelOf(opts.producer.role)),
      claimedBranches: [branch],
    });

    try {
      const gateway = new McpToolGateway({
        handlers: producerHandlers({
          worktree: produceWt,
          pool: opts.pool,
          workItemId: item.id,
          workItemKey: item.key,
          checkCommand: opts.checkCommand,
          criterionCount: item.criteria.length,
          onComment: (body) => emit({ kind: 'note', text: `${opts.producer.name}: ${body}` }),
        }) as Map<ToolName, ToolHandler>,
        audit,
        effects,
        grantsFor: () => resolveGrants(opts.producer.role),
      });

      usd += await drive(opts.producer.runtime, {
        role: opts.producer.role,
        context: {
          workItemKey: item.key,
          artifactType: 'code_change',
          acceptanceCriteria: item.criteria,
          attempt,
          ...(priorFindings.length === 0 ? {} : { priorFindings }),
        },
        tools: opts.producer.role.tools,
        limits: limitsOf(opts.producer.role),
        taskId: produceTaskId,
        agentId: opts.producer.name,
        kind: 'produce',
        gateway,
        emit: (e) => emit({ kind: 'agent', actor: opts.producer.name, event: e }),
      });

      const dirty = await produceWt.git.tryRun('status', '--porcelain');
      if (dirty.stdout.trim() !== '') {
        await produceWt.git.run('add', '-A');
        await produceWt.git.run('commit', '-q', '-m', `${item.key}: ${item.title}`);
      }
    } finally {
      await produceWt.destroy();
    }

    const changed = await vcs.getDiff({ id: 'probe', branch, base });
    if (changed.files.length === 0) {
      emit({ kind: 'note', text: 'producer made no change' });
      state = transition(state, 'human_requested');
      return { state, attempts: attempt, reason: 'producer made no change', usd };
    }

    state = transition(state, 'production_complete');
    ref = await vcs.openChangeRequest({
      branch,
      base,
      title: `${item.key}: ${item.title}`,
      body: criteriaChecklist(item.criteria),
      author: opts.producer.name,
      workItemId: item.id,
    });
    const checks = await vcs.runChecks(ref);
    emit({
      kind: 'phase',
      state,
      detail: `change request opened · ${changed.files.length} file(s) · ${checks.summary}`,
    });
    await note(
      `${opts.producer.name} (${opts.producer.role.id}) opened a change request on ${branch}\n` +
        `${changed.files.length} file(s) changed · ${checks.summary}\n` +
        `attempt ${attempt} of ${cap}`,
    );
    await move('in_review');

    /* ------------------------------------------------------------- verify */
    // The one place a verify task is created, so rule 1 cannot be bypassed.
    const chosen = selectVerifier(producerActor, [verifierCandidate]);
    state = transition(state, 'verifier_scheduled');
    emit({
      kind: 'phase',
      state,
      detail: `${chosen.agentId}  (vendor ${chosen.vendor} != ${producerActor.vendor})`,
    });

    const verifyTaskId = await createTask(opts.pool, item.id, 'verify', opts.verifier.role.id, attempt);
    const verifyWt = await Worktree.create({
      repoDir: opts.repoDir,
      branch,
      taskId: verifyTaskId,
      claimedBranches: [],
    });

    let verdict: AcceptedVerdict | undefined;
    let verifierSpend = { tokensIn: 0, tokensOut: 0, usd: 0 };
    try {
      const gateway = new McpToolGateway({
        handlers: verifierHandlers({
          worktree: verifyWt,
          pool: opts.pool,
          workItemId: item.id,
          workItemKey: item.key,
          checkCommand: opts.checkCommand,
          criterionCount: item.criteria.length,
          onVerdict: (v) => { verdict = v; },
          verifier: {
            agent: opts.verifier.name,
            vendor: opts.verifier.runtime.vendor,
            model: modelOf(opts.verifier.role),
            spent: () => verifierSpend,
          },
        }) as Map<ToolName, ToolHandler>,
        audit,
        effects,
        grantsFor: () => resolveGrants(opts.verifier.role),
      });

      usd += await drive(opts.verifier.runtime, {
        role: opts.verifier.role,
        context: {
          workItemKey: item.key,
          artifactType: 'code_change',
          acceptanceCriteria: item.criteria,
          attempt,
          diff: changed.text,
          checkResults: { ok: checks.ok, summary: checks.summary, output: checks.output },
        },
        tools: opts.verifier.role.tools,
        limits: limitsOf(opts.verifier.role),
        taskId: verifyTaskId,
        agentId: opts.verifier.name,
        kind: 'verify',
        gateway,
        emit: (e) => {
          if (e.t === 'usage') {
            verifierSpend = {
              tokensIn: verifierSpend.tokensIn + e.tokensIn,
              tokensOut: verifierSpend.tokensOut + e.tokensOut,
              usd: e.usd,
            };
          }
          emit({ kind: 'agent', actor: opts.verifier.name, event: e });
        },
      });
    } finally {
      await verifyWt.destroy();
    }

    if (verdict === undefined) {
      emit({ kind: 'note', text: 'verifier finished without submitting a verdict' });
      state = transition(state, 'verdict_blocked');
      return { state, attempts: attempt, reason: 'no verdict submitted', usd };
    }

    const v: AcceptedVerdict = verdict;
    const verdictId = await recordVerdict(opts.pool, verifyTaskId, v, producerActor, chosen);
    emit({
      kind: 'verdict',
      decision: v.decision,
      detail: v.overridden ? `overridden — ${v.reason}` : summarise(v),
    });

    await note(
      `${chosen.agentId} (${opts.verifier.role.id}, ${chosen.vendor}/${chosen.model}) reviewed it.\n` +
        `Verdict: ${v.decision}${v.overridden ? ` (rewritten from the findings — ${v.reason})` : ''}\n` +
        describeFindings(v),
    );

    const next = afterVerdict(v.decision, attempt, cap);
    state = next.next;

    if (v.decision !== 'PASS') {
      if (state === 'escalated') {
        await note(`Escalated: ${cap} attempts were used without a passing verdict. A human is needed.`);
        await move('blocked');
        return { state, attempts: attempt, reason: `loop cap reached at attempt ${attempt}`, usd };
      }
      priorFindings = v.submission.criteria.filter((c) => c.status === 'not_met');
      continue;
    }

    /* -------------------------------------------------------------- admit */
    await queue.enqueue(ref, verdictId);
    const [outcome] = await queue.tick();

    if (outcome?.status === 'merged') {
      state = transition(state, 'admission_succeeded');
      emit({ kind: 'phase', state, detail: `merged ${outcome.commit.slice(0, 7)}` });
      await note(
        `Merged ${outcome.commit.slice(0, 7)} into ${base} by the merge queue, after rebasing ` +
          `and re-running the checks.\nTotal cost $${usd.toFixed(4)} across ${attempt} attempt(s).`,
      );
      await move('done');
      return { state, attempts: attempt, mergeCommit: outcome.commit, usd };
    }

    state = transition(state, 'admission_failed');
    const reason = outcome?.status === 'rejected' ? outcome.reason : 'merge queue returned nothing';
    emit({ kind: 'phase', state, detail: reason });
    priorFindings = [{ index: -1, status: 'not_met', finding: { severity: 'blocker', claim: reason, evidence: 'merge queue' } }];
  }

  return { state: 'escalated', attempts: cap, reason: `loop cap of ${cap} reached`, usd };
}

/* ------------------------------------------------------------------ helpers */

interface DriveOptions {
  role: RoleDefinition;
  context: TaskContext;
  tools: readonly string[];
  limits: RunLimits;
  taskId: string;
  agentId: string;
  kind: 'produce' | 'verify';
  gateway: McpToolGateway;
  emit: (e: AgentEvent) => void;
}

async function drive(runtime: AgentRuntime, o: DriveOptions): Promise<number> {
  let usd = 0;
  const invoke = async (tool: string, args: unknown) => {
    const req: ToolCallRequest = {
      taskId: o.taskId,
      agentId: o.agentId,
      roleKind: o.kind,
      grants: o.tools,
      tool,
      args,
      attempt: o.context.attempt,
    };
    return o.gateway.call(req);
  };

  for await (const event of runtime.run({
    role: o.role,
    context: o.context,
    tools: o.tools,
    limits: o.limits,
    signal: AbortSignal.timeout(o.limits.maxMinutes * 60_000),
    invoke,
  })) {
    if (event.t === 'usage') usd = event.usd;
    o.emit(event);
  }
  return usd;
}

function modelOf(role: RoleDefinition): string {
  return role.model?.model ?? 'deterministic';
}

function limitsOf(role: RoleDefinition): RunLimits {
  return {
    maxMinutes: role.limits.max_minutes,
    maxTokens: role.limits.max_tokens,
    maxUsd: role.limits.max_usd,
  };
}

function criteriaChecklist(criteria: readonly string[]): string {
  return ['## Acceptance criteria', ...criteria.map((c, i) => `- [ ] [${i}] ${c}`)].join('\n');
}

function describeFindings(v: AcceptedVerdict): string {
  const unmet = v.submission.criteria.filter((c) => c.status === 'not_met');
  if (unmet.length === 0) return `All ${v.submission.criteria.length} acceptance criteria are met.`;
  return unmet
    .map((c) => `[${c.index}] ${c.finding?.claim ?? 'not met'}\n    evidence: ${c.finding?.evidence ?? ''}`)
    .join('\n');
}

function summarise(v: AcceptedVerdict): string {
  const met = v.submission.criteria.filter((c) => c.status === 'met').length;
  return `${met}/${v.submission.criteria.length} criteria met`;
}

interface WorkItem {
  id: string;
  key: string;
  title: string;
  criteria: string[];
}

async function loadWorkItem(pool: Pool, key: string): Promise<WorkItem> {
  const { rows } = await pool.query<{ id: string; key: string; title: string; acceptance_criteria: string[] }>(
    'SELECT id, key, title, acceptance_criteria FROM work_items WHERE key = $1',
    [key],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no work item "${key}"`);
  return { id: row.id, key: row.key, title: row.title, criteria: row.acceptance_criteria };
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

async function recordVerdict(
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

export { InvariantViolation };
