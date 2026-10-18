/**
 * The tool handlers an agent's calls actually reach, once the gateway has
 * allowed them.
 *
 * Every handler is bound to one worktree and one task, so a handler cannot act
 * outside the sandbox even if it wanted to — there is no path parameter that
 * reaches the real filesystem, because `resolve` refuses anything outside.
 */

import type { Pool } from 'pg';
import {
  acceptPlan,
  acceptVerdict,
  type AcceptedVerdict,
  type PlanSubmission,
  type ToolName,
} from '@shura/core';
import type { ToolHandler } from '@shura/tool-gateway';
import type { Worktree } from '@shura/sandbox';

export interface VerifierFacts {
  readonly agent: string;
  readonly vendor: 'anthropic' | 'openai' | 'google' | 'local';
  readonly model: string;
  /** Read at submission time, so the recorded cost is what the run actually spent. */
  readonly spent: () => { tokensIn: number; tokensOut: number; usd: number };
}

/**
 * Who ran, and what it spent.
 *
 * The same shape serves a verifier submitting a verdict and a planner
 * submitting a plan, for the same reason in both cases: the platform knows
 * which agent ran and what it cost, and asking a model to report its own
 * identity invites it to be wrong about it.
 */
export type AuthorFacts = VerifierFacts;

/** How a producer takes file ownership. Absent means claiming is unavailable,
 *  which is reported rather than silently succeeding. */
export interface ClaimBroker {
  claim(branch: string, fileGlobs: readonly string[]): Promise<
    { ok: true; expiresAt: Date } | { ok: false; reason: string }
  >;
}

export interface HandlerContext {
  readonly worktree: Worktree;
  readonly pool: Pool;
  readonly workItemId: string;
  readonly workItemKey: string;
  readonly checkCommand: readonly string[];
  readonly criterionCount: number;
  /** Filled in when a verifier submits. */
  onVerdict?: (v: AcceptedVerdict) => void;
  /** Filled in when a planner submits. */
  onPlan?: (p: PlanSubmission) => void;
  onComment?: (body: string) => void;
  verifier?: VerifierFacts;
  /** Who is planning. Same shape as `verifier`, different task. */
  author?: AuthorFacts;
  claims?: ClaimBroker;
}

export function producerHandlers(ctx: HandlerContext): Map<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ['repo.read', readHandler(ctx)],
    ['repo.search', searchHandler(ctx)],
    [
      'repo.write',
      async ({ args }) => {
        const { path, content } = args as { path: string; content: string };
        await ctx.worktree.write(path, content);
        return { written: path, bytes: content.length };
      },
    ],
    ['test.run', testHandler(ctx)],
    [
      'tracker.comment',
      async ({ args }) => {
        const { body } = args as { body: string };
        ctx.onComment?.(body);
        await ctx.pool.query(
          `INSERT INTO events (work_item_id, type, payload) VALUES ($1, 'tracker.comment', $2::jsonb)`,
          [ctx.workItemId, JSON.stringify({ body })],
        );
        return { posted: true };
      },
    ],
    [
      'claims.claim',
      async ({ args }) => {
        const { branch, fileGlobs } = args as { branch: string; fileGlobs: string[] };
        if (ctx.claims === undefined) {
          // Never report a claim that was not taken. An agent told it owns
          // files it does not own will edit them.
          throw new Error('claiming is not available in this run');
        }
        const result = await ctx.claims.claim(branch, fileGlobs);
        if (!result.ok) throw new Error(result.reason);
        return { claimed: fileGlobs, branch, expiresAt: result.expiresAt.toISOString() };
      },
    ],
  ]);
}

export function verifierHandlers(ctx: HandlerContext): Map<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ['repo.read', readHandler(ctx)],
    ['repo.search', searchHandler(ctx)],
    ['test.run', testHandler(ctx)],
    [
      'verdict.submit',
      async ({ args }) => {
        // Identity and cost are attached here, not asked of the model: the
        // platform knows which agent ran and what it spent.
        const facts = ctx.verifier;
        const spent = facts?.spent() ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
        const submission = {
          ...(args as Record<string, unknown>),
          verifier: {
            agent: facts?.agent ?? 'unknown',
            vendor: facts?.vendor ?? 'local',
            model: facts?.model ?? 'unknown',
          },
          cost: spent,
        };
        // The single door a verdict enters through: schema, full criterion
        // coverage, then the decision recomputed from the findings.
        const accepted = acceptVerdict(submission, ctx.criterionCount);
        ctx.onVerdict?.(accepted);
        return {
          recorded: true,
          decision: accepted.decision,
          ...(accepted.overridden ? { overridden: accepted.reason } : {}),
        };
      },
    ],
  ]);
}

/**
 * A planner reads and runs the checks, and writes one thing: the plan.
 *
 * Note what is absent: repo.write. The planner cannot start building while it
 * is supposed to be deciding what to build, and that is a grant, not an
 * instruction — an agent that can write will write.
 */
