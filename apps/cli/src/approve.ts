/**
 * `shura plans` and `shura approve` — the human half of the plan gate.
 *
 * The gate only means something if the plan is readable and approving it is a
 * deliberate act. So `plans` prints the whole plan rather than a summary, and
 * `approve` refuses while the plan has questions nobody has answered: an open
 * question is the agent reporting that the request did not settle something,
 * and pressing past it unanswered is a decision too.
 */

import { approvability } from '@shura/core';
import { createPool, databaseUrl, isReachable, PgPlans, type StoredPlan } from '@shura/db';
import { renderPlan, renderRevision, revisePlan } from '@shura/orchestrator';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { GitHubVcs } from '@shura/connectors';
import { loadConfig } from '@shura/config';
import { tryResolveGit } from '@shura/git';
import { agentsFor } from './build.js';
import { confirm, flag, flags, positional } from './args.js';

/**
 * Who is approving.
 *
 * The git identity, because that is the name already attached to decisions in
 * this repository, and an approval attributed to "unknown" is not much of an
 * approval. `--as` overrides it for anyone whose git is configured differently
 * from how they want to be recorded.
 */
function approver(args: readonly string[]): string {
  const explicit = flag(args, 'as');
  if (explicit !== undefined && explicit !== '') return explicit;

  const git = tryResolveGit();
  if (git !== undefined) {
    const read = (key: string): string | undefined => {
      try {
        const out = execFileSync(git.path, ['config', '--get', key], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out === '' ? undefined : out;
      } catch {
        return undefined;
      }
    };
    const name = read('user.name');
    const email = read('user.email');
    if (name !== undefined && email !== undefined) return `${name} <${email}>`;
    if (email !== undefined) return email;
    if (name !== undefined) return name;
  }
  return process.env.USER ?? process.env.LOGNAME ?? 'unknown';
}

export async function plans(args: string[]): Promise<number> {
  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }
  const store = new PgPlans(pool);

  try {
    const which = positional(args);
    if (which !== undefined) {
      const found = await store.find(which);
      if (found.length === 0) {
        console.error(`no plan matching "${which}"`);
        return 1;
      }
      if (found.length > 1) {
        console.error(`"${which}" matches ${found.length} plans. Use more of the id:`);
        for (const p of found) console.error(`  ${p.id}  ${p.workItemKey}`);
        return 2;
      }
      console.log(renderPlan(found[0]!));
      return 0;
    }

    const waiting = await store.awaiting();
    if (waiting.length === 0) {
      console.log('no plans are waiting for approval');
      return 0;
    }
    console.log(`${waiting.length} plan(s) waiting for approval:\n`);
    for (const p of waiting) {
      console.log(
        `  ${p.id.slice(0, 8)}  ${p.workItemKey.padEnd(12)} ${p.title}\n` +
          `  ${''.padEnd(8)}  ${p.repo} · ${p.criteria.length} criteria · ` +
          `${p.openQuestions.length} open question(s) · ${p.vendor}/${p.model} · ` +
          `$${p.costUsd.toFixed(4)}`,
      );
    }
    console.log(
      '\nRead one in full:   shura plans <id>\n' +
        'Approve it:         shura approve <id>\n' +
        'Then build it:      shura build --resume <id>',
    );
    return 0;
  } finally {
    await pool.end();
  }
}

export async function approve(args: string[]): Promise<number> {
  const which = positional(args);
  if (which === undefined) {
    console.error(
      'usage: shura approve <plan-id> [--answer "..."]... [--ignore-questions] [--reject]\n' +
        '  --answer           one per open question, in the order they are listed\n' +
        '  --ignore-questions approve with questions unanswered, letting the agent decide\n' +
        '  --reject           record a rejection instead, with --note saying why\n' +
        '  --note             a line recorded with the decision\n' +
        '  --no-revise        do not re-derive the criteria from the answers\n' +
        '  --yes              do not ask before spending on the revision',
    );
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()}`);
    await pool.end();
    return 1;
  }
  const store = new PgPlans(pool);

  try {
    const found = await store.find(which);
    if (found.length === 0) {
      console.error(`no plan matching "${which}"`);
      return 1;
    }
    if (found.length > 1) {
      console.error(`"${which}" matches ${found.length} plans. Use more of the id.`);
      return 2;
    }
    const plan = found[0]!;

    if (plan.status !== 'awaiting_approval') {
      console.error(
        `plan ${plan.id.slice(0, 8)} is already "${plan.status}"; there is nothing to decide.`,
      );
      return 1;
    }

    const rejecting = args.includes('--reject');
    const note = flag(args, 'note');

    if (rejecting) {
      if (note === undefined) {
        console.error(
          'rejecting a plan needs --note saying what is wrong with it.\n' +
            'The agent cannot do better from a rejection with no reason, and neither can you ' +
            'in a week when you read the row back.',
        );
        return 2;
      }
      await store.decide(plan.id, 'rejected', approver(args), [], note);
      console.log(`plan ${plan.id.slice(0, 8)} rejected.`);
      console.log(
        '\nNothing was built. Re-plan with a clearer request:\n' +
          `  shura build --repo ${plan.repo} --task "..."`,
      );
      return 0;
    }

    const answers = flags(args, 'answer');
    const verdict = approvability({
      openQuestions: plan.openQuestions,
      answers,
      ignoreQuestions: args.includes('--ignore-questions'),
    });

    if (!verdict.ok) {
      console.error(
        `plan ${plan.id.slice(0, 8)} raises ${plan.openQuestions.length} question(s) and ` +
          `${verdict.unanswered.length} ${verdict.unanswered.length === 1 ? 'is' : 'are'} unanswered:\n`,
      );
      plan.openQuestions.forEach((q, i) => {
        const a = answers[i];
        console.error(`  (${i}) ${q}`);
        console.error(
          a === undefined || a.trim() === ''
            ? '       -- unanswered'
            : `       -> ${a}`,
        );
      });
      console.error(
        '\nThese are where the agent noticed the request did not settle something.\n' +
          'Answer them in order:\n' +
          `  shura approve ${plan.id.slice(0, 8)}${plan.openQuestions.map((_q, i) => ` --answer "answer to ${i}"`).join('')}\n\n` +
          'Or let the agent decide them itself, which is a decision you are making:\n' +
          `  shura approve ${plan.id.slice(0, 8)} --ignore-questions`,
      );
      return 2;
    }

    // The answers have to reach the criteria, because the criteria are the only
    // thing the reviewer is shown. See revisePlan: approving answers as prose
    // alone produced a plan whose criteria contradicted the decision the
    // approver had just made.
    let approving: StoredPlan = plan;
    const answered = answers.some((a) => a.trim() !== '');
    if (answered && plan.openQuestions.length > 0 && !args.includes('--no-revise')) {
      const outcome = await reviseFromAnswers(pool, plan, answers, args);
      if (outcome === 'declined') return 0;
      if (typeof outcome === 'string') {
        console.error(`\n${outcome}`);
        console.error(
          '\nNothing was approved and your answers were not recorded, so nothing is half-done.\n' +
            'Re-run the same command to try again, or approve without re-deriving the criteria:\n' +
            `  shura approve ${plan.id.slice(0, 8)} --no-revise` +
            plan.openQuestions.map((_q, i) => ` --answer "${answers[i] ?? ''}"`).join('') +
            '\n  (the answers then reach the builder as notes, and the criteria stand as planned)',
        );
        return 1;
      }
      approving = outcome;
    }

    await store.decide(approving.id, 'approved', approver(args), answers, note);
    console.log(
      `plan ${approving.id.slice(0, 8)} approved by ${approver(args)}.\n` +
        `${approving.criteria.length} acceptance criteria are now ${approving.workItemKey}'s, and are what ` +
        'the reviewer will judge against.',
    );
    if (plan.openQuestions.length > 0 && answers.length === 0) {
      console.log(
        `\nApproved with ${plan.openQuestions.length} question(s) unanswered. The agent will ` +
          'decide them.',
      );
    }
    console.log(`\nBuild it:\n  shura build --resume ${approving.id.slice(0, 8)}`);
    return 0;
  } finally {
    await pool.end();
  }
}

