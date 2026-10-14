/**
 * The contract every runtime adapter must satisfy, the `fake` included.
 *
 * It is written once and run against each adapter, so "swap the vendor" means
 * running this suite rather than reading the new adapter hopefully. An adapter
 * that passes here is substitutable; one that does not is not, whatever its
 * README says.
 */

import { describe, expect, it } from 'vitest';
import { VENDORS, isKnownTool } from '@shura/core';
import type { AgentEvent, AgentRuntime, RunRequest, RunLimits, ToolInvoker } from '@shura/ports';
import type { RoleDefinition } from '@shura/core';

export const CONTRACT_ROLE: RoleDefinition = {
  id: 'contract-subject',
  kind: 'produce',
  model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
  tools: ['repo.read', 'repo.write', 'test.run'],
  limits: { max_minutes: 5, max_tokens: 200_000, max_usd: 1 },
  instructions: 'contract fixture',
  output: {},
  never: [],
};

export function contractRequest(over: Partial<RunRequest> = {}): RunRequest {
  const limits: RunLimits = { maxMinutes: 5, maxTokens: 200_000, maxUsd: 1 };
  return {
    role: CONTRACT_ROLE,
    context: {
      workItemKey: 'ORD-12',
      artifactType: 'code_change',
      acceptanceCriteria: ['Given an account, when I open orders, then I see my orders'],
      attempt: 1,
    },
    tools: ['repo.read', 'repo.write', 'test.run'],
    limits,
    signal: new AbortController().signal,
    invoke: allowAll,
    ...over,
  };
}

/** A permissive invoker for contract fixtures. Real runs go through the gateway. */
export const allowAll: ToolInvoker = async () => ({ allowed: true, output: { ok: true } });

export async function drain(runtime: AgentRuntime, req: RunRequest): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of runtime.run(req)) out.push(e);
  return out;
}

export interface ContractSubject {
  readonly name: string;
  /** A runtime that completes a normal produce run. */
  make(): AgentRuntime;
  /** A runtime whose run takes long enough to be aborted partway. */
  makeSlow?(): AgentRuntime;
}

export function runtimeContract(subject: ContractSubject): void {
  describe(`AgentRuntime contract: ${subject.name}`, () => {
    it('declares a vendor from the closed set', () => {
      expect(VENDORS).toContain(subject.make().vendor);
    });

    it('settles exactly once, on the final event', async () => {
      const events = await drain(subject.make(), contractRequest());
      const settling = events.filter((e) => e.t === 'result' || e.t === 'error');
      expect(settling).toHaveLength(1);
      expect(events.at(-1)).toBe(settling[0]);
    });

    it('accounts for what it spent', async () => {
      const usage = (await drain(subject.make(), contractRequest())).filter((e) => e.t === 'usage');
      expect(usage.length).toBeGreaterThan(0);
      for (const u of usage) {
        if (u.t !== 'usage') continue;
        expect(u.tokensIn).toBeGreaterThanOrEqual(0);
        expect(u.tokensOut).toBeGreaterThanOrEqual(0);
        expect(u.usd).toBeGreaterThanOrEqual(0);
      }
    });

    it('only ever names tools the platform knows', async () => {
      for (const e of await drain(subject.make(), contractRequest())) {
        if (e.t === 'tool_call') expect(isKnownTool(e.tool)).toBe(true);
      }
    });

    it('stops on the token ceiling instead of running past it', async () => {
      const events = await drain(
        subject.make(),
        contractRequest({ limits: { maxMinutes: 5, maxTokens: 10, maxUsd: 1 } }),
      );
      expect(events.at(-1)).toMatchObject({ t: 'error' });
      expect((events.at(-1) as { message: string }).message).toMatch(/budget/i);
    });

    const makeSlow = subject.makeSlow;
    if (makeSlow !== undefined) {
      it('stops when aborted, and says so', async () => {
        const ac = new AbortController();
        const runtime = makeSlow();
        const events: AgentEvent[] = [];
        for await (const e of runtime.run(contractRequest({ signal: ac.signal }))) {
          events.push(e);
          if (events.length === 2) ac.abort('human requested a stop');
        }
        const last = events.at(-1);
        expect(last).toMatchObject({ t: 'error' });
        expect((last as { message: string }).message).toMatch(/aborted/);
      });
    }
  });
}
