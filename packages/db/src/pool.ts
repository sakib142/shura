import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://forge:forge@localhost:5440/forge';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createPool(url: string = databaseUrl()): Pool {
  return new Pool({ connectionString: url, max: 4 });
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
