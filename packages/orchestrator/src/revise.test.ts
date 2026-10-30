/**
 * The plan, re-derived from the approver's answers.
 *
 * These tests name a failure found by running the thing, not by testing it. A
 * plan for a new profile field asked what to call the column; the approver
 * answered `bio`; the answer was recorded, handed to the builder as prose, and
 * the acceptance criteria went on naming `profiles.your_detail`. Since the
 * reviewer is shown the criteria and nothing else, it would have failed a
 * builder that did exactly what the approver asked for. The gate asked a
 * question and then overruled the answer.
 *
 * So the thing worth testing is not that a revision happens — it is that the
 * answer reaches the two places it has to: the prompt the planner revises
 * from, and the criteria that come back out.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Git, agentIdentity } from '@shura/git';
import { parseRole, type PlanSubmission } from '@shura/core';
import { createPool, isReachable, PgPlans, type StoredPlan } from '@shura/db';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { renderRevision, revisePlan } from './plan.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[revise] Postgres unreachable — skipping.');

let repoDir: string;

beforeAll(async () => {
  if (!up) return;
  repoDir = mkdtempSync(join(tmpdir(), 'shura-revise-'));
  const git = new Git(repoDir, agentIdentity('someone', 'human', 'none'));
  await git.run('init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'profile.tsx'), 'export const Profile = () => null;\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'a profile page');
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

/** The plan as first written: it asks the question, and names your_detail. */
const asPlanned: PlanSubmission = {
  understanding: 'A free-text field on the profile page.',
  approach: 'Add a your_detail column and a textarea bound to it.',
  files: [{ path: 'profile.tsx', reason: 'the profile page' }],
  outOfScope: ['Showing it anywhere else.'],
  criteria: [
    'Given a signed-in user, when they save, then profiles.your_detail holds the value',
  ],
  openQuestions: ['Column name: I am going with your_detail. Say so now if it should differ.'],
  author: { agent: 'plan-01', vendor: 'anthropic', model: 'default' },
  cost: { tokensIn: 900, tokensOut: 400, usd: 1.2 },
};

/** What the planner submits once told the column is called bio. */
const revised = {
  understanding: 'A free-text field on the profile page, stored in bio.',
  approach: 'Add a bio column and a textarea bound to it.',
  files: [{ path: 'profile.tsx', reason: 'the profile page' }],
  outOfScope: ['Showing it anywhere else.'],
  criteria: ['Given a signed-in user, when they save, then profiles.bio holds the value'],
  openQuestions: [],
};

function scripted(output: unknown, seen: RunRequest[]): AgentRuntime {
  return {
    vendor: 'anthropic',
    id: 'claude-cli',
    async *run(req: RunRequest): AsyncIterable<AgentEvent> {
      seen.push(req);
      yield { t: 'usage', tokensIn: 120, tokensOut: 40, usd: 0.03 };
      if (output !== undefined) yield { t: 'result', output };
    },
  };
}

async function stored(key: string): Promise<StoredPlan> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A profile field', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  const plans = new PgPlans(pool);
  const id = await plans.record(rows[0]!.id, 'task-1', {
    repo: 'impactproximity/tennis-courtshare',
    request: 'add a free-text field to the profile page',
    source: 'instructions',
    base: 'main',
    checks: ['sh', '-c', 'true'],
  }, asPlanned);
  return (await plans.get(id))!;
}

