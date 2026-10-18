import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, isReachable } from '@shura/db';
import { startWatchServer } from './server.js';
import type { CostEstimate, JobResult, JobRunner, JobState } from './jobs.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[serve] Postgres unreachable — skipping.');

const PORT = 7792;
const READ_ONLY_PORT = 7793;

/** Records what it was asked to do; calls no vendor and spends nothing. */
class FakeRunner implements JobRunner {
  planned: { repo: string; task: string }[] = [];
  built: string[] = [];
  state_: JobState = { phase: 'idle' };

  estimate(): CostEstimate {
    return {
      planner: 'anthropic/claude-sonnet-5',
      builder: 'anthropic/claude-sonnet-5',
      reviewer: 'openai/gpt-6.1-sol',
      planUsd: 3,
      buildUsd: 9,
      loopCap: 3,
    };
  }
  state(): JobState { return this.state_; }
  async plan(input: { repo: string; task: string }): Promise<JobResult> {
    this.planned.push(input);
    return { ok: true, planId: 'fake' };
  }
  async build(planId: string): Promise<JobResult> {
    this.built.push(planId);
    return { ok: true, url: 'https://github.com/o/r/pull/1' };
  }
}

const jobs = new FakeRunner();
const server = up ? startWatchServer({ pool, port: PORT, jobs }) : undefined;
const readOnly = up ? startWatchServer({ pool, port: READ_ONLY_PORT }) : undefined;

afterAll(async () => {
  await server?.close();
  await readOnly?.close();
  if (up) await pool.query('TRUNCATE events, plans, approvals, work_items CASCADE');
  await pool.end();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}, port = PORT) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    // What the page sends. Browsers add Sec-Fetch-Site themselves; here it is
    // explicit because fetch in Node does not.
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  });

async function awaitingPlan(key: string, questions: string[]): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A thing', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `INSERT INTO plans (work_item_id, task_id, repo, request, source, base, checks,
                        understanding, approach, criteria, open_questions,
                        author, vendor, model, cost_usd)
     VALUES ($1,'t1','me/app','do a thing','instructions','main','[]'::jsonb,'u','a',
             '["Given x, when y, then z"]'::jsonb, $2::jsonb,
             'plan-01','anthropic','claude-sonnet-5',0.04) RETURNING id`,
    [rows[0]!.id, JSON.stringify(questions)],
  );
  return p[0]!.id;
}

d('submitting work', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE events, plans, approvals, work_items CASCADE');
    jobs.planned = [];
    jobs.built = [];
    jobs.state_ = { phase: 'idle' };
  });

  it('starts a planning job and returns without waiting for it', async () => {
    const res = await post('/jobs', { repo: 'me/app', task: 'add a thing' });
    expect(res.status).toBe(202);
    expect(jobs.planned).toEqual([{ repo: 'me/app', task: 'add a thing' }]);
  });

  it('refuses a submission with no repository or no request', async () => {
    expect((await post('/jobs', { repo: '', task: 'x' })).status).toBe(400);
    expect((await post('/jobs', { repo: 'me/app', task: '  ' })).status).toBe(400);
    expect(jobs.planned).toEqual([]);
  });

  // Two agents on one branch is the collision claims refuses anyway; saying so
  // here means a sentence instead of a claim error from inside a hidden run.
  it('refuses a second job while one is running', async () => {
    jobs.state_ = { phase: 'planning', repo: 'me/app' };
    const res = await post('/jobs', { repo: 'me/other', task: 'x' });
    expect(res.status).toBe(409);
    expect(jobs.planned).toEqual([]);
  });

  it('reports what it will call and the ceiling, before anything is clicked', async () => {
    const s = (await (await fetch(`http://127.0.0.1:${PORT}/status`)).json()) as Record<string, unknown>;
    expect(s).toMatchObject({ readOnly: false, phase: 'idle' });
    expect(s['estimate']).toMatchObject({ planner: 'anthropic/claude-sonnet-5', planUsd: 3 });
  });
});

