import { describe, expect, it } from 'vitest';
import { assertVerifierGrantsAreReadOnly, isKnownTool } from '@forge/core';
import { loadAllRoles } from './index.js';

const roles = loadAllRoles();

describe('the shipped role definitions', () => {
  it('all load and satisfy the invariant', () => {
    expect([...roles.keys()].sort()).toEqual([
      'backend-developer',
      'backlog-author',
      'backlog-reviewer',
      'code-reviewer',
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
      ['backlog-author', 'backlog-reviewer'],
    ];
    for (const [p, v] of pairs) {
      const producer = roles.get(p)!;
      const verifier = roles.get(v)!;
      expect(verifier.model?.runtime).not.toBe(producer.model?.runtime);
    }
  });

  // A fallback that lands on the producer's vendor would defeat rule 1 silently
  // at the exact moment the primary is rate-limited.
  it('never let a verifier fall back onto its producer vendor', () => {
    const pairs: Array<[string, string]> = [
      ['backend-developer', 'code-reviewer'],
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
