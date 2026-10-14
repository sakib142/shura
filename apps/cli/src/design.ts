/**
 * `shura design` — a design extract in, a verified backlog out.
 *
 * The producer proposes; a verifier on a different vendor judges against the
 * Definition of Ready; only a passing verdict creates anything in the tracker.
 * The stories are written by deterministic code after the verdict, never by
 * the agent that proposed them.
 */

import { createPool, isReachable } from '@shura/db';
import { FigmaExtractSource, JiraTracker, renderExtract, textToAdf } from '@shura/connectors';
import { loadConfig } from '@shura/config';
import { loadAllRoles, withPrompt } from '@shura/roles';
import { designToBacklog, renderProposal, type Proposal } from '@shura/orchestrator';
import type { AgentEvent } from '@shura/ports';
import { configuredRole, runtimeFor } from './run.js';

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function onEvent(actor: string, e: AgentEvent): void {
  const a = actor.padEnd(10);
  if (e.t === 'tool_call') console.log(`${stamp()}  ${a} tool  ${e.tool}`);
  else if (e.t === 'tool_result' && !e.ok) console.log(`${stamp()}  ${a} DENIED ${e.denialReason ?? ''}`);
  else if (e.t === 'usage') console.log(`${stamp()}  ${a} ${e.tokensIn}/${e.tokensOut} tok  $${e.usd.toFixed(4)}`);
  else if (e.t === 'error') console.log(`${stamp()}  ${a} ERROR ${e.message}`);
}

function flag(args: string[], name: string): string | undefined {
  const exact = args.find((a) => a.startsWith(`--${name}=`));
  if (exact !== undefined) return exact.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function design(args: string[]): Promise<number> {
  const loaded = loadConfig(flag(args, 'config'));
  const config = loaded.config;
  const extractPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));

  if (extractPath === undefined) {
    console.error('usage: shura design <extract.json> [--create] [--dry-run]');
    console.error('\n  --create   write the accepted stories to the tracker');
    return 2;
  }

  const roles = loadAllRoles();
  const producer = configuredRole(config, 'backlog-author', withPrompt(roles.get('backlog-author')!));
  const verifier = configuredRole(config, 'backlog-reviewer', withPrompt(roles.get('backlog-reviewer')!));

  if (producer.agent.runtime === verifier.agent.runtime) {
    console.error(
      `backlog-author and backlog-reviewer are both on "${producer.agent.runtime}".\n` +
        'A verifier must run a different vendor. Change one in shura.config.yaml under `agents`.',
    );
    return 2;
  }

  const pool = createPool();
  if (!(await isReachable(pool))) {
    console.error('postgres unreachable — run: pnpm db:up && pnpm migrate');
    await pool.end();
    return 1;
  }

  const extract = await new FigmaExtractSource(extractPath).get();
  const rendered = renderExtract(extract);

  console.log(
    `design    ${extract.fileName}\n` +
      `section   ${extract.nodeName}\n` +
      `extracted ${extract.extractedAt}\n` +
      `producer  backlog-author      ${producer.agent.runtime}/${producer.agent.model}\n` +
      `verifier  backlog-reviewer    ${verifier.agent.runtime}/${verifier.agent.model}\n`,
  );

  try {
    const result = await designToBacklog({
      pool,
      extract,
      renderedExtract: rendered,
      producer: { runtime: runtimeFor(producer.agent), role: producer.role, name: 'ba-01' },
      verifier: { runtime: runtimeFor(verifier.agent), role: verifier.role, name: 'br-01' },
      loopCap: config.budgets.loop_cap,
      onEvent,
      onPhase: (t) => console.log(`${stamp()}  ${t}`),
    });

    if (result.proposal !== undefined) {
      console.log(`\n${renderProposal(result.proposal)}`);
    }

    if (!result.accepted) {
      console.log(`\nNOT ACCEPTED after ${result.attempts} attempt(s) — ${result.reason ?? 'rejected'}`);
      for (const c of result.verdict?.submission.criteria ?? []) {
        if (c.status === 'not_met' && c.finding !== undefined) {
          console.log(`  [${c.index}] ${c.finding.claim}`);
        }
      }
      console.log(`cost $${result.usd.toFixed(4)}`);
      return 1;
    }

    console.log(`\nACCEPTED after ${result.attempts} attempt(s)  $${result.usd.toFixed(4)}`);

    if (!args.includes('--create')) {
      console.log('\nNothing written. Re-run with --create to put these in the tracker.');
      return 0;
    }
    if (config.tracker.type !== 'jira') {
      console.log('\ntracker is not jira; nothing written.');
      return 0;
    }

    const created = await createInJira(config, extract.nodeName, result.proposal!);
    for (const key of created) console.log(`  created ${key}`);
    return 0;
  } catch (err) {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

/** Admission: deterministic code writes the stories, after the verdict. */
async function createInJira(
  config: ReturnType<typeof loadConfig>['config'],
  sectionName: string,
  proposal: Proposal,
): Promise<string[]> {
  if (config.tracker.type !== 'jira') return [];
  const email = process.env[config.tracker.emailEnv] ?? '';
  const token = process.env[config.tracker.tokenEnv] ?? '';
  const site = config.tracker.site.replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  const keys: string[] = [];
  for (const story of proposal.stories) {
    const body = [
      `From the design section "${sectionName}".`,
      '',
      'Acceptance criteria:',
      '',
      ...story.criteria.map((c) => `- ${c}`),
      ...(story.notes === undefined ? [] : ['', `Notes: ${story.notes}`]),
      ...(proposal.openQuestions.length === 0
        ? []
        : ['', 'Open questions raised during backlog creation:', ...proposal.openQuestions.map((q) => `- ${q}`)]),
    ].join('\n');

    const res = await fetch(`${site}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: config.tracker.project },
          issuetype: { name: 'Story' },
          summary: story.title,
          description: textToAdf(body),
        },
      }),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    keys.push(((await res.json()) as { key: string }).key);
  }

  void JiraTracker;
  return keys;
}
