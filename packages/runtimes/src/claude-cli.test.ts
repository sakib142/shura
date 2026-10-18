import { describe, expect, it } from 'vitest';
import { parseRole } from '@shura/core';
import type { RunRequest } from '@shura/ports';
import { ClaudeCliRuntime, DEFAULT_MODEL, argvFor, cliToolsFor, mapEvent } from './claude-cli.js';

const builder = parseRole({
  id: 'frontend-developer',
  kind: 'produce',
  model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
  tools: ['repo.read', 'repo.write'],
  instructions: 'Build it.',
});
const reviewer = parseRole({
  id: 'frontend-reviewer',
  kind: 'verify',
  model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
  tools: ['repo.read', 'verdict.submit'],
  instructions: 'Review it.',
});

function request(role: typeof builder, workdir?: string): RunRequest {
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

const argv = (role: typeof builder, settings?: string) =>
  argvFor(request(role), role.model!.model, settings);

const after = (a: string[], flag: string): string[] => {
  const i = a.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < a.length && !a[j]!.startsWith('--'); j++) out.push(a[j]!);
  return out;
};

describe('how a role becomes a command line', () => {
  /**
   * Rule 2, as a command line. An allowlist rather than only a denylist,
   * because anything unlisted then needs a permission nobody is there to grant
   * — so a tool a future CLI release adds is refused by default instead of
   * inherited.
   */
  it('gives a verify role no way to write', () => {
    const a = argv(reviewer);
    expect(after(a, '--allowedTools')).not.toContain('Write');
    expect(after(a, '--allowedTools')).toContain('Read');
    for (const banned of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
      expect(after(a, '--disallowedTools'), banned).toContain(banned);
    }
  });

  // A shell is a write tool wearing a different hat. Shura runs the checks
  // itself and hands the reviewer the output, so it has no use for one.
  it('gives a verify role no shell either, whatever its grants say', () => {
    const greedy = parseRole({
      id: 'frontend-reviewer',
      kind: 'verify',
      model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
      // test.run would map to Bash for a producer. A verifier gets it stripped.
      tools: ['repo.read', 'test.run', 'verdict.submit'],
      instructions: 'Review it.',
    });
    expect(after(argv(greedy), '--allowedTools')).not.toContain('Bash');
    expect(after(argv(greedy), '--disallowedTools')).toContain('Bash');
  });

  it('gives a producing role what its grants ask for', () => {
    const full = parseRole({
      id: 'frontend-developer',
      kind: 'produce',
      model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
      tools: ['repo.read', 'repo.search', 'repo.write', 'test.run'],
      instructions: 'Build it.',
    });
    expect(after(argv(full), '--allowedTools')).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']),
    );
  });

  /**
   * The regression this replaced. Deriving the allowlist from `role.kind`
   * alone handed the planner Write, Edit and Bash — because a planner is a
   * produce role — even though its definition deliberately withholds
   * `repo.write`. A planner that can rewrite the repository it is reading is
   * not a planner.
   */
  it('does not give a planner the means to write, though it produces', () => {
    const planner = parseRole({
      id: 'frontend-planner',
      kind: 'produce',
      model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
      tools: ['repo.read', 'repo.search', 'plan.submit'],
      instructions: 'Plan it.',
    });
    const allowed = after(argv(planner), '--allowedTools');
    expect(allowed).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    for (const banned of ['Write', 'Edit', 'Bash']) {
      expect(allowed, banned).not.toContain(banned);
      expect(after(argv(planner), '--disallowedTools'), banned).toContain(banned);
    }
  });

  it('maps a grant to the CLI tools that implement it', () => {
    const r = (tools: string[]) =>
      cliToolsFor(
        parseRole({
          id: 'x',
          kind: 'produce',
          model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
          tools,
          instructions: 'x',
        }),
      );
    expect(r(['repo.search'])).toEqual(expect.arrayContaining(['Grep', 'Glob']));
    expect(r(['repo.write'])).toEqual(expect.arrayContaining(['Write', 'Edit']));
    expect(r(['test.run'])).toEqual(['Bash']);
    // Grants that are not CLI tools at all.
    expect(r(['plan.submit', 'tracker.comment'])).toEqual([]);
  });

  it('never bypasses permissions wholesale', () => {
    for (const role of [builder, reviewer]) {
      const a = argv(role).join(' ');
      expect(a).not.toContain('--dangerously-skip-permissions');
      expect(a).not.toContain('bypassPermissions');
    }
  });

  /**
   * The machine this was written on had eleven MCP servers configured. A lane
   * inheriting them is neither reproducible nor something the role definition
   * can account for.
   */
  it('refuses to inherit the operator MCP servers and settings', () => {
    const a = argv(builder);
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--setting-sources');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('omits the model flag for the account default', () => {
    const role = { ...builder, model: { runtime: 'anthropic' as const, model: DEFAULT_MODEL } };
    expect(argv(role)).not.toContain('--model');
  });

  it('passes the hook settings through when given', () => {
    const a = argv(builder, '{"hooks":{}}');
    expect(a[a.indexOf('--settings') + 1]).toBe('{"hooks":{}}');
  });

  /**
   * `--json-schema` makes the CLI answer through a StructuredOutput tool.
   * Asking for a schema and then not allowing that tool denies the agent its
   * own output channel — which a live planner hit: it composed the plan, was
   * refused, and recovered only because the final message carried the JSON
   * too. It would not always.
   */
  it('allows the structured-output tool when it asks for a schema', () => {
    const withSchema = argvFor(
      { ...request(builder), outputSchema: { type: 'object' } },
      'claude-sonnet-5',
    );
    expect(after(withSchema, '--allowedTools')).toContain('StructuredOutput');
  });

  it('does not allow it when no schema is asked for', () => {
    expect(after(argv(builder), '--allowedTools')).not.toContain('StructuredOutput');
  });

  it('asks for a machine-readable stream', () => {
    const a = argv(builder);
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--verbose');
  });
});

