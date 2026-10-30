import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // One Postgres, shared by every integration test, and several of them
    // truncate tables to start from a known state. Run the files in parallel
    // and they truncate each other's fixtures mid-test, which shows up as a
    // flake in whichever file happened to lose the race rather than as
    // anything resembling its cause.
    fileParallelism: false,
  },
});
