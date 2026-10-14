#!/usr/bin/env node
/**
 * forge — the operator surface.
 *
 * Only the commands M3.5 needs are implemented. `doctor` reports what it
 * *cannot* do rather than failing silently, because a missing vendor key is an
 * answer worth having before a sprint rather than during one.
 */

import { VENDORS, assertCatalogComplete, type Vendor } from '@forge/core';
import { createPool, databaseUrl, isReachable, verifyAuditChain } from '@forge/db';
import { tryResolveGit } from '@forge/git';
import { hasPricing } from '@forge/model-gateway';
import { loadAllRoles } from '@forge/roles';
import { smoke } from './smoke.js';
import { run } from './run.js';
import { probe } from './probe.js';
import { submit } from './submit.js';
import { init } from './init.js';
import { ConfigInvalid } from '@forge/config';

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
      ? no('git: no working binary found — set FORGE_GIT, or `brew install git`')
      : ok(`git: ${git.version} at ${git.path} (via ${git.source})`),
  );
  if (git === undefined) fatal = true;

  try {
    const roles = loadAllRoles();
    const unpriced = [...roles.values()]
      .map((r) => r.model?.model)
      .filter((m): m is string => m !== undefined && !hasPricing(m));
    lines.push(
      unpriced.length === 0
        ? ok('pricing: every configured model has a published price')
        : no(`pricing: no price for ${[...new Set(unpriced)].join(', ')} — cost will report as unknown`),
    );
  } catch {
    // role loading already reported above
  }

  const present = VENDORS.filter((v) => (process.env[KEY_ENV[v]] ?? '') !== '');
  for (const v of VENDORS) {
    lines.push(present.includes(v) ? ok(`${v} key present`) : no(`${v} key absent (${KEY_ENV[v]})`));
  }

  // Rule 1 means a usable pair needs two different vendors, so the honest
  // report is which pairs are available, not merely which keys exist.
  const pairs = present.flatMap((p) => present.filter((v) => v !== p).map((v) => `${p}:${v}`));
  lines.push(
    pairs.length > 0
      ? ok(`verifier pairs available: ${pairs.join(', ')}`)
      : no('no verifier pair available — rule 1 needs two different vendors'),
  );

  console.log(lines.join('\n'));
  return fatal ? 1 : 0;
}

async function audit(args: string[]): Promise<number> {
  if (!args.includes('--verify')) {
    console.error('usage: forge audit --verify');
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
    default:
      console.error(
        [
          'usage: forge <command>',
          '',
          '  init                       write a starter forge.config.yaml',
          '  doctor                     check everything is wired up',
          '  submit <file.md>           define a work item and its acceptance criteria',
          '  run <ITEM> [--role R]      build it, review it, merge it',
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
