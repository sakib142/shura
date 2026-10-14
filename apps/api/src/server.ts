/**
 * The watch server.
 *
 * One page, one event stream, no build step and no framework. An open-source
 * user should be able to run `shura watch` and have something to look at
 * without installing a front end toolchain first.
 *
 * It reads the events table and nothing else, so it works while a run is in
 * progress in another terminal and equally well on a run that finished
 * yesterday.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { PAGE } from './page.js';

export interface WatchServerOptions {
  readonly pool: Pool;
  readonly port: number;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly at: string;
  readonly work_item_key: string | null;
}

export function startWatchServer(o: WatchServerOptions): { close: () => Promise<void> } {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') return page(res);
    if (url.pathname === '/events') return stream(o.pool, url, req, res);
    if (url.pathname === '/runs') return runs(o.pool, res);
    res.writeHead(404).end('not found');
  });
  server.listen(o.port);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function page(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
}

async function runs(pool: Pool, res: ServerResponse): Promise<void> {
  const { rows } = await pool.query(
    `SELECT w.key, w.title, w.state, count(e.id) AS events, max(e.at) AS last_at
       FROM work_items w LEFT JOIN events e ON e.work_item_id = w.id
      GROUP BY w.key, w.title, w.state
      HAVING count(e.id) > 0
      ORDER BY max(e.at) DESC NULLS LAST LIMIT 25`,
  );
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
}

/**
 * Server-sent events, by polling for rows after the last id delivered.
 *
 * Polling rather than LISTEN/NOTIFY because it survives a reconnect without
 * losing anything: the client sends the last id it saw, so a dropped
 * connection replays rather than skips.
 */
async function stream(
  pool: Pool,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const key = url.searchParams.get('key');
  let after = Number(url.searchParams.get('after') ?? '0');

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let open = true;
  req.on('close', () => {
    open = false;
  });

  while (open) {
    const { rows } = await pool.query<EventRow>(
      `SELECT e.id, e.type, e.payload, e.at, w.key AS work_item_key
         FROM events e LEFT JOIN work_items w ON w.id = e.work_item_id
        WHERE e.id > $1 ${key === null ? '' : 'AND w.key = $2'}
        ORDER BY e.id LIMIT 200`,
      key === null ? [after] : [after, key],
    );

    for (const row of rows) {
      after = Number(row.id);
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    }
    // A comment line keeps proxies and browsers from closing an idle stream.
    if (rows.length === 0) res.write(': keep-alive\n\n');
    await new Promise((r) => setTimeout(r, 400));
  }
  res.end();
}
