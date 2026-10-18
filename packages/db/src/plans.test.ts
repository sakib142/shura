import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { PlanSubmission } from '@shura/core';
import { PgPlans } from './plans.js';
import { createPool, isReachable } from './pool.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[plans] Postgres unreachable — skipping.');

afterAll(async () => {
  if (up) await pool.query('TRUNCATE plans, approvals, work_items CASCADE');
  await pool.end();
});

const plans = new PgPlans(pool);

const submission: PlanSubmission = {
  understanding: 'The orders table cannot be narrowed by date.',
  approach: 'Add a DateRange control and filter client-side.',
  files: [{ path: 'src/orders/OrderList.tsx', reason: 'where the table lives' }],
  outOfScope: ['Server-side filtering.'],
  criteria: [
    'Given orders in two months, when April is selected, then only April orders are listed',
    'Given no orders in the range, when it is applied, then an empty state is shown',
  ],
  openQuestions: ['Does the filter persist across a reload?'],
  author: { agent: 'plan-01', vendor: 'anthropic', model: 'claude-sonnet-5' },
  cost: { tokensIn: 1200, tokensOut: 800, usd: 0.0431 },
};

async function newItem(key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A date filter', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  return rows[0]!.id;
}

const source = {
  repo: 'sakib142/forge-sandbox',
  request: 'add a date filter to the orders page',
  source: 'instructions' as const,
  base: 'main',
  checks: ['pnpm', 'test'],
};

d('the plan gate', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE plans, approvals, work_items CASCADE');
  });

  it('records a plan as awaiting approval, not approved', async () => {
    const item = await newItem('SHURA-1');
    const id = await plans.record(item, 'task-1', source, submission);
    const stored = await plans.get(id);
    expect(stored?.status).toBe('awaiting_approval');
    expect(stored?.criteria).toHaveLength(2);
    expect(stored?.costUsd).toBeCloseTo(0.0431, 4);
  });

  // The work item is not given criteria until a human has agreed to them. A
  // plan recorded is a proposal; nothing downstream should be able to act on it.
  it('leaves the work item without criteria until the plan is approved', async () => {
    const item = await newItem('SHURA-2');
    const id = await plans.record(item, 'task-1', source, submission);

    const before = await pool.query<{ acceptance_criteria: string[] }>(
      'SELECT acceptance_criteria FROM work_items WHERE id = $1',
      [item],
    );
    expect(before.rows[0]?.acceptance_criteria).toEqual([]);

    await plans.decide(id, 'approved', 'Mohammad Sakib <sakib142@gmail.com>', ['No.']);

    const after = await pool.query<{ acceptance_criteria: string[] }>(
      'SELECT acceptance_criteria FROM work_items WHERE id = $1',
      [item],
    );
    expect(after.rows[0]?.acceptance_criteria).toHaveLength(2);
  });

  it('records who approved it, and their answers', async () => {
    const item = await newItem('SHURA-3');
    const id = await plans.record(item, 'task-1', source, submission);
    await plans.decide(id, 'approved', 'a-human', ['It does not persist.'], 'looks right');

    const { rows } = await pool.query<{ approver: string; decision: string; gate: string }>(
      'SELECT approver, decision, gate FROM approvals WHERE subject_id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ approver: 'a-human', decision: 'approved', gate: 'plan' });
    expect((await plans.get(id))?.answers).toEqual(['It does not persist.']);
  });

  it('does not give the work item criteria from a rejected plan', async () => {
    const item = await newItem('SHURA-4');
    const id = await plans.record(item, 'task-1', source, submission);
    await plans.decide(id, 'rejected', 'a-human', [], 'wrong scope');

    const { rows } = await pool.query<{ acceptance_criteria: string[] }>(
      'SELECT acceptance_criteria FROM work_items WHERE id = $1',
      [item],
    );
    expect(rows[0]?.acceptance_criteria).toEqual([]);
    expect((await plans.get(id))?.status).toBe('rejected');
  });

  // Approving twice would be a second decision on something already decided,
  // and on the build side it would open a second pull request for one plan.
  it('refuses to decide a plan twice', async () => {
    const item = await newItem('SHURA-5');
    const id = await plans.record(item, 'task-1', source, submission);
    await plans.decide(id, 'approved', 'a-human', ['no']);
    await expect(plans.decide(id, 'rejected', 'someone-else', [], 'no')).rejects.toThrow(
      /not awaiting approval/,
    );
  });

  it('lists what is waiting, and stops listing it once decided', async () => {
    const a = await plans.record(await newItem('SHURA-6'), 't1', source, submission);
    await plans.record(await newItem('SHURA-7'), 't2', source, submission);
    expect(await plans.awaiting()).toHaveLength(2);

    await plans.decide(a, 'approved', 'a-human', ['no']);
    expect(await plans.awaiting()).toHaveLength(1);
    expect((await plans.nextApproved())?.id).toBe(a);
  });

  it('finds a plan by the first few characters of its id', async () => {
    const id = await plans.record(await newItem('SHURA-8'), 't1', source, submission);
    const found = await plans.find(id.slice(0, 8));
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(id);
  });

  it('carries the work item key and title through, for the operator to read', async () => {
    const id = await plans.record(await newItem('SHURA-9'), 't1', source, submission);
    const stored = await plans.get(id);
    expect(stored?.workItemKey).toBe('SHURA-9');
    expect(stored?.title).toBe('A date filter');
    expect(stored?.repo).toBe('sakib142/forge-sandbox');
  });

  /**
   * A plan is for one repository, so it has to carry how to build that one.
   *
   * Before this, `shura build --resume` read the base branch and the check
   * command from shura.config.yaml — which names whichever repository the
   * config happens to point at. A plan for repo X would branch from repo Y's
   * base and run repo Y's test command against X's code, and say nothing.
   */
  it('round-trips the base branch and the check command', async () => {
    const id = await plans.record(await newItem('SHURA-11'), 't1', {
      repo: 'someone/other-app',
      request: 'add a thing',
      source: 'instructions',
      base: 'develop',
      checks: ['sh', '-c', 'npm ci && npm run test:ci'],
    }, submission);

    const stored = await plans.get(id);
    expect(stored?.base).toBe('develop');
    expect(stored?.checks).toEqual(['sh', '-c', 'npm ci && npm run test:ci']);
  });

  // An argv array, not a shell string: the command is exec'd without a shell,
  // so a pipeline has to arrive already wrapped.
  it('keeps the check command as argv rather than flattening it', async () => {
    const id = await plans.record(await newItem('SHURA-12'), 't1', {
      ...source,
      checks: ['sh', '-c', 'a && b'],
    }, submission);
    const stored = await plans.get(id);
    expect(Array.isArray(stored?.checks)).toBe(true);
    expect(stored?.checks).toHaveLength(3);
  });

  it('stops offering a built plan as something to build', async () => {
    const id = await plans.record(await newItem('SHURA-10'), 't1', source, submission);
    await plans.decide(id, 'approved', 'a-human', ['no']);
    await plans.built(id, 'shura/shura-10', '42');
    expect(await plans.nextApproved()).toBeUndefined();
    const stored = await plans.get(id);
    expect(stored?.status).toBe('built');
    expect(stored?.changeRequest).toBe('42');
  });
});
