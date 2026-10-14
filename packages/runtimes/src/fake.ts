/**
 * The deterministic runtime.
 *
 * It exists so the whole pipeline — scheduling, the invariant, the gateway, the
 * state machine — can be tested end to end without a network call or a cent of
 * spend, and so a failing test means the platform is wrong rather than a model
 * having had a bad day.
 *
 * It declares a vendor like any other adapter, which means rule 1 applies to it
 * too: two fakes on the same vendor cannot verify each other.
 */

import type { AgentEvent, AgentRuntime, RunRequest } from '@forge/ports';
import type { Vendor } from '@forge/core';

export type FakeScript = (req: RunRequest) => readonly AgentEvent[];

export interface FakeRuntimeOptions {
  readonly vendor: Vendor;
  readonly id?: string;
  readonly script: FakeScript | readonly AgentEvent[];
  /** Simulated per-event delay, so abort behaviour is observable. */
  readonly tickMs?: number;
}

export class FakeRuntime implements AgentRuntime {
  readonly vendor: Vendor;
  readonly id: string;
  readonly calls: RunRequest[] = [];

  readonly #script: FakeScript;
  readonly #tickMs: number;

  constructor(opts: FakeRuntimeOptions) {
    this.vendor = opts.vendor;
    this.id = opts.id ?? `fake-${opts.vendor}`;
    const script = opts.script;
    this.#script = typeof script === 'function' ? script : () => script;
    this.#tickMs = opts.tickMs ?? 0;
  }

  async *run(req: RunRequest): AsyncIterable<AgentEvent> {
    this.calls.push(req);

    let tokensIn = 0;
    let tokensOut = 0;
    let settled = false;

    for (const event of this.#script(req)) {
      if (req.signal.aborted) {
        yield { t: 'error', message: `aborted: ${describeAbort(req.signal)}` };
        return;
      }
      if (this.#tickMs > 0) await delay(this.#tickMs);

      if (event.t === 'usage') {
        tokensIn += event.tokensIn;
        tokensOut += event.tokensOut;
        if (tokensIn + tokensOut > req.limits.maxTokens) {
          yield event;
          yield { t: 'error', message: 'budget exhausted: token ceiling reached' };
          return;
        }
      }
      if (event.t === 'result' || event.t === 'error') settled = true;
      yield event;
    }

    // Every run settles exactly once. A runtime that just stops leaves a task
    // hanging, which is the failure mode the contract suite exists to catch.
    if (!settled) {
      yield { t: 'error', message: 'script ended without a result' };
    }
  }
}

function describeAbort(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === 'string' ? r : r instanceof Error ? r.message : 'signal';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------------------------------------------------------------- scripts */

/** A producer that writes a file, runs tests and reports a change request. */
export function producerScript(opts: {
  files: readonly string[];
  changeRequestId: string;
  usd?: number;
}): FakeScript {
  return () => [
    { t: 'reasoning', text: 'reading the acceptance criteria' },
    ...opts.files.flatMap(
      (path): AgentEvent[] => [
        { t: 'tool_call', tool: 'repo.write', args: { path } },
        { t: 'tool_result', ok: true },
        { t: 'file_change', path },
      ],
    ),
    { t: 'tool_call', tool: 'test.run', args: {} },
    { t: 'tool_result', ok: true },
    { t: 'usage', tokensIn: 12_000, tokensOut: 3_000, usd: opts.usd ?? 0.12 },
    { t: 'result', output: { changeRequestId: opts.changeRequestId } },
  ];
}

/** A verifier that submits a verdict through its one write channel. */
export function verifierScript(verdict: unknown, usd = 0.42): FakeScript {
  return () => [
    { t: 'reasoning', text: 'reading the diff and the check results' },
    { t: 'tool_call', tool: 'repo.read', args: { path: '.' } },
    { t: 'tool_result', ok: true },
    { t: 'tool_call', tool: 'verdict.submit', args: verdict },
    { t: 'tool_result', ok: true },
    { t: 'usage', tokensIn: 48_200, tokensOut: 12_900, usd },
    { t: 'result', output: verdict },
  ];
}

/** A verifier that tries to fix the code instead of reporting it. The gateway
 *  must deny this; the script is here so that denial is exercised. */
export function overreachingVerifierScript(verdict: unknown): FakeScript {
  return () => [
    { t: 'reasoning', text: 'this is a one-line fix, I will just apply it' },
    { t: 'tool_call', tool: 'repo.write', args: { path: 'src/orders/list.ts' } },
    { t: 'tool_result', ok: false, denialReason: 'denied by gateway' },
    { t: 'tool_call', tool: 'verdict.submit', args: verdict },
    { t: 'tool_result', ok: true },
    { t: 'usage', tokensIn: 40_000, tokensOut: 9_000, usd: 0.3 },
    { t: 'result', output: verdict },
  ];
}
