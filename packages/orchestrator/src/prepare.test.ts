/**
 * Installing dependencies before an agent is handed the worktree.
 *
 * Two sightings, five days apart, on two different repositories:
 *
 * A reviewer on courtshare reported "This review checkout also lacks
 * node_modules/.bin/tsc and node_modules/.bin/eslint" and marked a criterion
 * unmet for want of the tools to judge it. A verify task holds no write grant
 * and cannot install anything, so that finding was not actionable by anybody —
 * and it bought a builder pass that read the code, found nothing to write, and
 * stopped.
 *
 * A fix task on forge-sandbox spent about forty seconds trying `npm install
 * --offline`, then `--no-package-lock`, then `--fetch-retries=0` before giving
 * up.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git, agentIdentity } from '@shura/git';
import { Worktree } from '@shura/sandbox';
import { installDependencies, measureBaseline, wasAlreadyFailing } from './prepare.js';

let repoDir: string;
const made: Worktree[] = [];

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'shura-prep-'));
  const git = new Git(repoDir, agentIdentity('someone', 'human', 'none'));
  await git.run('init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'app.ts'), 'export const a = 1;\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'first');
});

afterAll(async () => {
  for (const wt of made.splice(0)) await wt.destroy().catch(() => {});
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
});

async function aWorktree(): Promise<Worktree> {
  const wt = await Worktree.create({
    repoDir,
    branch: 'main',
    taskId: `prep-${made.length}`,
    detached: true,
  });
  made.push(wt);
  return wt;
}

describe('preparing a worktree', () => {
  it('runs the surveyed install command in the worktree', async () => {
    const wt = await aWorktree();
    const r = await installDependencies(wt, 'touch installed.marker');

    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/dependencies installed in \d+s/);
    expect(existsSync(join(wt.dir, 'installed.marker'))).toBe(true);
  });

  // A repository with no dependencies is ordinary, and should cost nothing and
  // say nothing.
  it('does nothing when the survey found no install command', async () => {
    const wt = await aWorktree();
    for (const nothing of [undefined, '', '   ']) {
      const r = await installDependencies(wt, nothing);
      expect(r).toEqual({ ok: true });
    }
  });

  /*
   * A failed install must not fail the run. The builder can still try for
   * itself, and a reviewer that cannot run the tools will say so in its
   * findings — which this makes rarer, not impossible. Taking the whole run
   * down instead would turn a degraded pass into no pass at all.
   */
  it('reports a failed install without failing the run', async () => {
    const wt = await aWorktree();
    const r = await installDependencies(wt, 'echo nope >&2; exit 3');

    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/could not install dependencies \(exit 3/);
    expect(r.summary).toMatch(/gets the worktree anyway/);
    expect(r.output).toContain('nope');
  });

  it('never throws, whatever the command does', async () => {
    const wt = await aWorktree();
    await expect(installDependencies(wt, 'this-command-does-not-exist')).resolves.toMatchObject({
      ok: false,
    });
  });
});

/*
 * Measuring the base before anything is built.
 *
 * Criterion [19] demanded "no new error relative to a captured baseline" when
 * nothing captured one. No agent could settle it — a verify task cannot install
 * the tools it would need — so it went round the loop twice and ended with the
 * reviewer committing a verification note into the user's own repository.
 *
 * The measurement is deterministic, so it belongs to the harness and not to
 * anybody's judgement.
 */
describe('measuring the base', () => {
  it('records what the gate said, with the commit it said it about', async () => {
    const base = await measureBaseline({
      repoDir,
      base: 'main',
      taskId: 'baseline-ok',
      gate: ['sh', '-c', 'echo all good'],
    });

    expect(base?.code).toBe(0);
    expect(base?.output).toContain('all good');
    expect(base?.command).toEqual(['sh', '-c', 'echo all good']);
    expect(base?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(base?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // The case that matters: a repository whose gate is already red. Recording it
  // is what lets a builder be told the failure is not its own.
  it('records a gate that was already failing, rather than treating it as an error', async () => {
    const base = await measureBaseline({
      repoDir,
      base: 'main',
      taskId: 'baseline-red',
      gate: ['sh', '-c', 'echo broken already >&2; exit 2'],
    });

    expect(base?.code).toBe(2);
    expect(base?.output).toContain('broken already');
    expect(wasAlreadyFailing(base)).toBe(true);
  });

  it('runs the install first, so the gate has what it needs', async () => {
    const base = await measureBaseline({
      repoDir,
      base: 'main',
      taskId: 'baseline-install',
      install: 'echo installed > dep.marker',
      gate: ['sh', '-c', 'cat dep.marker'],
    });

    expect(base?.code).toBe(0);
    expect(base?.output).toContain('installed');
  });

  it('measures nothing when there is no gate to run', async () => {
    expect(
      await measureBaseline({ repoDir, base: 'main', taskId: 'baseline-none', gate: [] }),
    ).toBeUndefined();
  });

  // An unmeasured baseline must not read as "the base was fine", or the first
  // red gate gets blamed on whatever change happens to be in flight.
  it('does not claim the base was passing when nothing was measured', () => {
    expect(wasAlreadyFailing(undefined)).toBe(false);
  });

  // It must leave the base branch free: the builder's own branch is created
  // from it, and a held worktree would block that.
  it('leaves no worktree holding the base branch', async () => {
    await measureBaseline({
      repoDir,
      base: 'main',
      taskId: 'baseline-release',
      gate: ['sh', '-c', 'true'],
    });
    const list = await new Git(repoDir).tryRun('worktree', 'list');
    expect(list.stdout).not.toContain('baseline-release');
  });
});
