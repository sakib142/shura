/**
 * Design to backlog, through the same invariant as everything else.
 *
 * A producer proposes stories from a design extract. A verifier on a different
 * vendor judges them against the Definition of Ready. Only a passing verdict
 * puts anything in the tracker — which is why the producer holds
 * `backlog.propose` and not `tracker.write`: proposing is not creating, and an
 * agent that could write straight to the backlog would have no reviewer.
 */

import type { Pool } from 'pg';
import {
  acceptVerdict,
  selectVerifier,
  type AcceptedVerdict,
  type ActorIdentity,
  type RoleDefinition,
  type ToolName,
  type VerifierCandidate,
} from '@shura/core';
import type { AgentEvent, AgentRuntime, DesignExtract, ToolCallRequest } from '@shura/ports';
import { PgAuditSink, PgEffectStore } from '@shura/db';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@shura/tool-gateway';

export interface ProposedStory {
  readonly title: string;
  readonly criteria: readonly string[];
  readonly notes?: string;
}

export interface Proposal {
  readonly stories: readonly ProposedStory[];
  readonly openQuestions: readonly string[];
}

export interface DesignToBacklogOptions {
  readonly pool: Pool;
  readonly extract: DesignExtract;
  readonly renderedExtract: string;
  readonly producer: { runtime: AgentRuntime; role: RoleDefinition; name: string };
  readonly verifier: { runtime: AgentRuntime; role: RoleDefinition; name: string };
  readonly loopCap?: number;
  readonly onEvent?: (actor: string, e: AgentEvent) => void;
  readonly onPhase?: (text: string) => void;
}

export interface DesignToBacklogResult {
  readonly accepted: boolean;
  readonly proposal?: Proposal;
  readonly verdict?: AcceptedVerdict;
  readonly attempts: number;
  readonly usd: number;
  readonly reason?: string;
}

export async function designToBacklog(o: DesignToBacklogOptions): Promise<DesignToBacklogResult> {
  const emit = o.onEvent ?? (() => {});
  const phase = o.onPhase ?? (() => {});
  const cap = o.loopCap ?? 3;
  const audit = new PgAuditSink(o.pool);
  const effects = new PgEffectStore(o.pool);

  const producerActor: ActorIdentity = {
    agentId: o.producer.name,
    role: o.producer.role.id,
    kind: 'produce',
    vendor: o.producer.runtime.vendor,
    ...(o.producer.role.model === undefined ? {} : { model: o.producer.role.model.model }),
  };
  const candidate: VerifierCandidate = {
    agentId: o.verifier.name,
    role: o.verifier.role.id,
    kind: 'verify',
    vendor: o.verifier.runtime.vendor,
    ...(o.verifier.role.model === undefined ? {} : { model: o.verifier.role.model.model }),
    grants: o.verifier.role.tools as ToolName[],
  };

  let usd = 0;
  let priorFindings: unknown[] = [];

  for (let attempt = 1; attempt <= cap; attempt++) {
    /* ----------------------------------------------------------- propose */
    phase(`${o.producer.name} proposing from the design  (attempt ${attempt}/${cap})`);
    const produceTaskId = await task(o.pool, 'produce', o.producer.role.id, attempt);

    let proposal: Proposal | undefined;
    const produceGateway = new McpToolGateway({
      handlers: new Map<ToolName, ToolHandler>([
        ['docs.read', async () => ({ content: o.renderedExtract })],
        ['tracker.read', async () => ({ error: 'no tracker access while proposing' })],
        ['backlog.propose', async ({ args }) => {
          proposal = args as Proposal;
          return { received: proposal.stories.length, openQuestions: proposal.openQuestions.length };
        }],
      ]),
      audit,
      effects,
      grantsFor: () => resolveGrants(o.producer.role),
    });

    usd += await drive(o.producer.runtime, {
      role: o.producer.role,
      taskId: produceTaskId,
      agentId: o.producer.name,
      kind: 'produce',
      gateway: produceGateway,
      attempt,
      context: {
        workItemKey: o.extract.nodeName,
        artifactType: 'story',
        acceptanceCriteria: [],
        attempt,
        ...(priorFindings.length === 0 ? {} : { priorFindings }),
        diff: o.renderedExtract,
      },
      emit: (e) => emit(o.producer.name, e),
    });

    if (proposal === undefined || proposal.stories.length === 0) {
      return { accepted: false, attempts: attempt, usd, reason: 'no stories were proposed' };
    }
    const proposed: Proposal = proposal;
    phase(
      `proposed ${proposed.stories.length} stor${proposed.stories.length === 1 ? 'y' : 'ies'}, ` +
        `${proposed.openQuestions.length} open question(s)`,
    );

    /* ------------------------------------------------------------ verify */
    const chosen = selectVerifier(producerActor, [candidate]);
    phase(`${chosen.agentId} reviewing  (vendor ${chosen.vendor} != ${producerActor.vendor})`);
    const verifyTaskId = await task(o.pool, 'verify', o.verifier.role.id, attempt);

    // One criterion per story: the reviewer must judge each, by index.
    const criteria = proposed.stories.map(
      (s, i) => `Story ${i}: "${s.title}" is ready to build — criteria are checkable and nothing is invented`,
    );

    let verdict: AcceptedVerdict | undefined;
    let spend = { tokensIn: 0, tokensOut: 0, usd: 0 };
    const verifyGateway = new McpToolGateway({
      handlers: new Map<ToolName, ToolHandler>([
        ['docs.read', async () => ({ content: o.renderedExtract })],
        ['tracker.read', async () => ({ proposal: proposed })],
        ['verdict.submit', async ({ args }) => {
          verdict = acceptVerdict(
            {
              ...(args as Record<string, unknown>),
              verifier: {
                agent: o.verifier.name,
                vendor: o.verifier.runtime.vendor,
                model: o.verifier.role.model?.model ?? 'unknown',
              },
              cost: spend,
            },
            criteria.length,
          );
          return { recorded: true, decision: verdict.decision };
        }],
      ]),
      audit,
      effects,
      grantsFor: () => resolveGrants(o.verifier.role),
    });

    usd += await drive(o.verifier.runtime, {
      role: o.verifier.role,
      taskId: verifyTaskId,
      agentId: o.verifier.name,
      kind: 'verify',
      gateway: verifyGateway,
      attempt,
      context: {
        workItemKey: o.extract.nodeName,
        artifactType: 'story',
        acceptanceCriteria: criteria,
        attempt,
        diff: renderProposal(proposed),
        checkResults: { designExtract: o.renderedExtract },
      },
      emit: (e) => {
        if (e.t === 'usage') {
          spend = { tokensIn: spend.tokensIn + e.tokensIn, tokensOut: spend.tokensOut + e.tokensOut, usd: e.usd };
        }
        emit(o.verifier.name, e);
      },
    });

    if (verdict === undefined) {
      return { accepted: false, proposal: proposed, attempts: attempt, usd, reason: 'no verdict submitted' };
    }
    const v: AcceptedVerdict = verdict;

    if (v.decision === 'PASS') {
      return { accepted: true, proposal: proposed, verdict: v, attempts: attempt, usd };
    }

    priorFindings = v.submission.criteria.filter((c) => c.status === 'not_met');
    phase(`${v.decision}: ${priorFindings.length} stor(y|ies) sent back`);
    if (attempt === cap) {
      return {
        accepted: false, proposal: proposed, verdict: v, attempts: attempt, usd,
        reason: `${cap} attempts without a passing verdict`,
      };
    }
  }

  return { accepted: false, attempts: cap, usd, reason: 'loop cap reached' };
}