/** Event shapes taken from a live `claude -p --output-format stream-json` run. */
describe('mapping claude events', () => {
  it('ignores session bookkeeping', () => {
    expect(mapEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
    expect(mapEvent({ type: 'system', subtype: 'hook_started' })).toEqual([]);
    expect(mapEvent({ type: 'rate_limit_event' })).toEqual([]);
  });

  it('turns thinking into reasoning and tool_use into a tool call', () => {
    expect(
      mapEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'I should read it first.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'app.ts' } },
          ],
        },
      }),
    ).toEqual([
      { t: 'reasoning', text: 'I should read it first.' },
      { t: 'tool_call', tool: 'Read', args: { file_path: 'app.ts' } },
    ]);
  });

  // The event this runtime could not previously observe: a write.
  it('reports a write as a file change as well as a call', () => {
    const out = mapEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'note.md', content: 'x' } }],
      },
    });
    expect(out.map((e) => e.t)).toEqual(['tool_call', 'file_change']);
    expect(out[1]).toEqual({ t: 'file_change', path: 'note.md' });
  });

  /**
   * The CLI reports an absolute path into a temporary worktree. That is noise
   * in the event log and meaningless to anyone reading it later, because the
   * worktree is gone by then.
   */
  it('reports the changed path relative to the worktree', () => {
    const out = mapEvent(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/wt-9/src/a.ts' } }],
        },
      },
      '/tmp/wt-9',
    );
    expect(out[1]).toEqual({ t: 'file_change', path: 'src/a.ts' });
  });

  it('leaves a path outside the worktree alone rather than mangling it', () => {
    const out = mapEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/etc/x' } }] },
      },
      '/tmp/wt-9',
    );
    expect(out[1]).toEqual({ t: 'file_change', path: '/etc/x' });
  });

  it('does not call a read a file change', () => {
    const out = mapEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
    });
    expect(out.map((e) => e.t)).toEqual(['tool_call']);
  });

  it('reports a failed tool result as not ok', () => {
    expect(
      mapEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }),
    ).toEqual([{ t: 'tool_result', ok: false }]);
  });

  it('reports usage and the final text from the result event', () => {
    const out = mapEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      total_cost_usd: 0.04556,
      usage: {
        input_tokens: 28,
        output_tokens: 491,
        cache_read_input_tokens: 86_190,
        cache_creation_input_tokens: 17_229,
      },
    });
    expect(out[0]).toMatchObject({
      t: 'usage',
      tokensIn: 28,
      tokensOut: 491,
      cacheRead: 86_190,
      cacheWrite: 17_229,
      usd: 0.04556,
    });
    expect(out[1]).toEqual({ t: 'result', output: 'Done.' });
  });

  it('reports a failed run as an error, not a result', () => {
    const out = mapEvent({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    expect(out.at(-1)).toEqual({ t: 'error', message: 'boom' });
  });
});

