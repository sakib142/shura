/**
 * Token pricing, in USD per million tokens.
 *
 * Rule 4 requires a cost on every verdict, and the eval harness divides catch
 * rate by spend — so a wrong number here quietly corrupts the one measurement
 * the whole slice exists to produce.
 *
 * Which is why a model that is not listed returns `undefined` rather than zero.
 * A guessed price reads exactly like a real one in a report; a missing price
 * announces itself. Prices checked against vendor documentation on 2026-10-14.
 */

import type { Vendor } from '@shura/core';

export interface TokenPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export const PRICING: Readonly<Record<string, TokenPrice>> = {
  // Anthropic
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },

  // OpenAI
  'gpt-6-astra': { inputPerMTok: 10, outputPerMTok: 50 },
  'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 },
  'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5 },

  // Google — deliberately absent. Gemini pricing was not verified when this
  // table was written, and inventing it would put a fabricated number in the
  // cost column of the report that decides whether to fund the roadmap.
};

/** Self-hosted models have no per-token price; the cost is the hardware. */
export function isSelfHosted(vendor: Vendor): boolean {
  return vendor === 'local';
}

export interface Cost {
  readonly usd: number;
  /** False when the model has no published price here, so a report can say so
   *  rather than showing a confident zero. */
  readonly known: boolean;
}

export function costOf(
  vendor: Vendor,
  model: string,
  tokensIn: number,
  tokensOut: number,
): Cost {
  if (isSelfHosted(vendor)) return { usd: 0, known: true };

  const price = PRICING[model];
  if (price === undefined) return { usd: 0, known: false };

  const usd =
    (tokensIn / 1_000_000) * price.inputPerMTok +
    (tokensOut / 1_000_000) * price.outputPerMTok;
  return { usd, known: true };
}

export function hasPricing(model: string): boolean {
  return Object.hasOwn(PRICING, model);
}
