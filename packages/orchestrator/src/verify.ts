/**
 * Verifying one change request.
 *
 * Extracted so the eval harness measures the same code path production uses.
 * A probe that runs its own copy of the verify step measures the copy.
 */

import type { Pool } from 'pg';
import {
  acceptVerdict,
  type AcceptedVerdict,
  type RoleDefinition,
  type ToolName,
} from '@shura/core';
import type { AgentEvent, AgentRuntime, ChangeRequestRef, ToolCallRequest } from '@shura/ports';
import { Worktree } from '@shura/sandbox';
import type { LocalVcs } from '@shura/connectors';
import { PgAuditSink, PgEffectStore } from '@shura/db';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@shura/tool-gateway';
import { verifierHandlers } from './handlers.js';

export interface VerifyOptions {
  readonly pool: Pool;
  readonly repoDir: string;
  readonly checkCommand: readonly string[];
  readonly vcs: LocalVcs;
  readonly ref: ChangeRequestRef;
  readonly workItem: { id: string; key: string; criteria: readonly string[] };
  readonly verifier: { runtime: AgentRuntime; role: RoleDefinition; name: string };
  readonly taskId: string;
  readonly attempt: number;
  readonly onEvent?: (e: AgentEvent) => void;
}

export interface VerifyResult {
  readonly verdict?: AcceptedVerdict;
  readonly spend: { tokensIn: number; tokensOut: number; usd: number };
  readonly checksPassed: boolean;
}

export async function verifyChange(o: VerifyOptions): Promise<VerifyResult> {
  const emit = o.onEvent ?? (() => {});
  const diff = await o.vcs.getDiff(o.ref);
  const checks = await o.vcs.runChecks(o.ref);

  const worktree = await Worktree.create({
    repoDir: o.repoDir,
    branch: o.ref.branch,
    taskId: o.taskId,
    claimedBranches: [],
  });

  let verdict: AcceptedVerdict | undefined;
  let spend = { tokensIn: 0, tokensOut: 0, usd: 0 };

  try {
    const gateway = new McpToolGateway({
      handlers: verifierHandlers({
        worktree,
        pool: o.pool,
        workItemId: o.workItem.id,
        workItemKey: o.workItem.key,
        checkCommand: o.checkCommand,
        criterionCount: o.workItem.criteria.length,
        onVerdict: (v) => { verdict = v; },
        verifier: {
          agent: o.verifier.name,
          vendor: o.verifier.runtime.vendor,
          model: o.verifier.role.model?.model ?? 'unknown',
          spent: () => spend,
        },
      }) as Map<ToolName, ToolHandler>,
      audit: new PgAuditSink(o.pool),
      effects: new PgEffectStore(o.pool),
      grantsFor: () => resolveGrants(o.verifier.role),
    });

    const invoke = async (tool: string, args: unknown) => {
      const req: ToolCallRequest = {
        taskId: o.taskId,
        agentId: o.verifier.name,
        roleKind: 'verify',
        grants: o.verifier.role.tools,
        tool,
        args,
        attempt: o.attempt,
      };
      return gateway.call(req);
    };

    for await (const event of o.verifier.runtime.run({
      role: o.verifier.role,
      context: {
        workItemKey: o.workItem.key,
        artifactType: 'code_change',
        acceptanceCriteria: o.workItem.criteria,
        attempt: o.attempt,
        diff: diff.text,
        checkResults: { ok: checks.ok, summary: checks.summary, output: checks.output },
      },
      tools: o.verifier.role.tools,
      limits: {
        maxMinutes: o.verifier.role.limits.max_minutes,
        maxTokens: o.verifier.role.limits.max_tokens,
        maxUsd: o.verifier.role.limits.max_usd,
      },
      signal: AbortSignal.timeout(o.verifier.role.limits.max_minutes * 60_000),
      invoke,
    })) {
      if (event.t === 'usage') {
        spend = {
          tokensIn: spend.tokensIn + event.tokensIn,
          tokensOut: spend.tokensOut + event.tokensOut,
          usd: event.usd,
        };
      }
      emit(event);
    }
  } finally {
    await worktree.destroy();
  }

  return {
    ...(verdict === undefined ? {} : { verdict }),
    spend,
    checksPassed: checks.ok,
  };
}

export { acceptVerdict };
