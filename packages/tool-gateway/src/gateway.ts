/**
 * The single door. Every tool call an agent makes passes through here to be
 * permission-checked, schema-validated, deduplicated, given credentials, and
 * appended to an audit log the agent cannot reach.
 *
 * Order matters. Permission first, because a role that may not call a tool
 * should not have its arguments parsed, let alone reach an effect key. Then
 * validation, because the key is derived from the arguments. Then the effect
 * claim, then the handler.
 *
 * Credentials are handed to the handler, never to the agent, and never appear
 * in a result or an error message.
 */

import {
  ToolArgsInvalid,
  deriveEffectKey,
  hashArgs,
  isReclaimable,
  validateToolArgs,
  type ToolName,
} from '@forge/core';
import type {
  EffectStore,
  ErrorCategory,
  ToolCallRequest,
  ToolCallResult,
  ToolGateway,
} from '@forge/ports';
import { checkCall, type ResolvedGrants } from './permissions.js';

export interface ToolCallAudit {
  readonly taskId: string;
  readonly agentId: string;
  readonly tool: string;
  readonly argsHash: string;
  readonly allowed: boolean;
  readonly errorCategory?: ErrorCategory;
  readonly denialReason?: string;
  readonly at: Date;
}

/** Append-only by contract. The Postgres implementation holds no UPDATE or
 *  DELETE grant, so this cannot be rewritten after the fact. */
export interface AuditSink {
  record(entry: ToolCallAudit): Promise<void>;
}

export interface ToolInvocation {
  readonly args: unknown;
  readonly credentials: Readonly<Record<string, string>>;
  readonly taskId: string;
  readonly agentId: string;
}

export type ToolHandler = (invocation: ToolInvocation) => Promise<unknown>;

export interface CredentialProvider {
  /** Short-lived, scoped to this call. */
  issue(tool: ToolName, taskId: string): Promise<Readonly<Record<string, string>>>;
}

export class InMemoryAuditSink implements AuditSink {
  readonly entries: ToolCallAudit[] = [];
  async record(entry: ToolCallAudit): Promise<void> {
    this.entries.push(entry);
  }
  denials(): ToolCallAudit[] {
    return this.entries.filter((e) => !e.allowed);
  }
}

export class NoCredentials implements CredentialProvider {
  async issue(): Promise<Readonly<Record<string, string>>> {
    return {};
  }
}

export interface GatewayOptions {
  readonly handlers: ReadonlyMap<ToolName, ToolHandler>;
  readonly audit: AuditSink;
  readonly credentials?: CredentialProvider;
  /** Absent means no deduplication — acceptable only in tests with no side effects. */
  readonly effects?: EffectStore;
  readonly grantsFor: (req: ToolCallRequest) => ResolvedGrants;
}

interface Denial {
  category: ErrorCategory;
  retryable: boolean;
  reason: string;
}

export class McpToolGateway implements ToolGateway {
  readonly #opts: GatewayOptions;
  readonly #credentials: CredentialProvider;

  constructor(opts: GatewayOptions) {
    this.#opts = opts;
    this.#credentials = opts.credentials ?? new NoCredentials();
  }

  async call(req: ToolCallRequest): Promise<ToolCallResult> {
    const grants = this.#opts.grantsFor(req);

    // 1. Permission. A role that may not call this never gets further.
    const permissionDenial = checkCall(grants, req.tool);
    if (permissionDenial !== undefined) {
      return this.#deny(req, {
        category: 'permission',
        retryable: false,
        reason: permissionDenial,
      });
    }
    const tool = req.tool as ToolName;

    // 2. Arguments. A loose schema is how a model invents a parameter, and the
    //    effect key below is derived from these values.
    let args: unknown;
    try {
      args = validateToolArgs(tool, req.args);
    } catch (err) {
      if (!(err instanceof ToolArgsInvalid)) throw err;
      return this.#deny(req, { category: 'validation', retryable: true, reason: err.message });
    }

    const handler = this.#opts.handlers.get(tool);
    if (handler === undefined) {
      return this.#deny(req, {
        category: 'transient',
        retryable: false,
        reason: `"${tool}" is granted but no handler is registered`,
      });
    }

    // 3. Effect key, for anything that writes.
    const key = deriveEffectKey(tool, args, { taskId: req.taskId, attempt: req.attempt });
    const store = this.#opts.effects;

    if (key !== undefined && store !== undefined) {
      const claim = await store.begin(key, tool, req.taskId, isReclaimable(tool));

      if (claim.state === 'completed') {
        await this.#audit(req, true);
        return { allowed: true, output: claim.result, replayed: true };
      }
      if (claim.state === 'in_flight') {
        // Somebody claimed this and never came back. Whether the effect landed
        // is unknowable, so a human decides rather than us guessing.
        return this.#deny(req, {
          category: 'business',
          retryable: false,
          reason:
            `effect "${key}" has been in flight since ${claim.since.toISOString()}; a previous ` +
            `attempt died mid-effect and whether it landed is unknown — escalating rather than repeating it`,
        });
      }
    }

    const credentials = await this.#credentials.issue(tool, req.taskId);

    try {
      const output = await handler({
        args,
        credentials,
        taskId: req.taskId,
        agentId: req.agentId,
      });
      if (key !== undefined && store !== undefined) await store.complete(key, output);
      await this.#audit(req, true);
      return { allowed: true, output };
    } catch (err) {
      // The handler gave control back, so this attempt is over and a retry is
      // safe — unlike a claim nobody ever released.
      const reason = redact(err instanceof Error ? err.message : String(err), credentials);
      if (key !== undefined && store !== undefined) await store.fail(key, reason);
      return this.#deny(req, {
        category: 'transient',
        retryable: true,
        reason: `handler failed: ${reason}`,
      });
    }
  }

  async #deny(req: ToolCallRequest, d: Denial): Promise<ToolCallResult> {
    await this.#audit(req, false, d);
    return {
      allowed: false,
      errorCategory: d.category,
      isRetryable: d.retryable,
      denialReason: d.reason,
    };
  }

  async #audit(req: ToolCallRequest, allowed: boolean, d?: Denial): Promise<void> {
    await this.#opts.audit.record({
      taskId: req.taskId,
      agentId: req.agentId,
      tool: req.tool,
      argsHash: hashArgs(req.args),
      allowed,
      ...(d === undefined ? {} : { errorCategory: d.category, denialReason: d.reason }),
      at: new Date(),
    });
  }
}

function redact(message: string, credentials: Readonly<Record<string, string>>): string {
  let out = message;
  for (const value of Object.values(credentials)) {
    if (value.length >= 8) out = out.split(value).join('[redacted]');
  }
  return out;
}
