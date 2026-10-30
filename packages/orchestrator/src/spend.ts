/**
 * Saying what a run cost, when nothing was charged for it.
 *
 * Both CLIs report a dollar figure even on a subscription, and it is a real
 * number — what the same work would have cost through the metered API. It is
 * not what the user paid, which was nothing beyond a monthly fee they were
 * paying anyway.
 *
 * Printing it bare reads as a charge. A planning run reported "$0.4628" and
 * the only honest reading of that line was the wrong one, on a platform whose
 * whole argument is that it costs nothing extra to run.
 */

/** Rendered for a human: what it would have cost, said as what it is. */
export function describeSpend(usd: number, metered: boolean): string {
  if (metered) return `$${usd.toFixed(4)}`;
  if (usd <= 0) return 'no charge (subscription)';
  return `$${usd.toFixed(4)} of quota, not billed (subscription)`;
}

/**
 * Whether this run was billed per token.
 *
 * Shura drives the vendor CLIs under the user's own subscription, so the
 * answer today is always no. It is a function rather than a constant because
 * the distinction is what the wording depends on, and a future API-backed
 * runtime would need the other branch rather than a new vocabulary.
 */
export function isMetered(runtimeId: string): boolean {
  return !runtimeId.endsWith('-cli');
}
