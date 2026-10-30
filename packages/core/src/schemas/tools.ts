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
import { zodToJsonSchema } from 'zod-to-json-schema';
import { digest, stableStringify } from '../hash.js';
import { VerdictInputSchema } from './verdict.js';
import { PlanInputSchema } from './plan.js';
import { RepoPath } from './paths.js';
import type { ToolEffect } from '../vocabulary.js';

/** Context available when deriving an effect key. */
export interface EffectContext {
  readonly taskId: string;
  readonly attempt: number;
}

export interface ToolSpec {
  readonly effect: ToolEffect;
  /**
   * What the tool does, when to use it, and — critically — the constraints the
   * JSON Schema cannot express. `.refine()` rules are runtime-only, so a model
   * sent the schema alone would never learn that ".." is rejected. Tool
   * descriptions are the primary mechanism a model uses to choose between
   * similar tools, so these are written for the model, not for us.
   */
  readonly description: string;
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

/* RepoPath lives in paths.ts, which the plan contract needs too; the barrel
 * re-exports it from there, so it is imported here rather than re-exported. */

const WorkItemKey = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9]*-\d+$/, 'expected a key like ORD-12');
const BranchName = z.string().min(1).max(255).regex(/^[A-Za-z0-9._\-/]+$/);

export const TOOL_CATALOG = {
  'repo.read': {
    effect: 'read',
    description:
      'Read one file from the checked-out repository. Paths are repo-relative ("src/orders/list.ts"), never absolute and never containing ".." — a path that leaves the workspace is rejected. Use this to inspect code; use test.run to find out whether it works.',
    args: z.object({ path: RepoPath }),
  },
  'repo.search': {
    effect: 'read',
    description:
      'Search the repository for a pattern and get back matching lines with their file and line ' +
      'number. Use this FIRST, before reading anything: finding where something lives by opening ' +
      'files one at a time is slow, and every file you open stays in front of you for the rest of ' +
      'the task. One search usually replaces a dozen reads. ' +
      'Good uses: "where is OrderList used", "what imports this hook", "which files mention ' +
      'useAuth", "is there already a date picker". ' +
      'The pattern is a regular expression unless you set literal to true. Narrow it with glob ' +
      'when you know roughly where to look, for example "src/components/*". Only files tracked ' +
      'by git are searched, so dependencies and build output are never in the way.',
    args: z.object({
      pattern: z.string().min(1).max(500),
      glob: z.string().max(300).nullish(),
      literal: z.boolean().nullish(),
    }),
  },
  'repo.write': {
    effect: 'write',
    description:
      'Create or overwrite one file in the checked-out repository, replacing its entire contents. Paths are repo-relative, never absolute, never containing "..", and never inside .git. Writing the same path twice in one attempt is collapsed into a single effect, so re-writing identical content is a no-op rather than an error.',
    args: z.object({ path: RepoPath, content: z.string() }),
    // Attempt is in the key: rework must be able to rewrite the same file.
    effectKey: (a: { path: string }, c) => `repo.write:${c.taskId}:${c.attempt}:${a.path}`,
    reclaimable: true,
  },
  'repo.merge': {
    effect: 'write',
    description:
      'Merge an approved change request. Reserved for the merge queue; no producing or verifying role holds this grant. One verdict merges exactly once however often this is called.',
    args: z.object({ changeRequestId: z.string().min(1), verdictId: z.string().min(1) }),
    // No task, no attempt: one approved verdict merges once, across every retry.
    effectKey: (a: { changeRequestId: string; verdictId: string }) =>
      `repo.merge:${a.changeRequestId}:${a.verdictId}`,
    reclaimable: false,
  },
  'test.run': {
    effect: 'execute',
    description:
      'Run the test suite in the checked-out repository and return the result. Optionally filter to a subset by name. This executes code but changes nothing, so it is safe to call repeatedly; call it before claiming a criterion is met.',
    args: z.object({ filter: z.string().max(256).nullish() }),
  },
  'tracker.read': {
    effect: 'read',
    description:
      'Read one work item by key (for example "ORD-12"), returning its title, state and acceptance criteria. Use this to recover the criteria you are being judged against; use tracker.comment to report progress.',
    args: z.object({ workItemKey: WorkItemKey }),
  },
  'tracker.write': {
    effect: 'write',
    description:
      'Update fields on one work item. Changes what humans see in the tracker, so prefer tracker.comment for progress notes and reserve this for actual state changes.',
    args: z.object({ workItemKey: WorkItemKey, fields: z.record(z.string(), z.unknown()) }),
    effectKey: (a: { workItemKey: string }, c) =>
      `tracker.write:${c.taskId}:${c.attempt}:${a.workItemKey}`,
    reclaimable: false,
  },
  'tracker.comment': {
    effect: 'write',
    description:
      'Post one progress note on a work item, visible to humans. Keep it to what changed and what is left. Posting the identical body twice within an attempt is collapsed into a single comment, so a retry cannot spam the ticket.',
    args: z.object({ workItemKey: WorkItemKey, body: z.string().min(1).max(10_000) }),
    // A requeued task must not re-post the same note.
    effectKey: (a: { workItemKey: string; body: string }, c) =>
      `tracker.comment:${c.taskId}:${c.attempt}:${a.workItemKey}:${digest(a.body)}`,
    reclaimable: false,
  },
  'docs.read': {
    effect: 'read',
    description:
      'Read one documentation or specification file, repo-relative. Use this for the API contract, repo rules and design briefs; use repo.read for source code.',
    args: z.object({ path: RepoPath }),
  },
  'claims.claim': {
    effect: 'write',
    description:
      'Claim a branch and a set of file globs before writing anything, so no two agents edit the same files. Fails if the globs overlap a claim another agent already holds. Claim first, then write.',
    args: z.object({ branch: BranchName, fileGlobs: z.array(z.string().min(1)).min(1) }),
    // No attempt: reclaiming the same branch for the same task is one claim.
    effectKey: (a: { branch: string }, c) => `claims.claim:${c.taskId}:${a.branch}`,
    reclaimable: true,
  },
  'backlog.propose': {
    effect: 'write',
    description:
      'Propose the work items a design or brief should become. This does not create anything: ' +
      'the proposal goes to a reviewer on a different vendor model first, and only a passing ' +
      'verdict puts the stories into the tracker. Each story needs a title and acceptance ' +
      'criteria in Given/When/Then form, each naming a condition, an action and an outcome ' +
      'that a test could check. Record anything the design does not settle as an open question ' +
      'rather than deciding it yourself.',
    args: z.object({
      stories: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            criteria: z.array(z.string().min(1)).min(1),
            notes: z.string().max(2000).optional(),
          }),
        )
        .min(1),
      openQuestions: z.array(z.string().min(1)).default([]),
    }),
    effectKey: (_a: unknown, c) => `backlog.propose:${c.taskId}:${c.attempt}`,
    reclaimable: false,
  },
  'plan.submit': {
    effect: 'write',
    description:
      'Submit your plan for the task and stop. This does not change the repository: a human ' +
      'reads the plan and approves it before any code is written, so this is where you say what ' +
      'you intend to do while it is still cheap to be wrong. State what you understand the task ' +
      'to be in your own words, name the files you expect to touch and why, and give the ' +
      'acceptance criteria the work will be judged against — each one naming a condition, an ' +
      'action and an outcome, in the form "Given \u2026, when \u2026, then \u2026". Record anything the ' +
      'request does not settle as an open question rather than deciding it yourself; a plan with ' +
      'open questions is not a failure, it is the point of planning. Call this once.',
    args: PlanInputSchema,
    effectKey: (_a: unknown, c) => `plan.submit:${c.taskId}:${c.attempt}`,
    reclaimable: false,
  },
  'verdict.submit': {
    effect: 'write',
    description:
      'Submit the verdict for the artifact under review. This is the only way a verifying role can write anything, and the only way to record a judgment. Every acceptance criterion must be addressed; a criterion marked not_met must carry a finding naming the file, the problem and the evidence. The decision is recomputed from the findings, so declaring PASS while reporting a blocker will be overridden.',
    args: VerdictInputSchema,
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

/**
 * Vendors express "this optional was not supplied" as an explicit null, and
 * OpenAI's strict mode positively requires it — a nullable type is how you say
 * optional there at all. A schema that advertises nullable and then rejects
 * null is lying to the model, and it cannot tell the difference between that
 * and a real mistake.
 *
 * So a null is read as absence before validation. Nothing we accept from a
 * model carries a meaningful null, which is what makes this safe to do
 * centrally rather than schema by schema.
 *
 * It applies to structured output as well as tool arguments — the same
 * convention, arriving by a different door. A reviewer's verdict came back
 * with `finding: null` on every criterion and was rejected, which is this
 * exact problem with the fix sitting one module away.
 */
export function nullsAsAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nullsAsAbsent);
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null) continue;
    out[key] = nullsAsAbsent(raw);
  }
  return out;
}

