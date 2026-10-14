import type { RoleDefinition, Vendor } from '@forge/core';

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

export interface RunRequest {
  readonly role: RoleDefinition;
  readonly context: TaskContext;
  /** Resolved by the tool gateway from the role, never read from the role file
   *  directly — the gateway is the only thing that may decide what is granted. */
  readonly tools: readonly string[];
  readonly limits: RunLimits;
  readonly signal: AbortSignal;
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
