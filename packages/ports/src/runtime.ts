import type { RoleDefinition, Vendor } from '@shura/core';
import type { ToolCallResult } from './gateway.js';

/** What an agent streams back while it works. */
export type AgentEvent =
  | { readonly t: 'reasoning'; readonly text: string }
  | { readonly t: 'tool_call'; readonly tool: string; readonly args: unknown }
  | { readonly t: 'tool_result'; readonly ok: boolean; readonly denialReason?: string }
  | { readonly t: 'file_change'; readonly path: string }
  | {
      readonly t: 'usage';
      readonly tokensIn: number;
      readonly tokensOut: number;
      readonly usd: number;
      /** Prefix served from the vendor's cache, at a fraction of the price. */
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    }
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
  readonly title?: string;
  /**
   * The request as the human wrote it, free-form.
   *
   * Only the planner sees this. Once a plan is approved, the criteria it
   * produced are what the work is judged against — handing the raw request on
   * to the reviewer as well would give it a second, vaguer standard to judge
   * by, and a reviewer with two standards has none.
   */
  readonly request?: string;
  /** The approved plan, for a task that is carrying one out. */
  readonly plan?: ApprovedPlan;
  /** Output of the last failing build, when an attempt is being sent back. */
  readonly buildFailure?: string;
}

/** The parts of an approved plan a builder needs. */
export interface ApprovedPlan {
  readonly understanding: string;
  readonly approach: string;
  readonly files: readonly { readonly path: string; readonly reason: string }[];
  readonly outOfScope: readonly string[];
  /** Questions the approver answered, paired with their answers. */
  readonly answeredQuestions?: readonly { readonly question: string; readonly answer: string }[];
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
  /**
   * Where the agent works, for a runtime that drives a CLI.
   *
   * An API-backed runtime has no use for this: its agent touches files only
   * through `invoke`, which is already bound to a worktree. A CLI-backed one
   * runs a real process that has to start somewhere, and that somewhere must
   * be the task's worktree rather than wherever Shura happens to be running.
   */
  readonly workdir?: string;
  /**
   * The JSON Schema the agent's final answer must match.
   *
   * How a plan and a verdict come back from a CLI-driven agent. The API path
   * had them call a tool; a CLI agent has no access to Shura's tools, so the
   * CLIs' own structured-output flags carry it instead — `--json-schema` for
   * claude, `--output-schema` for codex.
   *
   * Nothing about validation moves: `acceptPlan` and `acceptVerdict` still run
   * on the result, so full criterion coverage and the server-side recomputation
   * of a decision are unchanged. This only replaces the transport.
   */
  readonly outputSchema?: Record<string, unknown>;
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
