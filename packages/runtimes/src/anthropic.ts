/**
 * The Anthropic adapter.
 *
 * A manual loop rather than the SDK tool runner, because every tool call has to
 * pass through our gateway for permission, validation, idempotency and audit —
 * the runner expects to call a `run()` function directly, and routing the
 * gateway inside one would still leave budget enforcement and event emission
 * outside the loop. The runner is also beta.
 *
 * API shapes current as of 2026-10-14: adaptive thinking (`budget_tokens` is
 * rejected on current models), effort via `output_config`, and no assistant
 * prefill.
 */

import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, type Vendor } from '@forge/core';
import type { AgentEvent, AgentRuntime, RunRequest } from '@forge/ports';
import { runAgentLoop, type VendorConversation, type VendorTurn } from './loop.js';
import { systemPrompt, userPrompt } from './prompt.js';

/** Per-request output cap. Kept under the SDK HTTP timeout for non-streaming
 *  requests; the loop continues across turns, so this is not a task ceiling. */
const MAX_TOKENS_PER_TURN = 16_000;

export interface AnthropicRuntimeOptions {
  readonly apiKey?: string;
  readonly client?: Anthropic;
}

export class AnthropicRuntime implements AgentRuntime {
  readonly vendor: Vendor = 'anthropic';
  readonly id = 'anthropic';
  readonly #client: Anthropic;

  constructor(opts: AnthropicRuntimeOptions = {}) {
    this.#client =
      opts.client ??
      (opts.apiKey === undefined ? new Anthropic() : new Anthropic({ apiKey: opts.apiKey }));
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
      conversation: new AnthropicConversation(this.#client, model, req),
    });
  }
}

class AnthropicConversation implements VendorConversation {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #req: RunRequest;
  readonly #messages: Anthropic.MessageParam[];
  readonly #tools: Anthropic.Tool[];

  constructor(client: Anthropic, model: string, req: RunRequest) {
    this.#client = client;
    this.#model = model;
    this.#req = req;
    this.#messages = [{ role: 'user', content: userPrompt(req) }];
    this.#tools = toolDefinitions(req.tools).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.parameters as Anthropic.Tool.InputSchema,
      // Guarantees the input validates against the schema, so a malformed call
      // never reaches the gateway in the first place.
      strict: true,
    }));
  }

  async turn(): Promise<VendorTurn> {
    const response = await this.#client.messages.create(
      {
        model: this.#model,
        max_tokens: MAX_TOKENS_PER_TURN,
        system: systemPrompt(this.#req),
        messages: this.#messages,
        ...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
        thinking: { type: 'adaptive' },
      },
      { signal: this.#req.signal },
    );

    this.#messages.push({ role: 'assistant', content: response.content });

    const reasoning = response.content
      .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
      .map((b) => b.thinking)
      .join('\n');

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));

    // A paused turn is not finished. The assistant turn is already on the
    // transcript above, so the loop only has to come round again — and if the
    // pause did carry tool calls, they are handled on the normal path below.
    if (response.stop_reason === 'pause_turn' && toolCalls.length === 0) {
      return {
        reasoning,
        toolCalls: [],
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        done: false,
        continueWithoutTools: true,
      };
    }

    return {
      reasoning,
      text,
      toolCalls,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      done: response.stop_reason === 'end_turn',
      ...(response.stop_reason === 'refusal'
        ? { refusal: response.stop_details?.explanation ?? 'safety refusal' }
        : {}),
      ...(response.stop_reason === 'max_tokens' ? { truncated: true } : {}),
    };
  }

  submitToolResults(results: readonly { id: string; output: unknown; isError: boolean }[]): void {
    // All results in a single user message. Splitting them across messages
    // teaches the model to stop making parallel calls.
    this.#messages.push({
      role: 'user',
      content: results.map(
        (r): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
          is_error: r.isError,
        }),
      ),
    });
  }
}

export async function* once(event: AgentEvent): AsyncIterable<AgentEvent> {
  yield event;
}
