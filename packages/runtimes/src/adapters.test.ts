import { describe, expect, it } from 'vitest';
import { InvariantViolation, assertDistinctVendor, parseRole, toolDefinitions } from '@forge/core';
import type { AgentRuntime } from '@forge/ports';
import { AnthropicRuntime } from './anthropic.js';
import { OpenAIRuntime, strictSchema } from './openai.js';
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

describe('OpenAI strict schemas', () => {
  // A real run failed with "Missing 'filter'": strict mode requires `required`
  // to name every property, and expresses optionality as a nullable type.
  it('lists every property as required', () => {
    const out = strictSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    });
    expect(out['required']).toEqual(['a', 'b']);
  });

  it('makes a previously optional property nullable instead of absent', () => {
    const out = strictSchema({
      type: 'object',
      properties: { filter: { type: 'string' } },
      required: [],
    });
    const props = out['properties'] as Record<string, { type: unknown }>;
    expect(props['filter']?.type).toEqual(['string', 'null']);
  });

  it('leaves an already-required property alone', () => {
    const out = strictSchema({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    const props = out['properties'] as Record<string, { type: unknown }>;
    expect(props['path']?.type).toBe('string');
  });

  it('leaves a schema with no properties unchanged', () => {
    expect(strictSchema({ type: 'object' })).toStrictEqual({ type: 'object' });
  });
})

describe('strict schemas apply at every level', () => {
  // The first fix only handled the top level, and a real run failed on an
  // optional nested two levels down inside an array item.
  it('rewrites an optional inside an array item', () => {
    const out = strictSchema({
      type: 'object',
      properties: {
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: { index: { type: 'integer' }, note: { type: 'string' } },
            required: ['index'],
          },
        },
      },
      required: ['criteria'],
    });
    const items = (out['properties'] as Record<string, { items: Record<string, unknown> }>)['criteria']!
      .items;
    expect(items['required']).toEqual(['index', 'note']);
    expect((items['properties'] as Record<string, { type: unknown }>)['note']?.type).toEqual([
      'string',
      'null',
    ]);
  });

  it('rewrites an optional nested two levels down', () => {
    const out = strictSchema({
      type: 'object',
      properties: {
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              finding: {
                type: 'object',
                properties: { claim: { type: 'string' }, file: { type: 'string' } },
                required: ['claim'],
              },
            },
            required: [],
          },
        },
      },
      required: [],
    });
    const finding = (
      (out['properties'] as Record<string, { items: { properties: Record<string, Record<string, unknown>> } }>)[
        'criteria'
      ]!.items.properties
    )['finding']!;
    expect(finding['required']).toEqual(['claim', 'file']);
  });

  it('leaves the real verdict schema valid for strict mode', () => {
    const [def] = toolDefinitions(['verdict.submit']);
    const out = strictSchema(def!.parameters);
    assertEveryPropertyRequired(out);
  });
});

/** Walks a schema asserting OpenAI's strict-mode rule holds everywhere. */
function assertEveryPropertyRequired(node: unknown): void {
  if (Array.isArray(node)) {
    for (const n of node) assertEveryPropertyRequired(n);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const o = node as Record<string, unknown>;
  const props = o['properties'];
  if (typeof props === 'object' && props !== null) {
    expect(o['required']).toEqual(Object.keys(props as Record<string, unknown>));
  }
  for (const v of Object.values(o)) assertEveryPropertyRequired(v);
}
