/**
 * `shura try <agent>` — run one agent, show what it produced, stop.
 *
 * The flow runs three agents in sequence, and when it fails somewhere in the
 * middle you have one broken thing and three suspects. Running each alone turns
 * that into three answers: this one works, this one works, this one is wrong.
 *
 * Each subcommand stops at the first point where the next agent would take
 * over. Nothing here opens a pull request, and nothing here merges.
 */

import { join } from 'node:path';
import { createPool, databaseUrl, isReachable, PgPlans, type StoredPlan } from '@shura/db';
import { GitHubVcs, githubDefaultBranch } from '@shura/connectors';
import { loadConfig } from '@shura/config';
import { PgAuditSink, PgEffectStore } from '@shura/db';
import {
  buildApprovedPlan,
  describeSpend,
  isMetered,
  recordVerdict,
  reviewBranch,
  type StreamEvent,
} from '@shura/orchestrator';
import type { ActorIdentity } from '@shura/core';
import { agentsFor, parseRepoSpec, render } from './build.js';
import { confirm, flag, positional } from './args.js';

const USAGE = [
  'usage: shura try <agent>',
  '',
  '  try planner  --repo owner/name --task "…"   read the repo, produce a plan, stop',
  '  try builder  --plan <id>                    build an approved plan, push, stop',
  '  try reviewer --repo owner/name --branch <b> judge a branch, print the verdict, stop',
  '',
  'options:',
  '  --domain NAME    house rules for this kind of codebase (frontend, backend)',
  '  --checks "cmd"   how to build and test it',
  '  --base BRANCH    what to compare against (reviewer) or branch from',
  '  --criteria-from <plan-id>   judge against an existing plan\'s criteria',
  '  --yes            do not ask before spending',
  '',
  'None of these opens a pull request. Use `shura build --resume` for the whole flow.',
].join('\n');

export async function tryAgent(args: string[]): Promise<number> {
  const which = positional(args);
  if (which === undefined || args.includes('--help')) {
    console.log(USAGE);
    return which === undefined ? 2 : 0;
  }
  switch (which) {
    case 'planner':
      // Already exactly this command: plan, record, stop at the gate.
      return (await import('./build.js')).build(args.filter((a) => a !== 'planner'));
    case 'builder':
      return tryBuilder(args);
    case 'reviewer':
      return tryReviewer(args);
    default:
      console.error(`unknown agent "${which}".\n\n${USAGE}`);
      return 2;
  }
}

/* ---------------------------------------------------------------- builder */

