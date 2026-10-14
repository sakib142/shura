import { describe, expect, it } from 'vitest';
import { parseRole, type ToolName } from '@forge/core';
import type { ToolCallRequest, ToolCallResult } from '@forge/ports';
import {
  InMemoryAuditSink,
  McpToolGateway,
  type CredentialProvider,
  type ToolHandler,
} from './gateway.js';
import { InMemoryEffectStore } from './effects.js';
import { resolveGrants } from './permissions.js';

const reviewer = parseRole({
  id: 'code-reviewer',
  kind: 'verify',
  model: { runtime: 'openai', model: 'gpt-5' },
  tools: ['repo.read', 'test.run', 'verdict.submit'],
  instructions: 'prompts/code-reviewer.md',
});

const developer = parseRole({
  id: 'backend-developer',
  kind: 'produce',
  model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
  tools: ['repo.read', 'repo.write', 'test.run', 'tracker.comment', 'claims.claim'],
  instructions: 'prompts/backend-developer.md',
});

const merger = parseRole({
  id: 'merge-queue',
  kind: 'admit',
  tools: ['repo.merge'],
  instructions: 'deterministic',
});

function build(role: typeof reviewer, over: Partial<{ handlers: Array<[ToolName, ToolHandler]> }> = {}) {
  const audit = new InMemoryAuditSink();
  const effects = new InMemoryEffectStore();
  let merges = 0;
  let comments = 0;
  const defaults: Array<[ToolName, ToolHandler]> = [
    ['repo.read', async () => ({ ok: true })],
    ['repo.write', async (i) => ({ written: (i.args as { path: string }).path })],
    ['repo.merge', async () => ({ commit: `sha-${++merges}` })],
    ['test.run', async () => ({ passed: 12 })],
    ['tracker.comment', async () => ({ commentId: ++comments })],
    ['claims.claim', async () => ({ claimId: 'c1' })],
    ['verdict.submit', async () => ({ recorded: true })],
  ];
  const gateway = new McpToolGateway({
    handlers: new Map([...defaults, ...(over.handlers ?? [])]),
    audit,
    effects,
    grantsFor: () => resolveGrants(role),
  });
  return { gateway, audit, effects, counts: () => ({ merges, comments }) };
}

function req(tool: string, args: unknown, over: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    roleKind: 'produce',
    grants: [],
    tool,
    args,
    attempt: 1,
    ...over,
  };
}

const denial = (r: ToolCallResult) => (r.allowed ? undefined : r);

describe('rule 2 at the door', () => {
  it('denies a verifier calling repo.write and records the denial', async () => {
    const { gateway, audit } = build(reviewer);
    const r = denial(await gateway.call(req('repo.write', { path: 'a.ts', content: 'x' })));
    expect(r?.errorCategory).toBe('permission');
    expect(r?.isRetryable).toBe(false);
    expect(audit.denials()).toHaveLength(1);
  });

  it('denies a verifier a write even when the grant list wrongly contains it', async () => {
    const audit = new InMemoryAuditSink();
    const gateway = new McpToolGateway({
      handlers: new Map<ToolName, ToolHandler>([['repo.write', async () => ({ written: true })]]),
      audit,
      grantsFor: () => ({ roleId: 'bad', kind: 'verify', tools: ['repo.write'] }),
    });
    const r = denial(await gateway.call(req('repo.write', { path: 'a.ts', content: 'x' })));
    expect(r?.denialReason).toMatch(/no write grant/);
    expect(r?.errorCategory).toBe('permission');
  });

  it('allows a verifier its one write channel', async () => {
    const { gateway } = build(reviewer);
    const r = await gateway.call(req('verdict.submit', { artifactId: 'a1' }, { roleKind: 'verify' }));
    expect(r.allowed).toBe(true);
  });
});

