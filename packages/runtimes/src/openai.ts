/**
 * The OpenAI adapter, on the Responses API.
 *
 * Two differences from Anthropic worth knowing, both of which have bitten
 * people: tool arguments arrive as a JSON *string* rather than an object, so
 * they are parsed here and a malformed one becomes a tool error rather than a
 * crash; and completion is signalled by the absence of `function_call` items in
 * the output rather than by a stop reason.
 *
 * API shape current as of 2026-10-14.
 */

import OpenAI from 'openai';
import { toolDefinitions, type Vendor } from '@forge/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@forge/ports';
import { runAgentLoop, type VendorConversation, type VendorToolResult, type VendorTurn } from './loop.js';
import { once } from './anthropic.js';
import { systemPrompt, userPrompt } from './prompt.js';

export interface OpenAIRuntimeOptions {
  readonly apiKey?: string;
  readonly client?: OpenAI;
}

export class OpenAIRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'openai';
  readonly id = 'openai';
  readonly #client: OpenAI;

  constructor(opts: OpenAIRuntimeOptions = {}) {
    this.#client =
      opts.client ?? (opts.apiKey === undefined ? new OpenAI() : new OpenAI({ apiKey: opts.apiKey }));
  }

  run(req: RunRequest): AsyncIterable<AgentEvent> {
    const model = req.role.model?.model;
    if (model === undefined) {
      return once({ t: 'error', message: `role "${req.role.id}" declares no model` });
    }
    return runAgentLoop({
      vendor: this.vendor,
      model,
      req,
      conversation: new OpenAIConversation(this.#client, model, req),
    });
  }
}

class OpenAIConversation implements VendorConversation {
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #req: RunRequest;
  readonly #input: unknown[];
  readonly #tools: unknown[];

  constructor(client: OpenAI, model: string, req: RunRequest) {
    this.#client = client;
    this.#model = model;
    this.#req = req;
    this.#input = [
      { role: 'system', content: systemPrompt(req) },
      { role: 'user', content: userPrompt(req) },
    ];
    this.#tools = toolDefinitions(req.tools).map((d) => ({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: strictSchema(d.parameters),
      strict: true,
    }));
  }

  async turn(): Promise<VendorTurn> {
    const response = (await this.#client.responses.create(
      {
        model: this.#model,
        input: this.#input,
        ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
      } as never,
      { signal: this.#req.signal },
    )) as OpenAIResponse;

    const output = response.output ?? [];
    this.#input.push(...output);

    const toolCalls = output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        args: parseArguments(item.arguments),
      }));

    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;

    if (response.status === 'incomplete') {
      return { toolCalls: [], tokensIn, tokensOut, done: false, truncated: true };
    }

    const refusal = output
      .flatMap((item) => item.content ?? [])
      .find((c) => c.type === 'refusal')?.refusal;
    if (refusal !== undefined) {
      return { toolCalls: [], tokensIn, tokensOut, done: false, refusal };
    }

    // Completion is the absence of a tool call, not a stop string.
    return {
      text: response.output_text ?? '',
      toolCalls,
      tokensIn,
      tokensOut,
      done: toolCalls.length === 0,
    };
  }

  submitToolResults(results: readonly VendorToolResult[]): void {
    for (const r of results) {
      this.#input.push({
        type: 'function_call_output',
        call_id: r.id,
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
      });
    }
  }
}

interface OpenAIResponse {
  output?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; refusal?: string }[];
  }[];
  output_text?: string;
  status?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Arguments arrive as a JSON string. A model can emit one that does not parse,
 * and that must become a tool error the model can correct — never an exception
 * that kills the run.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable_arguments: raw };
  }
}

/**
 * OpenAI's strict mode requires `required` to list every key in `properties`;
 * an omitted key is a 400, not a permitted optional. Optionality is expressed
 * by letting the type be null instead.
 *
 * Recursive, because the constraint applies at every level. Found twice by real
 * runs: first on a top-level optional, then — after a partial fix — on an
 * optional nested two levels down inside an array item. Anthropic accepts the
 * same schema unchanged, which is why this belongs in the adapter rather than
 * the shared catalog.
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
