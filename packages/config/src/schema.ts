/**
 * shura.config.yaml — everything the loop used to hardcode.
 *
 * Two principles, both of which matter more for an open-source project than
 * for one team's internal tool:
 *
 *   - Defaults do the work. A file naming only a repo and two models must run.
 *     Every other field has a sensible default, so a newcomer's first config is
 *     six lines rather than sixty.
 *   - Secrets never appear here. The file is meant to be committed, and a
 *     schema that merely *advises* against pasting a token is a schema that
 *     will eventually have a token pasted into it. Credentials are named, not
 *     carried, and `assertNoSecrets` refuses a file that carries one.
 */

import { z } from 'zod';
import { VENDORS } from '@shura/core';

const Command = z.array(z.string().min(1)).min(1);

/** Where code lives. `local` needs no credentials at all. */
export const RepoConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    /** Seeded into a bare repo on first run. */
    path: z.string().min(1),
    base: z.string().min(1).default('main'),
    checks: Command.default(['npm', 'test']),
  }),
  z.object({
    type: z.literal('github'),
    owner: z.string().min(1),
    name: z.string().min(1),
    base: z.string().min(1).default('main'),
    checks: Command.default(['npm', 'test']),
    /** Env var holding the token. The token itself never appears here. */
    tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
  }),
]);
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const TrackerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local') }),
  z.object({
    type: z.literal('jira'),
    site: z.string().min(1).describe('https://your-org.atlassian.net'),
    project: z.string().min(1),
    emailEnv: z.string().min(1).default('JIRA_EMAIL'),
    tokenEnv: z.string().min(1).default('JIRA_API_TOKEN'),
    /** Map our states onto whatever this Jira calls them. */
    statusMap: z.record(z.string(), z.string()).default({}),
  }),
]);
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

export const DesignConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('figma'),
    fileKey: z.string().min(1),
    tokenEnv: z.string().min(1).default('FIGMA_TOKEN'),
  }),
]);

export const AgentConfigSchema = z.object({
  runtime: z.enum(VENDORS),
  model: z.string().min(1),
  /** "vendor/model". Must not resolve to the producer's vendor. */
  fallback: z.string().min(1).optional(),
  /** How many of this role may run at once. */
  parallel: z.number().int().positive().default(1),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const BudgetsSchema = z.object({
  per_task_usd: z.number().positive().default(5),
  per_task_tokens: z.number().int().positive().default(2_000_000),
  per_task_minutes: z.number().positive().default(30),
  /** Rework attempts before a human is asked. */
  loop_cap: z.number().int().positive().default(3),
});

export const ForgeConfigSchema = z.object({
  project: z.string().min(1),
  repo: RepoConfigSchema,
  tracker: TrackerConfigSchema.default({ type: 'local' }),
  design: DesignConfigSchema.default({ type: 'none' }),
  /** Role id -> which model runs it. Overrides the shipped role defaults. */
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  budgets: BudgetsSchema.default({}),
  database: z
    .object({ urlEnv: z.string().min(1).default('DATABASE_URL') })
    .default({ urlEnv: 'DATABASE_URL' }),
});
export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;