d('revising a plan from the answers it was approved with', () => {
  it('carries the decision into the criteria the reviewer will be shown', async () => {
    const plan = await stored('SHURA-30');
    const seen: RunRequest[] = [];

    const outcome = await revisePlan({
      pool,
      repoDir,
      plan,
      answers: ['Call it bio.'],
      planner: { runtime: scripted(revised, seen), role: planner, name: 'plan-01' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revised.criteria).toEqual([
      'Given a signed-in user, when they save, then profiles.bio holds the value',
    ]);
    // The overruled choice must not survive into the contract.
    expect(JSON.stringify(outcome.revised.criteria)).not.toContain('your_detail');
    expect(outcome.spend.usd).toBeCloseTo(0.03, 4);
  });

  /*
   * The whole mechanism rests on this: if the answer is not in the prompt, the
   * revision is a second guess at the same question rather than a decision
   * being applied.
   */
  it('puts the question and the answer in front of the planner', async () => {
    const plan = await stored('SHURA-31');
    const seen: RunRequest[] = [];

    await revisePlan({
      pool,
      repoDir,
      plan,
      answers: ['Call it bio.'],
      planner: { runtime: scripted(revised, seen), role: planner, name: 'plan-01' },
    });

    const brief = seen[0]!.context.request;
    expect(brief).toContain('Column name: I am going with your_detail');
    expect(brief).toContain('Call it bio.');
    // Stated as a decision, not as further input to weigh.
    expect(brief).toContain('the answer');
    // The criteria it is revising are shown, and not handed over as something
    // it must satisfy — that would make the old column name a requirement.
    expect(brief).toContain('profiles.your_detail');
    expect(seen[0]!.context.acceptanceCriteria).toEqual([]);
  });

  it('reports an unanswered question as unanswered rather than inventing one', async () => {
    const plan = await stored('SHURA-32');
    const seen: RunRequest[] = [];

    await revisePlan({
      pool,
      repoDir,
      plan,
      answers: [''],
      planner: { runtime: scripted(revised, seen), role: planner, name: 'plan-01' },
    });

    expect(seen[0]!.context.request).toContain('none given');
  });

  it('fails rather than approving nothing when the planner submits no revision', async () => {
    const plan = await stored('SHURA-33');
    const outcome = await revisePlan({
      pool,
      repoDir,
      plan,
      answers: ['Call it bio.'],
      planner: { runtime: scripted(undefined, []), role: planner, name: 'plan-01' },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/without submitting a revision/);
  });
});

describe('showing the approver what their answers changed', () => {
  // Spelled out rather than cast from a partial: renderRevision reads the id
  // to print the command for re-reading the plan, and a cast would hide the
  // next field it comes to depend on.
  const before: StoredPlan = {
    id: 'de7ca26e-0000-0000-0000-000000000000',
    workItemId: '00000000-0000-0000-0000-00000000000a',
    workItemKey: 'SHURA-30',
    title: 'A profile field',
    taskId: 'task-1',
    repo: 'impactproximity/tennis-courtshare',
    request: 'add a free-text field to the profile page',
    source: 'instructions',
    base: 'main',
    checks: ['sh', '-c', 'true'],
    understanding: asPlanned.understanding,
    approach: asPlanned.approach,
    files: asPlanned.files,
    outOfScope: asPlanned.outOfScope,
    criteria: asPlanned.criteria,
    openQuestions: asPlanned.openQuestions,
    answers: ['Call it bio.'],
    author: 'plan-01',
    vendor: 'anthropic',
    model: 'default',
    costUsd: 1.2,
    status: 'awaiting_approval',
    createdAt: new Date(0),
  };

  it('names what was dropped and what replaced it', () => {
    const out = renderRevision(before, revised);
    expect(out).toContain('1 -> 1');
    expect(out).toContain('- Given a signed-in user, when they save, then profiles.your_detail');
    expect(out).toContain('+ Given a signed-in user, when they save, then profiles.bio');
    expect(out).toContain('understanding and approach');
  });

  /*
   * Silence here would read as "your answer was applied". It was not: the
   * revision disagreed, and the approver is about to sign off criteria that
   * contradict what they said.
   */
  it('says so when the answers did not reach the criteria at all', () => {
    const out = renderRevision(before, {
      ...revised,
      criteria: [...asPlanned.criteria],
    });
    expect(out).toContain('unchanged — the answers did not reach the criteria');
  });
});
