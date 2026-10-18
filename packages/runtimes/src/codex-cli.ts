/**
 * The OpenAI half of a cross-vendor pair, driven as a subprocess.
 *
 * `codex exec` rather than the OpenAI API, for one reason that decides whether
 * anyone adopts this: it authenticates with the user's existing ChatGPT
 * subscription. Metered API billing on top of a subscription a developer
 * already pays for is a second bill, and a second bill is why a tool does not
 * get used.
 *
 * It also makes rule 2 stronger than Shura could make it alone. A verify role
 * runs under `-s read-only`, which is an operating-system sandbox, not a
 * withheld tool: a reviewer that tried to write would be refused by the kernel
 * even if a bug in our own code had handed it the means. Probed against the
 * real CLI, the agent attempts the write and reports back
 * "operation not permitted".
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Vendor } from '@shura/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { systemPrompt, userPrompt } from './prompt.js';

/**
 * What the agent may do to the filesystem.
 *
 * `read-only` for anything judging, `workspace-write` for anything building.
 * `danger-full-access` exists in the CLI and is deliberately not offered here.
 */
export type Sandbox = 'read-only' | 'workspace-write';

/**
 * "Whatever this subscription provides."
 *
 * Under an API key a model is named and billed. Under a subscription the
 * account decides, and naming one it does not serve is a hard failure rather
 * than a downgrade. Roles that run on a CLI say this instead of guessing, and
 * what actually answered is recorded as `default` because the stream does not
 * report it — which is the honest value, not a placeholder.
 */
export const DEFAULT_MODEL = 'default';

export interface CodexCliOptions {
  /** Overridable for tests; the real one is found on PATH. */
  readonly bin?: string;
  /** Test seam: replaces the whole subprocess with a scripted stream. */
  readonly spawnFn?: typeof spawn;
}

/** The event shapes `codex exec --json` emits, as observed from the live CLI. */
interface CodexEvent {
  readonly type: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly id?: string;
    readonly type?: string;
    readonly text?: string;
    readonly command?: string;
    readonly path?: string;
    readonly changes?: readonly { readonly path?: string }[];
  };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cached_input_tokens?: number;
    readonly cache_write_input_tokens?: number;
  };
  readonly error?: { readonly message?: string } | string;
  readonly message?: string;
}

/**
 * OpenAI's structured output requires `required` to list every key in
 * `properties`; an omitted key is a 400, not a permitted optional. Optionality
 * is expressed by letting the type be null instead.
 *
 * Recursive, because the constraint applies at every level. This was learned
 * twice before — once on a top-level optional, then on one nested inside an
 * array item — and then lost: the fix lived in the OpenAI API adapter, and
 * deleting that adapter deleted it. A live reviewer hit the identical 400 on
 * `extraFindings`, which carries a `.default([])` and so is optional.
 *
 * Anthropic accepts the same schema unchanged, which is why this belongs at
 * this vendor's boundary rather than in the shared contract.
 */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return rewrite(schema) as Record<string, unknown>;
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };

  for (const key of ['items', 'additionalItems', 'not'] as const) {
    if (out[key] !== undefined) out[key] = rewrite(out[key]);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(rewrite);
  }

  const properties = out['properties'];
  if (typeof properties === 'object' && properties !== null) {
    const required = new Set(Array.isArray(out['required']) ? (out['required'] as string[]) : []);
    const rewritten: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
      const prop = rewrite(raw) as Record<string, unknown>;
      if (!required.has(key) && typeof prop['type'] === 'string') {
        prop['type'] = [prop['type'], 'null'];
      }
      rewritten[key] = prop;
    }

    out['properties'] = rewritten;
    out['required'] = Object.keys(properties as Record<string, unknown>);
  }

  return out;
}

