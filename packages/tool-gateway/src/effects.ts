/**
 * Idempotency for side-effecting tools.
 *
 * The protocol, and the part naive implementations get wrong: the key is
 * claimed *before* the handler runs, and completed after. That leaves three
 * distinguishable states rather than two.
 *
 *   completed  — replay the recorded result, never call the handler again
 *   failed     — the handler returned control with an error, so the attempt is
 *                over and a retry is safe
 *   in_flight  — somebody claimed it and never came back. The process died
 *                mid-effect and we cannot know whether the effect landed.
 *
 * That last state is the whole point. Retrying it silently is how a merge
 * happens twice. For effects confined to our own workspace it can be reclaimed
 * after a lease expires; for anything the outside world has already seen it
 * escalates to a human.
 */

import type { EffectClaim, EffectStore } from '@shura/ports';

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

interface Row {
  key: string;
  tool: string;
  taskId: string;
  status: 'in_flight' | 'completed' | 'failed';
  result?: unknown;
  claimedAt: Date;
}

export class InMemoryEffectStore implements EffectStore {
  readonly rows = new Map<string, Row>();
  #now: () => Date;
  readonly #leaseMs: number;

  constructor(opts: { now?: () => Date; leaseMs?: number } = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  }

  /** Test seam: move the clock without touching the rows. */
  setClock(now: () => Date): void {
    this.#now = now;
  }

  async begin(key: string, tool: string, taskId: string, reclaimable: boolean): Promise<EffectClaim> {
    const existing = this.rows.get(key);

    if (existing === undefined) {
      this.rows.set(key, { key, tool, taskId, status: 'in_flight', claimedAt: this.#now() });
      return { state: 'claimed' };
    }

    if (existing.status === 'completed') {
      return { state: 'completed', result: existing.result };
    }

    if (existing.status === 'failed') {
      existing.status = 'in_flight';
      existing.claimedAt = this.#now();
      return { state: 'claimed' };
    }

    const age = this.#now().getTime() - existing.claimedAt.getTime();
    if (reclaimable && age >= this.#leaseMs) {
      existing.claimedAt = this.#now();
      return { state: 'claimed' };
    }
    return { state: 'in_flight', since: existing.claimedAt };
  }

  async complete(key: string, result: unknown): Promise<void> {
    const row = this.rows.get(key);
    if (row === undefined) throw new Error(`cannot complete unclaimed effect "${key}"`);
    row.status = 'completed';
    row.result = result;
  }

  async fail(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row === undefined) return;
    row.status = 'failed';
  }
}
