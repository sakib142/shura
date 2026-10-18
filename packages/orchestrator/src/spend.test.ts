import { describe, expect, it } from 'vitest';
import { describeSpend, isMetered } from './spend.js';

/**
 * A planning run reported "planned for $0.4628" while the user was charged
 * nothing. Both CLIs report what the work would have cost through the metered
 * API, which is a real number and the wrong one to print bare on a platform
 * whose argument is that it costs nothing extra.
 */
describe('saying what a run cost', () => {
  it('names a subscription run as not billed', () => {
    expect(describeSpend(0.4628, false)).toBe('$0.4628 of quota, not billed (subscription)');
  });

  it('says plainly when there was no charge at all', () => {
    expect(describeSpend(0, false)).toBe('no charge (subscription)');
  });

  it('prints a metered run as a plain amount, because it is one', () => {
    expect(describeSpend(0.177, true)).toBe('$0.1770');
  });

  it('treats the CLI runtimes as unmetered and anything else as billed', () => {
    expect(isMetered('claude-cli')).toBe(false);
    expect(isMetered('codex-cli')).toBe(false);
    expect(isMetered('anthropic')).toBe(true);
    expect(isMetered('openai')).toBe(true);
  });
});
