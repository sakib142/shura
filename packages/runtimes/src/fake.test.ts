import { describe, expect, it } from 'vitest';
import { assertDistinctVendor, InvariantViolation } from '@shura/core';
import { contractRequest, drain, runtimeContract } from './contract.js';
import { FakeRuntime, overreachingVerifierScript, producerScript, verifierScript } from './fake.js';

runtimeContract({
  name: 'fake',
  make: () =>
    new FakeRuntime({
      vendor: 'anthropic',
      script: producerScript({ files: ['src/orders/list.ts'], changeRequestId: 'cr-41' }),
    }),
  makeSlow: () =>
    new FakeRuntime({
      vendor: 'anthropic',
      tickMs: 5,
      script: producerScript({ files: ['a.ts', 'b.ts', 'c.ts'], changeRequestId: 'cr-42' }),
    }),
});

describe('the fake is a first-class adapter', () => {
  // It declares a vendor, so rule 1 governs it exactly as it governs a real one.
  it('is subject to rule 1 like any other runtime', () => {
    const producer = new FakeRuntime({ vendor: 'anthropic', script: [] });
    const verifier = new FakeRuntime({ vendor: 'anthropic', script: [] });
    expect(() =>
      assertDistinctVendor(
        { agentId: producer.id, role: 'p', kind: 'produce', vendor: producer.vendor },
        { agentId: verifier.id, role: 'v', kind: 'verify', vendor: verifier.vendor },
      ),
    ).toThrow(InvariantViolation);
  });

  it('records what it was asked to do', async () => {
    const r = new FakeRuntime({
      vendor: 'openai',
      script: verifierScript({ decision: 'PASS' }),
    });
    await drain(r, contractRequest());
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.context.workItemKey).toBe('ORD-12');
  });

  it('errors rather than hanging when a script forgets to settle', async () => {
    const r = new FakeRuntime({ vendor: 'google', script: [{ t: 'reasoning', text: 'hmm' }] });
    const events = await drain(r, contractRequest());
    expect(events.at(-1)).toMatchObject({ t: 'error', message: /without a result/ });
  });

  it('can script a verifier reaching for a write it should not have', async () => {
    const r = new FakeRuntime({
      vendor: 'openai',
      script: overreachingVerifierScript({ decision: 'CHANGES_REQUESTED' }),
    });
    const events = await drain(r, contractRequest());
    const denied = events.find((e) => e.t === 'tool_result' && e.ok === false);
    expect(denied).toBeDefined();
  });
});
