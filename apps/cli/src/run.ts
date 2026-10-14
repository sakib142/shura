/**
 * `forge run` — one work item through the whole loop, streaming.
 *
 * Everything that used to be hardcoded here now comes from forge.config.yaml:
 * which repo, which checks, which agent, which models, which budgets.
 *
 * Deliberately verbose. The denial lines and the vendor-pair line are the
 * invariant being enforced in public — an operator should be able to see that
 * the separation of duties is real, not asserted in a prompt.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, databaseUrl, isReachable } from '@forge/db';
import { GitHubMergeQueue, GitHubVcs, JiraTracker, initRepo } from '@forge/connectors';
import { loadConfig, resolveFrom, type AgentConfig, type ForgeConfig } from '@forge/config';
import { loadAllRoles, withPrompt } from '@forge/roles';
import {
  AnthropicRuntime,
  GoogleRuntime,
  OpenAICompatibleRuntime,
  OpenAIRuntime,
} from '@forge/runtimes';
import type { AgentRuntime, Tracker } from '@forge/ports';
import type { RoleDefinition } from '@forge/core';
import { runWorkItem, type StreamEvent } from '@forge/orchestrator';

function render(e: StreamEvent): void {
  const t = new Date().toTimeString().slice(0, 8);
  if (e.kind === 'phase') console.log(`${t}  ${e.state.padEnd(22)} ${e.detail}`);
  else if (e.kind === 'note') console.log(`${t}  ${''.padEnd(22)} ${e.text}`);
  else if (e.kind === 'verdict') console.log(`${t}  VERDICT ${e.decision.padEnd(18)} ${e.detail}`);
  else {
    const a = e.actor.padEnd(10);
    const ev = e.event;
    if (ev.t === 'tool_call') console.log(`${t}  ${a} tool  ${ev.tool} ${preview(ev.args)}`);
    else if (ev.t === 'tool_result' && !ev.ok) console.log(`${t}  ${a} DENIED ${ev.denialReason ?? ''}`);
    else if (ev.t === 'file_change') console.log(`${t}  ${a} wrote ${ev.path}`);
    else if (ev.t === 'usage') console.log(`${t}  ${a} ${ev.tokensIn}/${ev.tokensOut} tok  $${ev.usd.toFixed(4)}`);
    else if (ev.t === 'error') console.log(`${t}  ${a} ERROR ${ev.message}`);
  }
}

function preview(args: unknown): string {
  const s = JSON.stringify(args) ?? '';
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** The runtime for a vendor. One place, so a new vendor is one line. */
export function runtimeFor(agent: AgentConfig): AgentRuntime {
  switch (agent.runtime) {
    case 'anthropic': return new AnthropicRuntime();
    case 'openai': return new OpenAIRuntime();
    case 'google': return new GoogleRuntime();
    case 'local': return new OpenAICompatibleRuntime();
  }
}