/** Parses and returns the narrowed arguments, or throws with every issue named. */
export function validateToolArgs(tool: ToolName, args: unknown): unknown {
  const parsed = CATALOG[tool].args.safeParse(nullsAsAbsent(args));
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

/* ------------------------------------------------- vendor-facing schemas */

/**
 * The JSON Schema a model is shown for one tool.
 *
 * Note what is lost in translation: zod `.refine()` rules are runtime-only, so
 * the no-".." and no-".git" constraints on repo paths do not survive into JSON
 * Schema. That is deliberate and safe — the gateway enforces them regardless —
 * but it is why every tool carries a description stating them in words. The
 * schema is a hint to the model; the gateway is the enforcement.
 */
/**
 * Any zod schema as JSON Schema, for a CLI's structured-output flag.
 *
 * The same translation `toolJsonSchema` does, without going through the tool
 * catalog: a CLI-driven agent returns its plan or verdict as its final answer
 * rather than by calling a tool, but it is held to the identical shape.
 */
export function asJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return { ...out, additionalProperties: false };
}

export function toolJsonSchema(tool: ToolName): Record<string, unknown> {
  const schema = zodToJsonSchema(CATALOG[tool].args, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // Strict modes across vendors reject unspecified properties, and OpenAI
  // requires this explicitly rather than inferring it.
  return { ...schema, additionalProperties: false };
}

/**
 * Vendors constrain tool names to `^[a-zA-Z0-9_-]+$` — no dots. Our names use a
 * dot as a namespace separator (`repo.read`), which reads better in grants,
 * effect keys and audit rows, so the dot is translated at the vendor boundary
 * rather than given up everywhere else.
 *
 * Found by a smoke test: both Anthropic and OpenAI reject `repo.read` with a
 * 400, and no amount of testing against scripted vendors would have shown it.
 */
export const VENDOR_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function vendorToolName(tool: ToolName): string {
  return tool.replace(/\./g, '_');
}

/** The inverse. Returns undefined for a name no tool maps to. */
export function internalToolName(vendorName: string): ToolName | undefined {
  if (isKnownTool(vendorName)) return vendorName;
  for (const name of Object.keys(CATALOG) as ToolName[]) {
    if (vendorToolName(name) === vendorName) return name;
  }
  return undefined;
}

export interface VendorToolDefinition {
  /** Our name, with the dot. Use this for grants, keys and audit. */
  readonly id: ToolName;
  /** The name the vendor is given, dot-free. */
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** The tool definitions for one role's grants, in a vendor-neutral shape. */
export function toolDefinitions(grants: readonly string[]): VendorToolDefinition[] {
  return grants.filter(isKnownTool).map((id) => ({
    id,
    name: vendorToolName(id),
    description: CATALOG[id].description,
    parameters: toolJsonSchema(id),
  }));
}
