#!/usr/bin/env node
/**
 * shura — the operator surface.
 *
 * Only the commands M3.5 needs are implemented. `doctor` reports what it
 * *cannot* do rather than failing silently, because a missing vendor key is an
 * answer worth having before a sprint rather than during one.
 */

import { execFileSync } from 'node:child_process';
import { assertCatalogComplete, type Vendor } from '@shura/core';
import { createPool, databaseUrl, isReachable, verifyAuditChain } from '@shura/db';
import { tryResolveGit } from '@shura/git';
import { loadAllRoles } from '@shura/roles';
import { smoke } from './smoke.js';
import { run } from './run.js';
import { probe } from './probe.js';
import { submit } from './submit.js';
import { init } from './init.js';
import { design } from './design.js';
import { watch } from './watch.js';
import { build } from './build.js';
import { serve } from './serve.js';
import { approve, plans } from './approve.js';
import { tryAgent } from './try.js';
import { ConfigInvalid } from '@shura/config';

const KEY_ENV: Record<Vendor, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  local: 'LOCAL_BASE_URL',
};

const ok = (s: string) => `  ok    ${s}`;
const no = (s: string) => `  ----  ${s}`;

async function doctor(): Promise<number> {
  const lines: string[] = [];
  let fatal = false;

  const pool = createPool();
  const dbUp = await isReachable(pool);
  lines.push(dbUp ? ok(`postgres  ${databaseUrl()}`) : no(`postgres unreachable at ${databaseUrl()}`));
  if (!dbUp) fatal = true;

  if (dbUp) {
    const breaks = await verifyAuditChain(pool);
    lines.push(breaks.length === 0 ? ok('audit chain intact') : no(`audit chain broken in ${breaks.length} place(s)`));
    if (breaks.length > 0) fatal = true;
  }
  await pool.end();

  try {
    assertCatalogComplete();
    lines.push(ok('tool catalog: every write tool declares an idempotency key'));
  } catch (err) {
    lines.push(no(`tool catalog: ${(err as Error).message}`));
    fatal = true;
  }

  try {
    const roles = loadAllRoles();
    lines.push(ok(`roles: ${roles.size} loaded, all satisfying the invariant`));
  } catch (err) {
    lines.push(no(`roles: ${(err as Error).message}`));
    fatal = true;
  }

  const git = tryResolveGit();
  lines.push(
    git === undefined
      ? no('git: no working binary found — set SHURA_GIT, or `brew install git`')
      : ok(`git: ${git.version} at ${git.path} (via ${git.source})`),
  );
  if (git === undefined) fatal = true;

  // The agents are the vendor CLIs now, so the question is whether they are
  // installed rather than whether a model has a published price — nothing is
  // billed per token.
  for (const [bin, vendor] of [
    ['claude', 'anthropic'],
    ['codex', 'openai'],
  ] as const) {
    const found = which(bin);
    lines.push(
      found === undefined
        ? no(`${bin} is not installed — needed for the ${vendor} agent`)
        : ok(`${bin} ${found}`),
    );
    if (found === undefined) fatal = true;
  }

  // An API key is no longer something to have; it is something to not have.
  // Shura blanks it per run so work stays on the subscription, but one sitting
  // in the environment means everything else is billed per token.
  for (const [vendor, envVar] of Object.entries(KEY_ENV)) {
    if (vendor === 'google' || vendor === 'local') continue;
    if ((process.env[envVar] ?? '') !== '') {
      lines.push(
        no(`${envVar} is set — Shura ignores it, but other tools on this machine will bill you`),
      );
    }
  }

  lines.push(
    ok('runs are covered by your subscriptions; nothing here is billed per token'),
    ok('check both CLIs answer, which also proves the cross-vendor pair:  shura smoke'),
  );

  console.log(lines.join('\n'));
  return fatal ? 1 : 0;
}

async function audit(args: string[]): Promise<number> {
  if (!args.includes('--verify')) {
    console.error('usage: shura audit --verify');
    return 2;
  }
  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()}`);
    await pool.end();
    return 1;
  }
  const breaks = await verifyAuditChain(pool);
  await pool.end();

  if (breaks.length === 0) {
    console.log('audit chain intact');
    return 0;
  }
  for (const b of breaks) console.error(`TAMPERED  ${b.table} id=${b.id}: ${b.reason}`);
  return 1;
}

/** The version of a CLI on PATH, or undefined when it is not there. */
function which(bin: string): string | undefined {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 })
      .trim()
      .split('\n')[0];
  } catch {
    return undefined;
  }
}

const [command, ...rest] = process.argv.slice(2);

async function dispatch(): Promise<number> {
  switch (command) {
    case 'doctor': return doctor();
    case 'audit': return audit(rest);
    case 'smoke': return smoke(rest[0]);
    case 'run': return run(rest);
    case 'probe': return probe(rest);
    case 'submit': return submit(rest);
    case 'init': return init(rest);
    case 'design': return design(rest);
    case 'watch': return watch(rest);
    case 'serve': return serve(rest);
    case 'build': return build(rest);
    case 'try': return tryAgent(rest);
    case 'plans': return plans(rest);
    case 'approve': return approve(rest);
    default:
      console.error(
        [
          'usage: shura <command>',
          '',
          '  init                       write a starter shura.config.yaml',
          '  doctor                     check everything is wired up',
          '',
          '  serve [--port=7777]        run the agent and give it work from your browser',
          '',
          '  build --repo R --task "…"  the same, from the terminal: plan it and stop for approval',
          '  build --repo R --jira KEY  the same, reading the request from a ticket',
          '  plans [ID]                 what is waiting for approval, or one plan in full',
          '  approve ID                 approve a plan so it can be built',
          '  build --resume ID          build an approved plan, review it, open a pull request',
          '',
          '  try planner|builder|reviewer   run one agent alone, to see what it does',
          '',
          '  submit <file.md>           define a work item and its acceptance criteria',
          '  run <ITEM> [--role R]      build it, review it, merge it',
          '  design <extract.json>      a design in, a verified backlog out',
          '  watch [--port=7777]        read-only live view; serve is this plus submitting work',
          '  probe [CASE]               measure whether the reviewer catches seeded faults',
          '  smoke [vendor]             one real round-trip per vendor',
          '  audit --verify             check the audit log for tampering',
        ].join('\n'),
      );
      return 2;
  }
}

let exit: number;
try {
  exit = await dispatch();
} catch (err) {
  // A config problem is a thing the user can fix, not a crash. Printing a
  // stack trace at someone whose YAML has a typo is how a project loses them.
  if (err instanceof ConfigInvalid) {
    console.error(`cannot read configuration:\n\n${err.message}\n`);
    exit = 2;
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    exit = 1;
  }
}
process.exit(exit);
