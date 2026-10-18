/**
 * Running one agent to completion.
 *
 * Every flow in this package goes through here, which is what makes the gateway
 * unavoidable: an adapter is handed `invoke` and nothing else, so it cannot
 * reach a tool without passing the permission check, the schema, the
 * idempotency claim and the audit write.
 */

import type { RoleDefinition, TaskKind } from '@shura/core';
import type { AgentEvent, AgentRuntime, RunLimits, TaskContext, ToolCallRequest } from '@shura/ports';
import type { McpToolGateway } from '@shura/tool-gateway';

export interface DriveOptions {
  readonly role: RoleDefinition;
  readonly context: TaskContext;
  /** Where a CLI-driven agent works. Ignored by anything API-backed. */
  readonly workdir?: string;
  /** The shape the agent's final answer must take, when it must take one. */
  readonly outputSchema?: Record<string, unknown>;
  readonly tools: readonly string[];
  readonly limits: RunLimits;
  readonly taskId: string;
  readonly agentId: string;
  readonly kind: Exclude<TaskKind, 'admit'>;
  readonly gateway: McpToolGateway;
  readonly emit: (e: AgentEvent) => void;
}

export interface DriveResult {
  readonly usd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** The agent's closing message, when it gave one. */
  readonly finalText?: string;
  /**
   * The agent's final answer as a structure, when a schema was asked for.
   *
   * How a plan and a verdict come back from a CLI-driven agent, which cannot
   * reach Shura's tools. Still validated by acceptPlan/acceptVerdict — this is
   * the transport, not the contract.
   */
  readonly output?: unknown;
  /**
   * Why the agent stopped, when it stopped badly.
   *
   * This exists because its absence caused a real failure: a builder hit its
   * spend ceiling partway through, the loop ended, and the caller — having no
   * way to tell "finished" from "cut off" — ran the checks, committed and
   * pushed a half-written change as though it were complete work. The checks
   * passed, because half a change often does.
   *
   * An agent that errored has not finished. Callers must not publish its work.
   */
  readonly error?: string;
}

export async function drive(runtime: AgentRuntime, o: DriveOptions): Promise<DriveResult> {
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let finalText: string | undefined;
  let output: unknown;
  let error: string | undefined;

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
    ...(o.workdir === undefined ? {} : { workdir: o.workdir }),
    ...(o.outputSchema === undefined ? {} : { outputSchema: o.outputSchema }),
  })) {
    if (event.t === 'usage') {
      usd = event.usd;
      tokensIn += event.tokensIn;
      tokensOut += event.tokensOut;
    }
    // Kept because a fixing reviewer's closing message is the only account a
    // human gets of what it changed after the review, and it goes into the
    // pull request.
    if (event.t === 'result') {
      if (typeof event.output === 'string') {
        if (event.output.trim() !== '') finalText = event.output;
      } else if (event.output !== undefined && event.output !== null) {
        output = event.output;
      }
    }
    // The last one wins: the loop yields at most one terminal error and then
    // stops, so this is why it stopped rather than something it recovered from.
    if (event.t === 'error') error = event.message;
    o.emit(event);
  }
  return {
    usd,
    tokensIn,
    tokensOut,
    ...(finalText === undefined ? {} : { finalText }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  };
}

export function modelOf(role: RoleDefinition): string {
  return role.model?.model ?? 'deterministic';
}

export function limitsOf(role: RoleDefinition): RunLimits {
  return {
    maxMinutes: role.limits.max_minutes,
    maxTokens: role.limits.max_tokens,
    maxUsd: role.limits.max_usd,
  };
}
