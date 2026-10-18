import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Git, agentIdentity } from '@shura/git';
import { parseRole } from '@shura/core';
import { createPool, isReachable, PgAuditSink, PgEffectStore } from '@shura/db';
import type { AgentEvent, AgentRuntime, RunRequest } from '@shura/ports';
import { reviewBranch } from './build-flow.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[alone] Postgres unreachable — skipping.');

/**
 * A real repository, because a review reads one. It needs no branch of its
 * own: the point is that the branch can come from anywhere, including someone
 * who is not Shura.
 */
let repoDir: string;

beforeAll(async () => {
  if (!up) return;
  repoDir = mkdtempSync(join(tmpdir(), 'shura-alone-'));
  const git = new Git(repoDir, agentIdentity('someone', 'human', 'none'));
  await git.run('init', '-q', '-b', 'someone-elses-branch');
  writeFileSync(join(repoDir, 'a.ts'), 'export const a = 1;\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'pushed by a person, not by Shura');
});

afterAll(async () => {
  if (up) await pool.query('TRUNCATE events, verdicts, artifacts, tasks, work_items CASCADE');
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
  await pool.end();
});

const reviewer = parseRole({
  id: 'reviewer',
  kind: 'verify',
  model: { runtime: 'openai', model: 'default' },
  tools: ['repo.read', 'repo.search', 'test.run', 'verdict.submit'],
  instructions: 'Review it.',
});

/** Answers with a structured verdict, the way a CLI reviewer does. */
function scripted(verdict: unknown): AgentRuntime {
  return {
    vendor: 'openai',
    id: 'codex-cli',
    async *run(_req: RunRequest): AsyncIterable<AgentEvent> {
      yield { t: 'usage', tokensIn: 10, tokensOut: 5, usd: 0 };
      yield { t: 'result', output: verdict };
    },
  };
}

async function workItem(key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', 'A thing', '[]'::jsonb, 'draft') RETURNING id`,
    [key],
  );
  return rows[0]!.id;
}

const CRITERIA = ['Given a list, when it is empty, then an empty state is shown'];

async function review(workItemId: string, key: string, verdict: unknown) {
  return reviewBranch({
    pool,
    repoDir,
    checkCommand: ['true'],
    reviewer: { runtime: scripted(verdict), role: reviewer, name: 'rev-01' },
    plan: {
      workItemId,
      workItemKey: key,
      title: 'A thing',
      understanding: 'u',
      approach: 'a',
      files: [],
      outOfScope: [],
    },
    attempt: 1,
    branch: 'someone-elses-branch',
    criteria: CRITERIA,
    diff: '--- a.ts\n+ changed',
    checks: { ok: true, summary: 'checks passed', output: '' },
    audit: new PgAuditSink(pool),
    effects: new PgEffectStore(pool),
    emit: () => {},
  });
}

/**
 * The reviewer, run on its own.
 *
 * It used to be module-private with an argument type demanding a whole
 * `BuildRequest` — a builder and a VCS it never touches — so there was no way
 * to judge a branch without first building one. Running three agents in
 * sequence and finding one broken gives you one failure and three suspects.
 */
d('reviewing a branch on its own', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE events, verdicts, artifacts, tasks, work_items CASCADE');
  });

  it('needs no builder, no vcs and no worktree it did not make', async () => {
    const id = await workItem('ALONE-1');
    const r = await review(id, 'ALONE-1', {
      artifactId: 'a1',
      decision: 'PASS',
      criteria: [{ index: 0, status: 'met' }],
      extraFindings: [],
    });
    expect(r.verdict?.decision).toBe('PASS');
  });

  // No plans row is created or read — the context is passed in. That is what
  // lets it judge a branch a human pushed.
  it('needs no plan row in the database', async () => {
    const id = await workItem('ALONE-2');
    await review(id, 'ALONE-2', {
      artifactId: 'a1',
      decision: 'PASS',
      criteria: [{ index: 0, status: 'met' }],
      extraFindings: [],
    });
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM plans');
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('creates and finishes its own verify task', async () => {
    const id = await workItem('ALONE-3');
    const r = await review(id, 'ALONE-3', {
      artifactId: 'a1',
      decision: 'PASS',
      criteria: [{ index: 0, status: 'met' }],
      extraFindings: [],
    });
    const { rows } = await pool.query<{ kind: string; status: string; role: string }>(
      'SELECT kind, status, role FROM tasks WHERE id = $1',
      [r.taskId],
    );
    expect(rows[0]).toMatchObject({ kind: 'verify', status: 'succeeded', role: 'reviewer' });
  });

  /**
   * The decision is recomputed from the findings, not trusted. This is the
   * property the whole arrangement rests on, and it has to survive being
   * reached through a different entry point.
   */
  it('still rewrites a decision that disagrees with its own findings', async () => {
    const id = await workItem('ALONE-4');
    const r = await review(id, 'ALONE-4', {
      artifactId: 'a1',
      decision: 'PASS',
      criteria: [
        {
          index: 0,
          status: 'not_met',
          finding: { severity: 'blocker', claim: 'no empty state', evidence: 'renders null' },
        },
      ],
      extraFindings: [],
    });
    expect(r.verdict?.decision).toBe('CHANGES_REQUESTED');
    expect(r.verdict?.overridden).toBe(true);
  });

  it('reports a malformed verdict as an error rather than a pass', async () => {
    const id = await workItem('ALONE-5');
    // Says every criterion is met while addressing none of them.
    const r = await review(id, 'ALONE-5', {
      artifactId: 'a1',
      decision: 'PASS',
      criteria: [],
      extraFindings: [],
    });
    expect(r.verdict).toBeUndefined();
    expect(r.error).toMatch(/rejected/);
  });
});
