import { createPool, databaseUrl, isReachable } from '@forge/db';
import { startWatchServer } from '@forge/api';

export async function watch(args: string[]): Promise<number> {
  const portArg = args.find((a) => a.startsWith('--port='))?.split('=')[1];
  const port = Number(portArg ?? 7777);

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error(`postgres unreachable at ${databaseUrl()} — run: pnpm db:up && pnpm migrate`);
    await pool.end();
    return 1;
  }

  startWatchServer({ pool, port });
  console.log(`watching on http://localhost:${port}`);
  console.log('Start a run in another terminal:  pnpm forge run <ITEM>');
  console.log('Ctrl-C to stop.');

  // Held open deliberately: this process exists to serve the page.
  await new Promise(() => {});
  return 0;
}
