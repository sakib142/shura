/**
 * `shura serve` — the agent, running, waiting for work.
 *
 * The flow this exists for: start it once, open the page, paste a repository
 * and a sentence, read the plan it comes back with, answer whatever it could
 * not settle, and approve. It builds, a different vendor's model reviews, and
 * you get a pull request to merge.
 *
 * This file is the composition root for that. It knows about configuration,
 * roles, vendors, budgets and git; the server knows none of those and receives
 * a `JobRunner` instead. That is why `apps/api` still depends on little more
 * than the database driver, and why `shura watch` — the same server with no
 * runner — stays a viewer that cannot spend anything.
 *
 * One job at a time. Two agents on one branch is the collision the claims table
 * refuses anyway; refusing it here means you get a sentence instead of a claim
 * error from inside a run you did not know had started.
 */

import { join } from 'node:path';
import { createPool, databaseUrl, isReachable, PgPlans } from '@shura/db';
import { GitHubVcs, JiraTracker, githubDefaultBranch } from '@shura/connectors';
import { loadConfig, type LoadedConfig } from '@shura/config';
import { buildApprovedPlan, planWorkItem, type StreamEvent } from '@shura/orchestrator';
import { startWatchServer, type CostEstimate, type JobResult, type JobRunner, type JobState } from '@shura/api';
import type { Tracker } from '@shura/ports';
import { flag } from './args.js';
import { agentsFor, parseRepoSpec, type Trio } from './build.js';

function line(e: StreamEvent): string | undefined {
  const t = new Date().toTimeString().slice(0, 8);
  if (e.kind === 'phase') return `${t}  ${e.state.padEnd(22)} ${e.detail}`;
  if (e.kind === 'note') return `${t}  ${''.padEnd(22)} ${e.text}`;
  if (e.kind === 'verdict') return `${t}  VERDICT ${e.decision.padEnd(18)} ${e.detail}`;
  const ev = e.event;
  const a = e.actor.padEnd(14);
  if (ev.t === 'tool_call') return `${t}  ${a} tool  ${ev.tool}`;
  if (ev.t === 'tool_result' && !ev.ok) return `${t}  ${a} DENIED ${ev.denialReason ?? ''}`;
  if (ev.t === 'usage') return `${t}  ${a} ${ev.tokensIn}/${ev.tokensOut} tok  $${ev.usd.toFixed(4)}`;
  if (ev.t === 'error') return `${t}  ${a} ERROR ${ev.message}`;
  return undefined;
}

