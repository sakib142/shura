import { describe, expect, it } from 'vitest';
import { PlanRejected, acceptPlan, approvability } from './plan.js';

const plan = {
  understanding: 'The orders table has no way to narrow by date; the request wants one.',
  files: [{ path: 'src/orders/OrderList.tsx', reason: 'where the table is rendered' }],
  approach: 'Add a DateRange control above the table and filter the rows client-side.',
  outOfScope: ['Server-side filtering, which would need a new endpoint.'],
  criteria: [
    'Given orders in March and April, when the range is set to April, then only April orders are listed',
  ],
  openQuestions: [],
  author: { agent: 'plan-01', vendor: 'anthropic', model: 'claude-sonnet-5' },
  cost: { tokensIn: 100, tokensOut: 50, usd: 0.01 },
};

describe('the plan contract', () => {
  it('accepts a plan that names files, an approach and checkable criteria', () => {
    expect(acceptPlan(plan).criteria).toHaveLength(1);
  });

  // The criteria are the only thing the reviewer judges against, so one that
  // cannot be checked produces a verdict that reads as meaningful and is not.
  it('refuses a criterion that names no condition, action and outcome', () => {
    expect(() =>
      acceptPlan({ ...plan, criteria: ['The date filter should work correctly'] }),
    ).toThrow(PlanRejected);
  });

  it('says why, so the planner can correct itself', () => {
    try {
      acceptPlan({ ...plan, criteria: ['it works'] });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/Given .*when .*then/i);
    }
  });

  // "I will look into it" is not approvable.
  it('refuses a plan that names no file it will touch', () => {
    expect(() => acceptPlan({ ...plan, files: [] })).toThrow(PlanRejected);
  });

  it('refuses an absolute path in the file list', () => {
    expect(() =>
      acceptPlan({ ...plan, files: [{ path: '/etc/passwd', reason: 'no' }] }),
    ).toThrow(PlanRejected);
  });

  it('defaults the optional lists rather than requiring them', () => {
    const { outOfScope: _o, openQuestions: _q, ...without } = plan;
    const accepted = acceptPlan(without);
    expect(accepted.outOfScope).toEqual([]);
    expect(accepted.openQuestions).toEqual([]);
  });
});

describe('the approval gate', () => {
  it('approves a plan that left nothing open', () => {
    expect(approvability({ openQuestions: [] })).toEqual({ ok: true });
  });

  // An open question is the agent reporting that the request did not settle
  // something. Pressing past it unanswered has to be deliberate, or the gate
  // becomes a rubber stamp and the agent is back to inventing scope.
  it('refuses while a question is unanswered', () => {
    const result = approvability({ openQuestions: ['Does the filter persist across a reload?'] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unanswered).toEqual([
      'Does the filter persist across a reload?',
    ]);
  });

  it('names only the questions that are still unanswered', () => {
    const result = approvability({
      openQuestions: ['first?', 'second?', 'third?'],
      answers: ['yes', '', 'no'],
    });
    expect(result.ok === false && result.unanswered).toEqual(['second?']);
  });

  it('treats whitespace as no answer at all', () => {
    const result = approvability({ openQuestions: ['first?'], answers: ['   '] });
    expect(result.ok).toBe(false);
  });

  it('approves once every question has an answer', () => {
    expect(
      approvability({ openQuestions: ['first?', 'second?'], answers: ['yes', 'no'] }),
    ).toEqual({ ok: true });
  });

  // Letting the agent decide is itself a decision, so it needs its own flag
  // rather than happening because nobody typed an answer.
  it('approves with questions open only when that is asked for explicitly', () => {
    expect(approvability({ openQuestions: ['first?'], ignoreQuestions: true })).toEqual({
      ok: true,
    });
  });
});
