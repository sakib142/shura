import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Git, agentIdentity } from '@shura/git';
import { producerHandlers } from './handlers.js';

/**
 * Searching exists because its absence was expensive.
 *
 * With only "read one file by path", an agent discovers a codebase by opening
 * files one at a time, and each one stays in the transcript for the rest of the
 * task. A measured run read 57 files into a 168k-token context and ran out of
 * money having written almost nothing. Most of those reads were answering
 * "where does this live".
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shura-search-'));
  const git = new Git(dir, agentIdentity('dev-01', 'frontend-developer', 'test'));
  await git.run('init', '-q', '-b', 'main');

  mkdirSync(join(dir, 'src/components'), { recursive: true });
  mkdirSync(join(dir, 'src/hooks'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/react'), { recursive: true });

  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(
    join(dir, 'src/components/OrderList.tsx'),
    'import { useAuth } from "../hooks/useAuth";\nexport function OrderList() { return null; }\n',
  );
  writeFileSync(join(dir, 'src/components/Page.tsx'), 'import { OrderList } from "./OrderList";\n');
  writeFileSync(join(dir, 'src/hooks/useAuth.ts'), 'export function useAuth() { return {}; }\n');
  // Ignored, and must never appear in results.
  writeFileSync(join(dir, 'node_modules/react/index.js'), 'export const useAuth = 1; // OrderList\n');

  await git.run('add', '-A');
  await git.run('commit', '-q', '-m', 'initial');
});

afterEach(() => {});

const search = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const handlers = producerHandlers({
    worktree: { git: new Git(dir) } as never,
    pool: {} as never,
    workItemId: 'w',
    workItemKey: 'K-1',
    checkCommand: ['true'],
    criterionCount: 0,
  });
  const handler = handlers.get('repo.search')!;
  return (await handler({ args } as never)) as Record<string, unknown>;
};

describe('searching the repository', () => {
  it('answers "where is this used" in one call', async () => {
    const r = await search({ pattern: 'OrderList' });
    expect(r['files']).toEqual(
      expect.arrayContaining(['src/components/OrderList.tsx', 'src/components/Page.tsx']),
    );
  });

  it('gives the file and line, so the next read is targeted', async () => {
    const r = await search({ pattern: 'useAuth', glob: 'src/hooks/*' });
    const [first] = r['matches'] as { path: string; line: number; text: string }[];
    expect(first).toMatchObject({ path: 'src/hooks/useAuth.ts', line: 1 });
    expect(first!.text).toContain('useAuth');
  });

  /**
   * The reason this uses `git grep` rather than walking the filesystem: only
   * tracked files are searched, so dependencies and build output are excluded
   * without maintaining a list of things to skip.
   */
  it('never returns a match from an ignored directory', async () => {
    const r = await search({ pattern: 'useAuth' });
    const files = r['files'] as string[];
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files).toContain('src/hooks/useAuth.ts');
  });

  it('narrows by glob', async () => {
    const r = await search({ pattern: 'OrderList', glob: 'src/components/Page.tsx' });
    expect(r['files']).toEqual(['src/components/Page.tsx']);
  });

  // "Nothing matched" is an answer. Returning it as a failure would invite the
  // agent to retry the same search.
  it('reports no matches as a result, not an error', async () => {
    const r = await search({ pattern: 'ThisDoesNotExistAnywhere' });
    expect(r['matches']).toEqual([]);
    expect(r['note']).toBe('nothing matched');
    expect(r['error']).toBeUndefined();
  });

  it('treats the pattern as a regular expression', async () => {
    const r = await search({ pattern: 'use(Auth|Nothing)' });
    expect((r['files'] as string[]).length).toBeGreaterThan(0);
  });

  // A regex metacharacter in a literal search must not be interpreted.
  it('searches literally when asked', async () => {
    const r = await search({ pattern: 'useAuth()', literal: true });
    expect((r['files'] as string[])).toContain('src/hooks/useAuth.ts');
  });
});
