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
import { createPool, databaseUrl, isReachable, PgPlans } from '@shura/db';
import { renderPlan } from '@shura/orchestrator';
import { execFileSync } from 'node:child_process';
import { tryResolveGit } from '@shura/git';
import { flag, flags, positional } from './args.js';

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
        '  --note             a line recorded with the decision',
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

    await store.decide(plan.id, 'approved', approver(args), answers, note);
    console.log(
      `plan ${plan.id.slice(0, 8)} approved by ${approver(args)}.\n` +
        `${plan.criteria.length} acceptance criteria are now ${plan.workItemKey}'s, and are what ` +
        'the reviewer will judge against.',
    );
    if (plan.openQuestions.length > 0 && answers.length === 0) {
      console.log(
        `\nApproved with ${plan.openQuestions.length} question(s) unanswered. The agent will ` +
          'decide them.',
      );
    }
    console.log(`\nBuild it:\n  shura build --resume ${plan.id.slice(0, 8)}`);
    return 0;
  } finally {
    await pool.end();
  }
}