/** A fake `claude` emitting a scripted stream, so no quota is spent. */
function fakeClaude(lines: readonly string[], code = 0) {
  const seen: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawnFn = ((_b: string, a: string[], o: Record<string, unknown>) => {
    seen.push({ argv: a, env: o['env'] as NodeJS.ProcessEnv });
    const { Readable } = require('node:stream') as typeof import('node:stream');
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const child = new EventEmitter() as never as Record<string, unknown>;
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

async function collect(runtime: ClaudeCliRuntime, req: RunRequest) {
  const out = [];
  for await (const e of runtime.run(req)) out.push(e);
  return out;
}

const INIT_SUB = '{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-sonnet-5"}';
const DONE = '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{}}';

describe('keeping the run on a subscription', () => {
  it('blanks the API key in the child environment', async () => {
    const { spawnFn, seen } = fakeClaude([INIT_SUB, DONE]);
    await collect(new ClaudeCliRuntime({ spawnFn }), request(builder));
    expect(seen[0]!.env['ANTHROPIC_API_KEY']).toBe('');
  });

  /**
   * The whole premise is that a user pays nothing beyond a subscription. If a
   * key reaches the process they are billed per token without having asked to
   * be, and an invoice is a bad way to find out.
   */
  it('stops the run if the CLI reports it is billing an API key', async () => {
    const { spawnFn } = fakeClaude([
      '{"type":"system","subtype":"init","apiKeySource":"ANTHROPIC_API_KEY"}',
      DONE,
    ]);
    const events = await collect(new ClaudeCliRuntime({ spawnFn }), request(builder));
    expect(events[0]).toMatchObject({ t: 'error' });
    expect((events[0] as { message: string }).message).toMatch(/not a subscription/);
    // And it stops there rather than carrying on and spending.
    expect(events).toHaveLength(1);
  });

  it('proceeds when the CLI confirms no key is in use', async () => {
    const { spawnFn } = fakeClaude([INIT_SUB, DONE]);
    const events = await collect(new ClaudeCliRuntime({ spawnFn }), request(builder));
    expect(events.map((e) => e.t)).toEqual(['usage', 'result']);
  });
});

describe('reading the stream', () => {
  it('treats a stream that never finishes as a failure', async () => {
    const { spawnFn } = fakeClaude([INIT_SUB], 1);
    const events = await collect(new ClaudeCliRuntime({ spawnFn }), request(builder));
    expect(events.at(-1)).toMatchObject({ t: 'error' });
  });

  it('ignores a line that is not JSON', async () => {
    const { spawnFn } = fakeClaude(['not json at all', INIT_SUB, DONE]);
    const events = await collect(new ClaudeCliRuntime({ spawnFn }), request(builder));
    expect(events.map((e) => e.t)).toEqual(['usage', 'result']);
  });
});
