import type { TaskKind } from '@forge/core';

export interface TaskRecord {
  readonly id: string;
  readonly workItemId: string;
  readonly artifactType: string;
  readonly kind: TaskKind;
  readonly role: string;
  readonly agentId: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly parentTaskId: string | null;
}

export interface ClaimRequest {
  readonly agentId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly fileGlobs: readonly string[];
  readonly ttlSeconds: number;
}

export type ClaimResult =
  | { readonly granted: true; readonly claimId: string; readonly expiresAt: Date }
  | { readonly granted: false; readonly conflictsWith: string; readonly reason: string };

/**
 * Durable orchestration. Postgres implements this for now; Temporal replaces it
 * without the state machine changing, which is the whole reason it is a port.
 */
export interface WorkflowEngine {
  enqueue(task: Omit<TaskRecord, 'id' | 'status'>): Promise<string>;
  claimNext(agentId: string): Promise<TaskRecord | null>;
  complete(taskId: string, outcome: 'succeeded' | 'failed', detail?: unknown): Promise<void>;
  scheduleTimer(taskId: string, fireAt: Date, kind: string, payload?: unknown): Promise<void>;
  waitForSignal(taskId: string, signal: string): Promise<unknown>;
}

export interface Claims {
  acquire(req: ClaimRequest): Promise<ClaimResult>;
  heartbeat(claimId: string): Promise<boolean>;
  release(claimId: string): Promise<void>;
}

export interface SandboxHandle {
  readonly id: string;
  readonly workdir: string;
  exec(cmd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  destroy(): Promise<void>;
}

export interface Sandbox {
  create(opts: { branch: string; taskId: string }): Promise<SandboxHandle>;
}
