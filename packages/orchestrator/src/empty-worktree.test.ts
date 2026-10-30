/**
 * What a clean worktree means after a build attempt.
 *
 * Found by running it twice. The first run built the change, pushed
 * shura/shura-9, got CHANGES_REQUESTED on one criterion and escalated. The
 * second run checked that branch out, found the feature already there, wrote
 * nothing — and the flow called that "the builder changed nothing" and stopped
 * for a human on attempt 1. A complete, green, pushed branch that no reviewer
 * had looked at, and $2.86 of quota to learn it.
 *
 * "The builder wrote nothing" and "there is nothing to review" are different
 * statements. Only the second one needs a person.
 */

import { describe, expect, it } from 'vitest';
import { passKey, whatAnEmptyWorktreeMeans } from './build-flow.js';

describe('reading an empty worktree', () => {
  it('sends a branch that already carries commits to review', () => {
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: '1\n' })).toEqual({
      send: 'review',
      ahead: 1,
    });
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: '  3  \n' })).toEqual({
      send: 'review',
      ahead: 3,
    });
  });

  it('asks for a human when the builder wrote nothing and the branch is empty', () => {
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: '0\n' })).toEqual({ send: 'human' });
  });

  /*
   * A count we could not take is not evidence of work. Guessing "probably
   * ahead" here would push an empty branch at a reviewer and spend its pass on
   * nothing.
   */
  it('asks for a human when the count could not be taken', () => {
    expect(whatAnEmptyWorktreeMeans({ ok: false, stdout: '' })).toEqual({ send: 'human' });
    expect(whatAnEmptyWorktreeMeans({ ok: false, stdout: '7' })).toEqual({ send: 'human' });
  });

  it('asks for a human rather than trusting output it cannot parse', () => {
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: '' })).toEqual({ send: 'human' });
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: 'fatal: bad revision\n' })).toEqual({
      send: 'human',
    });
    expect(whatAnEmptyWorktreeMeans({ ok: true, stdout: '-2\n' })).toEqual({ send: 'human' });
  });
});

/*
 * Buying the same producer pass twice.
 *
 * A pass is the commit it starts from plus the findings it is handed. When both
 * repeat the outcome does too, and the loop spends its whole cap arriving at
 * the same place — which is how run 1 on 30 October spent a second attempt on a
 * finding no edit could settle.
 */
describe('identifying a producer pass', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    severity: 'blocker' as const,
    claim: 'pageSize is never clamped',
    evidence: 'no bound between parse and query',
    kind: 'code' as const,
    ...over,
  });

  it('is the same pass for the same commit and the same findings', () => {
    expect(passKey('abc123', [finding()])).toBe(passKey('abc123', [finding()]));
  });

  it('is a different pass once the branch has moved', () => {
    expect(passKey('abc123', [finding()])).not.toBe(passKey('def456', [finding()]));
  });

  it('is a different pass when the findings change', () => {
    expect(passKey('abc123', [finding()])).not.toBe(
      passKey('abc123', [finding({ claim: 'something else entirely' })]),
    );
  });

  // Who is being asked is part of the question: the same text addressed to a
  // fixer rather than a builder is a different request.
  it('is a different pass when the kind changes', () => {
    expect(passKey('abc123', [finding()])).not.toBe(
      passKey('abc123', [finding({ kind: 'evidence' })]),
    );
  });

  // Substance, not bytes: a line number that shifted is the same complaint, and
  // treating it as new is how the loop talks itself into another attempt.
  it('ignores severity and line, which move while the substance does not', () => {
    expect(passKey('abc123', [finding({ severity: 'minor', line: 42 })])).toBe(
      passKey('abc123', [finding({ severity: 'blocker', line: 99 })]),
    );
  });

  it('does not depend on the order findings arrive in', () => {
    const a = finding();
    const b = finding({ claim: 'the empty state is missing' });
    expect(passKey('abc123', [a, b])).toBe(passKey('abc123', [b, a]));
  });

  it('separates no findings from some', () => {
    expect(passKey('abc123', [])).not.toBe(passKey('abc123', [finding()]));
  });
});

