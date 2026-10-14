import { describe, expect, it } from 'vitest';
import {
  InvariantViolation,
  assertAdmitterIsThirdParty,
  assertDistinctVendor,
  assertVerdictAttributed,
  assertVerifierGrantsAreReadOnly,
  denialReason,
  isValidPair,
  selectVerifier,
  type ActorIdentity,
  type VerifierCandidate,
} from './invariant.js';

const producer: ActorIdentity = {
  agentId: 'dev-01',
  role: 'backend-developer',
  kind: 'produce',
  vendor: 'anthropic',
  model: 'claude-sonnet-5',
};

const openaiVerifier: VerifierCandidate = {
  agentId: 'rev-01',
  role: 'code-reviewer',
  kind: 'verify',
  vendor: 'openai',
  model: 'gpt-5',
  grants: ['repo.read', 'test.run', 'verdict.submit'],
};

describe('rule 1 — the verifier runs a different vendor', () => {
  // The test that must pass before anything else in this repository exists.
  it('refuses a same-vendor pair before a token is spent', () => {
    const sameVendor: ActorIdentity = {
      agentId: 'rev-99',
      role: 'code-reviewer',
      kind: 'verify',
      vendor: 'anthropic',
      model: 'claude-opus-5',
    };
    expect(() => assertDistinctVendor(producer, sameVendor)).toThrow(InvariantViolation);
    expect(() => assertDistinctVendor(producer, sameVendor)).toThrow(/different vendor/);
  });

  it('refuses an agent verifying its own work even across roles', () => {
    const self: ActorIdentity = { ...producer, kind: 'verify', vendor: 'openai' };
    expect(() => assertDistinctVendor(producer, self)).toThrow(/cannot verify its own work/);
  });

  it('accepts a cross-vendor pair', () => {
    expect(() => assertDistinctVendor(producer, openaiVerifier)).not.toThrow();
    expect(isValidPair(producer, openaiVerifier)).toBe(true);
  });

  it('refuses an actor with no vendor as a verifier', () => {
    const deterministic: ActorIdentity = { agentId: 'mq', role: 'merge-queue', kind: 'admit' };
    expect(() => assertDistinctVendor(producer, deterministic)).toThrow(InvariantViolation);
  });

  it('selectVerifier picks an eligible candidate and skips same-vendor ones', () => {
    const sameVendor: VerifierCandidate = { ...openaiVerifier, agentId: 'rev-02', vendor: 'anthropic' };
    expect(selectVerifier(producer, [sameVendor, openaiVerifier]).agentId).toBe('rev-01');
  });

  it('selectVerifier throws, naming the vendors, when no candidate differs', () => {
    const sameVendor: VerifierCandidate = { ...openaiVerifier, agentId: 'rev-02', vendor: 'anthropic' };
    expect(() => selectVerifier(producer, [sameVendor])).toThrow(/different vendor/);
  });
});

describe('rule 2 — a verifier holds no write grant', () => {
  it('refuses a verify role granted repo.write', () => {
    expect(() =>
      assertVerifierGrantsAreReadOnly('code-reviewer', ['repo.read', 'repo.write']),
    ).toThrow(/may hold\s+no write grant|no write grant/);
  });

  it('refuses a verify role granted repo.merge', () => {
    expect(() => assertVerifierGrantsAreReadOnly('code-reviewer', ['repo.merge'])).toThrow(
      InvariantViolation,
    );
  });

  it('permits verdict.submit, the verifier output channel', () => {
    expect(() =>
      assertVerifierGrantsAreReadOnly('code-reviewer', ['repo.read', 'test.run', 'verdict.submit']),
    ).not.toThrow();
  });

  it('refuses an unknown tool rather than ignoring it', () => {
    expect(() => assertVerifierGrantsAreReadOnly('code-reviewer', ['repo.sudo'])).toThrow(
      /unknown tool/,
    );
  });

  // The denial a gateway records, and the line an operator sees in the stream.
  it('denies a verifier calling repo.write even when the grant list is wrong', () => {
    expect(denialReason('verify', ['repo.read', 'repo.write'], 'repo.write')).toMatch(
      /writes, and a verifier holds no write grant/,
    );
  });

  it('allows a producer to call repo.write', () => {
    expect(denialReason('produce', ['repo.read', 'repo.write'], 'repo.write')).toBeUndefined();
  });

  it('denies any ungranted tool', () => {
    expect(denialReason('produce', ['repo.read'], 'repo.write')).toMatch(/is not granted/);
  });

  it('denies an unknown tool rather than passing it through', () => {
    expect(denialReason('produce', ['repo.read'], 'repo.sudo')).toMatch(/unknown tool/);
  });
});

describe('rule 3 — admission is deterministic and third-party', () => {
  const admitter: ActorIdentity = { agentId: 'merge-queue', role: 'merge-queue', kind: 'admit' };

  it('accepts a model-free third actor', () => {
    expect(() => assertAdmitterIsThirdParty(producer, openaiVerifier, admitter)).not.toThrow();
  });

  it('refuses an admitter that carries a model', () => {
    const modelled: ActorIdentity = { ...admitter, vendor: 'openai', model: 'gpt-5' };
    expect(() => assertAdmitterIsThirdParty(producer, openaiVerifier, modelled)).toThrow(
      /must be deterministic/,
    );
  });

  it('refuses the verifier admitting its own verdict', () => {
    const verifierAsAdmitter: ActorIdentity = { ...openaiVerifier, kind: 'admit' };
    expect(() => assertAdmitterIsThirdParty(producer, openaiVerifier, verifierAsAdmitter)).toThrow(
      InvariantViolation,
    );
  });
});

describe('rule 4 — every verdict is attributable', () => {
  const full = {
    producerVendor: 'anthropic',
    producerModel: 'claude-sonnet-5',
    verifierVendor: 'openai',
    verifierModel: 'gpt-5',
    promptHash: 'sha256:abc',
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.01,
  } as const;

  it('accepts a complete record', () => {
    expect(() => assertVerdictAttributed({ ...full })).not.toThrow();
  });

  it('names what is missing', () => {
    const { verifierModel, ...rest } = full;
    void verifierModel;
    expect(() => assertVerdictAttributed(rest)).toThrow(/verifierModel/);
  });

  it('refuses a record with no cost accounting', () => {
    const { costUsd, ...rest } = full;
    void costUsd;
    expect(() => assertVerdictAttributed(rest)).toThrow(/costUsd/);
  });
});
