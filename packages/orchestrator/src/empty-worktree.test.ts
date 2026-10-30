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
import { whatAnEmptyWorktreeMeans } from './build-flow.js';

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