export function plannerHandlers(ctx: HandlerContext): Map<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ['repo.read', readHandler(ctx)],
    ['repo.search', searchHandler(ctx)],
    ['test.run', testHandler(ctx)],
    [
      'plan.submit',
      async ({ args }) => {
        const facts = ctx.author;
        const spent = facts?.spent() ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
        const plan = acceptPlan({
          ...(args as Record<string, unknown>),
          author: {
            agent: facts?.agent ?? 'unknown',
            vendor: facts?.vendor ?? 'local',
            model: facts?.model ?? 'unknown',
          },
          cost: spent,
        });
        ctx.onPlan?.(plan);
        return {
          recorded: true,
          criteria: plan.criteria.length,
          openQuestions: plan.openQuestions.length,
          // Said back to the model so it stops rather than continuing to
          // explore: the next thing that happens is a human reading this.
          next:
            plan.openQuestions.length > 0
              ? 'Your plan is recorded and waiting for a human, who must answer your open ' +
                'questions before anything is built. You are done; stop here.'
              : 'Your plan is recorded and waiting for a human to approve it. You are done; stop here.',
        };
      },
    ],
  ]);
}

/**
 * A reviewer that has chosen to fix what it found.
 *
 * This is a produce-kind task under the reviewer's identity, which is why it
 * holds repo.write and why it does NOT hold verdict.submit: the judgment was
 * recorded by the verify task that came before, and a task that writes the
 * code does not also get to record the verdict on it.
 */
export function fixerHandlers(ctx: HandlerContext): Map<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ['repo.read', readHandler(ctx)],
    ['repo.search', searchHandler(ctx)],
    [
      'repo.write',
      async ({ args }) => {
        const { path, content } = args as { path: string; content: string };
        await ctx.worktree.write(path, content);
        return { written: path, bytes: content.length };
      },
    ],
    ['test.run', testHandler(ctx)],
  ]);
}

/**
 * Searching, which is the cheapest tool in the catalog by a wide margin.
 *
 * Without it an agent discovers a codebase by opening files one at a time, and
 * every file it opens stays in the transcript for the rest of the task. A real
 * run read 57 files into a 168k-token context before it ran out of money,
 * having written almost nothing. Most of those reads were answering "where
 * does this live", which is one search.
 *
 * `git grep` rather than a filesystem walk: it searches only tracked files, so
 * node_modules, build output and anything gitignored are excluded for free,
 * and it skips binaries rather than dumping them into the context.
 */
function searchHandler(ctx: HandlerContext): ToolHandler {
  const LIMIT = 60;
  return async ({ args }) => {
    const { pattern, glob, literal } = args as {
      pattern: string;
      glob?: string;
      literal?: boolean;
    };

    const argv = [
      'grep',
      '--no-color',
      '-n', // line numbers
      '-I', // never match inside binary files
      literal === true ? '-F' : '-E',
      `--max-count=${LIMIT}`,
      '-e',
      pattern,
    ];
    if (glob !== undefined && glob !== '') argv.push('--', glob);

    const result = await ctx.worktree.git.tryRun(...argv);

    // git grep exits 1 for "no matches", which is an answer rather than a
    // failure. Anything else with no output is a real problem worth saying.
    if (!result.ok && result.stdout.trim() === '') {
      const stderr = result.stderr.trim();
      if (stderr !== '' && !/^fatal: /.test(stderr) === false) {
        return { pattern, matches: [], error: stderr.split('\n')[0] };
      }
      return { pattern, matches: [], note: 'nothing matched' };
    }

    const lines = result.stdout.split('\n').filter((l) => l !== '');
    const matches = lines.slice(0, LIMIT).map((line) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      return m === null
        ? { text: line.slice(0, 300) }
        : { path: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 300) };
    });

    return {
      pattern,
      matches,
      files: [...new Set(matches.map((m) => ('path' in m ? m.path : undefined)).filter(Boolean))],
      // Said rather than silently dropped: an agent that thinks it saw
      // everything will conclude something does not exist.
      ...(lines.length > LIMIT
        ? { truncated: `showing ${LIMIT} of ${lines.length}+ matches; narrow the pattern or set glob` }
        : {}),
    };
  };
}

function readHandler(ctx: HandlerContext): ToolHandler {
  return async ({ args }) => {
    const { path } = args as { path: string };
    try {
      return { path, content: await ctx.worktree.read(path) };
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Return these as results, not failures: a model exploring an unfamiliar
      // tree learns from them and moves on, where a thrown error reads as a
      // denial and invites it to try the same thing again.
      if (code === 'ENOENT') return { path, error: 'no such file' };
      if (code === 'EISDIR') {
        return { path, error: 'this is a directory; read a single file instead', entries: await listDir(ctx, path) };
      }
      throw err;
    }
  };
}

async function listDir(ctx: HandlerContext, path: string): Promise<string[]> {
  const result = await ctx.worktree.exec('ls', ['-1', ctx.worktree.resolve(path)]);
  return result.stdout.split('\n').filter((l) => l !== '').slice(0, 50);
}

function testHandler(ctx: HandlerContext): ToolHandler {
  return async () => {
    const [command, ...rest] = ctx.checkCommand;
    if (command === undefined) return { ran: false, reason: 'no check command configured' };
    const result = await ctx.worktree.exec(command, rest);
    return {
      passed: result.code === 0,
      exitCode: result.code,
      // Tail only: a full suite log crowds out the diff the model needs to see.
      output: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-40).join('\n'),
    };
  };
}
