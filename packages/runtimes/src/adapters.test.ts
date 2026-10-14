import { describe, expect, it } from 'vitest';
import { InvariantViolation, assertDistinctVendor, parseRole } from '@forge/core';
import type { AgentRuntime } from '@forge/ports';
import { AnthropicRuntime } from './anthropic.js';
import { OpenAIRuntime } from './openai.js';
import { GoogleRuntime } from './google.js';
import { OpenAICompatibleRuntime } from './openai-compatible.js';
import { FakeRuntime } from './fake.js';
import { contractRequest, drain } from './contract.js';

/** Dummy keys: these tests construct adapters and inspect them, never call out. */
const adapters: Array<[string, () => AgentRuntime, string]> = [
  ['anthropic', () => new AnthropicRuntime({ apiKey: 'test' }), 'anthropic'],
  ['openai', () => new OpenAIRuntime({ apiKey: 'test' }), 'openai'],
  ['google', () => new GoogleRuntime({ apiKey: 'test' }), 'google'],
  ['openai-compatible', () => new OpenAICompatibleRuntime({ apiKey: 'test' }), 'local'],
];

describe('vendor identity', () => {
  // Rule 1 compares this string. If it came from config, a typo could make two
  // adapters agree they are different vendors when they are not.
  it.each(adapters)('%s declares its vendor from the adapter', (_name, make, vendor) => {
    expect(make().vendor).toBe(vendor);
  });

  it('gives every adapter a distinct vendor, so any two can pair', () => {
    const vendors = adapters.map(([, make]) => make().vendor);
    expect(new Set(vendors).size).toBe(adapters.length);
  });

  it('refuses a pair built from two instances of the same adapter', () => {
    const a = new OpenAIRuntime({ apiKey: 'test' });
    const b = new OpenAIRuntime({ apiKey: 'test' });
    expect(() =>
      assertDistinctVendor(
        { agentId: 'p', role: 'producer', kind: 'produce', vendor: a.vendor },
        { agentId: 'v', role: 'verifier', kind: 'verify', vendor: b.vendor },
      ),
    ).toThrow(InvariantViolation);
  });

  it('accepts a pair across two different adapters', () => {
    const producer = new AnthropicRuntime({ apiKey: 'test' });
    const verifier = new OpenAIRuntime({ apiKey: 'test' });
    expect(() =>
      assertDistinctVendor(
        { agentId: 'p', role: 'producer', kind: 'produce', vendor: producer.vendor },
        { agentId: 'v', role: 'verifier', kind: 'verify', vendor: verifier.vendor },
      ),
    ).not.toThrow();
  });

  // The fake is an adapter like any other, so it is governed too.
  it('governs the fake by the same rule', () => {
    const fake = new FakeRuntime({ vendor: 'openai', script: [] });
    const real = new OpenAIRuntime({ apiKey: 'test' });
    expect(fake.vendor).toBe(real.vendor);
  });
});

describe('a role with no model', () => {
  const admitRole = parseRole({
    id: 'merge-queue',
    kind: 'admit',
    tools: ['repo.merge'],
    instructions: 'deterministic',
  });

  // Rule 3: admission is deterministic code. Handing an admit role to a model
  // adapter is a configuration error, and it settles as one rather than
  // throwing somewhere inside a vendor SDK.
  it.each(adapters)('%s settles with an error rather than throwing', async (_name, make) => {
    const events = await drain(make(), contractRequest({ role: admitRole }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'error', message: /declares no model/ });
  });
});
