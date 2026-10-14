import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Git, agentIdentity } from '@shura/git';
import { Worktree } from '@shura/sandbox';
import { createPool, isReachable } from '@shura/db';
import { LocalMergeQueue, LocalVcs, initRepo } from './vcs-local.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[connectors] Postgres unreachable — skipping.');

afterAll(async () => {
  if (up) await pool.query('TRUNCATE merge_queue, change_requests CASCADE');
  await pool.end();
});

const dirs: string[] = [];
afterAll(() => {
  for (const x of dirs.splice(0)) rmSync(x, { recursive: true, force: true });
});

/** A seed project whose test suite passes, and can be made to fail. */
function seedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shura-seed-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'value.txt'), '1\n');
  writeFileSync(
    join(dir, 'check.mjs'),
    `import { readFileSync } from 'node:fs';
     const v = Number(readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim());
     if (!Number.isInteger(v)) { console.error('not an integer:', v); process.exit(1); }
     console.log('ok', v);`,
  );
  return dir;
}

async function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'shura-vcs-'));
  dirs.push(root);
  const repoDir = join(root, 'target.git');
  await initRepo(repoDir, seedProject());
  const opts = { repoDir, pool, checkCommand: ['node', 'check.mjs'] as const };
  const vcs = new LocalVcs(opts);
  return { repoDir, vcs, queue: new LocalMergeQueue(opts, vcs) };
}

/** Writes a change on a branch the way a producer agent would. */
async function agentChange(repoDir: string, branch: string, content: string) {
  const wt = await Worktree.create({
    repoDir,
    branch,
    taskId: 'task-1',
    identity: agentIdentity('dev-01', 'backend-developer', 'claude-sonnet-5'),
    claimedBranches: [branch],
  });
  await wt.write('value.txt', content);
  await wt.git.run('add', '-A');
  await wt.git.run('commit', '-q', '-m', `work on ${branch}`);
  await wt.destroy();
}

d('the local VCS', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE merge_queue, change_requests CASCADE');
  });

  it('seeds a bare repo that checks out and passes its own checks', async () => {
    const { repoDir, vcs } = await freshRepo();
    await vcs.createBranch('main', 'feature/A');
    const checks = await vcs.runChecks({ id: 'x', branch: 'feature/A', base: 'main' });
    expect(checks.ok).toBe(true);
    expect(await new Git(repoDir).run('rev-parse', 'refs/heads/main')).toBeTruthy();
  });

  it('diffs only what the branch changed', async () => {
    const { repoDir, vcs } = await freshRepo();
    await vcs.createBranch('main', 'feature/B');
    await agentChange(repoDir, 'feature/B', '42\n');

    const ref = await vcs.openChangeRequest({
      branch: 'feature/B', base: 'main', title: 'bump', body: '', author: 'dev-01',
    });
    const diff = await vcs.getDiff(ref);
    expect(diff.files).toEqual(['value.txt']);
    expect(diff.text).toContain('+42');
  });

  it('reports failing checks rather than throwing', async () => {
    const { repoDir, vcs } = await freshRepo();
    await vcs.createBranch('main', 'feature/bad');
    await agentChange(repoDir, 'feature/bad', 'not-a-number\n');
    const checks = await vcs.runChecks({ id: 'x', branch: 'feature/bad', base: 'main' });
    expect(checks.ok).toBe(false);
    expect(checks.output).toContain('not an integer');
  });

  it('merges an approved change and records the commit', async () => {
    const { repoDir, vcs, queue } = await freshRepo();
    await vcs.createBranch('main', 'feature/C');
    await agentChange(repoDir, 'feature/C', '7\n');
    const ref = await vcs.openChangeRequest({
      branch: 'feature/C', base: 'main', title: 'seven', body: '', author: 'dev-01',
    });

    await queue.enqueue(ref, 'verdict-1');
    const [outcome] = await queue.tick();
    expect(outcome?.status).toBe('merged');

    const { rows } = await pool.query<{ status: string; merge_commit: string }>(
      'SELECT status, merge_commit FROM change_requests WHERE id=$1', [ref.id],
    );
    expect(rows[0]?.status).toBe('merged');
    expect(rows[0]?.merge_commit).toHaveLength(40);
  });

  // The merge commit must name neither the producer nor the reviewer.
  it('merges under its own identity, not the author of the work', async () => {
    const { repoDir, vcs, queue } = await freshRepo();
    await vcs.createBranch('main', 'feature/D');
    await agentChange(repoDir, 'feature/D', '9\n');
    const ref = await vcs.openChangeRequest({
      branch: 'feature/D', base: 'main', title: 'nine', body: '', author: 'dev-01',
    });
    await queue.enqueue(ref, 'verdict-2');
    await queue.tick();

    const { stdout } = await new Git(repoDir).run('log', '--format=%an', '-1', 'main');
    expect(stdout.trim()).toContain('merge-queue');
    expect(stdout).not.toContain('dev-01');
  });

  // The property a directly-merging reviewer gives up.
  it('refuses to merge when the result breaks the base, even though the branch was green', async () => {
    const { repoDir, vcs, queue } = await freshRepo();

    // Two branches, each green alone, that conflict once combined.
    await vcs.createBranch('main', 'feature/E1');
    await agentChange(repoDir, 'feature/E1', '11\n');
    await vcs.createBranch('main', 'feature/E2');
    await agentChange(repoDir, 'feature/E2', '22\n');

    const first = await vcs.openChangeRequest({
      branch: 'feature/E1', base: 'main', title: 'first', body: '', author: 'dev-01',
    });
    const second = await vcs.openChangeRequest({
      branch: 'feature/E2', base: 'main', title: 'second', body: '', author: 'dev-02',
    });
    expect((await vcs.runChecks(second)).ok).toBe(true);

    await queue.enqueue(first, 'v1');
    await queue.tick();
    await queue.enqueue(second, 'v2');
    const [outcome] = await queue.tick();

    expect(outcome?.status).toBe('rejected');
    expect((outcome as { reason: string }).reason).toMatch(/conflicts with main/);
  });

  it('does not merge the same verdict twice', async () => {
    const { repoDir, vcs, queue } = await freshRepo();
    await vcs.createBranch('main', 'feature/F');
    await agentChange(repoDir, 'feature/F', '5\n');
    const ref = await vcs.openChangeRequest({
      branch: 'feature/F', base: 'main', title: 'five', body: '', author: 'dev-01',
    });
    await queue.enqueue(ref, 'v-same');
    await queue.enqueue(ref, 'v-same');
    const outcomes = await queue.tick();
    expect(outcomes).toHaveLength(1);
  });
});
