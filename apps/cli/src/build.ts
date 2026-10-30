/**
 * `shura build` — the frontend agent, end to end.
 *
 *   shura build --repo owner/name --task "add a date filter to the orders page"
 *   shura build --repo owner/name --jira KAN-12
 *   shura build --resume <plan-id>
 *
 * The repository is an argument, not configuration. These agents are a generic
 * part of Shura and know nothing about any particular client's code; which
 * repository they are pointed at belongs in the invocation, and
 * shura.config.yaml keeps only the models, the budgets and the credential
 * names.
 *
 * The run stops at the plan. Nothing is written, no branch exists, and what it
 * has spent by then is cents — which is the point of stopping there rather than
 * after a build.
 */

import { join } from 'node:path';
import { createPool, databaseUrl, isReachable, PgPlans, type StoredPlan } from '@shura/db';

/** The pool, without the CLI taking a direct dependency on the driver. */
type Pool = ReturnType<typeof createPool>;
import { GitHubVcs, JiraTracker, githubDefaultBranch } from '@shura/connectors';
import { loadConfig, type ForgeConfig, type LoadedConfig } from '@shura/config';
import { loadAllRoles, withPrompt } from '@shura/roles';
import type { RoleDefinition } from '@shura/core';
import type { AgentRuntime, Tracker } from '@shura/ports';
import {
  buildApprovedPlan,
  describeSpend,
  isMetered,
  planWorkItem,
  renderPlan,
  type StreamEvent,
} from '@shura/orchestrator';
import { configuredRole, runtimeFor } from './run.js';
import { confirm, flag, positional } from './args.js';

const USAGE = [
  'usage:',
  '  shura build --repo <owner/name> --task "<what to build or fix>"',
  '  shura build --repo <owner/name> --jira <KEY>',
  '  shura build --resume <plan-id>',
  '',
  'The first two forms plan the work and stop for you to approve it.',
  '--resume carries out a plan you have already approved.',
  '',
  'options:',
  '  --repo owner/name    the repository to work on (overrides the config)',
  '  --task "..."         free-form instructions: a feature, or a bug to fix',
  '  --jira KEY           read the request from a ticket instead',
  '  --resume ID          build an approved plan; "latest" takes the oldest waiting one',
  '  --checks "cmd"       how to run the build and tests (overrides the config)',
  '  --base BRANCH        what to branch from and open the pull request against',
  '  --domain NAME        house rules for this kind of codebase (frontend, backend)',
  '  --planner ROLE       default planner',
  '  --builder ROLE       default builder',
  '  --reviewer ROLE      default reviewer',
  '  --yes                do not ask before spending',
].join('\n');

