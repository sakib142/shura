import { describe, expect, it } from 'vitest';
import { assertVerifierGrantsAreReadOnly, fixRoleOf, isKnownTool } from '@shura/core';
import { availableDomains, loadAllRoles, withPrompt } from './index.js';

const roles = loadAllRoles();

describe('the shipped role definitions', () => {
  it('all load and satisfy the invariant', () => {
    expect([...roles.keys()].sort()).toEqual([
      'backlog-author',
      'backlog-reviewer',
      'builder',
      'design-analyst',
      'merge-queue',
      'planner',
      'reviewer',
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
      ['builder', 'reviewer'],
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
      ['builder', 'reviewer'],
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

/**
 * The frontend agent, as shipped.
 *
 * Three roles with one flow between them, and the grants are what make the
 * flow safe rather than the prompts. These assert the grants, because a prompt
 * saying "you cannot write" is advice and an absent grant is a fact.
 */
describe('the three positions', () => {
  const planner = roles.get('planner')!;
  const reviewer = roles.get('reviewer')!;

  // The planner cannot start building while it is supposed to be deciding what
  // to build. That is a grant, not an instruction.
  it('gives the planner no way to write code', () => {
    expect(planner.tools).not.toContain('repo.write');
    expect(planner.tools).toContain('plan.submit');
    expect(planner.kind).toBe('produce');
  });

  it('keeps the reviewer read-only while it reviews, even though it may fix', () => {
    expect(reviewer.kind).toBe('verify');
    expect(reviewer.tools).not.toContain('repo.write');
    expect(() => assertVerifierGrantsAreReadOnly(reviewer.id, reviewer.tools)).not.toThrow();
  });

  it('puts the reviewer write grants on a separate produce role', () => {
    const fix = fixRoleOf(reviewer)!;
    expect(fix.kind).toBe('produce');
    expect(fix.tools).toContain('repo.write');
    // The judgment was recorded by the verify task. A task that writes the code
    // does not also get to record the verdict on it.
    expect(fix.tools).not.toContain('verdict.submit');
  });

  it('resolves the fix prompt as well as the review prompt', () => {
    const resolved = withPrompt(reviewer);
    expect(resolved.fix?.instructions).not.toMatch(/^prompts\//);
    expect(fixRoleOf(resolved)!.instructions).toContain('You now hold write access');
  });

  it('tells the planner what makes a criterion checkable', () => {
    const p = withPrompt(planner).instructions;
    expect(p).toMatch(/Given .*when .*then/i);
    expect(p).toContain('open question');
  });

  /*
   * This policy was reversed deliberately, and the reversal is what the test
   * pins. It used to say "choose return when you are unsure", on the grounds
   * that a reviewer's own fix is reviewed by nobody.
   *
   * A live run showed what that costs. The reviewer found one criterion it
   * could not verify — it runs read-only and could not install the project's
   * dependencies to run tsc and eslint — and returned, as instructed. The
   * builder was handed that finding, read the code, concluded correctly that
   * there was nothing to write, and changed nothing. A whole attempt spent
   * establishing that the finding was not actionable, and a human left holding
   * a branch with no pull request.
   *
   * So `fix` is the default now, and `return` is for questions rather than for
   * work. The cost has not gone away and must stay in front of the reviewer,
   * which is the third assertion.
   */
  it('tells the reviewer to fix what it finds, and keeps return for questions', () => {
    const p = withPrompt(reviewer).instructions;
    expect(p).toMatch(/default to `fix`/i);
    expect(p).toMatch(/return.*question/is);
    expect(p).toMatch(/reviewed by\s+no agent/i);
  });
});

/**
 * Position and domain are different kinds of thing, deliberately.
 *
 * The role describes the POSITION — what planning is, what reviewing is — and
 * is what the grants are built around. The overlay describes the DOMAIN, the
 * house rules of a kind of codebase, and changes nothing a gateway can check.
 *
 * Before this split there were five code roles for two domains, backend could
 * neither plan nor review, and `backend-developer` was the generic builder
 * prompt wearing a domain name.
 */
describe('domains as an overlay', () => {
  it('ships a domain for each kind of codebase it claims to know', () => {
    expect(availableDomains()).toEqual(['backend', 'frontend']);
  });

  it('leaves the prompt alone when no domain is asked for', () => {
    const bare = withPrompt(roles.get('builder')!).instructions;
    expect(bare).not.toMatch(/design token/i);
    expect(bare).not.toMatch(/replica/i);
  });

  it('appends the house rules when one is', () => {
    const frontend = withPrompt(roles.get('builder')!, undefined, 'frontend').instructions;
    expect(frontend).toMatch(/design token/i);
    expect(frontend).toMatch(/accessible name/i);

    const backend = withPrompt(roles.get('builder')!, undefined, 'backend').instructions;
    expect(backend).toMatch(/transaction boundary/i);
    expect(backend).not.toMatch(/design token/i);
  });

  it('gives every position the same overlay', () => {
    for (const id of ['planner', 'builder', 'reviewer']) {
      const p = withPrompt(roles.get(id)!, undefined, 'frontend').instructions;
      expect(p, id).toMatch(/design token/i);
    }
  });

  /**
   * A reviewer that knew the house rules while judging and forgot them while
   * fixing would write the very thing it had just flagged.
   */
  it('gives the reviewer fix prompt the overlay too', () => {
    const resolved = withPrompt(roles.get('reviewer')!, undefined, 'frontend');
    expect(fixRoleOf(resolved)!.instructions).toMatch(/design token/i);
  });

  // Silently running without the house rules produces work that looks right
  // and is not, which is the expensive kind of wrong.
  it('refuses a domain it does not have rather than ignoring it', () => {
    expect(() => withPrompt(roles.get('builder')!, undefined, 'mobile')).toThrow(/no domain/);
    expect(() => withPrompt(roles.get('builder')!, undefined, 'mobile')).toThrow(/frontend/);
  });

  // The position prompts must stay domain-neutral, or the overlay is pointless.
  it('keeps the position prompts free of any one domain', () => {
    for (const id of ['planner', 'builder', 'reviewer']) {
      const p = withPrompt(roles.get(id)!).instructions;
      expect(p, `${id} mentions design tokens`).not.toMatch(/design token/i);
      expect(p, `${id} mentions aria`).not.toMatch(/\baria\b/i);
      expect(p, `${id} mentions migrations`).not.toMatch(/\bmigration\b/i);
    }
  });
});

describe('model identifiers', () => {
  /**
   * Roles ask for the account default rather than naming a model.
   *
   * Shura drives the vendor CLIs, authenticated by the user's subscription,
   * and a subscription does not serve every model. Naming one it does not is
   * not a downgrade but a hard failure — the live CLI answers "The
   * 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT
   * account" and the run ends there.
   *
   * It also stops a shipped default from deciding what someone else's
   * subscription spends its quota on.
   */
  it('lets the subscription choose the model', () => {
    for (const role of roles.values()) {
      if (role.model === undefined) continue;
      expect(role.model.model, `${role.id}`).toBe('default');
    }
  });

  // Model IDs rot — gpt-5 and gemini-2.5-pro were both configured here and
  // both had been retired. Anyone overriding the default in their own config
  // is on their own, but nothing shipped should carry a name that can expire.
  it('ships no model name that can go stale', () => {
    for (const role of roles.values()) {
      const named = role.model?.model ?? 'default';
      expect(named, `${role.id}`).not.toMatch(/^(claude|gpt|gemini)-/);
    }
  });

  /**
   * `fallback` was declared in these files and never implemented — nothing
   * read it. A field that looks like a safety net and is not is worse than no
   * field, so it is gone rather than left to be trusted.
   */
  it('declares no fallback, because nothing ever honoured one', () => {
    for (const role of roles.values()) {
      expect(role.model?.fallback, `${role.id}`).toBeUndefined();
    }
  });
});

describe('prompt resolution', () => {
  // Leaving this unresolved sends the model a filename as its entire system
  // prompt. The agent still runs; it just has no instructions.
  it('replaces the instructions path with the prompt itself', () => {
    const role = withPrompt(roles.get('reviewer')!);
    expect(role.instructions).not.toMatch(/^prompts\//);
    expect(role.instructions).toContain('you cannot edit anything');
  });

  it('resolves a prompt for every shipped role', () => {
    for (const role of roles.values()) {
      expect(() => withPrompt(role), role.id).not.toThrow();
      expect(withPrompt(role).instructions.length, role.id).toBeGreaterThan(50);
    }
  });

  // The reviewer prompt is the single biggest lever on the eval numbers.
  it('gives the reviewer explicit categories rather than a confidence threshold', () => {
    const p = withPrompt(roles.get('reviewer')!).instructions;
    expect(p).toContain('## What to report');
    expect(p).toContain('## What to skip');
    expect(p).toMatch(/blocker/);
    // Few-shot examples, including the ambiguous cases.
    expect(p).toContain('Do not report this');
    expect(p.toLowerCase()).not.toContain('be conservative');
    expect(p.toLowerCase()).not.toContain('confidence score');
  });
});
