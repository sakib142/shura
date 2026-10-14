/**
 * The Google Gemini adapter.
 *
 * Gemini keeps the transcript server-side: each call returns an interaction id,
 * and the next call references it via `previous_interaction_id` rather than
 * resending history. That makes this the one adapter whose conversation state
 * is a single id instead of a growing array.
 *
 * API shape current as of 2026-10-14.
 */

import { GoogleGenAI } from '@google/genai';
import { toolDefinitions, type Vendor } from '@forge/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@forge/ports';
import { runAgentLoop, type VendorConversation, type VendorToolResult, type VendorTurn } from './loop.js';
import { once } from './anthropic.js';
import { systemPrompt, userPrompt } from './prompt.js';

export interface GoogleRuntimeOptions {
  readonly apiKey?: string;
  readonly client?: GoogleGenAI;
}

export class GoogleRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'google';
  readonly id = 'google';
  readonly #client: GoogleGenAI;

  constructor(opts: GoogleRuntimeOptions = {}) {
    this.#client =
      opts.client ??
      new GoogleGenAI(opts.apiKey === undefined ? {} : ({ apiKey: opts.apiKey } as never));
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
      conversation: new GoogleConversation(this.#client, model, req),
    });
  }
}

class GoogleConversation implements VendorConversation {
  readonly #client: GoogleGenAI;
  readonly #model: string;
  readonly #req: RunRequest;
  readonly #tools: unknown[];
  #nextInput: unknown;
  #previousInteractionId: string | undefined;

  constructor(client: GoogleGenAI, model: string, req: RunRequest) {
    this.#client = client;
    this.#model = model;
    this.#req = req;
    this.#tools = toolDefinitions(req.tools).map((d) => ({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    }));
    this.#nextInput = `${systemPrompt(req)}\n\n${userPrompt(req)}`;
  }

  async turn(): Promise<VendorTurn> {
    const interactions = (this.#client as unknown as GeminiClient).interactions;

    const interaction = await interactions.create({
      model: this.#model,
      input: this.#nextInput,
      ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
      ...(this.#previousInteractionId === undefined
        ? {}
        : { previous_interaction_id: this.#previousInteractionId }),
    });

    this.#previousInteractionId = interaction.id;

    const steps = interaction.steps ?? [];
    const toolCalls = steps
      .filter((s) => s.type === 'function_call')
      .map((s) => ({ id: s.id ?? '', name: s.name ?? '', args: s.arguments ?? {} }));

    const reasoning = steps
      .filter((s) => s.type === 'reasoning' || s.type === 'thinking')
      .map((s) => s.text ?? '')
      .join('\n');

    // Usage field names were not verified against the docs when this was
    // written, so they are read defensively and default to zero rather than
    // being guessed. A zero here understates spend — see the pricing table,
    // which also has no Gemini entry for the same reason.
    const usage = interaction.usage ?? {};
    const tokensIn = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const tokensOut = usage.output_tokens ?? usage.candidates_tokens ?? 0;

    return {
      reasoning,
      text: interaction.output_text ?? '',
      toolCalls,
      tokensIn,
      tokensOut,
      done: toolCalls.length === 0,
    };
  }

  submitToolResults(results: readonly VendorToolResult[]): void {
    this.#nextInput = results.map((r) => ({
      type: 'function_result',
      name: r.name,
      call_id: r.id,
      result: [
        { type: 'text', text: typeof r.output === 'string' ? r.output : JSON.stringify(r.output) },
      ],
    }));
  }
}

/** The SDK surface this adapter relies on, narrowed to what it uses. */
interface GeminiClient {
  interactions: {
    create(params: Record<string, unknown>): Promise<GeminiInteraction>;
  };
}

interface GeminiInteraction {
  id?: string;
  output_text?: string;
  steps?: { type?: string; id?: string; name?: string; arguments?: unknown; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    candidates_tokens?: number;
  };
}
