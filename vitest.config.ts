import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // Generous, because a lot of this suite is real git and real Postgres: two
    // repositories built per test in places, on whatever git the machine has.
    // The default five seconds is comfortable until the suite grows and the
    // machine is busy, at which point the same tests start crossing it — the
    // local VCS merge tests went from ~1s to timing out purely because other
    // files were added. Slow is fine; intermittently red is corrosive, and a
    // suite nobody trusts is one nobody runs.
    testTimeout: 60_000,
    // One Postgres, shared by every integration test, and several of them
    // truncate tables to start from a known state. Run the files in parallel
    // and they truncate each other's fixtures mid-test, which shows up as a
    // flake in whichever file happened to lose the race rather than as
    // anything resembling its cause.
    fileParallelism: false,
  },
});
