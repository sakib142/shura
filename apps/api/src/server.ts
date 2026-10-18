/**
 * The web surface.
 *
 * One page, one event stream, no build step and no framework. Someone who has
 * just cloned this should be able to run one command and have something to look
 * at, without installing a front end toolchain first.
 *
 * Started without a `jobs` runner it is the read-only dashboard `shura watch`
 * has always been. Started with one, it is also how work is submitted: a repo
 * and a sentence in, a plan to read, a pull request out.
 *
 * Two things about running a server that can spend money and push code:
 *
 *   - it binds 127.0.0.1 by default, not every interface. A dashboard on the
 *     office wifi is a curiosity; an agent that pushes to your repositories on
 *     the office wifi is not.
 *   - a mutating request must come from this server's own page. Any site you
 *     have open can POST to localhost, so without the check a page in another
 *     tab could start a run against your repository with your credentials.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { PAGE } from './page.js';
import { PgPlans } from '@shura/db';
import { approvability } from '@shura/core';
import type { JobRunner } from './jobs.js';

export * from './jobs.js';

export interface WatchServerOptions {
  readonly pool: Pool;
  readonly port: number;
  /** Absent for a read-only dashboard. Present for `shura serve`. */
  readonly jobs?: JobRunner;
  /** Defaults to loopback. Widen only deliberately. */
  readonly host?: string;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly at: string;
  readonly work_item_key: string | null;
}

export function startWatchServer(o: WatchServerOptions): { close: () => Promise<void> } {
  const host = o.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET') {
      if (url.pathname === '/') return page(res);
      if (url.pathname === '/events') return stream(o.pool, url, req, res);
      if (url.pathname === '/runs') return runs(o.pool, res);
      if (url.pathname === '/plans') return plans(o.pool, res);
      if (url.pathname === '/status') return status(o.jobs, res);
      return void res.writeHead(404).end('not found');
    }

    if (req.method === 'POST') {
      if (o.jobs === undefined) {
        // `shura watch` is a viewer. It must not become a way to spend money
        // because something sent it a POST.
        return void json(res, 405, {
          error:
            'this server is read-only. Start it with `shura serve` to submit work from the browser.',
        });
      }
      if (!sameOrigin(req, o.port, host)) {
        return void json(res, 403, {
          error: 'cross-origin request refused; use the page this server serves',
        });
      }
      const jobs = o.jobs;
      if (url.pathname === '/jobs') return void submit(jobs, req, res);
      const approve = /^\/plans\/([0-9a-fA-F-]{6,36})\/(approve|reject)$/.exec(url.pathname);
      if (approve !== null) {
        return void decide(o.pool, jobs, approve[1]!, approve[2] as 'approve' | 'reject', req, res);
      }
      return void json(res, 404, { error: 'no such endpoint' });
    }

    res.writeHead(405).end('method not allowed');
  });
  server.listen(o.port, host);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * Whether a mutating request came from this server's own page.
 *
 * Any site you have open can POST to localhost. Without this, a page in another
 * tab could start a run against your repository, with your token and your
 * vendor keys, and the first you would know is a pull request.
 *
 * `Sec-Fetch-Site` is the modern answer and every current browser sends it;
 * `Origin` is the fallback. A request with neither is not a browser, and is
 * refused rather than trusted — curl can still drive this by sending an Origin,
 * which is a deliberate convenience for scripting, not a hole: an attacker's
 * page cannot set that header.
 */
function sameOrigin(req: IncomingMessage, port: number, host: string): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return true;
  if (typeof site === 'string') return false;

  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  return [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(
    origin,
  );
}

/** Body, with a cap: this is a text field, not an upload endpoint. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function status(jobs: JobRunner | undefined, res: ServerResponse): void {
  if (jobs === undefined) {
    return json(res, 200, { readOnly: true, phase: 'idle' });
  }
  json(res, 200, { readOnly: false, ...jobs.state(), estimate: jobs.estimate() });
}

/**
 * Submit a repository and a sentence.
 *
 * Returns as soon as the job has started, not when it finishes: planning takes
 * a minute or two and the page follows along on the event stream rather than
 * holding a request open. The click itself is the cost consent — the page shows
 * what will be called and the ceiling next to the button.
 */