async function tryBuilder(args: string[]): Promise<number> {
  const planId = flag(args, 'plan') ?? flag(args, 'resume');
  if (planId === undefined) {
    console.error('which plan?  shura try builder --plan <id>\n\nSee waiting plans: shura plans');
    return 2;
  }

  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;
  const agents = agentsFor(args, config);
  if (typeof agents === 'string') {
    console.error(agents);
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }

  try {
    const plan = await findPlan(pool, planId);
    if (typeof plan === 'string') {
      console.error(plan);
      return 1;
    }
    if (plan.status !== 'approved') {
      console.error(
        `plan ${plan.id.slice(0, 8)} is "${plan.status}", not approved.\n` +
          `  shura plans ${plan.id.slice(0, 8)}\n  shura approve ${plan.id.slice(0, 8)}`,
      );
      return 1;
    }

    const repo = parseRepoSpec(plan.repo);
    if (typeof repo === 'string') {
      console.error(repo);
      return 1;
    }
    const token = tokenFor(config);
    if (token === undefined) return 2;

    const checks = flag(args, 'checks') !== undefined
      ? ['sh', '-c', flag(args, 'checks')!]
      : plan.checks.length > 0
        ? [...plan.checks]
        : config.repo.checks;

    console.log(
      `\n${plan.workItemKey}  ${plan.title}\n` +
        `repo      ${plan.repo} (${plan.base})\n` +
        `checks    ${checks.join(' ')}\n` +
        `builder   ${agents.builder.role.id.padEnd(12)} ${agents.builder.vendor}\n` +
        `\nThe builder alone. It will push a branch and stop — nothing reviews it,\n` +
        `and no pull request is opened.\n`,
    );
    if (!(await confirm(`Run the builder? It calls ${agents.builder.vendor}.`, args))) {
      console.log('nothing spent.');
      return 1;
    }

    const vcs = new GitHubVcs({
      owner: repo.owner,
      repo: repo.name,
      token,
      base: plan.base,
      checkCommand: checks,
      workDir: join(loaded.dir, '.shura'),
    });
    console.log(`cloning ${plan.repo}`);
    const repoDir = await vcs.repoDir();
    await vcs.refresh();

    const outcome = await buildApprovedPlan({
      pool,
      repoDir,
      checkCommand: checks,
      plan,
      builder: agents.builder,
      reviewer: agents.reviewer,
      vcs,
      loopCap: config.budgets.loop_cap,
      stopAfter: 'push',
      onEvent: render,
    });

    console.log(
      `\n${outcome.state}  after ${outcome.attempts} attempt(s)  ` +
        `${describeSpend(outcome.usd, isMetered(agents.builder.runtime.id))}` +
        (outcome.reason === undefined ? '' : `  — ${outcome.reason}`),
    );
    if (outcome.state !== 'awaiting_verification') {
      console.log('\nNo branch was published. Nothing to review.');
      return 1;
    }
    console.log(
      `\nBranch pushed: ${outcome.branch}\n` +
        `Now judge it on its own:\n` +
        `  shura try reviewer --repo ${plan.repo} --branch ${outcome.branch} ` +
        `--criteria-from ${plan.id.slice(0, 8)}`,
    );
    return 0;
  } catch (err) {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

/* --------------------------------------------------------------- reviewer */

async function tryReviewer(args: string[]): Promise<number> {
  const branch = flag(args, 'branch');
  if (branch === undefined) {
    console.error('which branch?  shura try reviewer --repo owner/name --branch <branch>');
    return 2;
  }

  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;
  const agents = agentsFor(args, config);
  if (typeof agents === 'string') {
    console.error(agents);
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()}`);
    await pool.end();
    return 1;
  }

  try {
    // Criteria come from a plan when one is named, because that is what the
    // reviewer judges against in the real flow. Without one there is nothing
    // to judge by, and a reviewer with no standard produces a verdict that
    // reads as meaningful and is not.
    const from = flag(args, 'criteria-from') ?? flag(args, 'plan');
    if (from === undefined) {
      console.error(
        'the reviewer judges against acceptance criteria, so it needs a plan to take them from:\n' +
          '  shura try reviewer --repo owner/name --branch <b> --criteria-from <plan-id>\n\n' +
          'See plans:  shura plans',
      );
      return 2;
    }
    const plan = await findPlan(pool, from);
    if (typeof plan === 'string') {
      console.error(plan);
      return 1;
    }

    const spec = flag(args, 'repo') ?? plan.repo;
    const repo = parseRepoSpec(spec);
    if (typeof repo === 'string') {
      console.error(repo);
      return 1;
    }
    const token = tokenFor(config);
    if (token === undefined) return 2;

    const checks = flag(args, 'checks') !== undefined
      ? ['sh', '-c', flag(args, 'checks')!]
      : plan.checks.length > 0
        ? [...plan.checks]
        : config.repo.checks;
    const base =
      flag(args, 'base') ??
      (await githubDefaultBranch({ owner: repo.owner, repo: repo.name, token })) ??
      plan.base;

    console.log(
      `\njudging  ${repo.owner}/${repo.name}  ${branch} against ${base}\n` +
        `criteria ${plan.criteria.length}, from plan ${plan.id.slice(0, 8)}\n` +
        `reviewer ${agents.reviewer.role.id.padEnd(12)} ${agents.reviewer.vendor}\n` +
        `\nThe reviewer alone. It cannot write — on codex that is an operating-system\n` +
        `sandbox, not a withheld tool. No pull request, no fix, no merge.\n`,
    );
    if (!(await confirm(`Run the reviewer? It calls ${agents.reviewer.vendor}.`, args))) {
      console.log('nothing spent.');
      return 1;
    }

    const vcs = new GitHubVcs({
      owner: repo.owner,
      repo: repo.name,
      token,
      base,
      checkCommand: checks,
      workDir: join(loaded.dir, '.shura'),
    });
    console.log(`cloning ${repo.owner}/${repo.name}`);
    const repoDir = await vcs.repoDir();
    await vcs.refresh();

    // The two inputs a review needs, both producible without a build having
    // just run — which is the point: this works on a branch anyone pushed.
    const ref = { id: 'try', branch, base };
    const diff = await vcs.getDiff(ref);
    if (diff.files.length === 0) {
      console.error(`\n${branch} changes nothing against ${base}. There is nothing to judge.`);
      return 1;
    }
    console.log(`${diff.files.length} file(s) changed; running the checks`);
    const checkRun = await vcs.runChecks(ref);
    console.log(`${checkRun.summary}\n`);

    const review = await reviewBranch({
      pool,
      repoDir,
      checkCommand: checks,
      reviewer: agents.reviewer,
      plan: {
        workItemId: plan.workItemId,
        workItemKey: plan.workItemKey,
        title: plan.title,
        understanding: plan.understanding,
        approach: plan.approach,
        files: plan.files,
        outOfScope: plan.outOfScope,
      },
      attempt: 1,
      branch,
      criteria: plan.criteria,
      diff: diff.text,
      checks: checkRun,
      audit: new PgAuditSink(pool),
      effects: new PgEffectStore(pool),
      emit: render,
    });

    if (review.verdict === undefined) {
      console.error(`\nno verdict: ${review.error ?? 'the reviewer finished without one'}`);
      return 1;
    }

    const v = review.verdict;
    const producer: ActorIdentity = {
      agentId: agents.builder.name,
      role: agents.builder.role.id,
      kind: 'produce',
      vendor: agents.builder.runtime.vendor,
      model: agents.builder.role.model?.model ?? 'default',
    };
    const verifier: ActorIdentity = {
      agentId: agents.reviewer.name,
      role: agents.reviewer.role.id,
      kind: 'verify',
      vendor: agents.reviewer.runtime.vendor,
      model: agents.reviewer.role.model?.model ?? 'default',
    };
    await recordVerdict(pool, review.taskId, v, producer, verifier);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`VERDICT  ${v.decision}${v.overridden ? `  (rewritten — ${v.reason})` : ''}`);
    console.log(`${'='.repeat(70)}\n`);
    for (const c of v.submission.criteria) {
      const mark = c.status === 'met' ? 'met     ' : c.status === 'not_met' ? 'NOT MET ' : 'n/a     ';
      console.log(`  ${mark} [${c.index}] ${plan.criteria[c.index] ?? ''}`.slice(0, 160));
      if (c.finding !== undefined) {
        console.log(`           ${c.finding.severity}: ${c.finding.claim}`);
        console.log(`           evidence: ${c.finding.evidence}`.slice(0, 200));
      }
    }
    for (const f of v.submission.extraFindings) {
      console.log(`  EXTRA    ${f.severity}: ${f.claim}`);
    }
    console.log(
      `\n${describeSpend(review.usd, isMetered(agents.reviewer.runtime.id))}` +
        `  ·  the verdict is recorded; nothing was written to the repository`,
    );
    return v.decision === 'PASS' ? 0 : 1;
  } catch (err) {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

/* ----------------------------------------------------------------- shared */

async function findPlan(
  pool: ReturnType<typeof createPool>,
  idOrPrefix: string,
): Promise<StoredPlan | string> {
  const matches = await new PgPlans(pool).find(idOrPrefix);
  if (matches.length === 0) return `no plan matching "${idOrPrefix}". See:  shura plans`;
  if (matches.length > 1) return `"${idOrPrefix}" matches ${matches.length} plans. Use more of the id.`;
  return matches[0]!;
}

function tokenFor(config: ReturnType<typeof loadConfig>['config']): string | undefined {
  const envVar = config.repo.type === 'github' ? config.repo.tokenEnv : 'GITHUB_TOKEN';
  const token = process.env[envVar] ?? '';
  if (token === '') {
    console.error(`${envVar} is not set, so the repository cannot be read.`);
    return undefined;
  }
  return token;
}
