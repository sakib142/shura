import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, isReachable } from '@shura/db';
import { startWatchServer } from './server.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[watch] Postgres unreachable — skipping.');

// A port unlikely to collide with a watch server someone is actually using.
const PORT = 7791;
const server = up ? startWatchServer({ pool, port: PORT }) : undefined;
const at = (path: string): string => `http://127.0.0.1:${PORT}${path}`;

afterAll(async () => {
  await server?.close();
  if (up) await pool.query('TRUNCATE events, plans, work_items CASCADE');
  await pool.end();
});

async function itemWithEvents(key: string, count: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A thing', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  const id = rows[0]!.id;
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO events (work_item_id, type, payload)
       VALUES ($1, 'note', $2::jsonb)`,
      [id, JSON.stringify({ kind: 'note', text: `event ${i}` })],
    );
  }
  return id;
}

/** Reads the SSE stream for a moment, then gives up what it got. */
async function sseLines(path: string, ms = 700): Promise<string[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const lines: string[] = [];
  try {
    const res = await fetch(at(path), { signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Keep the trailing fragment: a data: line can arrive split across two
      // chunks, and discarding the remainder loses it.
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.startsWith('data:')) lines.push(line.slice(5).trim());
      }
    }
  } catch {
    // Aborting the read is how this test ends; the lines collected are the result.
  } finally {
    clearTimeout(timer);
  }
  return lines;
}

/**
 * The page is one String.raw template, so a backtick anywhere inside it ends
 * the literal and the file stops parsing. It has happened twice, both times in
 * a prose comment mentioning a command name, and both times the error pointed
 * at a line far from the cause.
 */
describe('the page template', () => {
  it('contains no backtick that would end the literal', async () => {
    const source = await readFile(new URL('./page.ts', import.meta.url), 'utf8');
    const body = source.split('String.raw`')[1]!;
    const inside = body.slice(0, body.lastIndexOf('`'));
    expect(inside).not.toContain('`');
  });

  it('is served whole, with the closing tag intact', async () => {
    const html = await (await fetch(at('/'))).text();
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});

d('the watch server', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE events, plans, work_items CASCADE');
  });

  it('serves the page', async () => {
    const html = await (await fetch(at('/'))).text();
    expect(html).toContain('Shura');
    expect(html).toContain('id="gate"');
  });

  it('404s an unknown path', async () => {
    expect((await fetch(at('/nope'))).status).toBe(404);
  });

  /**
   * The bug this fixes: the client never sent `after`, so every connect — and
   * every silent EventSource reconnect — replayed the whole table from row 1.
   */
  it('replays everything when given no cursor', async () => {
    await itemWithEvents('WATCH-1', 3);
    expect(await sseLines('/events')).toHaveLength(3);
  });

  it('sends only what is newer than the cursor', async () => {
    await itemWithEvents('WATCH-2', 3);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM events ORDER BY id');
    const second = Number(rows[1]!.id);

    const lines = await sseLines(`/events?after=${second}`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).payload.text).toBe('event 2');
  });

  it('sends nothing when the cursor is already current', async () => {
    await itemWithEvents('WATCH-3', 2);
    const { rows } = await pool.query<{ max: string }>('SELECT max(id) AS max FROM events');
    expect(await sseLines(`/events?after=${rows[0]!.max}`)).toEqual([]);
  });

  it('filters to one run by key', async () => {
    await itemWithEvents('WATCH-4', 2);
    await itemWithEvents('WATCH-5', 3);
    expect(await sseLines('/events?key=WATCH-5')).toHaveLength(3);
  });

  describe('the plan gate', () => {
    async function awaitingPlan(key: string): Promise<void> {
      const id = await itemWithEvents(key, 0);
      await pool.query(
        `INSERT INTO plans (work_item_id, task_id, repo, request, source, base, checks,
                            understanding, approach, criteria, open_questions,
                            author, vendor, model, cost_usd)
         VALUES ($1, 't1', 'me/app', 'do a thing', 'instructions', 'main', '[]'::jsonb,
                 'u', 'a', '["Given x, when y, then z"]'::jsonb, '["really?"]'::jsonb,
                 'plan-01', 'anthropic', 'claude-sonnet-5', 0.0431)`,
        [id],
      );
    }

    it('reports a plan waiting for a human', async () => {
      await awaitingPlan('WATCH-6');
      const plans = (await (await fetch(at('/plans'))).json()) as Record<string, unknown>[];
      const [plan] = plans;
      expect(plan).toMatchObject({
        key: 'WATCH-6',
        repo: 'me/app',
        criteria: 1,
        open_questions: 1,
        model: 'claude-sonnet-5',
      });
    });

    it('stops reporting it once it is decided', async () => {
      await awaitingPlan('WATCH-7');
      await pool.query(`UPDATE plans SET status = 'approved'`);
      expect(await (await fetch(at('/plans'))).json()).toEqual([]);
    });

    // A plan sitting at the gate has no events of its own, and /runs hides
    // event-less work items — which is why the gate needed its own route
    // rather than being inferable from the run list.
    it('shows a plan whose run would not appear in the run list', async () => {
      await awaitingPlan('WATCH-8');
      expect(await (await fetch(at('/runs'))).json()).toEqual([]);
      expect(await (await fetch(at('/plans'))).json()).toHaveLength(1);
    });
  });
});