async function submit(jobs: JobRunner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === undefined) return json(res, 400, { error: 'expected a small JSON body' });

  const repo = typeof body['repo'] === 'string' ? body['repo'].trim() : '';
  const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
  if (repo === '') return json(res, 400, { error: 'name a repository, as owner/name' });
  if (task === '') {
    return json(res, 400, { error: 'say what to build or fix — a sentence is enough' });
  }
  if (jobs.state().phase !== 'idle') {
    return json(res, 409, {
      error: `already ${jobs.state().phase}. One job at a time: two agents on one branch is the ` +
        'collision the claim refuses anyway.',
    });
  }

  json(res, 202, { started: true });
  // Detached on purpose. Failures surface on the event stream and in /status.
  void jobs.plan({ repo, task });
}

/** Approve a plan and start building it, or reject it with a reason. */
async function decide(
  pool: Pool,
  jobs: JobRunner,
  planId: string,
  action: 'approve' | 'reject',
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJson(req)) ?? {};
  const store = new PgPlans(pool);

  const matches = await store.find(planId);
  const plan = matches.length === 1 ? matches[0] : undefined;
  if (plan === undefined) {
    return json(res, 404, { error: `no single plan matching "${planId}"` });
  }
  if (plan.status !== 'awaiting_approval') {
    return json(res, 409, { error: `that plan is already "${plan.status}"` });
  }

  const note = typeof body['note'] === 'string' ? body['note'] : undefined;

  if (action === 'reject') {
    if (note === undefined || note.trim() === '') {
      return json(res, 400, {
        error:
          'say what is wrong with it. The agent cannot do better from a rejection with no ' +
          'reason, and neither can you in a week.',
      });
    }
    await store.decide(plan.id, 'rejected', approver(body), [], note);
    return json(res, 200, { rejected: true });
  }

  // The gate, enforced here and not only in the CLI. A browser button that
  // skipped the open questions would turn the whole thing into a rubber stamp.
  const answers = Array.isArray(body['answers'])
    ? (body['answers'] as unknown[]).map((a) => (typeof a === 'string' ? a : ''))
    : [];
  const verdict = approvability({
    openQuestions: plan.openQuestions,
    answers,
    ignoreQuestions: body['ignoreQuestions'] === true,
  });
  if (!verdict.ok) {
    return json(res, 400, {
      error: 'answer the open questions, or say explicitly that the agent should decide them',
      unanswered: verdict.unanswered,
    });
  }
  if (jobs.state().phase !== 'idle') {
    return json(res, 409, { error: `already ${jobs.state().phase}; wait for it to finish` });
  }

  await store.decide(plan.id, 'approved', approver(body), answers, note);
  json(res, 202, { approved: true, building: true });
  void jobs.build(plan.id);
}

/** Who approved. Named by the browser if it was told, the host user otherwise. */
function approver(body: Record<string, unknown>): string {
  const given = body['approver'];
  if (typeof given === 'string' && given.trim() !== '') return given.trim().slice(0, 200);
  return process.env.USER ?? process.env.LOGNAME ?? 'browser';
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
 * Plans waiting for a human.
 *
 * The gate is the centre of the flow and was terminal-only: a plan could sit
 * awaiting approval indefinitely with the live view showing a finished run and
 * no hint that anything wanted a decision. Read-only — approving stays a
 * deliberate act at the command line, where the open questions have to be
 * answered rather than clicked past.
 */
async function plans(pool: Pool, res: ServerResponse): Promise<void> {
  const { rows } = await pool.query(
    `SELECT p.id, p.repo, w.key, w.title,
            jsonb_array_length(p.criteria) AS criteria,
            jsonb_array_length(p.open_questions) AS open_questions,
            -- The text as well as the count: the page renders a box per
            -- question, and the gate is only real if the asker can read what
            -- they are answering.
            p.open_questions AS open_questions_text,
            p.criteria AS criteria_text,
            p.vendor, p.model, p.cost_usd
       FROM plans p JOIN work_items w ON w.id = p.work_item_id
      WHERE p.status = 'awaiting_approval'
      ORDER BY p.created_at LIMIT 10`,
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