describe('tool argument contracts', () => {
  // A permissive object is how a model invents a parameter.
  it('rejects a repo path that escapes the workspace', async () => {
    const { gateway, audit } = build(developer);
    const r = denial(await gateway.call(req('repo.write', { path: '../../etc/passwd', content: 'x' })));
    expect(r?.errorCategory).toBe('validation');
    expect(r?.denialReason).toMatch(/\.\." segment/);
    expect(audit.denials()).toHaveLength(1);
  });

  it('rejects an absolute path', async () => {
    const { gateway } = build(developer);
    const r = denial(await gateway.call(req('repo.write', { path: '/etc/passwd', content: 'x' })));
    expect(r?.denialReason).toMatch(/repo-relative/);
  });

  it('rejects a write into the git directory', async () => {
    const { gateway } = build(developer);
    const r = denial(await gateway.call(req('repo.write', { path: '.git/config', content: 'x' })));
    expect(r?.denialReason).toMatch(/git directory/);
  });

  it('rejects a missing required field', async () => {
    const { gateway } = build(developer);
    const r = denial(await gateway.call(req('repo.write', { path: 'a.ts' })));
    expect(r?.errorCategory).toBe('validation');
    expect(r?.denialReason).toMatch(/content/);
  });

  it('rejects a malformed work item key', async () => {
    const { gateway } = build(developer);
    const r = denial(await gateway.call(req('tracker.comment', { workItemKey: 'nope', body: 'hi' })));
    expect(r?.denialReason).toMatch(/ORD-12/);
  });

  // Validation errors are the one denial worth feeding back for self-correction.
  it('marks a validation failure retryable and a permission failure not', async () => {
    const { gateway } = build(developer);
    const bad = denial(await gateway.call(req('repo.write', { path: '../x', content: 'y' })));
    const forbidden = denial(await gateway.call(req('repo.merge', { changeRequestId: 'cr', verdictId: 'v' })));
    expect(bad?.isRetryable).toBe(true);
    expect(forbidden?.isRetryable).toBe(false);
  });

  it('accepts a well-formed call', async () => {
    const { gateway } = build(developer);
    expect((await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'x' }))).allowed).toBe(true);
  });
});

describe('idempotency', () => {
  // One approved verdict merges once, however often the queue retries.
  it('merges once for the same change request and verdict', async () => {
    const { gateway, counts } = build(merger);
    const args = { changeRequestId: 'cr-41', verdictId: 'v-9' };
    const first = await gateway.call(req('repo.merge', args, { roleKind: 'admit', attempt: 1 }));
    const second = await gateway.call(req('repo.merge', args, { roleKind: 'admit', attempt: 2 }));

    expect(counts().merges).toBe(1);
    expect(first).toMatchObject({ allowed: true, output: { commit: 'sha-1' } });
    expect(second).toMatchObject({ allowed: true, output: { commit: 'sha-1' }, replayed: true });
  });

  it('posts a ticket comment once when the task is requeued', async () => {
    const { gateway, counts } = build(developer);
    const args = { workItemKey: 'ORD-12', body: 'opened change request #41' };
    await gateway.call(req('tracker.comment', args));
    await gateway.call(req('tracker.comment', args));
    expect(counts().comments).toBe(1);
  });

  // Rework must be free to rewrite a file it already touched.
  it('treats the same write under a new attempt as a new effect', async () => {
    const writes: string[] = [];
    const { gateway } = build(developer, {
      handlers: [['repo.write', async (i) => { writes.push((i.args as { content: string }).content); return { ok: true }; }]],
    });
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'v1' }, { attempt: 1 }));
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'v2' }, { attempt: 2 }));
    expect(writes).toEqual(['v1', 'v2']);
  });

  it('collapses the same write within one attempt', async () => {
    const writes: string[] = [];
    const { gateway } = build(developer, {
      handlers: [['repo.write', async (i) => { writes.push((i.args as { content: string }).content); return { ok: true }; }]],
    });
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'v1' }, { attempt: 1 }));
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'v1' }, { attempt: 1 }));
    expect(writes).toEqual(['v1']);
  });

  // The failure mode that matters: a process that died mid-merge.
  it('escalates rather than repeating an effect nobody released', async () => {
    const { gateway, effects } = build(merger);
    await effects.begin('repo.merge:cr-41:v-9', 'repo.merge', 'other-task', false);

    const r = denial(
      await gateway.call(req('repo.merge', { changeRequestId: 'cr-41', verdictId: 'v-9' }, { roleKind: 'admit' })),
    );
    expect(r?.errorCategory).toBe('business');
    expect(r?.isRetryable).toBe(false);
    expect(r?.denialReason).toMatch(/died mid-effect/);
  });

  it('never reclaims an externally visible effect, however stale', async () => {
    const { gateway, effects } = build(merger);
    await effects.begin('repo.merge:cr-41:v-9', 'repo.merge', 'other-task', false);
    effects.setClock(() => new Date(Date.now() + 24 * 60 * 60 * 1000));

    const r = denial(
      await gateway.call(req('repo.merge', { changeRequestId: 'cr-41', verdictId: 'v-9' }, { roleKind: 'admit' })),
    );
    expect(r?.errorCategory).toBe('business');
  });

  // A write confined to our own worktree is safe to redo once the lease lapses.
  it('reclaims a stale workspace-only effect after the lease', async () => {
    const { gateway, effects } = build(developer);
    await effects.begin('repo.write:task-1:1:src/a.ts', 'repo.write', 'task-1', true);
    effects.setClock(() => new Date(Date.now() + 24 * 60 * 60 * 1000));

    const r = await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'x' }));
    expect(r.allowed).toBe(true);
  });

  it('lets a retry through after the handler returned an error', async () => {
    let calls = 0;
    const { gateway } = build(developer, {
      handlers: [['repo.write', async () => { calls++; if (calls === 1) throw new Error('disk full'); return { ok: true }; }]],
    });
    const first = denial(await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'x' })));
    expect(first?.errorCategory).toBe('transient');
    expect(first?.isRetryable).toBe(true);

    const second = await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'x' }));
    expect(second.allowed).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not deduplicate reads', async () => {
    let reads = 0;
    const { gateway } = build(developer, {
      handlers: [['repo.read', async () => { reads++; return { ok: true }; }]],
    });
    await gateway.call(req('repo.read', { path: 'src/a.ts' }));
    await gateway.call(req('repo.read', { path: 'src/a.ts' }));
    expect(reads).toBe(2);
  });
});

