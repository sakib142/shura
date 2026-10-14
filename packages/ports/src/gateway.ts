import type { TaskKind } from '@shura/core';

export interface ToolCallRequest {
  readonly taskId: string;
  readonly agentId: string;
  readonly roleKind: TaskKind;
  readonly grants: readonly string[];
  readonly tool: string;
  readonly args: unknown;
  /** Part of most idempotency keys: rework is a new attempt, so a producer may
   *  legitimately repeat an effect it performed on the previous pass. */
  readonly attempt: number;
}

/**
 * Why a call failed, in a form the caller can act on.
 *
 * A single opaque string cannot be recovered from: the agent cannot tell a
 * permission denial it must never retry from a transient fault it should, or
 * from a schema error it could fix and resubmit.
 */
export type ErrorCategory =
  /** The role may not do this. Never retryable; the grant set is the answer. */
  | 'permission'
  /** The arguments were wrong. Retryable once the error is fed back. */
  | 'validation'
  /** Something downstream failed and may succeed later. */
  | 'transient'
  /** A rule or a safety stop, not a fault. Needs a human, not a retry. */
  | 'business';

export type ToolCallResult =
  | {
      readonly allowed: true;
      readonly output: unknown;
      /** True when the result came from the effect store rather than the handler. */
      readonly replayed?: boolean;
    }
  | {
      readonly allowed: false;
      readonly errorCategory: ErrorCategory;
      readonly isRetryable: boolean;
      readonly denialReason: string;
    };

/**
 * The single door. Every tool call is permission-checked, schema-validated,
 * deduplicated, has its credentials injected per call, and is appended to an
 * audit log the agent cannot reach.
 */
export interface ToolGateway {
  call(req: ToolCallRequest): Promise<ToolCallResult>;
}

/* ------------------------------------------------------------------ effects */

export type EffectClaim =
  /** The caller owns this effect and must now perform it. */
  | { readonly state: 'claimed' }
  /** Already done. Replay the recorded result; do not call the handler. */
  | { readonly state: 'completed'; readonly result: unknown }
  /**
   * Someone claimed this effect and never came back — the process died
   * mid-effect. Whether the side effect landed is unknowable, so for anything
   * the outside world has seen this escalates instead of being retried.
   */
  | { readonly state: 'in_flight'; readonly since: Date };

export interface EffectStore {
  /** Claims the key, or reports what is already known about it. */
  begin(key: string, tool: string, taskId: string, reclaimable: boolean): Promise<EffectClaim>;
  complete(key: string, result: unknown): Promise<void>;
  /** The handler returned control with an error, so the attempt is over and a
   *  later call may try again — unlike a claim nobody ever released. */
  fail(key: string, reason: string): Promise<void>;
}

export interface ArtifactStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
}
