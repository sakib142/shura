import { describe, expect, it } from 'vitest';
import { InvariantViolation, RoleInvalid, parseRole } from './role.js';

const reviewer = {
  id: 'code-reviewer',
  kind: 'verify',
  model: { runtime: 'openai', model: 'gpt-5' },
  tools: ['repo.read', 'test.run', 'verdict.submit'],
  instructions: 'prompts/code-reviewer.md',
};

describe('role loading runs the invariant', () => {
  it('accepts a read-only verify role', () => {
    expect(parseRole(reviewer).id).toBe('code-reviewer');
  });

  // Fails at load, not at the moment an agent reaches for the tool.
  it('refuses a verify role granted a write tool', () => {
    expect(() => parseRole({ ...reviewer, tools: [...reviewer.tools, 'repo.write'] })).toThrow(
      InvariantViolation,
    );
  });

  it('refuses an admit role that declares a model', () => {
    expect(() =>
      parseRole({
        id: 'merge-queue',
        kind: 'admit',
        model: { runtime: 'openai', model: 'gpt-5' },
        tools: ['repo.merge'],
        instructions: 'n/a',
      }),
    ).toThrow(/must be deterministic/);
  });

  it('accepts a model-free admit role', () => {
    expect(
      parseRole({
        id: 'merge-queue',
        kind: 'admit',
        tools: ['repo.merge'],
        instructions: 'deterministic',
      }).model,
    ).toBeUndefined();
  });

  it('refuses a produce role with no model', () => {
    expect(() =>
      parseRole({ id: 'dev', kind: 'produce', tools: ['repo.write'], instructions: 'x' }),
    ).toThrow(/declares no model/);
  });

  it('refuses a role that grants what it also forbids', () => {
    expect(() =>
      parseRole({
        id: 'dev',
        kind: 'produce',
        model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
        tools: ['repo.write'],
        never: ['repo.write'],
        instructions: 'x',
      }),
    ).toThrow(RoleInvalid);
  });
});
