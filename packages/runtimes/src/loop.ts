/**
 * The agent loop, written once.
 *
 * Every vendor has its own request shape, but the parts that are easy to get
 * wrong — settling exactly once, honouring the abort signal, stopping on the
 * budget, routing every tool call through the gateway — are identical, and a
 * bug in any of them is a hung task or a runaway bill. So they live here, and
 * an adapter supplies only the translation to and from its API.
 *
 * Termination is structural: a vendor reports whether it wants another tool,
 * and the loop ends when it does not. Nothing here parses prose looking for a
 * model saying it is finished, and the iteration cap is a backstop against a
 * pathological loop, never the primary stop.
 */

import type { AgentEvent, RunRequest, ToolInvoker } from '@shura/ports';
import { costOf } from '@shura/model-gateway';
import { internalToolName, type Vendor } from '@shura/core';

export interface VendorToolCall {
  readonly id: string;
  readonly name: string;
  /** Already parsed. Vendors differ — Anthropic sends an object, OpenAI a JSON
   *  string — so the adapter parses and this is always structured. */
  readonly args: unknown;
}

export interface VendorToolResult {
  readonly id: string;
  readonly name: string;
  readonly output: unknown;
  readonly isError: boolean;
}

export interface VendorTurn {
  readonly reasoning?: string;
  readonly text?: string;
  readonly toolCalls: readonly VendorToolCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** True when the model is finished and wants no further tool. */
  readonly done: boolean;
  /** Set when the vendor declined the request outright. */
  readonly refusal?: string;
  /** Set when the vendor stopped because its own output cap was reached. */
  readonly truncated?: boolean;
  /**
   * The vendor paused mid-turn and needs another round to continue, without
   * asking for a tool. Anthropic signals this with `pause_turn`. Treating it as
   * finished would silently truncate the answer; treating it as a contract
   * violation would fail a healthy run.
   */
  readonly continueWithoutTools?: boolean;
}

/** One vendor conversation. The adapter owns the transcript; the loop does not. */
export interface VendorConversation {
  turn(): Promise<VendorTurn>;
  submitToolResults(results: readonly VendorToolResult[]): void;
}

/** Backstop only — the real stops are `done`, the budget, and the signal. */
export const MAX_ITERATIONS = 100;

/**
 * How many times the same call may be denied before the run gives up.
 *
 * A model that cannot get past a denial will keep trying, and every attempt
 * costs tokens. Observed in practice: thirteen identical denied reads, $0.15,
 * no progress. The loop cap would eventually have caught it; the budget would
 * have caught it later and more expensively.
 */
export const MAX_REPEATED_DENIALS = 3;

export interface LoopOptions {
  readonly vendor: Vendor;
  readonly model: string;
  readonly conversation: VendorConversation;
  readonly req: RunRequest;
}

export async function* runAgentLoop(opts: LoopOptions): AsyncIterable<AgentEvent> {
  const { vendor, model, conversation, req } = opts;
  let tokensIn = 0;
  let tokensOut = 0;
  let usd = 0;
  const denials = new Map<string, number>();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (req.signal.aborted) {
      yield { t: 'error', message: `aborted: ${abortReason(req.signal)}` };
      return;
    }

    let turn: VendorTurn;
    try {
      turn = await conversation.turn();
    } catch (err) {
      yield { t: 'error', message: `${vendor}: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }

    tokensIn += turn.tokensIn;
    tokensOut += turn.tokensOut;
    const cost = costOf(vendor, model, tokensIn, tokensOut);
    usd = cost.usd;

    if (turn.reasoning !== undefined && turn.reasoning !== '') {
      yield { t: 'reasoning', text: turn.reasoning };
    }
    yield { t: 'usage', tokensIn: turn.tokensIn, tokensOut: turn.tokensOut, usd };

    if (turn.refusal !== undefined) {
      yield { t: 'error', message: `${vendor} declined the request: ${turn.refusal}` };
      return;
    }

    // Budget. Checked after the turn is accounted for, so the ceiling is a
    // ceiling rather than something we only notice having blown past.
    if (tokensIn + tokensOut > req.limits.maxTokens) {
      yield { t: 'error', message: `budget exhausted: token ceiling reached (${tokensIn + tokensOut})` };
      return;
    }
    if (cost.known && usd > req.limits.maxUsd) {
      yield { t: 'error', message: `budget exhausted: spend ceiling reached ($${usd.toFixed(2)})` };
      return;
    }

    if (turn.truncated === true) {
      yield { t: 'error', message: `${vendor} stopped at its output cap before finishing` };
      return;
    }

    if (turn.done) {
      yield { t: 'result', output: turn.text ?? '' };
      return;
    }

    if (turn.continueWithoutTools === true) {
      // Paused, not finished. The adapter has already pushed the partial turn
      // back onto its transcript; go round again.
      continue;
    }

    if (turn.toolCalls.length === 0) {
      // Not done, asking for nothing, not paused: a vendor contract violation,
      // not a state to spin on.
      yield { t: 'error', message: `${vendor} returned no tool calls and did not finish` };
      return;
    }

    const results: VendorToolResult[] = [];
    for (const raw of turn.toolCalls) {
      // Vendors see dot-free names; everything inside uses ours. Translating
      // here means one place handles it rather than four adapters each
      // remembering to.
      const internal = internalToolName(raw.name);
      const call = internal === undefined ? raw : { ...raw, name: internal };
      if (req.signal.aborted) {
        yield { t: 'error', message: `aborted: ${abortReason(req.signal)}` };
        return;
      }
      yield { t: 'tool_call', tool: call.name, args: call.args };

      const outcome = await invokeSafely(req.invoke, call);

      if (outcome.allowed) {
        yield { t: 'tool_result', ok: true };
        results.push({ id: call.id, name: call.name, output: outcome.output, isError: false });
        if (call.name === 'repo.write') {
          const path = pathOf(call.args);
          if (path !== undefined) yield { t: 'file_change', path };
        }
      } else {
        // A denial is returned to the model, not thrown. It is the only way the
        // model can learn it asked for something it may not have, or got the
        // arguments wrong — and a validation denial is explicitly retryable.
        yield { t: 'tool_result', ok: false, denialReason: outcome.denialReason };

        const signature = `${call.name}:${JSON.stringify(call.args)}`;
        const seen = (denials.get(signature) ?? 0) + 1;
        denials.set(signature, seen);
        if (seen >= MAX_REPEATED_DENIALS) {
          yield {
            t: 'error',
            message:
              `the same call was denied ${seen} times and is not getting through: ` +
              `${call.name} — ${outcome.denialReason}`,
          };
          return;
        }

        results.push({
          id: call.id,
          name: call.name,
          output: {
            error: outcome.denialReason,
            category: outcome.errorCategory,
            retryable: outcome.isRetryable,
          },
          isError: true,
        });
      }
    }

    conversation.submitToolResults(results);
  }

  yield { t: 'error', message: `stopped after ${MAX_ITERATIONS} iterations without finishing` };
}

async function invokeSafely(invoke: ToolInvoker, call: VendorToolCall) {
  try {
    return await invoke(call.name, call.args);
  } catch (err) {
    return {
      allowed: false as const,
      errorCategory: 'transient' as const,
      isRetryable: true,
      denialReason: `tool invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function pathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === 'string' ? r : r instanceof Error ? r.message : 'signal';
}
