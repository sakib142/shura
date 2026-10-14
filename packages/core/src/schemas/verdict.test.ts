import { describe, expect, it } from 'vitest';
import { VerdictRejected, acceptVerdict, resolveDecision } from './verdict.js';

const base = {
  artifactId: 'a_7f3c',
  verifier: { agent: 'rev-01', vendor: 'openai', model: 'gpt-5' },
  cost: { tokensIn: 48_200, tokensOut: 12_900, usd: 0.42 },
};

const blocker = {
  severity: 'blocker' as const,
  file: 'src/orders/list.ts',
  line: 42,
  claim: 'pageSize is parsed but never clamped',
  evidence: 'no bound between parse at :38 and query at :51',
};

describe('decision is recomputed, not trusted', () => {
  // Without this the scheme rests on the reviewer's self-consistency, which is
  // the thing it was built not to rely on.
  it('rewrites a PASS that lists an unmet criterion', () => {
    const r = acceptVerdict(
      {
        ...base,
        decision: 'PASS',
        criteria: [
          { index: 0, status: 'met' },
          { index: 1, status: 'not_met', finding: blocker },
        ],
      },
      2,
    );
    expect(r.decision).toBe('CHANGES_REQUESTED');
    expect(r.overridden).toBe(true);
    expect(r.reason).toMatch(/claimed PASS/);
  });

  it('rewrites a PASS carrying a blocker outside the criteria', () => {
    const r = acceptVerdict(
      {
        ...base,
        decision: 'PASS',
        criteria: [{ index: 0, status: 'met' }],
        extraFindings: [blocker],
      },
      1,
    );
    expect(r.decision).toBe('CHANGES_REQUESTED');
    expect(r.overridden).toBe(true);
  });

  it('leaves an honest PASS alone', () => {
    const r = acceptVerdict(
      { ...base, decision: 'PASS', criteria: [{ index: 0, status: 'met' }] },
      1,
    );
    expect(r.decision).toBe('PASS');
    expect(r.overridden).toBe(false);
  });

  it('does not upgrade a CHANGES_REQUESTED into a PASS', () => {
    const r = resolveDecision({
      ...base,
      decision: 'CHANGES_REQUESTED',
      criteria: [{ index: 0, status: 'met' }],
      extraFindings: [],
    } as never);
    expect(r.decision).toBe('PASS');
    expect(r.overridden).toBe(true);
  });
});

describe('criterion coverage', () => {
  // Stops a verifier passing an artifact by quietly ignoring the hard criterion.
  it('rejects a verdict that skips a criterion', () => {
    expect(() =>
      acceptVerdict({ ...base, decision: 'PASS', criteria: [{ index: 0, status: 'met' }] }, 3),
    ).toThrow(/does not address criteria \[1, 2\]/);
  });

  it('rejects a duplicated criterion index', () => {
    expect(() =>
      acceptVerdict(
        {
          ...base,
          decision: 'PASS',
          criteria: [
            { index: 0, status: 'met' },
            { index: 0, status: 'met' },
          ],
        },
        1,
      ),
    ).toThrow(/more than once/);
  });

  it('rejects an invented criterion index', () => {
    expect(() =>
      acceptVerdict({ ...base, decision: 'PASS', criteria: [{ index: 5, status: 'met' }] }, 1),
    ).toThrow(/does not exist/);
  });
});

describe('findings must be actionable', () => {
  it('rejects not_met with no finding', () => {
    expect(() =>
      acceptVerdict(
        { ...base, decision: 'CHANGES_REQUESTED', criteria: [{ index: 0, status: 'not_met' }] },
        1,
      ),
    ).toThrow(VerdictRejected);
  });

  it('rejects met that carries a finding', () => {
    expect(() =>
      acceptVerdict(
        { ...base, decision: 'PASS', criteria: [{ index: 0, status: 'met', finding: blocker }] },
        1,
      ),
    ).toThrow(VerdictRejected);
  });

  it('requires a finding to carry its evidence', () => {
    expect(() =>
      acceptVerdict(
        {
          ...base,
          decision: 'CHANGES_REQUESTED',
          criteria: [
            { index: 0, status: 'not_met', finding: { severity: 'blocker', claim: 'bad', evidence: '' } },
          ],
        },
        1,
      ),
    ).toThrow(VerdictRejected);
  });
});

describe('BLOCKED', () => {
  it('is honoured as claimed and needs no criterion coverage', () => {
    const r = acceptVerdict(
      { ...base, decision: 'BLOCKED', criteria: [], blockedReason: 'the test suite will not run' },
      3,
    );
    expect(r.decision).toBe('BLOCKED');
  });

  it('must say what blocked it', () => {
    expect(() => acceptVerdict({ ...base, decision: 'BLOCKED', criteria: [] }, 3)).toThrow(
      /must say what blocked it/,
    );
  });
});
