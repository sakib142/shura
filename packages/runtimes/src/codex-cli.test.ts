import { describe, expect, it } from 'vitest';
import { parseRole } from '@shura/core';
import type { RunRequest } from '@shura/ports';
import { CodexCliRuntime, DEFAULT_MODEL, mapEvent, strictSchema } from './codex-cli.js';

const reviewer = parseRole({
  id: 'frontend-reviewer',
  kind: 'verify',
  model: { runtime: 'openai', model: 'gpt-6.1-sol' },
  tools: ['repo.read', 'test.run', 'verdict.submit'],
  instructions: 'Review it.',
});

const builder = parseRole({
  id: 'frontend-developer',
  kind: 'produce',
  model: { runtime: 'openai', model: 'gpt-6.1-sol' },
  tools: ['repo.read', 'repo.write'],
  instructions: 'Build it.',
});

/**
 * The real event shapes, copied from a live `codex exec --json` run rather
 * than imagined. A mapping test written against invented events proves the
 * mapping is self-consistent and nothing else.
 */
describe('mapping codex events', () => {
  it('ignores the events that carry nothing to act on', () => {
    expect(mapEvent({ type: 'thread.started', thread_id: 'x' })).toEqual([]);
    expect(mapEvent({ type: 'turn.started' })).toEqual([]);
  });

  it('turns an agent message into reasoning', () => {
    const [e] = mapEvent({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Looks wrong.' },
    });
    expect(e).toEqual({ t: 'reasoning', text: 'Looks wrong.' });
  });

  it('reports token usage, including what came from cache', () => {
    const [e] = mapEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 35_928,
        cached_input_tokens: 24_576,
        cache_write_input_tokens: 0,
        output_tokens: 89,
      },
    });
    expect(e).toMatchObject({ t: 'usage', tokensIn: 35_928, tokensOut: 89, cacheRead: 24_576 });
  });

  /**
   * A subscription run has no per-token price. Writing a dollar figure would
   * read as "this cost nothing" when the honest statement is "this was not
   * metered" — which `costOf` already expresses as `known: false`.
   */
  it('claims no dollar cost, because a subscription has none to report', () => {
    const [e] = mapEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    expect(e).toMatchObject({ t: 'usage', usd: 0 });
  });

  it('surfaces a failure as an error rather than swallowing it', () => {
    expect(mapEvent({ type: 'turn.failed', error: { message: 'model overloaded' } })).toEqual([
      { t: 'error', message: 'model overloaded' },
    ]);
    expect(mapEvent({ type: 'error', error: 'bad request' })).toEqual([
      { t: 'error', message: 'bad request' },
    ]);
  });

  it('reports a file change per path touched', () => {
    expect(
      mapEvent({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
      }),
    ).toEqual([
      { t: 'file_change', path: 'a.ts' },
      { t: 'file_change', path: 'b.ts' },
    ]);
  });
});

/** A fake `codex` that emits a scripted stream, so no quota is spent. */
function fakeCodex(lines: readonly string[], code = 0) {
  const seen: { argv: string[]; env: NodeJS.ProcessEnv; cwd: string | undefined }[] = [];
  const spawnFn = ((_bin: string, argv: string[], opts: Record<string, unknown>) => {
    seen.push({
      argv,
      env: opts['env'] as NodeJS.ProcessEnv,
      cwd: opts['cwd'] as string | undefined,
    });
    const { Readable } = require('node:stream') as typeof import('node:stream');
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const child = new EventEmitter() as never as {
      stdout: NodeJS.ReadableStream;
      stderr: NodeJS.ReadableStream;
      exitCode: number | null;
      kill: () => void;
      once: (e: string, cb: (c: number) => void) => void;
    };
    Object.assign(child, {
      stdout: Readable.from(lines.map((l) => `${l}\n`)),
      stderr: Readable.from([]),
      exitCode: code,
      kill: () => {},
    });
    return child;
  }) as never;
  return { spawnFn, seen };
}

function request(role: typeof reviewer, workdir?: string): RunRequest {
  return {
    role,
    context: { workItemKey: 'X-1', artifactType: 'code_change', acceptanceCriteria: [], attempt: 1 },
    tools: role.tools,
    limits: { maxMinutes: 5, maxTokens: 1_000_000, maxUsd: 10 },
    signal: AbortSignal.timeout(10_000),
    invoke: async () => ({ allowed: true, ok: true, output: '' }) as never,
    ...(workdir === undefined ? {} : { workdir }),
  };
}

async function collect(runtime: CodexCliRuntime, req: RunRequest) {
  const events = [];
  for await (const e of runtime.run(req)) events.push(e);
  return events;
}

describe('choosing a model', () => {
  /**
   * A subscription does not serve every model. The live CLI answers
   * "The 'gpt-5.1-codex' model is not supported when using Codex with a
   * ChatGPT account" and fails the run — so a role that runs on a CLI asks for
   * the account default rather than naming one.
   */
  it('omits the model flag when the role asks for the account default', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    const role = { ...reviewer, model: { runtime: 'openai' as const, model: DEFAULT_MODEL } };
    await collect(new CodexCliRuntime({ spawnFn }), request(role));
    expect(seen[0]!.argv).not.toContain('-m');
  });

  it('passes a named model through when one is named', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(seen[0]!.argv[seen[0]!.argv.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
  });
});

