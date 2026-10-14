import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_STATES,
  IllegalTransition,
  afterVerdict,
  allowedEvents,
  canTransition,
  transition,
} from './state-machine.js';

describe('artifact lifecycle', () => {
  it('walks the happy path from draft to admitted', () => {
    let s = transition('draft', 'start_production');
    expect(s).toBe('producing');
    s = transition(s, 'production_complete');
    expect(s).toBe('awaiting_verification');
    s = transition(s, 'verifier_scheduled');
    expect(s).toBe('verifying');
    s = transition(s, 'verdict_pass');
    expect(s).toBe('awaiting_admission');
    s = transition(s, 'admission_succeeded');
    expect(s).toBe('admitted');
  });

  it('loops rework back to the producer', () => {
    const changes = transition('verifying', 'verdict_changes');
    expect(changes).toBe('changes_requested');
    expect(transition(changes, 'rework_start')).toBe('producing');
  });

  // A reviewer that merged directly would lose this: two change requests can each
  // be green alone and still break the base together.
  it('sends a failed admission back for changes rather than merging', () => {
    expect(transition('awaiting_admission', 'admission_failed')).toBe('changes_requested');
  });

  it('refuses to skip verification', () => {
    expect(() => transition('awaiting_verification', 'verdict_pass')).toThrow(IllegalTransition);
    expect(() => transition('producing', 'admission_succeeded')).toThrow(IllegalTransition);
  });

  it('cannot leave admitted', () => {
    expect(allowedEvents('admitted')).toHaveLength(0);
  });

  it('lets a human resume an escalated artifact', () => {
    expect(transition('escalated', 'human_resumed')).toBe('producing');
  });

  it('defines a transition table for every state', () => {
    for (const s of ARTIFACT_STATES) {
      expect(() => allowedEvents(s)).not.toThrow();
    }
  });

  it('canTransition agrees with transition', () => {
    expect(canTransition('draft', 'start_production')).toBe(true);
    expect(canTransition('draft', 'verdict_pass')).toBe(false);
  });
});

describe('afterVerdict', () => {
  it('admits on PASS', () => {
    expect(afterVerdict('PASS', 1, 3).next).toBe('awaiting_admission');
  });

  it('sends changes back while attempts remain', () => {
    expect(afterVerdict('CHANGES_REQUESTED', 1, 3)).toEqual({
      event: 'verdict_changes',
      next: 'changes_requested',
    });
  });

  it('escalates once the loop cap is reached', () => {
    expect(afterVerdict('CHANGES_REQUESTED', 3, 3)).toEqual({
      event: 'loop_cap_hit',
      next: 'escalated',
    });
  });

  // BLOCKED is an escalation, never an admission — so it can't be used to slip through.
  it('escalates on BLOCKED', () => {
    expect(afterVerdict('BLOCKED', 1, 3).next).toBe('escalated');
  });
});
