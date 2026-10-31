/**
 * Getting a worktree ready before an agent is handed it.
 *
 * Every worktree is created from a bare ref, so it has no installed
 * dependencies. That cost shows up twice, and both were measured:
 *
 * The builder paid to install on every pass — part of why a pass ran for
 * minutes before writing anything.
 *
 * The reviewer could not install **at all**. It runs read-only by rule 2, so on
 * 30 October it reported "This review checkout also lacks node_modules/.bin/tsc
 * and node_modules/.bin/eslint" and marked a criterion unmet for want of the
 * tools to judge it. That single finding was not actionable by any producer, so
 * it bought a builder pass that read the code, concluded there was nothing to
 * write, and stopped. The same thing happened again on forge-sandbox, where a
 * fix task spent about forty seconds trying `npm install --offline`, then
 * `--no-package-lock`, then `--fetch-retries=0` before giving up.
 *
 * So deterministic code installs first, using the command the survey
 * discovered, and the agent is handed a worktree it can actually work in.
 *
 * ## Why there is no shared dependency store
 *
 * The plan called for installing "into a store shared across worktrees". There
 * isn't one, deliberately. Sharing a `node_modules` across worktrees means
 * knowing it is called `node_modules` — and symlinking it means knowing about
 * lifecycle scripts and platform-specific binaries. That is npm knowledge, in
 * the platform, which is the one thing this design does not allow.
 *
 * Every package manager already has a shared store: npm has ~/.npm, NuGet has
 * ~/.nuget/packages, cargo has ~/.cargo/registry. Running the project's own
 * install command uses whichever one the project has, and the second install is
 * fast because the manager made it fast. The platform stays ignorant.
 *
 * ## On running a command a model wrote
 *
 * The install command comes from the planner's survey, and a human reads and
 * approves that survey before any build runs — `shura plans` prints it, and
 * `approve` is where it becomes the contract. So this executes a human-approved
 * command, not an arbitrary one. It also runs inside the worktree, under the
 * same push guard as everything else.
 */

import type { Baseline } from '@shura/core';
import { Worktree } from '@shura/sandbox';

export interface Prepared {
  /** False only when an install was attempted and failed. */
  readonly ok: boolean;
  /** One line for the operator, or undefined when there was nothing to do. */
  readonly summary?: string;
  readonly output?: string;
}

/**
 * Installs dependencies into a worktree, if the repository has any.
 *
 * Never throws and never fails a run. A failed install is reported and the
 * agent still gets the worktree: a builder can try for itself, and a reviewer
 * that cannot run the tools will say so in its findings, which is the outcome
 * this exists to make rarer rather than impossible.
 */
export async function installDependencies(
  wt: Worktree,
  install: string | undefined,
  timeoutMs = 600_000,
): Promise<Prepared> {
  if (install === undefined || install.trim() === '') return { ok: true };

  const started = Date.now();
  const r = await wt.exec('sh', ['-c', install], timeoutMs);
  const seconds = Math.round((Date.now() - started) / 1000);

  if (r.code === 0) {
    return { ok: true, summary: `dependencies installed in ${seconds}s` };
  }
  return {
    ok: false,
    summary:
      `could not install dependencies (exit ${r.code} after ${seconds}s) — the agent gets the ` +
      'worktree anyway, and a reviewer that cannot run the tools will say so',
    output: `${r.stdout}\n${r.stderr}`.trim(),
  };
}

/**
 * What the gate says about the base, before anything has changed.
 *
 * Deterministic: a worktree on the base commit, the surveyed install, the gate,
 * and whatever it says. No model is involved and nothing is judged here — this
 * only measures, so that two questions become answerable later.
 *
 * A builder handed a failing check deserves to know whether it caused it. And
 * "no new errors" stops being something an agent has to prove: the harness has
 * the before, so it can subtract.
 *
 * Returns undefined when there is no gate to run, which is a legitimate state
 * for a repository with nothing runnable rather than a failure to measure.
 */
export async function measureBaseline(o: {
  readonly repoDir: string;
  readonly base: string;
  readonly taskId: string;
  readonly install?: string;
  readonly gate: readonly string[];
  readonly timeoutMs?: number;
}): Promise<Baseline | undefined> {
  const [command, ...args] = o.gate;
  if (command === undefined) return undefined;

  const wt = await Worktree.create({
    repoDir: o.repoDir,
    branch: o.base,
    taskId: o.taskId,
    claimedBranches: [],
    // Detached and unclaimed: this measures the base and must not hold it, or
    // the builder's own branch cannot be created from it.
    detached: true,
  });

  try {
    await installDependencies(wt, o.install, o.timeoutMs);
    const sha = await wt.git.tryRun('rev-parse', 'HEAD');
    const r = await wt.exec(command, args, o.timeoutMs ?? 900_000);
    return {
      command: [...o.gate],
      code: r.code,
      output: `${r.stdout}\n${r.stderr}`.trim(),
      at: new Date().toISOString(),
      sha: sha.ok ? sha.stdout.trim() : 'unknown',
    };
  } finally {
    await wt.destroy();
  }
}

/**
 * Whether a failing gate is this change's fault.
 *
 * A builder was once sent back to fix a check it had not broken. Without a
 * before-state there is no way to tell the difference, so every red gate looked
 * like the producer's doing.
 */
export function wasAlreadyFailing(baseline: Baseline | undefined): boolean {
  return baseline !== undefined && baseline.code !== 0;
}