/** Applies config overrides on top of a shipped role definition. */
export function configuredRole(
  config: ForgeConfig,
  roleId: string,
  base: RoleDefinition,
): { role: RoleDefinition; agent: AgentConfig } {
  const override = config.agents[roleId];
  const model = override ?? {
    runtime: base.model?.runtime ?? 'anthropic',
    model: base.model?.model ?? 'claude-sonnet-5',
    parallel: 1,
  };
  return {
    agent: model,
    role: {
      ...base,
      model: {
        runtime: model.runtime,
        model: model.model,
        ...(model.fallback === undefined ? {} : { fallback: model.fallback }),
      },
      limits: {
        max_minutes: config.budgets.per_task_minutes,
        max_tokens: config.budgets.per_task_tokens,
        max_usd: config.budgets.per_task_usd,
      },
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const exact = args.find((a) => a.startsWith(`--${name}=`));
  if (exact !== undefined) return exact.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function run(args: string[]): Promise<number> {
  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;

  const key = args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));
  if (key === undefined) {
    console.error(
      'usage: forge run <ITEM> [--role R] [--reviewer R] [--reset] [--reseed]\n' +
        '  --reset   clear run records; the repository is untouched\n' +
        '  --reseed  rebuild the local repository from the fixture, discarding merged work',
    );
    return 2;
  }

  const producerId = flag(args, 'role') ?? 'backend-developer';
  const verifierId = flag(args, 'reviewer') ?? 'code-reviewer';

  const roles = loadAllRoles();
  const producerBase = roles.get(producerId);
  const verifierBase = roles.get(verifierId);
  if (producerBase === undefined || verifierBase === undefined) {
    console.error(
      `unknown role. Available: ${[...roles.keys()].join(', ')}`,
    );
    return 2;
  }
  if (producerBase.kind !== 'produce') {
    console.error(`"${producerId}" is a ${producerBase.kind} role, not a producer.`);
    return 2;
  }
  if (verifierBase.kind !== 'verify') {
    console.error(`"${verifierId}" is a ${verifierBase.kind} role, not a verifier.`);
    return 2;
  }

  const producer = configuredRole(config, producerId, withPrompt(producerBase));
  const verifier = configuredRole(config, verifierId, withPrompt(verifierBase));

  // Caught here rather than after the producer has already run and spent.
  if (producer.agent.runtime === verifier.agent.runtime) {
    console.error(
      `${producerId} and ${verifierId} are both on "${producer.agent.runtime}".\n` +
        'A verifier must run a different vendor. Change one in forge.config.yaml under `agents`.',
    );
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }

  if (args.includes('--reset')) {
    // Run records only. The repository is left alone — use --reseed for that.
    await pool.query('TRUNCATE merge_queue, change_requests, verdicts, artifacts, tasks CASCADE');
    console.log('reset: cleared run records (the repository is untouched)');
  }

  // A Jira-backed project reads the story from Jira and mirrors it locally, so
  // the rest of the loop works the same either way.
  let tracker: Tracker | undefined;
  if (config.tracker.type === 'jira') {
    const email = process.env[config.tracker.emailEnv] ?? '';
    const token = process.env[config.tracker.tokenEnv] ?? '';
    if (email === '' || token === '') {
      console.error(
        `tracker is jira but ${config.tracker.emailEnv} or ${config.tracker.tokenEnv} is not set.`,
      );
      await pool.end();
      return 2;
    }
    tracker = new JiraTracker({
      site: config.tracker.site,
      email,
      token,
      project: config.tracker.project,
      statusMap: config.tracker.statusMap,
    });

    const item = await tracker.get(key);
    if (item === undefined) {
      // Not in Jira. It may still be a local item from `forge submit`, which
      // is how you try something without creating a ticket for it. Falling
      // through is friendlier than refusing, as long as it says which it used.
      const { rows: local } = await pool.query<{ title: string }>(
        'SELECT title FROM work_items WHERE key = $1',
        [key],
      );
      if (local[0] === undefined) {
        console.error(
          `no issue "${key}" in ${config.tracker.site}, and no local work item either.\n` +
            'Create one in Jira, or locally with:  forge submit <file.md>',
        );
        await pool.end();
        return 1;
      }
      console.log(`"${key}" is a local work item (not in Jira) — progress will not be posted`);
      tracker = undefined;
    } else {
      if (item.criteria.length === 0) {
        console.error(
          `${key} has no acceptance criteria a reviewer could judge against.\n` +
            'Add lines in Given/When/Then form to the description, for example:\n' +
            '  Given a status filter, when orders are listed, then only those are returned',
        );
        await pool.end();
        return 1;
      }
      await pool.query(
        `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
         VALUES ($1, 'story', $2, $3::jsonb, 'draft')
         ON CONFLICT (key) DO UPDATE
           SET title = EXCLUDED.title, acceptance_criteria = EXCLUDED.acceptance_criteria`,
        [item.key, item.title, JSON.stringify(item.criteria)],
      );
      console.log(`read ${key} from ${config.tracker.site} — ${item.criteria.length} criteria`);
    }
  }

  const { rows } = await pool.query<{ title: string }>(
    'SELECT title FROM work_items WHERE key = $1',
    [key],
  );
  if (rows[0] === undefined) {
    console.error(`no work item "${key}". Create one with:  forge submit <file.md>`);
    await pool.end();
    return 1;
  }

  let repoDir: string;
  let github: { vcs: GitHubVcs; queue: GitHubMergeQueue } | undefined;

  if (config.repo.type === 'github') {
    const token = process.env[config.repo.tokenEnv] ?? '';
    if (token === '') {
      console.error(`repo is github but ${config.repo.tokenEnv} is not set.`);
      await pool.end();
      return 2;
    }
    const options = {
      owner: config.repo.owner,
      repo: config.repo.name,
      token,
      base: config.repo.base,
      checkCommand: config.repo.checks,
      workDir: join(loaded.dir, '.forge'),
    };
    const vcs = new GitHubVcs(options);
    github = { vcs, queue: new GitHubMergeQueue(options, vcs) };
    console.log(`cloning ${config.repo.owner}/${config.repo.name}`);
    repoDir = await vcs.repoDir();
  } else {
    repoDir = join(loaded.dir, '.forge', `${config.project}.git`);

    // Seed only when there is nothing there, or when asked to start over.
    // Re-seeding on every run deletes whatever the previous run merged, which
    // made three tickets read Done against work that no longer existed.
    const fresh = !existsSync(repoDir);
    if (fresh || args.includes('--reseed')) {
      console.log(`seeding ${config.project} from ${config.repo.path}`);
      await initRepo(repoDir, resolveFrom(loaded, config.repo.path));
    } else {
      console.log(`using the existing ${config.project} repository`);
    }
  }

  console.log(
    `\n${key}  ${rows[0].title}\n` +
      `producer  ${producerId.padEnd(20)} ${producer.agent.runtime}/${producer.agent.model}\n` +
      `verifier  ${verifierId.padEnd(20)} ${verifier.agent.runtime}/${verifier.agent.model}\n` +
      `budget    $${config.budgets.per_task_usd} per task, ${config.budgets.loop_cap} attempts\n`,
  );

  try {
    const outcome = await runWorkItem({
      pool,
      repoDir,
      checkCommand: config.repo.checks,
      workItemKey: key,
      producer: { runtime: runtimeFor(producer.agent), role: producer.role, name: 'dev-01' },
      verifier: { runtime: runtimeFor(verifier.agent), role: verifier.role, name: 'rev-01' },
      loopCap: config.budgets.loop_cap,
      ...(github === undefined ? {} : { vcs: github.vcs, mergeQueue: github.queue }),
      ...(tracker === undefined ? {} : { tracker }),
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

/** True when `value` is the argument to a preceding --flag. */
function isFlagValue(args: string[], value: string): boolean {
  const i = args.indexOf(value);
  return i > 0 && (args[i - 1]?.startsWith('--') ?? false) && !args[i - 1]!.includes('=');
}
