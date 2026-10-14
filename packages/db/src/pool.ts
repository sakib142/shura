import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://shura:shura@localhost:5440/shura';

/**
 * The test database is a different database, not a different table prefix.
 *
 * Tests truncate; real runs leave an audit trail that is supposed to be
 * permanent. Sharing one database means `pnpm test` quietly destroys the record
 * of work that actually happened — which it did, once, before this existed.
 */
export const TEST_DATABASE_URL = 'postgres://shura:shura@localhost:5440/shura_test';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/** True when running under a test runner. */
export function isTestRun(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL;
}

export function createPool(url?: string): Pool {
  // Under a test runner this defaults to the test database, so a suite that
  // truncates cannot reach real data even if someone forgets.
  const connectionString = url ?? (isTestRun() ? testDatabaseUrl() : databaseUrl());
  return new Pool({ connectionString, max: 4 });
}

/** True when Postgres is reachable. Lets database tests skip rather than fail
 *  when someone runs the suite without Docker up. */
export async function isReachable(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
