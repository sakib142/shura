import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ToolCallResult } from '@shura/ports';
import { runAgentLoop, MAX_ITERATIONS, type VendorConversation, type VendorTurn } from './loop.js';
import { contractRequest, drain } from './contract.js';

/** A scripted vendor, so the loop can be tested without a network or a key. */
class ScriptedConversation implements VendorConversation {
  readonly submitted: unknown[][] = [];
  #i = 0;
  constructor(private readonly turns: readonly VendorTurn[]) {}
  async turn(): Promise<VendorTurn> {
    const t = this.turns[this.#i++];
    if (t === undefined) throw new Error('script exhausted');
    return t;
  }
  submitToolResults(results: readonly unknown[]): void {
    this.submitted.push([...results]);
  }
}

const finished = (text = 'done'): VendorTurn => ({
  text,
  toolCalls: [],
  tokensIn: 100,
  tokensOut: 50,
  done: true,
});

const wantsTool = (name: string, args: unknown = { path: 'a.ts' }): VendorTurn => ({
  toolCalls: [{ id: 'c1', name, args }],
  tokensIn: 100,
  tokensOut: 50,
  done: false,
});

function run(turns: readonly VendorTurn[], over = {}): Promise<AgentEvent[]> {
  const conversation = new ScriptedConversation(turns);
  const req = contractRequest(over);
  return collect(runAgentLoop({ vendor: 'anthropic', model: 'claude-sonnet-5', req, conversation }));
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('settling', () => {
  it('settles exactly once, on the final event', async () => {
    const events = await run([finished()]);
    const settling = events.filter((e) => e.t === 'result' || e.t === 'error');
    expect(settling).toHaveLength(1);
    expect(events.at(-1)).toBe(settling[0]);
  });

  // Termination is structural. Nothing reads prose looking for "I am done".
  it('finishes when the vendor reports done, not on any text content', async () => {
    const events = await run([wantsTool('repo.read'), finished('all good')]);
    expect(events.at(-1)).toMatchObject({ t: 'result', output: 'all good' });
  });

  it('errors rather than spinning when a vendor neither finishes nor asks for a tool', async () => {
    const events = await run([{ toolCalls: [], tokensIn: 1, tokensOut: 1, done: false }]);
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /no tool calls and did not finish/ });
  });

  it('continues through a pause without treating it as finished', async () => {
    const paused: VendorTurn = {
      toolCalls: [], tokensIn: 10, tokensOut: 5, done: false, continueWithoutTools: true,
    };
    const events = await run([paused, finished('after the pause')]);
    expect(events.at(-1)).toMatchObject({ t: 'result', output: 'after the pause' });
  });

  it('reports a vendor refusal as an error rather than an empty result', async () => {
    const events = await run([
      { toolCalls: [], tokensIn: 1, tokensOut: 1, done: false, refusal: 'declined on policy' },
    ]);
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /declined the request/ });
  });

  it('reports truncation rather than passing off a half answer', async () => {
    const events = await run([
      { toolCalls: [], tokensIn: 1, tokensOut: 1, done: false, truncated: true },
    ]);
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /output cap/ });
  });

  it('errors if a vendor call throws', async () => {
    const conversation: VendorConversation = {
      async turn() { throw new Error('connection reset'); },
      submitToolResults() {},
    };
    const events = await collect(
      runAgentLoop({ vendor: 'openai', model: 'gpt-6.1-sol', req: contractRequest(), conversation }),
    );
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /connection reset/ });
  });
});

describe('budget', () => {
  it('stops on the token ceiling', async () => {
    const events = await run([wantsTool('repo.read'), finished()], {
      limits: { maxMinutes: 5, maxTokens: 10, maxUsd: 100 },
    });
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /token ceiling/ });
  });

  it('stops on the spend ceiling', async () => {
    const big: VendorTurn = { toolCalls: [], tokensIn: 1_000_000, tokensOut: 1_000_000, done: true };
    const events = await run([big], {
      limits: { maxMinutes: 5, maxTokens: 10_000_000, maxUsd: 0.5 },
    });
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /spend ceiling/ });
  });

  // A model with no published price must not look free and run forever.
  it('does not enforce a spend ceiling it cannot compute', async () => {
    const conversation = new ScriptedConversation([
      { toolCalls: [], tokensIn: 1_000_000, tokensOut: 1_000_000, done: true },
    ]);
    const events = await collect(
      runAgentLoop({
        vendor: 'google',
        model: 'gemini-3.8-flash',
        req: contractRequest({ limits: { maxMinutes: 5, maxTokens: 10_000_000, maxUsd: 0.000001 } }),
        conversation,
      }),
    );
    expect(events.at(-1)?.t).toBe('result');
    const usage = events.find((e) => e.t === 'usage');
    expect(usage).toMatchObject({ usd: 0 });
  });

  it('accounts for spend on every turn', async () => {
    const events = await run([finished()]);
    const usage = events.find((e) => e.t === 'usage');
    expect(usage).toMatchObject({ tokensIn: 100, tokensOut: 50 });
    // claude-sonnet-5: $3/$15 per MTok
    expect((usage as { usd: number }).usd).toBeCloseTo(100 / 1e6 * 3 + 50 / 1e6 * 15, 10);
  });
});