describe('the audit log', () => {
  it('records allowed and denied calls, with the category on denials', async () => {
    const { gateway, audit } = build(developer);
    await gateway.call(req('repo.read', { path: 'src/a.ts' }));
    await gateway.call(req('repo.merge', { changeRequestId: 'c', verdictId: 'v' }));
    expect(audit.entries.map((e) => e.allowed)).toEqual([true, false]);
    expect(audit.entries[1]?.errorCategory).toBe('permission');
  });

  it('hashes arguments rather than storing them', async () => {
    const { gateway, audit } = build(developer);
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'hunter2' }));
    expect(audit.entries[0]?.argsHash).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(audit.entries)).not.toContain('hunter2');
  });

  it('hashes equal arguments equally regardless of key order', async () => {
    const { gateway, audit } = build(developer);
    await gateway.call(req('repo.write', { path: 'a.ts', content: 'x' }));
    await gateway.call(req('repo.write', { content: 'x', path: 'a.ts' }));
    expect(audit.entries[0]?.argsHash).toBe(audit.entries[1]?.argsHash);
  });

  it('records a replayed call as well as the original', async () => {
    const { gateway, audit } = build(merger);
    const args = { changeRequestId: 'cr', verdictId: 'v' };
    await gateway.call(req('repo.merge', args, { roleKind: 'admit' }));
    await gateway.call(req('repo.merge', args, { roleKind: 'admit' }));
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries.every((e) => e.allowed)).toBe(true);
  });
});

describe('credentials', () => {
  const provider: CredentialProvider = {
    async issue(tool) {
      return { token: `short-lived-token-for-${tool}` };
    },
  };

  it('injects per call, and the agent never sees them in the request', async () => {
    const audit = new InMemoryAuditSink();
    let seen: Readonly<Record<string, string>> | undefined;
    const gateway = new McpToolGateway({
      handlers: new Map<ToolName, ToolHandler>([
        ['repo.read', async (inv) => { seen = inv.credentials; return { ok: true }; }],
      ]),
      audit,
      credentials: provider,
      grantsFor: () => resolveGrants(reviewer),
    });
    await gateway.call(req('repo.read', { path: 'a.ts' }, { roleKind: 'verify' }));
    expect(seen).toEqual({ token: 'short-lived-token-for-repo.read' });
  });

  it('redacts a credential that leaks into a handler error', async () => {
    const audit = new InMemoryAuditSink();
    const gateway = new McpToolGateway({
      handlers: new Map<ToolName, ToolHandler>([
        ['repo.read', async (inv) => { throw new Error(`401 using ${inv.credentials.token}`); }],
      ]),
      audit,
      credentials: provider,
      grantsFor: () => resolveGrants(reviewer),
    });
    const r = denial(await gateway.call(req('repo.read', { path: 'a.ts' }, { roleKind: 'verify' })));
    expect(r?.denialReason).toContain('[redacted]');
    expect(r?.denialReason).not.toContain('short-lived-token');
    expect(JSON.stringify(audit.entries)).not.toContain('short-lived-token');
  });
});
