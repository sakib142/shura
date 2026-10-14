import { describe, expect, it } from 'vitest';
import {
  RepoPath,
  TOOL_CATALOG,
  ToolArgsInvalid,
  assertCatalogComplete,
  deriveEffectKey,
  isReclaimable,
  toolEffect,
  validateToolArgs,
  type ToolName,
} from './tools.js';

const ctx = { taskId: 'task-1', attempt: 1 };

describe('the catalog is internally consistent', () => {
  it('gives every write tool a key derivation and no read tool one', () => {
    expect(() => assertCatalogComplete()).not.toThrow();
  });

  it('declares an argument schema for every tool', () => {
    for (const name of Object.keys(TOOL_CATALOG) as ToolName[]) {
      expect(TOOL_CATALOG[name].args).toBeDefined();
    }
  });

  // Rule 3: the thing that merges is not a model, and merging is externally visible.
  it('marks externally visible effects unreclaimable', () => {
    expect(isReclaimable('repo.merge')).toBe(false);
    expect(isReclaimable('tracker.comment')).toBe(false);
    expect(isReclaimable('verdict.submit')).toBe(false);
  });

  it('marks workspace-only effects reclaimable', () => {
    expect(isReclaimable('repo.write')).toBe(true);
    expect(isReclaimable('claims.claim')).toBe(true);
  });
});

describe('repo paths', () => {
  it.each([
    ['src/orders/list.ts', true],
    ['a.ts', true],
    ['../../etc/passwd', false],
    ['src/../../../etc/passwd', false],
    ['/etc/passwd', false],
    ['.git/config', false],
    ['src//a.ts', false],
    ['src/a b.ts', false],
    ['', false],
  ])('%s accepted: %s', (path, ok) => {
    expect(RepoPath.safeParse(path).success).toBe(ok);
  });
});

describe('argument validation', () => {
  it('names every problem rather than only the first', () => {
    try {
      validateToolArgs('repo.write', { path: '../x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolArgsInvalid);
      expect((err as ToolArgsInvalid).message).toMatch(/path/);
      expect((err as ToolArgsInvalid).message).toMatch(/content/);
    }
  });

  it('strips unknown fields rather than passing invented parameters through', () => {
    const out = validateToolArgs('repo.read', { path: 'a.ts', force: true }) as Record<string, unknown>;
    expect(out).toEqual({ path: 'a.ts' });
  });

  it('requires a work item key in the expected shape', () => {
    expect(() => validateToolArgs('tracker.read', { workItemKey: 'ORD-12' })).not.toThrow();
    expect(() => validateToolArgs('tracker.read', { workItemKey: 'ord 12' })).toThrow(ToolArgsInvalid);
  });
});

describe('effect keys', () => {
  it('gives read and execute tools no key at all', () => {
    expect(deriveEffectKey('repo.read', { path: 'a.ts' }, ctx)).toBeUndefined();
    expect(deriveEffectKey('test.run', {}, ctx)).toBeUndefined();
  });

  // The two halves of our own design that no single formula can satisfy.
  it('separates the same write across attempts, so rework can rewrite a file', () => {
    const a = deriveEffectKey('repo.write', { path: 'a.ts' }, { taskId: 't', attempt: 1 });
    const b = deriveEffectKey('repo.write', { path: 'a.ts' }, { taskId: 't', attempt: 2 });
    expect(a).not.toBe(b);
  });

  it('collapses a merge across attempts, so one verdict merges once', () => {
    const args = { changeRequestId: 'cr-41', verdictId: 'v-9' };
    const a = deriveEffectKey('repo.merge', args, { taskId: 't1', attempt: 1 });
    const b = deriveEffectKey('repo.merge', args, { taskId: 't2', attempt: 7 });
    expect(a).toBe(b);
  });

  it('separates comments by body, so a different note still posts', () => {
    const base = { workItemKey: 'ORD-12' };
    const a = deriveEffectKey('tracker.comment', { ...base, body: 'opened #41' }, ctx);
    const b = deriveEffectKey('tracker.comment', { ...base, body: 'tests green' }, ctx);
    expect(a).not.toBe(b);
    expect(a).toBe(deriveEffectKey('tracker.comment', { ...base, body: 'opened #41' }, ctx));
  });

  it('ignores the attempt for a claim, since reclaiming a branch is one claim', () => {
    const args = { branch: 'feature/ORD-12', fileGlobs: ['src/**'] };
    expect(deriveEffectKey('claims.claim', args, { taskId: 't', attempt: 1 })).toBe(
      deriveEffectKey('claims.claim', args, { taskId: 't', attempt: 3 }),
    );
  });

  it('ties a verdict to its artifact and its verifier task', () => {
    expect(deriveEffectKey('verdict.submit', { artifactId: 'a1' }, { taskId: 'v1', attempt: 1 })).toBe(
      'verdict.submit:a1:v1',
    );
  });
});

describe('effects', () => {
  it('classifies a test run as execute, not write', () => {
    expect(toolEffect('test.run')).toBe('execute');
    expect(toolEffect('repo.read')).toBe('read');
    expect(toolEffect('repo.merge')).toBe('write');
  });
});
