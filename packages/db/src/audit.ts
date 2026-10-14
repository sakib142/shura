/**
 * The Postgres audit sink, and the chain check over it.
 *
 * The sink only inserts. Nothing here can update or delete, and the application
 * role holds no grant to do so either — the hash chain exists to catch whoever
 * can.
 */

import type { Pool } from 'pg';
import type { AuditSink, ToolCallAudit } from '@forge/tool-gateway';

export class PgAuditSink implements AuditSink {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(entry: ToolCallAudit): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tool_calls (task_id, agent_id, tool, args_hash, allowed, denial_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.taskId,
        entry.agentId,
        entry.tool,
        entry.argsHash,
        entry.allowed,
        entry.denialReason ?? null,
      ],
    );
  }
}

export interface ChainBreak {
  readonly table: string;
  readonly id: string;
  readonly reason: string;
}

/**
 * Walks an audit chain and reports the first row whose contents disagree with
 * its recorded hash, or whose link to its predecessor is broken. An empty array
 * means the log is intact.
 */
export async function verifyAuditChain(
  pool: Pool,
  tables: readonly string[] = ['events', 'tool_calls'],
): Promise<ChainBreak[]> {
  const breaks: ChainBreak[] = [];
  for (const table of tables) {
    const { rows } = await pool.query<{ bad_id: string; reason: string }>(
      `SELECT bad_id, reason FROM verify_audit_chain($1)`,
      [table],
    );
    for (const r of rows) breaks.push({ table, id: r.bad_id, reason: r.reason });
  }
  return breaks;
}