describe('abort', () => {
  it('stops before the first turn when already aborted', async () => {
    const ac = new AbortController();
    ac.abort('human requested a stop');
    const events = await run([finished()], { signal: ac.signal });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'error', message: /human requested a stop/ });
  });

  it('stops between tool calls', async () => {
    const ac = new AbortController();
    const invoke = vi.fn(async (): Promise<ToolCallResult> => {
      ac.abort('budget');
      return { allowed: true, output: {} };
    });
    const events = await run([
      { toolCalls: [
          { id: 'a', name: 'repo.read', args: { path: 'a.ts' } },
          { id: 'b', name: 'repo.read', args: { path: 'b.ts' } },
        ], tokensIn: 1, tokensOut: 1, done: false },
      finished(),
    ], { signal: ac.signal, invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /aborted/ });
  });
});

describe('tool dispatch', () => {
  it('routes every call through invoke and nowhere else', async () => {
    const invoke = vi.fn(async (): Promise<ToolCallResult> => ({ allowed: true, output: { ok: 1 } }));
    await run([wantsTool('repo.read'), finished()], { invoke });
    expect(invoke).toHaveBeenCalledWith('repo.read', { path: 'a.ts' });
  });

  // A denial has to reach the model, or it can never correct itself.
  it('feeds a denial back to the model as a tool error, with its category', async () => {
    const conversation = new ScriptedConversation([wantsTool('repo.write'), finished()]);
    const invoke = async (): Promise<ToolCallResult> => ({
      allowed: false,
      errorCategory: 'validation',
      isRetryable: true,
      denialReason: 'path may not contain a ".." segment',
    });
    const events = await collect(
      runAgentLoop({
        vendor: 'anthropic',
        model: 'claude-sonnet-5',
        req: contractRequest({ invoke }),
        conversation,
      }),
    );
    expect(events.find((e) => e.t === 'tool_result')).toMatchObject({ ok: false });
    expect(conversation.submitted[0]?.[0]).toMatchObject({
      isError: true,
      output: { category: 'validation', retryable: true },
    });
  });

  it('turns a thrown invoker into a retryable tool error, not a dead run', async () => {
    const invoke = async (): Promise<ToolCallResult> => { throw new Error('gateway down'); };
    const events = await run([wantsTool('repo.read'), finished()], { invoke });
    expect(events.at(-1)?.t).toBe('result');
    expect(events.find((e) => e.t === 'tool_result')).toMatchObject({
      ok: false,
      denialReason: /gateway down/,
    });
  });

  it('emits a file_change for a successful write', async () => {
    const events = await run([wantsTool('repo.write', { path: 'src/a.ts', content: 'x' }), finished()]);
    expect(events.find((e) => e.t === 'file_change')).toMatchObject({ path: 'src/a.ts' });
  });

  it('submits all results from one turn together', async () => {
    const conversation = new ScriptedConversation([
      { toolCalls: [
          { id: 'a', name: 'repo.read', args: { path: 'a.ts' } },
          { id: 'b', name: 'repo.read', args: { path: 'b.ts' } },
        ], tokensIn: 1, tokensOut: 1, done: false },
      finished(),
    ]);
    await collect(
      runAgentLoop({ vendor: 'anthropic', model: 'claude-sonnet-5', req: contractRequest(), conversation }),
    );
    expect(conversation.submitted).toHaveLength(1);
    expect(conversation.submitted[0]).toHaveLength(2);
  });
});

describe('the iteration cap is a backstop, not the stop', () => {
  it('ends a pathological loop rather than running forever', async () => {
    const conversation: VendorConversation = {
      async turn() { return wantsTool('repo.read'); },
      submitToolResults() {},
    };
    const events = await collect(
      runAgentLoop({
        vendor: 'anthropic',
        model: 'claude-sonnet-5',
        req: contractRequest({ limits: { maxMinutes: 60, maxTokens: 1e9, maxUsd: 1e6 } }),
        conversation,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      t: 'error',
      message: new RegExp(`${MAX_ITERATIONS} iterations`),
    });
  });
});