export function render(e: StreamEvent): void {
  const t = new Date().toTimeString().slice(0, 8);
  if (e.kind === 'phase') console.log(`${t}  ${e.state.padEnd(22)} ${e.detail}`);
  else if (e.kind === 'note') console.log(`${t}  ${''.padEnd(22)} ${e.text}`);
  else if (e.kind === 'verdict') console.log(`${t}  VERDICT ${e.decision.padEnd(18)} ${e.detail}`);
  else {
    const a = e.actor.padEnd(14);
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

/**
 * "owner/name" from whatever the user typed.
 *
 * Accepts a full GitHub URL and a trailing .git, because both get pasted.
 * Returns the problem as a string rather than throwing — every caller wants to
 * print it and carry on, not catch.
 */
export function parseRepoSpec(
  spec: string,
): { readonly owner: string; readonly name: string } | string {
  const cleaned = spec
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (m === null) {
    return `expected a repository as "owner/name", for example sakib142/forge-sandbox (got "${spec}")`;
  }
  return { owner: m[1]!, name: m[2]! };
}

interface Resolved {
  readonly owner: string;
  readonly name: string;
  readonly base: string;
  readonly checks: readonly string[];
  readonly tokenEnv: string;
}

/**
 * Where the work happens, from the flag if given and the config otherwise.
 *
 * A repository named on the command line does not inherit the configured
 * repository's check command, because they are different projects. It falls
 * back to the configured one only because requiring --checks every time would
 * be tiresome for the common case of working on the same repo repeatedly.
 */
function resolveRepo(args: string[], config: ForgeConfig): Resolved | string {
  const spec = flag(args, 'repo');
  const checksFlag = flag(args, 'checks');
  const checks =
    checksFlag !== undefined
      ? ['sh', '-c', checksFlag]
      : config.repo.checks;

  if (spec !== undefined) {
    const parsed = parseRepoSpec(spec);
    if (typeof parsed === 'string') return parsed;
    return {
      owner: parsed.owner,
      name: parsed.name,
      base: flag(args, 'base') ?? 'main',
      checks,
      tokenEnv: config.repo.type === 'github' ? config.repo.tokenEnv : 'GITHUB_TOKEN',
    };
  }

  if (config.repo.type !== 'github') {
    return (
      'this flow pushes a branch and opens a pull request, so it needs a GitHub repository.\n' +
      'Name one:  shura build --repo owner/name --task "..."'
    );
  }
  return {
    owner: config.repo.owner,
    name: config.repo.name,
    base: flag(args, 'base') ?? config.repo.base,
    checks,
    tokenEnv: config.repo.tokenEnv,
  };
}

function trackerFrom(config: ForgeConfig): Tracker | string | undefined {
  if (config.tracker.type !== 'jira') return undefined;
  const email = process.env[config.tracker.emailEnv] ?? '';
  const token = process.env[config.tracker.tokenEnv] ?? '';
  if (email === '' || token === '') {
    return `tracker is jira but ${config.tracker.emailEnv} or ${config.tracker.tokenEnv} is not set.`;
  }
  return new JiraTracker({
    site: config.tracker.site,
    email,
    token,
    project: config.tracker.project,
    statusMap: config.tracker.statusMap,
  });
}

export interface Trio {
  readonly planner: { runtime: AgentRuntime; role: RoleDefinition; name: string; vendor: string };
  readonly builder: { runtime: AgentRuntime; role: RoleDefinition; name: string; vendor: string };
  readonly reviewer: { runtime: AgentRuntime; role: RoleDefinition; name: string; vendor: string };
}

/** The three agents, with rule 1 checked before anything is spent. */
export function agentsFor(args: string[], config: ForgeConfig): Trio | string {
  const roles = loadAllRoles();
  // The house rules for this kind of codebase, appended to every agent's
  // prompt. Absent is a legitimate choice: the agent explores the repository
  // itself and will work out what it is looking at.
  const domain = flag(args, 'domain');
  const pick = (
    flagName: string,
    fallback: string,
    want: 'produce' | 'verify',
  ): { role: RoleDefinition; vendor: string; runtime: AgentRuntime } | string => {
    const id = flag(args, flagName) ?? fallback;
    const base = roles.get(id);
    if (base === undefined) {
      return `unknown role "${id}". Available: ${[...roles.keys()].join(', ')}`;
    }
    if (base.kind !== want) {
      return `"${id}" is a ${base.kind} role, not a ${want} one.`;
    }
    const configured = configuredRole(config, id, withPrompt(base, undefined, domain));
    return {
      role: configured.role,
      vendor: configured.agent.runtime,
      runtime: runtimeFor(configured.agent),
    };
  };

  try {
    if (domain !== undefined) withPrompt(roles.get('planner')!, undefined, domain);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const planner = pick('planner', 'planner', 'produce');
  if (typeof planner === 'string') return planner;
  const builder = pick('builder', 'builder', 'produce');
  if (typeof builder === 'string') return builder;
  const reviewer = pick('reviewer', 'reviewer', 'verify');
  if (typeof reviewer === 'string') return reviewer;

  // Rule 1, before a token is spent rather than after the builder has run.
  if (builder.vendor === reviewer.vendor) {
    return (
      `the builder and the reviewer are both on "${builder.vendor}".\n` +
      'A reviewer must run a different vendor. Change one in shura.config.yaml under `agents`.'
    );
  }

  return {
    planner: { ...planner, name: 'plan-01' },
    builder: { ...builder, name: 'dev-01' },
    reviewer: { ...reviewer, name: 'rev-01' },
  };
}

export async function build(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }

  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;

  const resume = flag(args, 'resume');
  const task = flag(args, 'task');
  const jira = flag(args, 'jira');

  if (resume === undefined && task === undefined && jira === undefined) {
    console.error(`nothing to do: give --task, --jira, or --resume.\n\n${USAGE}`);
    return 2;
  }
  if (task !== undefined && jira !== undefined) {
    console.error('--task and --jira both describe the request. Give one.');
    return 2;
  }

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
    return resume === undefined
      ? await planPhase({ args, loaded, agents, pool, task, jira })
      : await buildPhase({ args, loaded, agents, pool, resume });
  } catch (err) {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

/* ---------------------------------------------------------------- plan phase */

interface PlanArgs {
  args: string[];
  loaded: LoadedConfig;
  agents: Trio;
  pool: Pool;
  task: string | undefined;
  jira: string | undefined;
}

async function planPhase(p: PlanArgs): Promise<number> {
  const { args, loaded, agents, pool } = p;
  const config = loaded.config;

  let repo = resolveRepo(args, config);
  if (typeof repo === 'string') {
    console.error(repo);
    return 2;
  }

  const token = process.env[repo.tokenEnv] ?? '';
  if (token === '') {
    console.error(`${repo.tokenEnv} is not set, so ${repo.owner}/${repo.name} cannot be read.`);
    return 2;
  }

  // Ask the repository what it branches from, unless told. Assuming "main" is
  // how a repo that defaults to "master" fails with a 404 on its own base ref.
  if (flag(args, 'base') === undefined) {
    const actual = await githubDefaultBranch({ owner: repo.owner, repo: repo.name, token });
    if (actual !== undefined && actual !== repo.base) {
      console.log(`${repo.owner}/${repo.name} defaults to "${actual}", not "${repo.base}" — using it`);
      repo = { ...repo, base: actual };
    }
  }

  // The request, either as the human wrote it or as the ticket has it.
  let key: string;
  let title: string;
  let request: string;
  let source: 'instructions' | 'tracker';
  let tracker: Tracker | undefined;

  if (p.jira !== undefined) {
    const t = trackerFrom(config);
    if (typeof t === 'string') {
      console.error(t);
      return 2;
    }
    if (t === undefined) {
      console.error('--jira needs `tracker: jira` in shura.config.yaml.');
      return 2;
    }
    tracker = t;
    const item = await t.get(p.jira);
    if (item === undefined) {
      console.error(`no issue "${p.jira}" in this Jira.`);
      return 1;
    }
    key = item.key;
    title = item.title;
    // The whole description, not the criteria pulled out of it. Deriving
    // checkable criteria from prose is what the planner is for, and a ticket
    // that already has them is the easy case rather than the required one.
    request =
      (item.description ?? '').trim() === ''
        ? item.title
        : `${item.title}\n\n${item.description ?? ''}`;
    source = 'tracker';
    console.log(`read ${key} from ${config.tracker.type === 'jira' ? config.tracker.site : 'the tracker'}`);
  } else {
    request = p.task!;
    title = firstLine(request);
    key = await nextLocalKey(pool);
    source = 'instructions';
  }

  console.log(
    `\n${key}  ${title}\n` +
      `repo      ${repo.owner}/${repo.name} (${repo.base})\n` +
      `checks    ${repo.checks.join(' ')}\n` +
      `planner   ${agents.planner.role.id.padEnd(20)} ${agents.planner.vendor}/${agents.planner.role.model?.model}\n` +
      `budget    $${agents.planner.role.limits.max_usd} for planning\n`,
  );

  const go = await confirm(
    `Planning calls ${agents.planner.vendor}, which costs money (usually a few cents). Go ahead?`,
    args,
  );
  if (!go) {
    console.log('nothing spent.');
    return 1;
  }

  // Created after the gate, not before. A declined run used to leave a work
  // item behind and advance the SHURA-n counter, so three changes of mind left
  // three rows describing work nobody ever asked to start.
  //
  // Criteria are deliberately empty: the plan produces them. Criteria invented
  // here would give the planner something to agree with instead of something
  // to work out.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO work_items (key, type, title, acceptance_criteria, state)
     VALUES ($1, 'story', $2, '[]'::jsonb, 'draft')
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [key, title],
  );
  const workItemId = rows[0]!.id;

  const vcs = new GitHubVcs({
    owner: repo.owner,
    repo: repo.name,
    token,
    base: repo.base,
    checkCommand: repo.checks,
    workDir: join(loaded.dir, '.shura'),
  });
  // Planning itself never writes, so a read-only token is legitimate here. But
  // finding out now beats finding out after an approved plan has been built and
  // the push fails — so it reports rather than refuses.
  const writable = await probeWrite(vcs);
  if (writable !== undefined) {
    console.log(
      `\nnote: ${writable}\n` +
        'Planning does not need write access, so this run can continue. Building will.\n',
    );
  }

  console.log(`cloning ${repo.owner}/${repo.name}`);
  const repoDir = await vcs.repoDir();
  await vcs.refresh();

  const outcome = await planWorkItem({
    pool,
    repoDir,
    base: repo.base,
    checkCommand: repo.checks,
    workItem: { id: workItemId, key, title },
    // The target is recorded with the plan, not left to be re-derived at build
    // time from a config that names whichever repo it happens to name.
    source: {
      repo: `${repo.owner}/${repo.name}`,
      request,
      source,
      base: repo.base,
      checks: repo.checks,
    },
    planner: { runtime: agents.planner.runtime, role: agents.planner.role, name: agents.planner.name },
    onEvent: render,
  });

  if (!outcome.ok) {
    console.error(
      `\n${outcome.reason}  (${describeSpend(outcome.usd, isMetered(agents.planner.runtime.id))})`,
    );
    return 1;
  }

  const store = new PgPlans(pool);
  const stored = await store.get(outcome.planId);
  console.log(`\n${'='.repeat(78)}\n`);
  if (stored !== undefined) console.log(renderPlan(stored));
  console.log(`\n${'='.repeat(78)}`);
  console.log(
    `\nplanned \u2014 ${describeSpend(outcome.usd, isMetered(agents.planner.runtime.id))}. ` +
      'Nothing has been written.\n',
  );

  if (outcome.plan.openQuestions.length > 0) {
    console.log(
      `This plan raises ${outcome.plan.openQuestions.length} question(s). Answer them in order:\n` +
        `  shura approve ${outcome.planId.slice(0, 8)}` +
        outcome.plan.openQuestions.map((_q, i) => ` --answer "..."`).join('') +
        '\n\nOr let the agent decide them:\n' +
        `  shura approve ${outcome.planId.slice(0, 8)} --ignore-questions`,
    );
  } else {
    console.log(
      'Read it, then:\n' +
        `  shura approve ${outcome.planId.slice(0, 8)}\n` +
        `  shura build --resume ${outcome.planId.slice(0, 8)}\n\n` +
        'Or reject it and say what is wrong:\n' +
        `  shura approve ${outcome.planId.slice(0, 8)} --reject --note "..."`,
    );
  }
  void tracker;
  return 0;
}

/* --------------------------------------------------------------- build phase */

interface BuildArgs {
  args: string[];
  loaded: LoadedConfig;
  agents: Trio;
  pool: Pool;
  resume: string;
}

async function buildPhase(b: BuildArgs): Promise<number> {
  const { args, loaded, agents, pool } = b;
  const config = loaded.config;
  const store = new PgPlans(pool);

  let plan: StoredPlan | undefined;
  if (b.resume === 'latest') {
    plan = await store.nextApproved();
    if (plan === undefined) {
      console.error(
        'no approved plan is waiting to be built.\n' +
          'See what needs approving:  shura plans',
      );
      return 1;
    }
  } else {
    const found = await store.find(b.resume);
    if (found.length === 0) {
      console.error(`no plan matching "${b.resume}"`);
      return 1;
    }
    if (found.length > 1) {
      console.error(`"${b.resume}" matches ${found.length} plans. Use more of the id.`);
      return 2;
    }
    plan = found[0]!;
  }

  if (plan.status === 'awaiting_approval') {
    console.error(
      `plan ${plan.id.slice(0, 8)} has not been approved. Nothing is built until a human has ` +
        'read it:\n' +
        `  shura plans ${plan.id.slice(0, 8)}\n` +
        `  shura approve ${plan.id.slice(0, 8)}`,
    );
    return 1;
  }
  if (plan.status === 'rejected') {
    console.error(`plan ${plan.id.slice(0, 8)} was rejected. Plan again rather than building it.`);
    return 1;
  }
  if (plan.status === 'built') {
    console.error(
      `plan ${plan.id.slice(0, 8)} has already been built on ${plan.branch ?? 'a branch'}` +
        (plan.changeRequest === undefined ? '' : ` (pull request ${plan.changeRequest})`) +
        '.\nBuilding it again would open a second pull request for the same plan.',
    );
    return 1;
  }
  if (plan.criteria.length === 0) {
    console.error(
      `plan ${plan.id.slice(0, 8)} carries no acceptance criteria, so the reviewer would have ` +
        'nothing to judge against. This should not happen; the plan is unusable.',
    );
    return 1;
  }

  const [owner, name] = plan.repo.split('/');
  if (owner === undefined || name === undefined) {
    console.error(`plan ${plan.id.slice(0, 8)} records its repo as "${plan.repo}", which is not owner/name.`);
    return 1;
  }
  const tokenEnv = config.repo.type === 'github' ? config.repo.tokenEnv : 'GITHUB_TOKEN';
  const token = process.env[tokenEnv] ?? '';
  if (token === '') {
    console.error(`${tokenEnv} is not set, so nothing can be pushed to ${plan.repo}.`);
    return 2;
  }
  // From the plan, not from config. The config's base branch and check command
  // belong to whichever repository it names; using them to build a different
  // one either branches from the wrong ref or verifies nothing, and says
  // nothing either way. A flag still wins, for the case where the plan was
  // recorded with a command that has since changed.
  const checksFlag = flag(args, 'checks');
  const checks =
    checksFlag !== undefined
      ? ['sh', '-c', checksFlag]
      : plan.checks.length > 0
        ? [...plan.checks]
        : config.repo.checks;
  const base = flag(args, 'base') ?? plan.base;

  if (plan.checks.length === 0 && checksFlag === undefined) {
    // Only reachable for a plan recorded before the plan carried its target.
    console.log(
      `plan ${plan.id.slice(0, 8)} predates plans carrying their own check command, so the ` +
        `configured one is being used: ${config.repo.checks.join(' ')}\n` +
        'Pass --checks if that is not how this repository is built.',
    );
  }

  const tracker = trackerFrom(config);
  if (typeof tracker === 'string') {
    console.error(tracker);
    return 2;
  }
  // Only comment on a ticket the request actually came from. A locally-keyed
  // item has no ticket, and posting to one that happens to share the key is
  // how the wrong project gets Shura's progress notes.
  const notifyTracker = plan.source === 'tracker' ? tracker : undefined;

  console.log(
    `\n${plan.workItemKey}  ${plan.title}\n` +
      `plan      ${plan.id.slice(0, 8)}  approved  ·  ${plan.criteria.length} criteria\n` +
      `repo      ${plan.repo} (${base})\n` +
      // Shown because this is what decides whether the work is judged green,
      // and on a repository the config does not describe it is the single
      // easiest thing to have wrong.
      `checks    ${checks.join(' ')}\n` +
      `builder   ${agents.builder.role.id.padEnd(20)} ${agents.builder.vendor}/${agents.builder.role.model?.model}\n` +
      `reviewer  ${agents.reviewer.role.id.padEnd(20)} ${agents.reviewer.vendor}/${agents.reviewer.role.model?.model}` +
      (agents.reviewer.role.fix === undefined ? '  (reports only)' : '  (may fix what it finds)') +
      `\nbudget    $${config.budgets.per_task_usd} per task, ${config.budgets.loop_cap} attempts\n`,
  );

  const go = await confirm(
    `This builds and reviews the work, calling ${agents.builder.vendor} and ` +
      `${agents.reviewer.vendor}. Up to $${config.budgets.per_task_usd} per task. Go ahead?`,
    args,
  );
  if (!go) {
    console.log('nothing spent.');
    return 1;
  }

  const vcs = new GitHubVcs({
    owner,
    repo: name,
    token,
    base,
    checkCommand: checks,
    workDir: join(loaded.dir, '.shura'),
  });
  // Before the builder runs, not after. A read-only token otherwise passes every
  // check and fails at the push, by which point the whole budget is spent.
  const blocked = await probeWrite(vcs);
  if (blocked !== undefined) {
    console.error(`\ncannot build: ${blocked}`);
    return 1;
  }

  console.log(`cloning ${plan.repo}`);
  const repoDir = await vcs.repoDir();
  await vcs.refresh();

  const outcome = await buildApprovedPlan({
    pool,
    repoDir,
    checkCommand: checks,
    plan,
    builder: { runtime: agents.builder.runtime, role: agents.builder.role, name: agents.builder.name },
    reviewer: { runtime: agents.reviewer.runtime, role: agents.reviewer.role, name: agents.reviewer.name },
    vcs,
    loopCap: config.budgets.loop_cap,
    ...(notifyTracker === undefined ? {} : { tracker: notifyTracker }),
    onEvent: render,
  });

  console.log(
    `\n${outcome.state}  after ${outcome.attempts} attempt(s)  ` +
      `${describeSpend(outcome.usd, isMetered(agents.builder.runtime.id))}` +
      (outcome.decision === undefined ? '' : `  verdict ${outcome.decision}`) +
      (outcome.reason === undefined ? '' : `  — ${outcome.reason}`),
  );

  if (outcome.changeRequest !== undefined) {
    console.log(
      `\nA pull request is open for you to review and merge:\n` +
        `  ${outcome.changeRequest.url ?? `#${outcome.changeRequest.id}`}\n`,
    );
    if (outcome.reviewerFixed) {
      console.log(
        'Part of this branch was written by the reviewer after its own review, so no agent\n' +
          'reviewed those commits. The pull request names them. Look hardest there.\n',
      );
    }
    console.log('Shura does not merge. Nothing lands until you approve it.');
    return 0;
  }

  console.log(`\nThe branch ${outcome.branch} is pushed, but no pull request was opened.`);
  return 1;
}

/* ------------------------------------------------------------------- helpers */

/**
 * Checks the token can really push, and says so in one line if it cannot.
 *
 * Returns undefined when the write succeeded. A probe branch left behind is
 * reported rather than swallowed — it is litter in the user's repository and
 * they should know it is there.
 */
async function probeWrite(vcs: GitHubVcs): Promise<string | undefined> {
  try {
    const { leftover } = await vcs.assertCanWrite();
    if (leftover !== undefined) {
      console.log(
        `note: write access is fine, but the probe branch "${leftover}" could not be deleted. ` +
          'Remove it when convenient.',
      );
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

/**
 * A key for a request that came with no ticket.
 *
 * SHURA-n, counting up. Racy in principle and irrelevant in practice: this
 * runs once per invocation of a command a person types.
 */
async function nextLocalKey(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ n: number | null }>(
    `SELECT max(substring(key from '^SHURA-([0-9]+)$')::int) AS n
       FROM work_items WHERE key ~ '^SHURA-[0-9]+$'`,
  );
  return `SHURA-${(rows[0]?.n ?? 0) + 1}`;
}