export class CodexCliRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'openai';
  readonly id = 'codex-cli';
  readonly #bin: string;
  readonly #spawn: typeof spawn;

  constructor(options: CodexCliOptions = {}) {
    this.#bin = options.bin ?? 'codex';
    this.#spawn = options.spawnFn ?? spawn;
  }

  run(req: RunRequest): AsyncIterable<AgentEvent> {
    return this.#stream(req);
  }

  async *#stream(req: RunRequest): AsyncIterable<AgentEvent> {
    const sandbox: Sandbox = req.role.kind === 'verify' ? 'read-only' : 'workspace-write';
    const model = req.role.model?.model;
    if (model === undefined) {
      yield { t: 'error', message: `role "${req.role.id}" declares no model` };
      return;
    }

    // codex takes its schema as a file and writes the final answer to another,
    // unlike claude which does both inline. Cleaned up in the finally below.
    const scratch =
      req.outputSchema === undefined ? undefined : mkdtempSync(join(tmpdir(), 'shura-codex-'));
    const schemaPath = scratch === undefined ? undefined : join(scratch, 'schema.json');
    const answerPath = scratch === undefined ? undefined : join(scratch, 'answer.json');
    if (schemaPath !== undefined && req.outputSchema !== undefined) {
      writeFileSync(schemaPath, JSON.stringify(strictSchema(req.outputSchema)), 'utf8');
    }

    const argv = [
      'exec',
      '--json',
      '-s',
      sandbox,
      // Without this a lane inherits whatever MCP servers and settings the
      // operator happens to have configured, which is neither reproducible nor
      // something the role definition can account for.
      '--ignore-user-config',
      // No session files left behind for a run whose record lives in Postgres.
      '--ephemeral',
      '--skip-git-repo-check',
      // A subscription does not offer every model. Asking for one it does not
      // serve fails the run outright — the live CLI answers
      // "The 'gpt-5.1-codex' model is not supported when using Codex with a
      // ChatGPT account" — so DEFAULT_MODEL means "whatever this account gets",
      // and the flag is omitted entirely.
      ...(model === DEFAULT_MODEL ? [] : ['-m', model]),
      ...(req.workdir === undefined ? [] : ['-C', req.workdir]),
      ...(schemaPath === undefined ? [] : ['--output-schema', schemaPath]),
      ...(answerPath === undefined ? [] : ['-o', answerPath]),
      // The role's instructions and the task, as one prompt. codex has no
      // separate system-prompt flag, so the framing is prepended.
      `${systemPrompt(req)}\n\n---\n\n${userPrompt(req)}`,
    ];

    const child = this.#spawn(this.#bin, argv, {
      ...(req.workdir === undefined ? {} : { cwd: req.workdir }),
      // Forcing subscription auth: a key in the environment would silently
      // bill the user per token for work their subscription already covers,
      // which is the entire thing this runtime exists to avoid.
      env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const abort = (): void => {
      child.kill('SIGTERM');
    };
    req.signal.addEventListener('abort', abort, { once: true });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    let finalText = '';
    let sawUsage = false;

    try {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        let event: CodexEvent;
        try {
          event = JSON.parse(trimmed) as CodexEvent;
        } catch {
          // A line that is not JSON is the CLI talking to a human, not an
          // event. Dropping it is right; failing the run over it is not.
          continue;
        }

        for (const mapped of mapEvent(event)) {
          if (mapped.t === 'usage') sawUsage = true;
          if (mapped.t === 'reasoning') finalText = mapped.text;
          yield mapped;
        }
      }

      const code = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('close', (c) => resolve(c ?? -1));
      });

      if (req.signal.aborted) {
        yield { t: 'error', message: `aborted: ${String(req.signal.reason ?? 'timeout')}` };
        return;
      }
      if (code !== 0) {
        yield {
          t: 'error',
          message: `codex exited ${code}${stderr.trim() === '' ? '' : `: ${lastLine(stderr)}`}`,
        };
        return;
      }
      // No events at all is a launch that failed, not a short run. Reporting it
      // as a clean finish would let an empty result read as agreement.
      if (!sawUsage && finalText === '') {
        yield {
          t: 'error',
          message: `codex produced no output${stderr.trim() === '' ? '' : `: ${lastLine(stderr)}`}`,
        };
        return;
      }
      // The structured answer, when one was asked for. Read from the file
      // rather than scraped from the message stream: the stream carries the
      // agent's prose, and a verdict parsed out of prose is a verdict nobody
      // can trust.
      yield { t: 'result', output: readAnswer(answerPath) ?? finalText };
    } finally {
      req.signal.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** One codex event to zero or more of ours. Exported for the mapping tests. */
export function mapEvent(event: CodexEvent): AgentEvent[] {
  switch (event.type) {
    case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'agent_message' && (item.text ?? '') !== '') {
        return [{ t: 'reasoning', text: item.text! }];
      }
      if (item.type === 'command_execution') {
        return [
          { t: 'tool_call', tool: 'shell', args: { command: item.command ?? '' } },
          { t: 'tool_result', ok: true },
        ];
      }
      if (item.type === 'file_change') {
        const paths = (item.changes ?? []).map((c) => c.path).filter((p): p is string => p !== undefined);
        const all = paths.length > 0 ? paths : item.path === undefined ? [] : [item.path];
        return all.map((path) => ({ t: 'file_change', path }));
      }
      return [];
    }

    case 'turn.completed': {
      const u = event.usage ?? {};
      return [
        {
          t: 'usage',
          tokensIn: u.input_tokens ?? 0,
          tokensOut: u.output_tokens ?? 0,
          // No dollar figure. A subscription run has no per-token price, and
          // writing 0 would read as "this was free" rather than "not metered".
          // costOf() reports `known: false` for exactly this case.
          usd: 0,
          ...(u.cached_input_tokens === undefined ? {} : { cacheRead: u.cached_input_tokens }),
          ...(u.cache_write_input_tokens === undefined
            ? {}
            : { cacheWrite: u.cache_write_input_tokens }),
        },
      ];
    }

    case 'error':
    case 'turn.failed': {
      const detail =
        typeof event.error === 'string'
          ? event.error
          : (event.error?.message ?? event.message ?? 'codex reported a failure');
      return [{ t: 'error', message: detail }];
    }

    // thread.started and turn.started carry no information the orchestrator
    // acts on; the thread id is in the raw log if a run ever needs tracing.
    default:
      return [];
  }
}

/** The structured answer, or undefined when there was not one. */
function readAnswer(path: string | undefined): unknown {
  if (path === undefined) return undefined;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw === '' ? undefined : JSON.parse(raw);
  } catch {
    // No file, or not JSON. The caller falls back to the final message, and
    // acceptVerdict rejects it with a message the agent can act on.
    return undefined;
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter((l) => l.trim() !== '');
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}
