import { describe, expect, it } from 'vitest';
import { InvariantViolation, RoleInvalid, fixRoleOf, parseRole } from './role.js';

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

/**
 * A reviewer that may fix what it found.
 *
 * The thing being tested is that rule 2 did not have to be weakened for this.
 * The verify role's own grants are still read-only and still checked; the write
 * grants live on a separate produce-kind role, so no single task both judges
 * and writes.
 */
describe('a verify role that may fix what it found', () => {
  const fixer = {
    ...reviewer,
    id: 'frontend-reviewer',
    fix: { tools: ['repo.read', 'repo.write', 'test.run'], instructions: 'prompts/fix.md' },
  };

  it('is accepted, and its reviewing grants stay read-only', () => {
    const role = parseRole(fixer);
    expect(role.tools).not.toContain('repo.write');
    expect(role.fix?.tools).toContain('repo.write');
  });

  // The whole point. The verify task cannot write, whatever its fix block says.
  it('still cannot be granted a write tool for reviewing', () => {
    expect(() => parseRole({ ...fixer, tools: [...reviewer.tools, 'repo.write'] })).toThrow(
      InvariantViolation,
    );
  });

  it('refuses to let the fixing task also record the verdict', () => {
    expect(() =>
      parseRole({ ...fixer, fix: { ...fixer.fix, tools: ['repo.write', 'verdict.submit'] } }),
    ).toThrow(/must not also record the verdict/);
  });

  it('refuses a fix block on a producing role, which already holds its writes', () => {
    expect(() =>
      parseRole({
        id: 'frontend-developer',
        kind: 'produce',
        model: { runtime: 'anthropic', model: 'claude-sonnet-5' },
        tools: ['repo.read', 'repo.write'],
        instructions: 'prompts/dev.md',
        fix: { tools: ['repo.write'], instructions: 'prompts/fix.md' },
      }),
    ).toThrow(/only a verify role has something to fix/);
  });

  it('refuses a fix block that grants what the role lists under never', () => {
    expect(() =>
      parseRole({
        ...fixer,
        never: ['repo.merge'],
        fix: { tools: ['repo.write', 'repo.merge'], instructions: 'prompts/fix.md' },
      }),
    ).toThrow(/while listing them under "never"/);
  });

  it('refuses a fix block granting an unknown tool', () => {
    expect(() =>
      parseRole({ ...fixer, fix: { tools: ['repo.destroy'], instructions: 'prompts/fix.md' } }),
    ).toThrow(RoleInvalid);
  });
});

describe('the produce role a fixing reviewer wears', () => {
  const fixer = parseRole({
    ...reviewer,
    id: 'frontend-reviewer',
    fix: { tools: ['repo.read', 'repo.write', 'test.run'], instructions: 'prompts/fix.md' },
  });

  it('is a produce task, which is why the gateway lets it write', () => {
    const fix = fixRoleOf(fixer)!;
    expect(fix.kind).toBe('produce');
    expect(fix.tools).toEqual(['repo.read', 'repo.write', 'test.run']);
  });

  it('keeps the reviewer model, because it is the same agent', () => {
    expect(fixRoleOf(fixer)!.model).toEqual(fixer.model);
  });

  // A distinct id so the audit cannot confuse the two tasks, and so a lookup
  // by role id can never return this one as something to schedule.
  it('carries a distinct id and its own prompt', () => {
    const fix = fixRoleOf(fixer)!;
    expect(fix.id).toBe('frontend-reviewer:fix');
    expect(fix.instructions).toBe('prompts/fix.md');
  });

  it('is itself a valid role, with no fix block of its own', () => {
    const fix = fixRoleOf(fixer)!;
    expect(fix.fix).toBeUndefined();
    expect(parseRole(fix).id).toBe('frontend-reviewer:fix');
  });

  it('does not exist for a reviewer that may only report', () => {
    expect(fixRoleOf(parseRole(reviewer))).toBeUndefined();
  });
});
