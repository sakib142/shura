/**
 * `shura probe` — does the reviewer catch a fault the tests do not?
 *
 * This is the question the whole design rests on. Everything else is machinery
 * for getting a verifier in front of a diff; this measures whether that was
 * worth doing.
 *
 * Each case is checked twice before it counts: the suite must be green (a fault
 * CI catches measures nothing about a reviewer), and the control must be the
 * genuinely correct implementation, so a reviewer that simply rejects
 * everything scores zero rather than perfect.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, isReachable } from '@shura/db';
import { LocalVcs, initRepo } from '@shura/connectors';
import { Worktree } from '@shura/sandbox';
import { agentIdentity } from '@shura/git';
import { loadAllRoles, withPrompt } from '@shura/roles';
import { CodexCliRuntime } from '@shura/runtimes';
import { verifyChange } from '@shura/orchestrator';
import { CASES, type Case } from '@shura/fault-corpus';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FIXTURE = join(ROOT, 'eval', 'fixtures', 'target-app');
const REPO = join(ROOT, '.shura', 'probe.git');
const CHECK = ['node', '--test', '--experimental-strip-types', 'test/orders.test.ts'];

const CRITERIA = [
  'Given a status filter, when orders are listed, then only orders with that status are returned',
  'Given no status filter, when orders are listed, then orders of every status are returned',
  'Given a customer filter, when orders are listed, then only that customer orders are returned',
  'Given a page size above the maximum, when orders are listed, then the page size is capped at the maximum',
  'Given successive pages, when orders are listed, then every order appears on exactly one page',
];

interface Row {
  readonly id: string;
  readonly faulty: boolean;
  readonly decision: string;
  readonly caught: boolean;
  readonly findings: string[];
  readonly usd: number;
  readonly valid: boolean;
}

export async function probe(args: string[]): Promise<number> {
  const only = args.find((a) => !a.startsWith('--'));
  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error('postgres unreachable — run: pnpm db:up && pnpm migrate');
    await pool.end();
    return 1;
  }

  const roles = loadAllRoles();
  const verifierRole = withPrompt(roles.get('reviewer')!);
  const runtime = new CodexCliRuntime();

  const { rows: wi } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ('PROBE-1','story','Orders listing', $1::jsonb, 'draft')
     ON CONFLICT (key) DO UPDATE SET acceptance_criteria = EXCLUDED.acceptance_criteria
     RETURNING id`,
    [JSON.stringify(CRITERIA)],
  );
  const workItem = { id: wi[0]!.id, key: 'PROBE-1', criteria: CRITERIA };

  console.log(
    `reviewer  ${verifierRole.model?.runtime}/${verifierRole.model?.model}\n` +
      `cases     ${CASES.length} (1 control, ${CASES.filter((c) => c.faulty).length} seeded faults)\n` +
      `every case passes the test suite, so CI catches none of them\n`,
  );

  const results: Row[] = [];
  for (const c of CASES) {
    if (only !== undefined && c.id !== only) continue;
    results.push(await runCase(pool, c, workItem, { runtime, role: verifierRole, name: 'rev-01' }));
  }

  await pool.end();
  return report(results);
}

async function runCase(
  pool: ReturnType<typeof createPool>,
  c: Case,
  workItem: { id: string; key: string; criteria: readonly string[] },
  verifier: { runtime: CodexCliRuntime; role: ReturnType<typeof withPrompt>; name: string },
): Promise<Row> {
  await initRepo(REPO, FIXTURE);
  const vcsOpts = { repoDir: REPO, pool, checkCommand: CHECK };
  const vcs = new LocalVcs(vcsOpts);

  const branch = `probe/${c.id}`;
  await vcs.createBranch('main', branch);

  const wt = await Worktree.create({
    repoDir: REPO,
    branch,
    taskId: `probe-${c.id}`,
    identity: agentIdentity('dev-probe', 'builder', 'default'),
    claimedBranches: [branch],
  });
  try {
    for (const [path, content] of Object.entries(c.files)) {
      mkdirSync(dirname(join(wt.dir, path)), { recursive: true });
      writeFileSync(join(wt.dir, path), content);
    }
    await wt.git.run('add', '-A');
    await wt.git.run('commit', '-q', '-m', `PROBE-1: ${c.title}`);
  } finally {
    await wt.destroy();
  }

  const ref = await vcs.openChangeRequest({
    branch,
    base: 'main',
    title: `PROBE-1: ${c.title}`,
    body: CRITERIA.map((x, i) => `- [ ] [${i}] ${x}`).join('\n'),
    author: 'dev-probe',
    workItemId: workItem.id,
  });

  process.stdout.write(`  ${c.id.padEnd(24)} `);
  const result = await verifyChange({
    pool,
    repoDir: REPO,
    checkCommand: CHECK,
    vcs,
    ref,
    workItem,
    verifier,
    attempt: 1,
  });

  // A case whose suite is red is not a probe of the reviewer at all.
  if (!result.checksPassed) {
    console.log('INVALID — the test suite failed, so CI would have caught this');
    return { id: c.id, faulty: c.faulty, decision: 'n/a', caught: false, findings: [], usd: result.spend.usd, valid: false };
  }

  const decision = result.verdict?.decision ?? 'NO VERDICT';
  const findings = (result.verdict?.submission.criteria ?? [])
    .filter((x) => x.status === 'not_met' && x.finding !== undefined)
    .map((x) => `[${x.index}] ${x.finding!.claim}`)
    .concat(
      (result.verdict?.submission.extraFindings ?? []).map((f) => `(extra) ${f.claim}`),
    );

  const rejected = decision === 'CHANGES_REQUESTED' || decision === 'BLOCKED';
  const caught = c.faulty ? rejected : !rejected;

  console.log(
    `${caught ? 'CAUGHT ' : c.faulty ? 'MISSED ' : 'FALSE+ '} ${decision.padEnd(18)} $${result.spend.usd.toFixed(4)}`,
  );
  for (const f of findings.slice(0, 3)) console.log(`${''.padEnd(26)} · ${f}`);

  return { id: c.id, faulty: c.faulty, decision, caught, findings, usd: result.spend.usd, valid: true };
}

function report(rows: readonly Row[]): number {
  const valid = rows.filter((r) => r.valid);
  const faults = valid.filter((r) => r.faulty);
  const controls = valid.filter((r) => !r.faulty);
  const caught = faults.filter((r) => r.caught).length;
  const falsePositives = controls.filter((r) => !r.caught).length;
  const usd = rows.reduce((a, r) => a + r.usd, 0);

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`catch rate        ${caught}/${faults.length} seeded faults`);
  console.log(`false positives   ${falsePositives}/${controls.length} known-good`);
  console.log(`cost              $${usd.toFixed(4)} total`);
  if (rows.length !== valid.length) {
    console.log(`invalid cases     ${rows.length - valid.length} (suite was red; not scored)`);
  }

  const missed = faults.filter((r) => !r.caught);
  if (missed.length > 0) {
    console.log(`\nmissed: ${missed.map((m) => m.id).join(', ')}`);
  }
  // A reviewer is only useful if it catches faults AND passes good code.
  return caught === faults.length && falsePositives === 0 ? 0 : 1;
}
