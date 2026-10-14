/**
 * A real round-trip against each configured vendor.
 *
 * The unit tests prove the loop is correct against scripted vendors. They
 * cannot prove the request shapes are right, because those were written from
 * documentation and documentation drifts. This spends a few cents to find out.
 *
 * The probe is deliberately one that cannot be faked by a model guessing: the
 * answer is a random token that exists only in the tool result, so a response
 * containing it proves the tool was defined, called, parsed, executed, fed back
 * and read.
 */

import { parseRole, type RoleDefinition, type Vendor } from '@forge/core';
import type { AgentEvent, RunRequest, ToolCallResult } from '@forge/ports';
import {
  AnthropicRuntime,
  GoogleRuntime,
  OpenAICompatibleRuntime,
  OpenAIRuntime,
} from '@forge/runtimes';
import type { AgentRuntime } from '@forge/ports';

interface Probe {
  readonly vendor: Vendor;
  readonly model: string;
  readonly envVar: string;
  readonly make: () => AgentRuntime;
}

const PROBES: readonly Probe[] = [
  { vendor: 'anthropic', model: 'claude-sonnet-5', envVar: 'ANTHROPIC_API_KEY', make: () => new AnthropicRuntime() },
  { vendor: 'openai', model: 'gpt-6.1-sol', envVar: 'OPENAI_API_KEY', make: () => new OpenAIRuntime() },
  { vendor: 'google', model: 'gemini-3.8-flash', envVar: 'GOOGLE_API_KEY', make: () => new GoogleRuntime() },
  { vendor: 'local', model: process.env.LOCAL_MODEL ?? 'llama3.1', envVar: 'LOCAL_BASE_URL', make: () => new OpenAICompatibleRuntime() },
];

function role(vendor: Vendor, model: string): RoleDefinition {
  return parseRole({
    id: `smoke-${vendor}`,
    kind: 'produce',
    model: { runtime: vendor, model },
    tools: ['repo.read'],
    limits: { max_minutes: 2, max_tokens: 20_000, max_usd: 0.5 },
    instructions:
      'You are verifying a tool pipeline. Read the file named in the task using the ' +
      'repo read tool, then reply with the build token it contains and nothing else. ' +
      'Do not ask questions; the path is in the task.',
  });
}

function request(r: RoleDefinition, secret: string, signal: AbortSignal): RunRequest {
  let reads = 0;
  const invoke = async (tool: string, args: unknown): Promise<ToolCallResult> => {
    if (tool !== 'repo.read') {
      return { allowed: false, errorCategory: 'permission', isRetryable: false, denialReason: `"${tool}" is not granted` };
    }
    reads++;
    void args;
    return { allowed: true, output: { content: `BUILD_TOKEN=${secret}` } };
  };
  Object.defineProperty(invoke, 'reads', { get: () => reads });

  return {
    role: r,
    context: {
      workItemKey: 'SMOKE-1',
      artifactType: 'code_change',
      acceptanceCriteria: [
        'Given the file build/stamp.txt, when it is read, then its build token is reported',
      ],
      attempt: 1,
      diff: 'Read the file at path: build/stamp.txt',
    },
    tools: ['repo.read'],
    limits: { maxMinutes: 2, maxTokens: 20_000, maxUsd: 0.5 },
    signal,
    invoke,
  };
}

export async function smoke(only?: string): Promise<number> {
  const secret = `T${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  let ran = 0;
  let failed = 0;

  for (const probe of PROBES) {
    if (only !== undefined && probe.vendor !== only) continue;
    if ((process.env[probe.envVar] ?? '') === '') {
      console.log(`  skip   ${probe.vendor.padEnd(10)} ${probe.envVar} not set`);
      continue;
    }

    ran++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('smoke timeout'), 120_000);
    const started = Date.now();
    const events: AgentEvent[] = [];
    let toolCalls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let usd = 0;

    try {
      const runtime = probe.make();
      const req = request(role(probe.vendor, probe.model), secret, ac.signal);

      for await (const e of runtime.run(req)) {
        events.push(e);
        if (e.t === 'tool_call') toolCalls++;
        if (e.t === 'usage') {
          tokensIn += e.tokensIn;
          tokensOut += e.tokensOut;
          usd = e.usd;
        }
      }
    } catch (err) {
      console.log(`  FAIL   ${probe.vendor.padEnd(10)} threw: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
      clearTimeout(timer);
      continue;
    }
    clearTimeout(timer);

    const last = events.at(-1);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (last?.t !== 'result') {
      console.log(`  FAIL   ${probe.vendor.padEnd(10)} ${last?.t === 'error' ? last.message : 'no result'}`);
      failed++;
      continue;
    }

    // The token exists only in the tool result, so this is the whole pipeline.
    const output = String(last.output);
    const roundTripped = output.includes(secret);
    const cost = usd > 0 ? `$${usd.toFixed(4)}` : 'unpriced';

    if (!roundTripped || toolCalls === 0) {
      console.log(
        `  FAIL   ${probe.vendor.padEnd(10)} ${toolCalls} tool call(s), token ${roundTripped ? 'returned' : 'MISSING'} — ${output.slice(0, 80)}`,
      );
      failed++;
      continue;
    }

    console.log(
      `  ok     ${probe.vendor.padEnd(10)} ${probe.model.padEnd(16)} ${toolCalls} tool call  ` +
        `${tokensIn}/${tokensOut} tok  ${cost}  ${seconds}s`,
    );
  }

  if (ran === 0) {
    console.log('\nNo vendors configured. Add keys to .env.');
    return 1;
  }
  console.log(`\n${ran - failed}/${ran} vendors round-tripped a real tool call.`);
  return failed === 0 ? 0 : 1;
}
