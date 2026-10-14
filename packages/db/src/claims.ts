/**
 * File ownership between agents.
 *
 * A claim covers a branch and a set of file globs. Two agents may not hold
 * overlapping globs at the same time, and may not hold the same branch at all.
 *
 * The expiry rule matters as much as the overlap rule. An agent that dies
 * holding a claim must not block that work forever, and an agent still working
 * must not have its claim taken out from under it — so a live claim is renewed
 * by a heartbeat, and only a claim whose heartbeat has stopped can be taken
 * over.
 */

import type { Pool } from 'pg';
import { overlappingGlobs } from '@shura/core';

export interface ClaimRequest {
  readonly agentId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly fileGlobs: readonly string[];
  readonly ttlSeconds?: number;
}

export type ClaimResult =
  | { readonly granted: true; readonly claimId: string; readonly expiresAt: Date }
  | {
      readonly granted: false;
      readonly reason: string;
      readonly heldBy: string;
      readonly conflicts: readonly { readonly wanted: string; readonly held: string }[];
    };

export const DEFAULT_TTL_SECONDS = 30 * 60;

interface Row {
  id: string;
  agent_id: string;
  task_id: string;
  branch: string;
  file_globs: string[];
  expires_at: Date;
}

export class PgClaims {
  constructor(private readonly pool: Pool) {}

  /**
   * Takes the claim, or explains who holds it.
   *
   * Runs in one serializable transaction: two agents asking at the same moment
   * must not both be told yes, and a check followed by an unguarded insert is
   * exactly how that happens.
   */
  async acquire(req: ClaimRequest): Promise<ClaimResult> {
    const ttl = req.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Expire anything whose heartbeat stopped before taking the lock, so a
      // dead agent's claim does not outlive it.
      await client.query(
        `UPDATE claims SET released_at = now()
          WHERE released_at IS NULL AND expires_at < now()`,
      );

      const { rows: live } = await client.query<Row>(
        `SELECT id, agent_id, task_id, branch, file_globs, expires_at
           FROM claims WHERE released_at IS NULL FOR UPDATE`,
      );

      const mine = live.find((r) => r.task_id === req.taskId && r.branch === req.branch);
      if (mine !== undefined) {
        // Extending an existing claim with more globs, which is what happens
        // when an agent discovers it needs another file.
        const others = live.filter((r) => r.id !== mine.id);
        const clash = this.#firstClash(req.fileGlobs, others);
        if (clash !== undefined) {
          await client.query('ROLLBACK');
          return clash;
        }
        const merged = [...new Set([...mine.file_globs, ...req.fileGlobs])];
        const { rows } = await client.query<{ id: string; expires_at: Date }>(
          `UPDATE claims SET file_globs = $2, expires_at = now() + ($3 || ' seconds')::interval,
                             heartbeat_at = now()
            WHERE id = $1 RETURNING id, expires_at`,
          [mine.id, merged, String(ttl)],
        );
        await client.query('COMMIT');
        return { granted: true, claimId: rows[0]!.id, expiresAt: rows[0]!.expires_at };
      }

      const onBranch = live.find((r) => r.branch === req.branch);
      if (onBranch !== undefined) {
        await client.query('ROLLBACK');
        return {
          granted: false,
          reason: `branch "${req.branch}" is already claimed`,
          heldBy: onBranch.agent_id,
          conflicts: [],
        };
      }

      const clash = this.#firstClash(req.fileGlobs, live);
      if (clash !== undefined) {
        await client.query('ROLLBACK');
        return clash;
      }

      const { rows } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO claims (agent_id, task_id, branch, file_globs, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
         RETURNING id, expires_at`,
        [req.agentId, req.taskId, req.branch, req.fileGlobs, String(ttl)],
      );
      await client.query('COMMIT');
      return { granted: true, claimId: rows[0]!.id, expiresAt: rows[0]!.expires_at };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Still alive. Returns false if the claim was already expired or released. */
  async heartbeat(claimId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE claims SET heartbeat_at = now(), expires_at = now() + ($2 || ' seconds')::interval
        WHERE id = $1 AND released_at IS NULL`,
      [claimId, String(ttlSeconds)],
    );
    return rowCount === 1;
  }

  async release(claimId: string): Promise<void> {
    await this.pool.query(`UPDATE claims SET released_at = now() WHERE id = $1`, [claimId]);
  }

  async liveClaims(): Promise<readonly { agentId: string; branch: string; globs: string[] }[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, agent_id, task_id, branch, file_globs, expires_at
         FROM claims WHERE released_at IS NULL AND expires_at > now() ORDER BY branch`,
    );
    return rows.map((r) => ({ agentId: r.agent_id, branch: r.branch, globs: r.file_globs }));
  }

  #firstClash(
    wanted: readonly string[],
    live: readonly Row[],
  ): (ClaimResult & { granted: false }) | undefined {
    for (const row of live) {
      const conflicts = overlappingGlobs(wanted, row.file_globs);
      if (conflicts.length > 0) {
        return {
          granted: false,
          reason:
            `${conflicts.length} file pattern(s) are already claimed by ${row.agent_id} ` +
            `on branch "${row.branch}"`,
          heldBy: row.agent_id,
          conflicts,
        };
      }
    }
    return undefined;
  }
}