/**
 * Re-derives the criteria from the answers, and hands back the plan as revised.
 *
 * Returns the stored plan on success, `'declined'` when the approver said no to
 * the spend, and a message when it could not be done — in which case nothing is
 * written at all, so the approver can re-run or fall back to `--no-revise`
 * rather than being left with answers recorded against stale criteria.
 */
async function reviseFromAnswers(
  pool: ReturnType<typeof createPool>,
  plan: StoredPlan,
  answers: readonly string[],
  args: string[],
): Promise<StoredPlan | 'declined' | string> {
  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;

  const agents = agentsFor(args, config);
  if (typeof agents === 'string') return agents;

  const spec = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(plan.repo);
  if (spec === null) {
    return `the plan records its repository as "${plan.repo}", which is not owner/name.`;
  }
  // The plan's own target, not the configured one: these agents are generic and
  // the plan may well have been made against a repository the config never
  // mentions. Only the token comes from configuration.
  const tokenEnv = config.repo.type === 'github' ? config.repo.tokenEnv : 'GITHUB_TOKEN';
  const token = process.env[tokenEnv] ?? '';
  if (token === '') {
    return `${tokenEnv} is not set, and re-reading ${plan.repo} needs it.`;
  }

  console.log(
    `\nYour answers change what the work will be judged against, so ${agents.planner.name} ` +
      're-derives the acceptance criteria before this is approved.\n' +
      `This re-reads ${plan.repo} and calls ${agents.planner.vendor}. Measured against a real\n` +
      'repository it cost about as much as the planning run itself did, not a few cents: the\n' +
      'cost of planning is in reading the repository, and a revision reads it again.',
  );
  const go = await confirm('Go ahead?', args);
  if (!go) {
    console.log(
      'nothing spent, nothing approved.\n\n' +
        'To approve with the criteria exactly as planned, and the answers passed to the\n' +
        'builder as notes instead:\n' +
        `  shura approve ${plan.id.slice(0, 8)} --no-revise` +
        plan.openQuestions.map((_q, i) => ` --answer "${answers[i] ?? ''}"`).join(''),
    );
    return 'declined';
  }

  const vcs = new GitHubVcs({
    owner: spec[1]!,
    repo: spec[2]!,
    token,
    base: plan.base,
    checkCommand: plan.checks,
    workDir: join(loaded.dir, '.shura'),
  });
  const repoDir = await vcs.repoDir();
  await vcs.refresh();

  const outcome = await revisePlan({
    pool,
    repoDir,
    plan,
    answers,
    planner: {
      runtime: agents.planner.runtime,
      role: agents.planner.role,
      name: agents.planner.name,
    },
    onEvent: (e) => {
      if (e.kind === 'note') console.log(`  ${e.text}`);
    },
  });

  if (!outcome.ok) {
    return `could not re-derive the criteria: ${outcome.reason}`;
  }

  const store = new PgPlans(pool);
  await store.revise(plan.id, outcome.revised, outcome.spend, approver(args));

  console.log(`\n${renderRevision(plan, outcome.revised)}`);
  console.log(
    `\nrevised — $${outcome.spend.usd.toFixed(4)} of quota, not billed (subscription).`,
  );

  const reloaded = await store.get(plan.id);
  return reloaded ?? `plan ${plan.id.slice(0, 8)} vanished while being revised.`;
}
