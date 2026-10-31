/**
 * A plan refused for its shape, corrected rather than abandoned.
 *
 * On 30 October a planner read forge-sandbox, decided what to do, and returned
 * four criteria without Given/When/Then. The schema refused them and the run
 * ended with no plan — a whole pass spent, nothing produced, and the operator
 * told only that "the planner finished without submitting a plan".
 *
 * `PlanRejected` had carried the validation detail all along, with a comment
 * saying it does so "so it can correct itself". That was true of the
 * `plan.submit` tool path and never of the structured-output path, which is the
 * one every CLI runtime uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Git, agentIdentity } from '@shura/git';
import { parseRole } from '@shura/core';
import { createPool, isReachable } from '@shura/db';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { planWorkItem } from './plan.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[plan-retry] Postgres unreachable — skipping.');

let repoDir: string;

beforeAll(async () => {
  if (!up) return;
  repoDir = mkdtempSync(join(tmpdir(), 'shura-plan-'));
  const git = new Git(repoDir, agentIdentity('someone', 'human', 'none'));
  await git.run('init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'orders.ts'), 'export const orders = [];\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'a repository');
});

afterAll(async () => {
  if (up) await pool.query('TRUNCATE events, tasks, plans, approvals, work_items CASCADE');
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
  await pool.end();
});

const planner = parseRole({
  id: 'planner',
  kind: 'produce',
  model: { runtime: 'anthropic', model: 'default' },
  tools: ['repo.read', 'repo.search'],
  instructions: 'Plan it.',
});

/** The shape the schema insists on. */
const good = {
  understanding: 'The order list cannot be narrowed by date.',
  approach: 'Add a date range control and filter in the component.',
  files: [{ path: 'orders.ts', reason: 'where the list lives' }],
  outOfScope: [],
  criteria: ['Given orders in two months, when April is picked, then only April orders show'],
  openQuestions: [],
  survey: {
    install: 'npm ci',
    checks: [
      {
        name: 'build',
        command: 'npm run build',
        proves: 'it bundles; it does not type-check, because tsconfig.json has files: []',
        greenOnBase: true,
        usableAsGate: true,
      },
      { name: 'lint', command: 'npm run lint', proves: 'style rules hold', greenOnBase: false, usableAsGate: true },
    ],
    readFiles: ['package.json', 'tsconfig.json'],
  },
};

/** The same work, with criteria the schema will refuse. */
const badlyShaped = { ...good, criteria: ['Filter the orders by date', 'Show an empty state'] };

function answering(outputs: readonly unknown[], seen: RunRequest[]): AgentRuntime {
  let call = 0;
  return {
    vendor: 'anthropic',
    id: 'claude-cli',
    async *run(req: RunRequest): AsyncIterable<AgentEvent> {
      seen.push(req);
      const output = outputs[Math.min(call, outputs.length - 1)];
      call += 1;
      yield { t: 'usage', tokensIn: 100, tokensOut: 50, usd: 0.1 };
      yield { t: 'result', output };
    },
  };
}

async function anItem(key: string): Promise<{ id: string; key: string; title: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A date filter', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  return { id: rows[0]!.id, key, title: 'A date filter' };
}

const source = {
  repo: 'sakib142/forge-sandbox',
  request: 'let me filter the orders by date',
  source: 'instructions' as const,
  base: 'main',
  checks: ['sh', '-c', 'true'],
};

d('a plan refused for its shape', () => {
  it('is corrected on a second attempt rather than ending the run', async () => {
    const seen: RunRequest[] = [];
    const outcome = await planWorkItem({
      pool,
      repoDir,
      base: 'main',
      checkCommand: ['true'],
      workItem: await anItem('SHURA-40'),
      source,
      planner: { runtime: answering([badlyShaped, good], seen), role: planner, name: 'plan-01' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.criteria).toEqual(good.criteria);
    expect(seen).toHaveLength(2);
    // Both attempts are paid for, so both are reported.
    expect(outcome.usd).toBeGreaterThan(0);
  });

  /*
   * The correction has to carry the rejected answer, not just the complaint.
   * Without it the planner re-reads the repository to rebuild an understanding
   * it already had, and the retry costs as much as the attempt it is fixing.
   */
  it('hands back the errors and the rejected answer, and says not to start again', async () => {
    const seen: RunRequest[] = [];
    await planWorkItem({
      pool,
      repoDir,
      base: 'main',
      checkCommand: ['true'],
      workItem: await anItem('SHURA-41'),
      source,
      planner: { runtime: answering([badlyShaped, good], seen), role: planner, name: 'plan-01' },
    });

    const correction = seen[1]!.context.request;
    expect(correction).toMatch(/must be checkable/i);
    expect(correction).toMatch(/do not start again/i);
    expect(correction).toContain('Filter the orders by date');
    expect(correction).toContain('let me filter the orders by date');
  });

  it('gives up after one correction rather than paying forever', async () => {
    const seen: RunRequest[] = [];
    const outcome = await planWorkItem({
      pool,
      repoDir,
      base: 'main',
      checkCommand: ['true'],
      workItem: await anItem('SHURA-42'),
      source,
      planner: { runtime: answering([badlyShaped], seen), role: planner, name: 'plan-01' },
    });

    expect(outcome.ok).toBe(false);
    expect(seen).toHaveLength(2);
  });

  /*
   * Only a refused shape is worth asking twice for. A pass that hit its ceiling
   * or timed out will do the same again, and a second one buys another bill for
   * the same answer.
   */
  it('does not retry a planner that stopped badly', async () => {
    const seen: RunRequest[] = [];
    const runtime: AgentRuntime = {
      vendor: 'anthropic',
      id: 'claude-cli',
      async *run(req: RunRequest): AsyncIterable<AgentEvent> {
        seen.push(req);
        yield { t: 'usage', tokensIn: 10, tokensOut: 5, usd: 0.01 };
        yield { t: 'error', message: 'stopped at its ceiling' };
      },
    };

    const outcome = await planWorkItem({
      pool,
      repoDir,
      base: 'main',
      checkCommand: ['true'],
      workItem: await anItem('SHURA-43'),
      source,
      planner: { runtime, role: planner, name: 'plan-01' },
    });

    expect(outcome.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
