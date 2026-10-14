import { describe, expect, it } from 'vitest';
import { assertVerifierGrantsAreReadOnly, isKnownTool } from '@shura/core';
import { loadAllRoles, withPrompt } from './index.js';

const roles = loadAllRoles();

describe('the shipped role definitions', () => {
  it('all load and satisfy the invariant', () => {
    expect([...roles.keys()].sort()).toEqual([
      'backend-developer',
      'backlog-author',
      'backlog-reviewer',
      'code-reviewer',
      'design-analyst',
      'frontend-developer',
      'merge-queue',
    ]);
  });

  it('grant only tools the platform knows', () => {
    for (const role of roles.values()) {
      for (const tool of role.tools) expect(isKnownTool(tool)).toBe(true);
    }
  });

  it('give every verify role read-only grants', () => {
    for (const role of roles.values()) {
      if (role.kind !== 'verify') continue;
      expect(() => assertVerifierGrantsAreReadOnly(role.id, role.tools)).not.toThrow();
    }
  });

  // Rule 3, as shipped: the thing that merges is not a model.
  it('leave the admit role without a model', () => {
    const mq = roles.get('merge-queue')!;
    expect(mq.kind).toBe('admit');
    expect(mq.model).toBeUndefined();
  });

  // Rule 1, as shipped: a producer and its default verifier must be able to pair.
  it('pair each producer with a verifier on a different vendor', () => {
    const pairs: Array<[string, string]> = [
      ['backend-developer', 'code-reviewer'],
      ['frontend-developer', 'code-reviewer'],
      ['backlog-author', 'backlog-reviewer'],
      ['design-analyst', 'backlog-reviewer'],
    ];
    for (const [p, v] of pairs) {
      const producer = roles.get(p)!;
      const verifier = roles.get(v)!;
      expect(verifier.model?.runtime, `${p} -> ${v}`).not.toBe(producer.model?.runtime);
    }
  });

  // A fallback that lands on the producer's vendor would defeat rule 1 silently
  // at the exact moment the primary is rate-limited.
  it('never let a verifier fall back onto its producer vendor', () => {
    const pairs: Array<[string, string]> = [
      ['backend-developer', 'code-reviewer'],
      ['frontend-developer', 'code-reviewer'],
      ['backlog-author', 'backlog-reviewer'],
    ];
    for (const [p, v] of pairs) {
      const producerVendor = roles.get(p)!.model!.runtime;
      const fallback = roles.get(v)!.model?.fallback;
      if (fallback === undefined) continue;
      expect(fallback.split('/')[0]).not.toBe(producerVendor);
    }
  });
});

describe('model identifiers', () => {
  // Model IDs rot. gpt-5 and gemini-2.5-pro were both configured here and both
  // had been retired; claude-sonnet-5-5 in the architecture doc never existed.
  // This test does not prove an ID is live, but it does stop a typo and forces
  // a conscious edit whenever one changes.
  const KNOWN: Record<string, readonly string[]> = {
    anthropic: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    openai: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
    google: ['gemini-3.8-flash', 'gemini-4-argon'],
    local: [],
  };

  it('uses only model IDs checked against vendor documentation', () => {
    for (const role of roles.values()) {
      const m = role.model;
      if (m === undefined) continue;
      if (m.runtime === 'local') continue;
      expect(KNOWN[m.runtime], `${role.id} runtime`).toContain(m.model);
    }
  });

  it('keeps every fallback on a vendor different from the primary', () => {
    for (const role of roles.values()) {
      const fallback = role.model?.fallback;
      if (fallback === undefined) continue;
      const [vendor, model] = fallback.split('/');
      expect(vendor, `${role.id} fallback vendor`).not.toBe(role.model?.runtime);
      expect(KNOWN[vendor ?? ''], `${role.id} fallback`).toContain(model);
    }
  });
});

describe('prompt resolution', () => {
  // Leaving this unresolved sends the model a filename as its entire system
  // prompt. The agent still runs; it just has no instructions.
  it('replaces the instructions path with the prompt itself', () => {
    const role = withPrompt(roles.get('code-reviewer')!);
    expect(role.instructions).not.toMatch(/^prompts\//);
    expect(role.instructions).toContain('You cannot edit anything');
  });

  it('resolves a prompt for every shipped role', () => {
    for (const role of roles.values()) {
      expect(() => withPrompt(role), role.id).not.toThrow();
      expect(withPrompt(role).instructions.length, role.id).toBeGreaterThan(50);
    }
  });

  // The reviewer prompt is the single biggest lever on the eval numbers.
  it('gives the reviewer explicit categories rather than a confidence threshold', () => {
    const p = withPrompt(roles.get('code-reviewer')!).instructions;
    expect(p).toContain('## What to report');
    expect(p).toContain('## What to skip');
    expect(p).toMatch(/blocker/);
    // Few-shot examples, including the ambiguous cases.
    expect(p).toContain('Do not report this');
    expect(p.toLowerCase()).not.toContain('be conservative');
    expect(p.toLowerCase()).not.toContain('confidence score');
  });
});
