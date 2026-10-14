/**
 * `forge run` — one work item through the whole loop, streaming.
 *
 * Deliberately verbose. The denial lines and the vendor-pair line are the
 * invariant being enforced in public: an operator should be able to see that
 * the separation of duties is real, not asserted in a prompt.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, databaseUrl, isReachable } from '@forge/db';
import { initRepo } from '@forge/connectors';
import { loadAllRoles, withPrompt } from '@forge/roles';
import { AnthropicRuntime, OpenAIRuntime } from '@forge/runtimes';
import { runWorkItem, type StreamEvent } from '@forge/orchestrator';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIXTURE = join(ROOT, 'eval', 'fixtures', 'target-app');
const REPO = join(ROOT, '.forge', 'target.git');
const CHECK = ['node', '--test', '--experimental-strip-types', 'test/orders.test.ts'];

const SEED = {
  key: 'ORD-12',
  title: 'Filter orders by status',
  criteria: [
    'Given a status filter, when orders are listed, then only orders with that status are returned',
    'Given no status filter, when orders are listed, then orders of every status are returned',
    'Given an unknown status, when orders are listed, then no orders are returned and no error is thrown',
  ],
};

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function render(e: StreamEvent): void {
  const t = stamp();
  if (e.kind === 'phase') {
    console.log(`${t}  ${e.state.padEnd(22)} ${e.detail}`);
  } else if (e.kind === 'note') {
    console.log(`${t}  ${''.padEnd(22)} ${e.text}`);
  } else if (e.kind === 'verdict') {
    console.log(`${t}  VERDICT ${e.decision.padEnd(18)} ${e.detail}`);
  } else {
    const { actor, event } = e;
    const a = actor.padEnd(10);
    switch (event.t) {
      case 'tool_call':
        console.log(`${t}  ${a} tool  ${event.tool} ${preview(event.args)}`);
        break;
      case 'tool_result':
        if (!event.ok) console.log(`${t}  ${a} DENIED ${event.denialReason ?? ''}`);
        break;
      case 'file_change':
        console.log(`${t}  ${a} wrote ${event.path}`);
        break;
      case 'usage':
        console.log(`${t}  ${a} ${event.tokensIn}/${event.tokensOut} tok  $${event.usd.toFixed(4)}`);
        break;
      case 'error':
        console.log(`${t}  ${a} ERROR ${event.message}`);
        break;
      default:
        break;
    }
  }
}

function preview(args: unknown): string {
  const s = JSON.stringify(args) ?? '';
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export async function run(args: string[]): Promise<number> {
  const key = args.find((a) => !a.startsWith('--')) ?? SEED.key;
  const pool = createPool();

  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }

  if (args.includes('--reset')) {
    await pool.query('TRUNCATE merge_queue, change_requests, verdicts, artifacts, tasks CASCADE');
    await pool.query('DELETE FROM work_items WHERE key = $1', [key]);
    console.log(`reset: cleared prior runs of ${key}`);
  }

  await pool.query(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', $2, $3::jsonb, 'draft')
     ON CONFLICT (key) DO NOTHING`,
    [key, SEED.title, JSON.stringify(SEED.criteria)],
  );

  console.log(`seeding target repo from ${FIXTURE.replace(ROOT, '.')}`);
  await initRepo(REPO, FIXTURE);

  const roles = loadAllRoles();
  const producerRole = withPrompt(roles.get('backend-developer')!);
  const verifierRole = withPrompt(roles.get('code-reviewer')!);

  console.log(
    `\n${key}  ${SEED.title}\n` +
      `producer  ${producerRole.model?.runtime}/${producerRole.model?.model}\n` +
      `verifier  ${verifierRole.model?.runtime}/${verifierRole.model?.model}\n`,
  );

  try {
    const outcome = await runWorkItem({
      pool,
      repoDir: REPO,
      checkCommand: CHECK,
      workItemKey: key,
      producer: { runtime: new AnthropicRuntime(), role: producerRole, name: 'dev-01' },
      verifier: { runtime: new OpenAIRuntime(), role: verifierRole, name: 'rev-01' },
      onEvent: render,
    });

    console.log(
      `\n${outcome.state}  after ${outcome.attempts} attempt(s)  $${outcome.usd.toFixed(4)}` +
        (outcome.mergeCommit === undefined ? '' : `  merged ${outcome.mergeCommit.slice(0, 7)}`) +
        (outcome.reason === undefined ? '' : `  — ${outcome.reason}`),
    );
    return outcome.state === 'admitted' ? 0 : 1;
  } catch (err) {
    console.error(`\nrun failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}
