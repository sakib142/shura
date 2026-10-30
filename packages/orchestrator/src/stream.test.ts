import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, isReachable, verifyAuditChain } from '@shura/db';
import { recorder } from './stream.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[stream] Postgres unreachable — skipping.');

afterAll(async () => {
  if (up) await pool.query('TRUNCATE events, work_items CASCADE');
  await pool.end();
});

async function item(key: string): Promise<void> {
  await pool.query(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A thing', '[]'::jsonb, 'draft')`,
    [key],
  );
}

d('recording events', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE events, work_items CASCADE');
  });

  it('persists what it streams', async () => {
    await item('EV-1');
    const seen: string[] = [];
    const emit = recorder(pool, 'EV-1', (e) => seen.push(e.kind));
    emit({ kind: 'note', text: 'one' });
    await emit.flush();

    expect(seen).toEqual(['note']);
    const { rows } = await pool.query<{ type: string }>('SELECT type FROM events');
    expect(rows).toHaveLength(1);
  });

  /**
   * The bug this exists for.
   *
   * The chain trigger takes an advisory lock so two appends cannot read the
   * same predecessor — but `bigserial` allocates the id BEFORE that lock. Two
   * concurrent inserts could take ids 2 and 3 and run the trigger in the
   * opposite order, leaving row 3 chained to row 1. `shura audit --verify`
   * then reported the log as tampered when nothing had tampered with it.
   *
   * Found on a real run: two emits back to back in the planner.
   */
  it('keeps the hash chain intact when events are emitted back to back', async () => {
    await item('EV-2');
    const emit = recorder(pool, 'EV-2', () => {});
    for (let i = 0; i < 25; i++) emit({ kind: 'note', text: `event ${i}` });
    await emit.flush();

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM events');
    expect(Number(rows[0]!.n)).toBe(25);
    expect(await verifyAuditChain(pool)).toEqual([]);
  });

  it('keeps it intact across two runs recording at once', async () => {
    await item('EV-3');
    await item('EV-4');
    const a = recorder(pool, 'EV-3', () => {});
    const b = recorder(pool, 'EV-4', () => {});
    for (let i = 0; i < 15; i++) {
      a({ kind: 'note', text: `a${i}` });
      b({ kind: 'note', text: `b${i}` });
    }
    await Promise.all([a.flush(), b.flush()]);

    expect(await verifyAuditChain(pool)).toEqual([]);
  });

  // Recording must never break a run that is otherwise working — and one
  // failed insert must not stall every event queued behind it.
  it('carries on after an event that matches no work item', async () => {
    await item('EV-5');
    const emit = recorder(pool, 'EV-5', () => {});
    const orphan = recorder(pool, 'NO-SUCH-ITEM', () => {});

    orphan({ kind: 'note', text: 'goes nowhere' });
    emit({ kind: 'note', text: 'still recorded' });
    await Promise.all([orphan.flush(), emit.flush()]);

    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM events');
    expect(Number(rows[0]!.n)).toBe(1);
    expect(await verifyAuditChain(pool)).toEqual([]);
  });
});