d('the plan gate, over HTTP', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE events, plans, approvals, work_items CASCADE');
    jobs.built = [];
    jobs.state_ = { phase: 'idle' };
  });

  it('approves a plan with nothing open, and starts the build', async () => {
    const id = await awaitingPlan('SRV-1', []);
    const res = await post(`/plans/${id}/approve`, { answers: [] });
    expect(res.status).toBe(202);
    expect(jobs.built).toEqual([id]);
  });

  /**
   * The rule the whole gate rests on. A browser button that let you click past
   * the open questions would make it a rubber stamp, so the refusal lives on
   * the server rather than in the page's validation.
   */
  it('refuses to approve while a question is unanswered', async () => {
    const id = await awaitingPlan('SRV-2', ['Does it persist?', 'What is the default?']);
    const res = await post(`/plans/${id}/approve`, { answers: ['yes', ''] });
    expect(res.status).toBe(400);
    const out = (await res.json()) as { unanswered?: string[] };
    expect(out.unanswered).toEqual(['What is the default?']);
    expect(jobs.built).toEqual([]);
  });

  it('approves once every question is answered, and records the answers', async () => {
    const id = await awaitingPlan('SRV-3', ['Does it persist?']);
    expect((await post(`/plans/${id}/approve`, { answers: ['it resets'] })).status).toBe(202);

    const { rows } = await pool.query<{ answers: string[]; status: string }>(
      'SELECT answers, status FROM plans WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ answers: ['it resets'], status: 'approved' });
    expect(jobs.built).toEqual([id]);
  });

  it('lets the agent decide them only when asked explicitly', async () => {
    const id = await awaitingPlan('SRV-4', ['Does it persist?']);
    const res = await post(`/plans/${id}/approve`, { answers: [], ignoreQuestions: true });
    expect(res.status).toBe(202);
  });

  it('refuses a rejection with no reason', async () => {
    const id = await awaitingPlan('SRV-5', []);
    expect((await post(`/plans/${id}/reject`, {})).status).toBe(400);
    expect((await post(`/plans/${id}/reject`, { note: 'wrong scope' })).status).toBe(200);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM plans WHERE id = $1', [id]);
    expect(rows[0]?.status).toBe('rejected');
  });

  it('refuses to decide the same plan twice', async () => {
    const id = await awaitingPlan('SRV-6', []);
    expect((await post(`/plans/${id}/approve`, { answers: [] })).status).toBe(202);
    expect((await post(`/plans/${id}/approve`, { answers: [] })).status).toBe(409);
  });

  it('records who approved it', async () => {
    const id = await awaitingPlan('SRV-7', []);
    await post(`/plans/${id}/approve`, { answers: [], approver: 'Mohammad' });
    const { rows } = await pool.query<{ approver: string; gate: string }>(
      'SELECT approver, gate FROM approvals WHERE subject_id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ approver: 'Mohammad', gate: 'plan' });
  });

  it('exposes the question text, so the asker can read what they answer', async () => {
    await awaitingPlan('SRV-8', ['Does it persist?']);
    const [plan] = (await (await fetch(`http://127.0.0.1:${PORT}/plans`)).json()) as Record<string, unknown>[];
    expect(plan!['open_questions_text']).toEqual(['Does it persist?']);
    expect(plan!['criteria_text']).toEqual(['Given x, when y, then z']);
  });
});

/**
 * A server that can spend money and push code needs these two properties, and
 * they are the kind that are easy to lose in a refactor.
 */
d('not letting anything else drive the agent', () => {
  beforeEach(async () => {
    jobs.planned = [];
    jobs.state_ = { phase: 'idle' };
  });

  // Any page you have open can POST to localhost. Without this check, a tab on
  // another site could start a run against your repository with your token.
  it('refuses a cross-site POST', async () => {
    const res = await post('/jobs', { repo: 'me/app', task: 'x' }, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(jobs.planned).toEqual([]);
  });

  it('refuses a POST with no origin signal at all', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'me/app', task: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(jobs.planned).toEqual([]);
  });

  // A real browser always sends Sec-Fetch-Site. A script does not, so Origin is
  // the fallback — and an attacker's page cannot set that header, which is what
  // makes accepting it safe.
  it('accepts a matching Origin when there is no Sec-Fetch-Site', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ repo: 'me/app', task: 'x' }),
    });
    expect(res.status).toBe(202);
  });

  it('refuses an Origin that is not this server', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ repo: 'me/app', task: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  // `shura watch` must stay a viewer. Starting the server with no runner is
  // what makes that true, rather than a flag someone can get wrong.
  it('refuses every mutating route when started without a runner', async () => {
    const res = await post('/jobs', { repo: 'me/app', task: 'x' }, {}, READ_ONLY_PORT);
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toMatch(/read-only/);

    const status = (await (
      await fetch(`http://127.0.0.1:${READ_ONLY_PORT}/status`)
    ).json()) as { readOnly: boolean };
    expect(status.readOnly).toBe(true);
  });

  it('caps the body, so this is not an upload endpoint', async () => {
    const res = await post('/jobs', { repo: 'me/app', task: 'x'.repeat(70_000) });
    expect(res.status).toBe(400);
  });
});
