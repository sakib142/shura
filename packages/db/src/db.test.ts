import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { parseRole, type ToolName } from '@shura/core';
import type { ToolCallRequest } from '@shura/ports';
import { McpToolGateway, resolveGrants, type ToolHandler } from '@shura/tool-gateway';
import { PgEffectStore } from './effects.js';
import { PgAuditSink, verifyAuditChain } from './audit.js';
import { createPool, isReachable } from './pool.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const describeDb = up ? describe : describe.skip;

if (!up) {
  console.warn('[db] Postgres unreachable — skipping. Run `pnpm db:up && pnpm migrate`.');
}

afterAll(async () => {
  // These tests deliberately tamper with audit rows. Left behind, they would
  // make `shura doctor` report a broken chain on a perfectly healthy install.
  if (up) {
    await pool.query('TRUNCATE tool_calls RESTART IDENTITY');
    await pool.query('TRUNCATE events RESTART IDENTITY');
    await pool.query('TRUNCATE effects');
  }
  await pool.end();
});

const merger = parseRole({
  id: 'merge-queue',
  kind: 'admit',
  tools: ['repo.merge'],
  instructions: 'deterministic',
});

const developer = parseRole({
  id: 'backend-developer',
  kind: 'produce',
  model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
  tools: ['repo.read', 'repo.write', 'tracker.comment'],
  instructions: 'x',
});

function req(tool: string, args: unknown, over: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    taskId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    roleKind: 'produce',
    grants: [],
    tool,
    args,
    attempt: 1,
    ...over,
  };
}

describeDb('PgEffectStore', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE effects');
  });

  it('claims a fresh key once and reports the second caller as in flight', async () => {
    const store = new PgEffectStore(pool);
    expect(await store.begin('k1', 'repo.merge', 't', false)).toEqual({ state: 'claimed' });
    const second = await store.begin('k1', 'repo.merge', 't', false);
    expect(second.state).toBe('in_flight');
  });

  it('replays a completed effect without the caller touching the handler', async () => {
    const store = new PgEffectStore(pool);
    await store.begin('k2', 'repo.merge', 't', false);
    await store.complete('k2', { commit: 'sha-1' });
    expect(await store.begin('k2', 'repo.merge', 't', false)).toEqual({
      state: 'completed',
      result: { commit: 'sha-1' },
    });
  });

  it('lets a failed effect be retried', async () => {
    const store = new PgEffectStore(pool);
    await store.begin('k3', 'repo.write', 't', true);
    await store.fail('k3', 'disk full');
    expect(await store.begin('k3', 'repo.write', 't', true)).toEqual({ state: 'claimed' });
  });

  // The distinction that stops a merge happening twice.
  it('never reclaims an externally visible effect, however stale', async () => {
    const store = new PgEffectStore(pool, '0 seconds');
    await store.begin('k4', 'repo.merge', 't', false);
    await pool.query(`UPDATE effects SET claimed_at = now() - interval '1 day' WHERE key = 'k4'`);
    expect((await store.begin('k4', 'repo.merge', 't', false)).state).toBe('in_flight');
  });

  it('reclaims a stale workspace-only effect once the lease lapses', async () => {
    const store = new PgEffectStore(pool, '15 minutes');
    await store.begin('k5', 'repo.write', 't', true);
    await pool.query(`UPDATE effects SET claimed_at = now() - interval '1 day' WHERE key = 'k5'`);
    expect(await store.begin('k5', 'repo.write', 't', true)).toEqual({ state: 'claimed' });
  });

  it('holds a workspace-only effect while its lease is live', async () => {
    const store = new PgEffectStore(pool, '15 minutes');
    await store.begin('k6', 'repo.write', 't', true);
    expect((await store.begin('k6', 'repo.write', 't', true)).state).toBe('in_flight');
  });
});

describeDb('the gateway against a real database', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE effects');
    await pool.query('TRUNCATE tool_calls RESTART IDENTITY');
  });

  function build(role: typeof merger) {
    let merges = 0;
    const handlers = new Map<ToolName, ToolHandler>([
      ['repo.merge', async () => ({ commit: `sha-${++merges}` })],
      ['repo.write', async () => ({ ok: true })],
      ['repo.read', async () => ({ ok: true })],
    ]);
    const gateway = new McpToolGateway({
      handlers,
      audit: new PgAuditSink(pool),
      effects: new PgEffectStore(pool),
      grantsFor: () => resolveGrants(role),
    });
    return { gateway, merges: () => merges };
  }

  it('merges once for one verdict, across attempts, and replays the result', async () => {
    const { gateway, merges } = build(merger);
    const args = { changeRequestId: 'cr-41', verdictId: 'v-9' };
    const a = await gateway.call(req('repo.merge', args, { roleKind: 'admit', attempt: 1 }));
    const b = await gateway.call(req('repo.merge', args, { roleKind: 'admit', attempt: 5 }));

    expect(merges()).toBe(1);
    expect(a).toMatchObject({ allowed: true, output: { commit: 'sha-1' } });
    expect(b).toMatchObject({ allowed: true, replayed: true, output: { commit: 'sha-1' } });
  });

  it('writes every call to tool_calls, denials included', async () => {
    const { gateway } = build(developer);
    await gateway.call(req('repo.write', { path: 'src/a.ts', content: 'x' }));
    await gateway.call(req('repo.write', { path: '../../etc/passwd', content: 'x' }));

    const { rows } = await pool.query<{ allowed: boolean; denial_reason: string | null }>(
      'SELECT allowed, denial_reason FROM tool_calls ORDER BY id',
    );
    expect(rows.map((r) => r.allowed)).toEqual([true, false]);
    expect(rows[1]?.denial_reason).toMatch(/\.\." segment/);
  });
});

describeDb('the audit chain', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE tool_calls RESTART IDENTITY');
    await pool.query('TRUNCATE events RESTART IDENTITY');
  });

  it('reports an intact log as intact', async () => {
    const sink = new PgAuditSink(pool);
    for (const tool of ['repo.read', 'repo.write', 'repo.merge']) {
      await sink.record({
        taskId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        tool,
        argsHash: 'sha256:abc',
        allowed: true,
        at: new Date(),
      });
    }
    expect(await verifyAuditChain(pool)).toEqual([]);
  });

  // The application role cannot rewrite these. This catches whoever can.
  it('detects a row edited directly in the database', async () => {
    const sink = new PgAuditSink(pool);
    for (const tool of ['repo.read', 'repo.write']) {
      await sink.record({
        taskId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        tool,
        argsHash: 'sha256:abc',
        allowed: false,
        denialReason: 'denied',
        at: new Date(),
      });
    }
    await pool.query(`UPDATE tool_calls SET allowed = true, denial_reason = NULL WHERE id = 2`);

    const breaks = await verifyAuditChain(pool, ['tool_calls']);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ table: 'tool_calls', id: '2' });
    expect(breaks[0]?.reason).toMatch(/do not match the recorded hash/);
  });

  it('detects a deleted row', async () => {
    const sink = new PgAuditSink(pool);
    for (const tool of ['repo.read', 'repo.write', 'repo.merge']) {
      await sink.record({
        taskId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        tool,
        argsHash: 'sha256:abc',
        allowed: true,
        at: new Date(),
      });
    }
    await pool.query('DELETE FROM tool_calls WHERE id = 2');
    const breaks = await verifyAuditChain(pool, ['tool_calls']);
    expect(breaks[0]?.reason).toMatch(/prev_hash does not match/);
  });
});
