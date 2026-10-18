import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git, agentIdentity } from '@shura/git';
import { stageWork } from './build-flow.js';

/**
 * The failure this guards against: the check command runs `pnpm install`, which
 * rewrites the lockfile, `git add -A` commits it, and `GitHubVcs.getDiff`
 * refuses the diff — after the work is done and paid for.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function repoWithLockfile(): Promise<{ git: Git; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'shura-stage-'));
  dirs.push(dir);
  const git = new Git(dir, agentIdentity('dev-01', 'frontend-developer', 'test'));
  await git.run('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'initial');
  return { git, dir };
}

const staged = async (git: Git): Promise<string[]> =>
  (await git.run('diff', '--cached', '--name-only')).stdout.split('\n').filter((l) => l !== '');

describe('staging an agent\'s work', () => {
  it('discards lockfile churn the checks caused', async () => {
    const { git, dir } = await repoWithLockfile();
    // What `pnpm install` does to a tracked lockfile.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# resolved\n');

    const discarded = await stageWork({ git } as never);

    expect(discarded).toEqual(['pnpm-lock.yaml']);
    expect(await staged(git)).toEqual([]);
  });

  it('still stages the work the agent actually did', async () => {
    const { git, dir } = await repoWithLockfile();
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'new.ts'), 'export const b = 3;\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# churn\n');

    const discarded = await stageWork({ git } as never);

    expect(discarded).toEqual(['pnpm-lock.yaml']);
    expect(await staged(git)).toEqual(['app.ts', 'new.ts']);
  });

  it('says nothing was discarded when nothing was', async () => {
    const { git, dir } = await repoWithLockfile();
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');

    expect(await stageWork({ git } as never)).toEqual([]);
    expect(await staged(git)).toEqual(['app.ts']);
  });

  /**
   * The one that actually happened.
   *
   * The repository committed no lockfile and ignored none either, so the check
   * command's `pnpm install` created one from nothing. The first version of
   * stageWork only looked at tracked files, found no change to revert, and let
   * `add -A` commit it — and the run died at the diff, after the work was done
   * and paid for.
   */
  it('removes a lockfile the checks created from nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shura-stage-'));
    dirs.push(dir);
    const git = new Git(dir, agentIdentity('dev-01', 'frontend-developer', 'test'));
    await git.run('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
    await git.run('add', '-A');
    await git.run('commit', '-q', '-m', 'initial — no lockfile, and none ignored');

    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'); // what install does

    const discarded = await stageWork({ git } as never);

    expect(discarded).toEqual(['pnpm-lock.yaml']);
    expect(await staged(git)).toEqual(['app.ts']);
    expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false);
  });

  // The tripwire still has to fire for something committed on purpose. This
  // only undoes the lockfiles a build is known to produce; a directory the
  // agent created is staged and gets caught downstream.
  it('does not hide a generated directory the agent created', async () => {
    const { git, dir } = await repoWithLockfile();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'console.log(1)\n');

    await stageWork({ git } as never);

    expect(await staged(git)).toContain('dist/bundle.js');
  });
});
