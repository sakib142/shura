/**
 * Tool contracts.
 *
 * A tool is a name, an effect, an argument schema, and — for anything that
 * writes — a rule for deriving its idempotency key. Permissive argument objects
 * invite invented parameters, so every tool states exactly what it takes.
 *
 * Key derivation is per tool on purpose. No single formula works: rework must
 * be free to rewrite a file it already touched, while one approved verdict must
 * merge exactly once no matter how often the queue retries.
 */

import { z } from 'zod';
import { digest, stableStringify } from '../hash.js';
import type { ToolEffect } from '../vocabulary.js';

/** Context available when deriving an effect key. */
export interface EffectContext {
  readonly taskId: string;
  readonly attempt: number;
}

export interface ToolSpec {
  readonly effect: ToolEffect;
  readonly args: z.ZodTypeAny;
  /** Write tools only: how two calls are judged to be the same effect. */
  readonly effectKey?: (args: never, ctx: EffectContext) => string;
  /**
   * Whether a stale in-flight effect may be reclaimed after a crash.
   *
   * True for effects confined to our own workspace, which are safe to redo.
   * False for anything the outside world has already seen — a merge, a ticket
   * comment, a recorded verdict — where redoing it is exactly the harm.
   */
  readonly reclaimable?: boolean;
}

/**
 * Repo paths. Anthropic's SWE-bench write-up found models made mistakes with
 * ambiguous file paths until the rule was made unambiguous; ours is
 * repo-relative with no escape, which doubles as a sandbox control and holds
 * unchanged when the worktree driver becomes a container.
 */
export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'may contain only letters, digits, dot, underscore, hyphen, slash')
  .refine((p) => !p.startsWith('/'), { message: 'must be repo-relative, not absolute' })
  .refine((p) => !p.split('/').includes('..'), { message: 'may not contain a ".." segment' })
  .refine((p) => !p.includes('//'), { message: 'may not contain an empty path segment' })
  .refine((p) => !p.startsWith('.git/'), { message: 'may not touch the git directory' });

const WorkItemKey = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9]*-\d+$/, 'expected a key like ORD-12');
const BranchName = z.string().min(1).max(255).regex(/^[A-Za-z0-9._\-/]+$/);

export const TOOL_CATALOG = {
  'repo.read': {
    effect: 'read',
    args: z.object({ path: RepoPath }),
  },
  'repo.write': {
    effect: 'write',
    args: z.object({ path: RepoPath, content: z.string() }),
    // Attempt is in the key: rework must be able to rewrite the same file.
    effectKey: (a: { path: string }, c) => `repo.write:${c.taskId}:${c.attempt}:${a.path}`,
    reclaimable: true,
  },
  'repo.merge': {
    effect: 'write',
    args: z.object({ changeRequestId: z.string().min(1), verdictId: z.string().min(1) }),
    // No task, no attempt: one approved verdict merges once, across every retry.
    effectKey: (a: { changeRequestId: string; verdictId: string }) =>
      `repo.merge:${a.changeRequestId}:${a.verdictId}`,
    reclaimable: false,
  },
  'test.run': {
    effect: 'execute',
    args: z.object({ filter: z.string().max(256).optional() }),
  },
  'tracker.read': {
    effect: 'read',
    args: z.object({ workItemKey: WorkItemKey }),
  },
  'tracker.write': {
    effect: 'write',
    args: z.object({ workItemKey: WorkItemKey, fields: z.record(z.string(), z.unknown()) }),
    effectKey: (a: { workItemKey: string }, c) =>
      `tracker.write:${c.taskId}:${c.attempt}:${a.workItemKey}`,
    reclaimable: false,
  },
  'tracker.comment': {
    effect: 'write',
    args: z.object({ workItemKey: WorkItemKey, body: z.string().min(1).max(10_000) }),
    // A requeued task must not re-post the same note.
    effectKey: (a: { workItemKey: string; body: string }, c) =>
      `tracker.comment:${c.taskId}:${c.attempt}:${a.workItemKey}:${digest(a.body)}`,
    reclaimable: false,
  },
  'docs.read': {
    effect: 'read',
    args: z.object({ path: RepoPath }),
  },
  'claims.claim': {
    effect: 'write',
    args: z.object({ branch: BranchName, fileGlobs: z.array(z.string().min(1)).min(1) }),
    // No attempt: reclaiming the same branch for the same task is one claim.
    effectKey: (a: { branch: string }, c) => `claims.claim:${c.taskId}:${a.branch}`,
    reclaimable: true,
  },
  'verdict.submit': {
    effect: 'write',
    // Validated in full by acceptVerdict; this is the envelope check.
    args: z.object({ artifactId: z.string().min(1) }).passthrough(),
    effectKey: (a: { artifactId: string }, c) => `verdict.submit:${a.artifactId}:${c.taskId}`,
    reclaimable: false,
  },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_CATALOG;

/** `as const satisfies` keeps each entry narrow, which is what makes a missing
 *  effectKey a compile error above. The accessors read through this widened
 *  view so they can ask about optional fields uniformly. */
const CATALOG: Readonly<Record<ToolName, ToolSpec>> = TOOL_CATALOG;

export function isKnownTool(tool: string): tool is ToolName {
  return Object.hasOwn(TOOL_CATALOG, tool);
}

export function toolSpec(tool: ToolName): ToolSpec {
  return CATALOG[tool];
}

export function toolEffect(tool: ToolName): ToolEffect {
  return CATALOG[tool].effect;
}

export class ToolArgsInvalid extends Error {
  constructor(
    readonly tool: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(`${tool}: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`);
    this.name = 'ToolArgsInvalid';
  }
}

/** Parses and returns the narrowed arguments, or throws with every issue named. */
export function validateToolArgs(tool: ToolName, args: unknown): unknown {
  const parsed = CATALOG[tool].args.safeParse(args);
  if (!parsed.success) {
    throw new ToolArgsInvalid(
      tool,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/** The idempotency key for a write call, or undefined for read/execute tools. */
export function deriveEffectKey(
  tool: ToolName,
  args: unknown,
  ctx: EffectContext,
): string | undefined {
  const spec = CATALOG[tool];
  if (spec.effectKey === undefined) return undefined;
  return (spec.effectKey as (a: unknown, c: EffectContext) => string)(args, ctx);
}

export function isReclaimable(tool: ToolName): boolean {
  return CATALOG[tool].reclaimable === true;
}

/** Every write tool must declare how its effects are deduplicated. */
export function assertCatalogComplete(): void {
  for (const [name, spec] of Object.entries(CATALOG) as [ToolName, ToolSpec][]) {
    if (spec.effect === 'write' && spec.effectKey === undefined) {
      throw new Error(`tool "${name}" writes but declares no effectKey`);
    }
    if (spec.effect !== 'write' && spec.effectKey !== undefined) {
      throw new Error(`tool "${name}" declares an effectKey but does not write`);
    }
  }
}

export { stableStringify };
