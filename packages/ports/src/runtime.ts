import type { RoleDefinition, Vendor } from '@forge/core';
import type { ToolCallResult } from './gateway.js';

/** What an agent streams back while it works. */
export type AgentEvent =
  | { readonly t: 'reasoning'; readonly text: string }
  | { readonly t: 'tool_call'; readonly tool: string; readonly args: unknown }
  | { readonly t: 'tool_result'; readonly ok: boolean; readonly denialReason?: string }
  | { readonly t: 'file_change'; readonly path: string }
  | { readonly t: 'usage'; readonly tokensIn: number; readonly tokensOut: number; readonly usd: number }
  | { readonly t: 'result'; readonly output: unknown }
  | { readonly t: 'error'; readonly message: string };

export interface TaskContext {
  readonly workItemKey: string;
  readonly artifactType: string;
  readonly acceptanceCriteria: readonly string[];
  /** Findings from the previous attempt, when this is rework. */
  readonly priorFindings?: readonly unknown[];
  readonly attempt: number;
  readonly repoRules?: string;
  readonly lessons?: readonly string[];
  readonly diff?: string;
  readonly checkResults?: unknown;
}

export interface RunLimits {
  readonly maxMinutes: number;
  readonly maxTokens: number;
  readonly maxUsd: number;
}

/**
 * How an adapter executes a tool.
 *
 * Every call goes through this and nowhere else, so an adapter cannot reach a
 * tool without passing the gateway's permission check, schema validation,
 * idempotency claim and audit write. Adapters therefore never see the gateway,
 * credentials, or the task identity — the worker binds those before handing
 * this down.
 */
export type ToolInvoker = (tool: string, args: unknown) => Promise<ToolCallResult>;

export interface RunRequest {
  readonly role: RoleDefinition;
  readonly context: TaskContext;
  /** Grant names, resolved by the tool gateway — never read from the role file. */
  readonly tools: readonly string[];
  readonly limits: RunLimits;
  readonly signal: AbortSignal;
  readonly invoke: ToolInvoker;
}

/**
 * One interface, every vendor behind it.
 *
 * `vendor` is declared by the adapter rather than read from configuration. Rule
 * 1 compares this string, so it must not be something a client could mistype
 * into agreement with the producer's.
 */
export interface AgentRuntime {
  readonly vendor: Vendor;
  readonly id: string;
  run(req: RunRequest): AsyncIterable<AgentEvent>;
}
