import { describe, expect, it } from 'vitest';
import { PRICING, costOf, hasPricing } from './pricing.js';

describe('cost accounting', () => {
  it('prices a known model from its token counts', () => {
    // claude-sonnet-5: $3 in / $15 out per MTok
    const c = costOf('anthropic', 'claude-sonnet-5', 1_000_000, 1_000_000);
    expect(c).toEqual({ usd: 18, known: true });
  });

  // A guessed price reads exactly like a real one in a report. A missing one
  // announces itself.
  it('reports an unknown model as unknown rather than free', () => {
    const c = costOf('google', 'gemini-3.8-flash', 1_000_000, 1_000_000);
    expect(c).toEqual({ usd: 0, known: false });
  });

  it('treats self-hosted models as genuinely zero, and says so', () => {
    expect(costOf('local', 'llama-whatever', 1_000_000, 0)).toEqual({ usd: 0, known: true });
  });

  it('has no zero-priced hosted entries, which would hide spend', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      expect(p.inputPerMTok, model).toBeGreaterThan(0);
      expect(p.outputPerMTok, model).toBeGreaterThan(0);
    }
  });

  it('prices output at least as much as input, as every vendor does', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      expect(p.outputPerMTok, model).toBeGreaterThanOrEqual(p.inputPerMTok);
    }
  });

  it('knows the models the shipped roles use, except the documented gap', () => {
    expect(hasPricing('claude-sonnet-5')).toBe(true);
    expect(hasPricing('gpt-6.1-sol')).toBe(true);
    // Deliberate: Gemini pricing was not verified, so it is absent rather than invented.
    expect(hasPricing('gemini-3.8-flash')).toBe(false);
  });
});
