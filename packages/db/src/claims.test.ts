import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgClaims } from './claims.js';
import { createPool, isReachable } from './pool.js';

const pool: Pool = createPool();
const up = await isReachable(pool);
const d = up ? describe : describe.skip;
if (!up) console.warn('[claims] Postgres unreachable — skipping.');

afterAll(async () => {
  if (up) await pool.query('TRUNCATE claims');
  await pool.end();
});

const claims = new PgClaims(pool);
const req = (over: Partial<Parameters<PgClaims['acquire']>[0]> = {}) => ({
  agentId: 'dev-01',
  taskId: 'task-1',
  branch: 'feature/ORD-12',
  fileGlobs: ['src/orders/**'],
  ...over,
});

d('claiming', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE claims');
  });

  it('grants a claim when nothing is held', async () => {
    const r = await claims.acquire(req());
    expect(r.granted).toBe(true);
  });

  // The collision the stub allowed: two agents editing the same files.
  it('refuses overlapping globs, and says who holds them', async () => {
    await claims.acquire(req());
    const r = await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', branch: 'feature/ORD-13',
            fileGlobs: ['src/orders/list.ts'] }),
    );
    expect(r.granted).toBe(false);
    if (r.granted) return;
    expect(r.heldBy).toBe('dev-01');
    expect(r.conflicts[0]).toEqual({ wanted: 'src/orders/list.ts', held: 'src/orders/**' });
  });

  it('allows two agents on genuinely separate paths', async () => {
    await claims.acquire(req());
    const r = await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', branch: 'feature/USR-1',
            fileGlobs: ['src/users/**'] }),
    );
    expect(r.granted).toBe(true);
  });

  it('refuses a second agent on the same branch, whatever the globs', async () => {
    await claims.acquire(req());
    const r = await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', fileGlobs: ['docs/**'] }),
    );
    expect(r.granted).toBe(false);
    if (!r.granted) expect(r.reason).toMatch(/already claimed/);
  });

  it('lets the same task widen its own claim', async () => {
    await claims.acquire(req());
    const r = await claims.acquire(req({ fileGlobs: ['test/orders/**'] }));
    expect(r.granted).toBe(true);
    const live = await claims.liveClaims();
    expect(live[0]?.globs.sort()).toEqual(['src/orders/**', 'test/orders/**']);
  });

  it('does not let one task widen into another task files', async () => {
    await claims.acquire(req());
    await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', branch: 'feature/USR-1', fileGlobs: ['src/users/**'] }),
    );
    const r = await claims.acquire(req({ fileGlobs: ['src/users/profile.ts'] }));
    expect(r.granted).toBe(false);
  });
});

d('expiry', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE claims');
  });

  // An agent that dies must not block the work forever.
  it('lets a lapsed claim be taken over', async () => {
    const first = await claims.acquire(req({ ttlSeconds: 1 }));
    expect(first.granted).toBe(true);
    await pool.query(`UPDATE claims SET expires_at = now() - interval '1 minute'`);

    const r = await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', branch: 'feature/ORD-13' }),
    );
    expect(r.granted).toBe(true);
  });

  // An agent still working must not have its claim taken from under it.
  it('holds a claim whose heartbeat is current', async () => {
    const first = await claims.acquire(req());
    expect(first.granted).toBe(true);
    if (!first.granted) return;

    await pool.query(`UPDATE claims SET expires_at = now() - interval '1 minute'`);
    expect(await claims.heartbeat(first.claimId)).toBe(true);

    const r = await claims.acquire(
      req({ agentId: 'dev-02', taskId: 'task-2', branch: 'feature/ORD-13' }),
    );
    expect(r.granted).toBe(false);
  });

  it('reports a heartbeat on a released claim as failed', async () => {
    const first = await claims.acquire(req());
    if (!first.granted) throw new Error('expected a claim');
    await claims.release(first.claimId);
    expect(await claims.heartbeat(first.claimId)).toBe(false);
  });

  it('frees the branch once released', async () => {
    const first = await claims.acquire(req());
    if (!first.granted) throw new Error('expected a claim');
    await claims.release(first.claimId);
    const r = await claims.acquire(req({ agentId: 'dev-02', taskId: 'task-2' }));
    expect(r.granted).toBe(true);
  });
});

d('two agents asking at the same moment', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE claims');
  });

  // A check followed by an unguarded insert is exactly how both get told yes.
  it('grants exactly one of two simultaneous requests', async () => {
    const results = await Promise.allSettled([
      claims.acquire(req({ agentId: 'a', taskId: 't-a', branch: 'f/a' })),
      claims.acquire(req({ agentId: 'b', taskId: 't-b', branch: 'f/b' })),
    ]);
    const granted = results.filter(
      (r) => r.status === 'fulfilled' && r.value.granted,
    ).length;
    // Both want src/orders/**; at most one may have it. A serialization
    // failure counts as "not granted", which is the safe outcome.
    expect(granted).toBe(1);
  });
});
