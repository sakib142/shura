/**
 * The Postgres effect store.
 *
 * The claim is atomic: `INSERT ... ON CONFLICT DO NOTHING` either wins the key
 * or tells us somebody else holds it. Every state change afterwards is guarded
 * by the status we observed, so two workers racing on the same key cannot both
 * conclude they own the effect.
 */

import type { Pool } from 'pg';
import type { EffectClaim, EffectStore } from '@forge/ports';

export const DEFAULT_LEASE = '15 minutes';

export class PgEffectStore implements EffectStore {
  readonly #pool: Pool;
  readonly #lease: string;

  constructor(pool: Pool, lease: string = DEFAULT_LEASE) {
    this.#pool = pool;
    this.#lease = lease;
  }

  async begin(key: string, tool: string, taskId: string, reclaimable: boolean): Promise<EffectClaim> {
    const claimed = await this.#pool.query(
      `INSERT INTO effects (key, tool, task_id, status)
       VALUES ($1, $2, $3, 'in_flight')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, tool, taskId],
    );
    if (claimed.rowCount === 1) return { state: 'claimed' };

    const { rows } = await this.#pool.query<{ status: string; result: unknown; claimed_at: Date }>(
      `SELECT status, result, claimed_at FROM effects WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) {
      // Deleted between our insert and our read. Start over rather than guess.
      return this.begin(key, tool, taskId, reclaimable);
    }

    if (row.status === 'completed') return { state: 'completed', result: row.result };

    if (row.status === 'failed') {
      const retook = await this.#pool.query(
        `UPDATE effects SET status = 'in_flight', claimed_at = now(), reason = NULL
         WHERE key = $1 AND status = 'failed' RETURNING key`,
        [key],
      );
      if (retook.rowCount === 1) return { state: 'claimed' };
      return this.begin(key, tool, taskId, reclaimable);
    }

    // in_flight. Only an effect confined to our own workspace may be taken over,
    // and only once its lease has lapsed. Anything the outside world has seen
    // stays stuck here on purpose, for a human to resolve.
    if (reclaimable) {
      const retook = await this.#pool.query(
        `UPDATE effects SET claimed_at = now()
         WHERE key = $1 AND status = 'in_flight' AND claimed_at < now() - $2::interval
         RETURNING key`,
        [key, this.#lease],
      );
      if (retook.rowCount === 1) return { state: 'claimed' };
    }
    return { state: 'in_flight', since: row.claimed_at };
  }

  async complete(key: string, result: unknown): Promise<void> {
    await this.#pool.query(
      `UPDATE effects SET status = 'completed', result = $2::jsonb, completed_at = now()
       WHERE key = $1`,
      [key, JSON.stringify(result ?? null)],
    );
  }

  async fail(key: string, reason: string): Promise<void> {
    await this.#pool.query(
      `UPDATE effects SET status = 'failed', reason = $2 WHERE key = $1`,
      [key, reason],
    );
  }
}
