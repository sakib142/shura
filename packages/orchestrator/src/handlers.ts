/**
 * The tool handlers an agent's calls actually reach, once the gateway has
 * allowed them.
 *
 * Every handler is bound to one worktree and one task, so a handler cannot act
 * outside the sandbox even if it wanted to — there is no path parameter that
 * reaches the real filesystem, because `resolve` refuses anything outside.
 */

import type { Pool } from 'pg';
import { acceptVerdict, type AcceptedVerdict, type ToolName } from '@forge/core';
import type { ToolHandler } from '@forge/tool-gateway';
import type { Worktree } from '@forge/sandbox';

export interface VerifierFacts {
  readonly agent: string;
  readonly vendor: 'anthropic' | 'openai' | 'google' | 'local';
  readonly model: string;
  /** Read at submission time, so the recorded cost is what the run actually spent. */
  readonly spent: () => { tokensIn: number; tokensOut: number; usd: number };
}

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
  onComment?: (body: string) => void;
  verifier?: VerifierFacts;
  claims?: ClaimBroker;
}

export function producerHandlers(ctx: HandlerContext): Map<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ['repo.read', readHandler(ctx)],
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