function renderProposal(p: Proposal): string {
  const lines: string[] = ['PROPOSED STORIES', ''];
  p.stories.forEach((s, i) => {
    lines.push(`Story ${i}: ${s.title}`);
    s.criteria.forEach((c, j) => lines.push(`  [${j}] ${c}`));
    if (s.notes !== undefined) lines.push(`  notes: ${s.notes}`);
    lines.push('');
  });
  lines.push('OPEN QUESTIONS');
  if (p.openQuestions.length === 0) lines.push('  (none raised)');
  for (const q of p.openQuestions) lines.push(`  - ${q}`);
  return lines.join('\n');
}

interface DriveOpts {
  role: RoleDefinition;
  taskId: string;
  agentId: string;
  kind: 'produce' | 'verify';
  gateway: McpToolGateway;
  attempt: number;
  context: Parameters<AgentRuntime['run']>[0]['context'];
  emit: (e: AgentEvent) => void;
}

async function drive(runtime: AgentRuntime, o: DriveOpts): Promise<number> {
  let usd = 0;
  for await (const event of runtime.run({
    role: o.role,
    context: o.context,
    tools: o.role.tools,
    limits: {
      maxMinutes: o.role.limits.max_minutes,
      maxTokens: o.role.limits.max_tokens,
      maxUsd: o.role.limits.max_usd,
    },
    signal: AbortSignal.timeout(o.role.limits.max_minutes * 60_000),
    invoke: async (tool: string, args: unknown) => {
      const req: ToolCallRequest = {
        taskId: o.taskId, agentId: o.agentId, roleKind: o.kind,
        grants: o.role.tools, tool, args, attempt: o.attempt,
      };
      return o.gateway.call(req);
    },
  })) {
    if (event.t === 'usage') usd = event.usd;
    o.emit(event);
  }
  return usd;
}

async function task(pool: Pool, kind: string, role: string, attempt: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ('DESIGN-RUN', 'epic', 'design to backlog', '[]'::jsonb, 'draft')
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
  );
  const { rows: t } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (work_item_id, artifact_type, kind, role, attempt, status)
     VALUES ($1,'story',$2,$3,$4,'running') RETURNING id`,
    [rows[0]!.id, kind, role, attempt],
  );
  return t[0]!.id;
}

export { renderProposal };