export async function serve(args: string[]): Promise<number> {
  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;
  const port = Number(flag(args, 'port') ?? 7777);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`--port must be a number between 1 and 65535 (got "${flag(args, 'port')}")`);
    return 2;
  }

  const agents = agentsFor(args, config);
  if (typeof agents === 'string') {
    console.error(agents);
    return 2;
  }

  const tokenEnv = config.repo.type === 'github' ? config.repo.tokenEnv : 'GITHUB_TOKEN';
  const token = process.env[tokenEnv] ?? '';
  if (token === '') {
    console.error(
      `${tokenEnv} is not set, so no repository could be read or pushed to.\n` +
        'Put it in .env next to shura.config.yaml, then start again.',
    );
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }

  const plans = new PgPlans(pool);
  let state: JobState = { phase: 'idle' };

  const estimate = (): CostEstimate => ({
    planner: `${agents.planner.vendor}/${agents.planner.role.model?.model ?? '?'}`,
    builder: `${agents.builder.vendor}/${agents.builder.role.model?.model ?? '?'}`,
    reviewer: `${agents.reviewer.vendor}/${agents.reviewer.role.model?.model ?? '?'}`,
    planUsd: agents.planner.role.limits.max_usd,
    buildUsd: agents.builder.role.limits.max_usd + agents.reviewer.role.limits.max_usd,
    loopCap: config.budgets.loop_cap,
  });

  /** Streams to the terminal that started the server; the page reads the DB. */
  const onEvent = (e: StreamEvent): void => {
    const rendered = line(e);
    if (rendered !== undefined) console.log(rendered);
  };

  const trackerFor = (source: 'instructions' | 'tracker'): Tracker | undefined => {
    if (source !== 'tracker' || config.tracker.type !== 'jira') return undefined;
    const email = process.env[config.tracker.emailEnv] ?? '';
    const apiToken = process.env[config.tracker.tokenEnv] ?? '';
    if (email === '' || apiToken === '') return undefined;
    return new JiraTracker({
      site: config.tracker.site,
      email,
      token: apiToken,
      project: config.tracker.project,
      statusMap: config.tracker.statusMap,
    });
  };

  const vcsFor = (owner: string, name: string, base: string, checks: readonly string[]): GitHubVcs =>
    new GitHubVcs({
      owner,
      repo: name,
      token,
      base,
      checkCommand: checks,
      workDir: join(loaded.dir, '.shura'),
    });

  const runner: JobRunner = {
    estimate,
    state: () => state,

    async plan(input): Promise<JobResult> {
      const spec = parseRepoSpec(input.repo);
      if (typeof spec === 'string') return { ok: false, error: spec };

      state = { phase: 'planning', repo: `${spec.owner}/${spec.name}`, startedAt: nowIso() };
      try {
        const checks = config.repo.checks;
        const base =
          (await githubDefaultBranch({ owner: spec.owner, repo: spec.name, token })) ?? 'main';

        const vcs = vcsFor(spec.owner, spec.name, base, checks);
        // Planning does not write, but finding out now beats finding out after
        // an approved plan fails to push.
        try {
          await vcs.assertCanWrite();
        } catch (err) {
          onEvent({
            kind: 'note',
            text: `note: ${(err as Error).message.split('\n')[0]} — planning can still proceed`,
          });
        }

        console.log(`cloning ${spec.owner}/${spec.name}`);
        const repoDir = await vcs.repoDir();
        await vcs.refresh();

        const key = await nextKey(pool);
        const title = firstLine(input.task);
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
           VALUES ($1, 'story', $2, '[]'::jsonb, 'draft')
           ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
          [key, title],
        );

        const outcome = await planWorkItem({
          pool,
          repoDir,
          base,
          checkCommand: checks,
          workItem: { id: rows[0]!.id, key, title },
          source: {
            repo: `${spec.owner}/${spec.name}`,
            request: input.task,
            source: 'instructions',
            base,
            checks,
          },
          planner: {
            runtime: agents.planner.runtime,
            role: agents.planner.role,
            name: agents.planner.name,
          },
          onEvent,
        });

        if (!outcome.ok) {
          state = { phase: 'idle', lastError: outcome.reason };
          return { ok: false, error: outcome.reason };
        }
        state = { phase: 'idle' };
        console.log(`\nplan ${outcome.planId.slice(0, 8)} is waiting for you in the browser\n`);
        return { ok: true, planId: outcome.planId };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        state = { phase: 'idle', lastError: error };
        onEvent({ kind: 'note', text: `planning failed: ${error}` });
        return { ok: false, error };
      }
    },

    async build(planId): Promise<JobResult> {
      const plan = await plans.get(planId);
      if (plan === undefined) return { ok: false, error: `no plan ${planId}` };
      if (plan.status !== 'approved') {
        return { ok: false, error: `plan is "${plan.status}", not approved` };
      }

      const spec = parseRepoSpec(plan.repo);
      if (typeof spec === 'string') return { ok: false, error: spec };

      state = { phase: 'building', workItemKey: plan.workItemKey, repo: plan.repo, startedAt: nowIso() };
      try {
        // From the plan, not from config: the config describes whichever
        // repository it names, which may not be this one.
        const checks = plan.checks.length > 0 ? [...plan.checks] : config.repo.checks;
        const vcs = vcsFor(spec.owner, spec.name, plan.base, checks);

        await vcs.assertCanWrite();
        console.log(`cloning ${plan.repo}`);
        const repoDir = await vcs.repoDir();
        await vcs.refresh();

        const tracker = trackerFor(plan.source);
        const outcome = await buildApprovedPlan({
          pool,
          repoDir,
          checkCommand: checks,
          plan,
          builder: {
            runtime: agents.builder.runtime,
            role: agents.builder.role,
            name: agents.builder.name,
          },
          reviewer: {
            runtime: agents.reviewer.runtime,
            role: agents.reviewer.role,
            name: agents.reviewer.name,
          },
          vcs,
          loopCap: config.budgets.loop_cap,
          ...(tracker === undefined ? {} : { tracker }),
          onEvent,
        });

        const url = outcome.changeRequest?.url;
        state = {
          phase: 'idle',
          ...(url === undefined ? {} : { lastPullRequest: url }),
          ...(outcome.changeRequest === undefined
            ? { lastError: outcome.reason ?? `ended as ${outcome.state}` }
            : {}),
        };
        console.log(
          `\n${outcome.state}  after ${outcome.attempts} attempt(s)  $${outcome.usd.toFixed(4)}` +
            (url === undefined ? '' : `\n${url}`) +
            '\n',
        );
        return outcome.changeRequest === undefined
          ? { ok: false, error: outcome.reason ?? `ended as ${outcome.state}` }
          : { ok: true, ...(url === undefined ? {} : { url }) };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        state = { phase: 'idle', lastError: error };
        onEvent({ kind: 'note', text: `build failed: ${error}` });
        return { ok: false, error };
      }
    },
  };

  const server = startWatchServer({ pool, port, jobs: runner });
  const est = estimate();

  console.log(
    [
      '',
      `  Shura is running on http://localhost:${port}`,
      '',
      '  Open it, name a repository and say what you want built.',
      '',
      `  planner   ${est.planner.padEnd(30)}up to $${est.planUsd} per plan`,
      `  builder   ${est.builder.padEnd(30)}`,
      `  reviewer  ${est.reviewer.padEnd(30)}up to $${est.buildUsd} per build, ${est.loopCap} attempts`,
      '',
      '  Nothing is called until you click. Shura does not merge — you do.',
      '  Bound to localhost only. Ctrl-C to stop.',
      '',
    ].join('\n'),
  );

  const stop = async (): Promise<void> => {
    console.log('\nstopping');
    await server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  await new Promise(() => {});
  return 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function firstLine(text: string): string {
  const first = text.trim().split('\n')[0]!.trim();
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

async function nextKey(pool: ReturnType<typeof createPool>): Promise<string> {
  const { rows } = await pool.query<{ n: number | null }>(
    `SELECT max(substring(key from '^SHURA-([0-9]+)$')::int) AS n
       FROM work_items WHERE key ~ '^SHURA-[0-9]+$'`,
  );
  return `SHURA-${(rows[0]?.n ?? 0) + 1}`;
}