describe('how the reviewer is launched', () => {
  /**
   * The whole reason this runtime exists on the review side: `-s read-only` is
   * an operating-system sandbox. A reviewer handed a write tool by some future
   * bug would still be refused by the kernel. Probed against the real CLI: the
   * agent tries, and reports back "operation not permitted".
   */
  it('runs a verify role under the read-only sandbox', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(seen[0]!.argv).toContain('-s');
    expect(seen[0]!.argv[seen[0]!.argv.indexOf('-s') + 1]).toBe('read-only');
  });

  it('gives a producing role a writable workspace, and never full access', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(builder));
    const argv = seen[0]!.argv;
    expect(argv[argv.indexOf('-s') + 1]).toBe('workspace-write');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv.join(' ')).not.toContain('danger-full-access');
  });

  /**
   * A key in the environment would silently bill per token for work the
   * subscription already covers — the second bill this runtime exists to
   * avoid.
   */
  it('blanks the API keys, forcing subscription auth', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(seen[0]!.env['OPENAI_API_KEY']).toBe('');
    expect(seen[0]!.env['CODEX_API_KEY']).toBe('');
  });

  it('runs in the task worktree, not wherever Shura was started', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(reviewer, '/tmp/wt-1'));
    expect(seen[0]!.cwd).toBe('/tmp/wt-1');
    expect(seen[0]!.argv).toContain('-C');
  });

  it('does not inherit the operator own config', async () => {
    const { spawnFn, seen } = fakeCodex(['{"type":"turn.completed","usage":{}}']);
    await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(seen[0]!.argv).toContain('--ignore-user-config');
  });
});

describe('reading the stream', () => {
  it('yields the mapped events and a final result', async () => {
    const { spawnFn } = fakeCodex([
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"the verdict"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    ]);
    const events = await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(events.map((e) => e.t)).toEqual(['reasoning', 'usage', 'result']);
    expect(events[2]).toEqual({ t: 'result', output: 'the verdict' });
  });

  // The CLI prints human-facing lines to stdout too. One is not a reason to
  // fail a run that is otherwise working.
  it('ignores a line that is not JSON', async () => {
    const { spawnFn } = fakeCodex([
      'Reading additional input from stdin...',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{}}',
    ]);
    const events = await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(events.map((e) => e.t)).toEqual(['reasoning', 'usage', 'result']);
  });

  /**
   * Silence is a failed launch, not a short run. Reported as a clean finish it
   * would read as a reviewer that looked and found nothing wrong.
   */
  it('treats no output at all as a failure', async () => {
    const { spawnFn } = fakeCodex([]);
    const events = await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/no output/);
  });

  it('reports a non-zero exit as an error', async () => {
    const { spawnFn } = fakeCodex(['{"type":"turn.completed","usage":{}}'], 3);
    const events = await collect(new CodexCliRuntime({ spawnFn }), request(reviewer));
    expect(events.at(-1)).toMatchObject({ t: 'error' });
    expect((events.at(-1) as { message: string }).message).toMatch(/exited 3/);
  });

  it('refuses a role with no model rather than guessing one', async () => {
    const { spawnFn } = fakeCodex([]);
    const noModel = { ...reviewer, model: undefined } as typeof reviewer;
    const events = await collect(new CodexCliRuntime({ spawnFn }), request(noModel));
    expect(events[0]).toMatchObject({ t: 'error' });
  });
});

/**
 * The schema fix that was learned, then lost.
 *
 * OpenAI's structured output rejects a schema whose `required` omits any key
 * in `properties` — a 400, not a permitted optional. That was solved once in
 * the OpenAI API adapter, and deleting that adapter deleted the fix with it. A
 * live reviewer hit the identical error on `extraFindings`, which carries a
 * `.default([])` and is therefore optional.
 */
describe('making a schema acceptable to OpenAI', () => {
  it('requires every property, and makes the optional ones nullable', () => {
    const out = strictSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } },
      required: ['a'],
    });
    expect(out['required']).toEqual(['a', 'b']);
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['b']!['type']).toEqual(['array', 'null']);
    // Already required, so untouched.
    expect(props['a']!['type']).toBe('string');
  });

  // The second time it was found, the offending optional was two levels down
  // inside an array item.
  it('applies at every depth, including inside array items', () => {
    const out = strictSchema({
      type: 'object',
      properties: {
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: { index: { type: 'integer' }, finding: { type: 'object', properties: {} } },
            required: ['index'],
          },
        },
      },
      required: ['criteria'],
    });
    const items = (out['properties'] as Record<string, Record<string, unknown>>)['criteria']!
      .items as Record<string, unknown>;
    expect(items['required']).toEqual(['index', 'finding']);
  });

  it('leaves a schema that already names everything alone', () => {
    const already = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(strictSchema(already)).toEqual(already);
  });
});
