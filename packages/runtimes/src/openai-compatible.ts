/**
 * The adapter for anything speaking the OpenAI Chat Completions API — vLLM,
 * Ollama, OpenRouter, a private gateway.
 *
 * Deliberately Chat Completions, not the Responses API: self-hosted servers
 * implement `/v1/chat/completions`, and pointing the Responses API at one would
 * fail against most of them. This is the air-gapped path, so it must work
 * against what those servers actually serve.
 *
 * Its vendor is `local`, so rule 1 pairs it with any hosted vendor.
 */

import OpenAI from 'openai';
import { toolDefinitions, type Vendor } from '@shura/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { runAgentLoop, type VendorConversation, type VendorToolResult, type VendorTurn } from './loop.js';
import { once } from './anthropic.js';
import { systemPrompt, userPrompt } from './prompt.js';

const MAX_TOKENS_PER_TURN = 8_000;

export interface OpenAICompatibleRuntimeOptions {
  /** e.g. http://localhost:11434/v1 for Ollama, or a vLLM server. */
  readonly baseURL?: string;
  /** Most self-hosted servers ignore this, but the SDK requires a value. */
  readonly apiKey?: string;
  readonly client?: OpenAI;
}

export class OpenAICompatibleRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'local';
  readonly id = 'openai-compatible';
  readonly #client: OpenAI;

  constructor(opts: OpenAICompatibleRuntimeOptions = {}) {
    this.#client =
      opts.client ??
      new OpenAI({
        baseURL: opts.baseURL ?? process.env.LOCAL_BASE_URL ?? 'http://localhost:11434/v1',
        apiKey: opts.apiKey ?? process.env.LOCAL_API_KEY ?? 'not-needed',
      });
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
      conversation: new ChatCompletionsConversation(this.#client, model, req),
    });
  }
}

class ChatCompletionsConversation implements VendorConversation {
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #req: RunRequest;
  readonly #messages: OpenAI.Chat.ChatCompletionMessageParam[];
  readonly #tools: OpenAI.Chat.ChatCompletionTool[];

  constructor(client: OpenAI, model: string, req: RunRequest) {
    this.#client = client;
    this.#model = model;
    this.#req = req;
    this.#messages = [
      { role: 'system', content: systemPrompt(req) },
      { role: 'user', content: userPrompt(req) },
    ];
    this.#tools = toolDefinitions(req.tools).map(
      (d) =>
        ({
          type: 'function',
          function: { name: d.name, description: d.description, parameters: d.parameters },
        }) as OpenAI.Chat.ChatCompletionTool,
    );
  }

  async turn(): Promise<VendorTurn> {
    const response = await this.#client.chat.completions.create(
      {
        model: this.#model,
        max_tokens: MAX_TOKENS_PER_TURN,
        messages: this.#messages,
        ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
      },
      { signal: this.#req.signal },
    );

    const choice = response.choices[0];
    const message = choice?.message;
    if (message === undefined) {
      return { toolCalls: [], tokensIn: 0, tokensOut: 0, done: false };
    }
    this.#messages.push(message);

    const rawCalls = message.tool_calls ?? [];
    const toolCalls = rawCalls.flatMap((c) =>
      'function' in c
        ? [{ id: c.id, name: c.function.name, args: parseArguments(c.function.arguments) }]
        : [],
    );

    const tokensIn = response.usage?.prompt_tokens ?? 0;
    const tokensOut = response.usage?.completion_tokens ?? 0;

    if (choice?.finish_reason === 'length') {
      return { toolCalls: [], tokensIn, tokensOut, done: false, truncated: true };
    }

    return {
      text: message.content ?? '',
      toolCalls,
      tokensIn,
      tokensOut,
      done: toolCalls.length === 0,
    };
  }

  submitToolResults(results: readonly VendorToolResult[]): void {
    for (const r of results) {
      this.#messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
      });
    }
  }
}

function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable_arguments: raw };
  }
}
