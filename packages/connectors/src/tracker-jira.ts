/**
 * Jira Cloud.
 *
 * Reads work and writes progress, and nothing else. Forge does not create or
 * edit stories: Jira owns those fields, Forge owns status and commentary. One
 * writer per field means there is no two-way sync to reconcile, which is the
 * trap the architecture doc's own risk table names.
 *
 * Acceptance criteria come from the description, parsed for Given/When/Then.
 * No custom field to configure, so this works against any Jira — and a ticket
 * whose criteria are not checkable is refused rather than producing a verdict
 * that cannot mean anything.
 */

import type { Tracker, TrackerItem, TrackerState } from '@forge/ports';
import { adfToText, textToAdf } from './adf.js';

export interface JiraOptions {
  readonly site: string;
  readonly email: string;
  readonly token: string;
  readonly project: string;
  /** Our state -> this Jira's status name. Falls back to the defaults below. */
  readonly statusMap?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

const DEFAULT_STATUS: Readonly<Record<TrackerState, string>> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  blocked: 'To Do',
};

export class JiraError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Jira responded ${status}: ${detail}`);
    this.name = 'JiraError';
  }
}

export class JiraTracker implements Tracker {
  readonly #o: JiraOptions;
  readonly #fetch: typeof fetch;

  constructor(options: JiraOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async get(key: string): Promise<TrackerItem | undefined> {
    const res = await this.#call(`/rest/api/3/issue/${encodeURIComponent(key)}`);
    if (res.status === 404) return undefined;
    const issue = (await this.#json(res)) as {
      key: string;
      fields: {
        summary: string;
        description?: unknown;
        status?: { name?: string };
        issuetype?: { name?: string };
      };
    };

    return {
      key: issue.key,
      title: issue.fields.summary,
      criteria: parseCriteria(adfToText(issue.fields.description)),
      state: issue.fields.status?.name ?? 'unknown',
      type: issue.fields.issuetype?.name ?? 'unknown',
    };
  }

  async comment(key: string, body: string): Promise<void> {
    const res = await this.#call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: textToAdf(body) }),
    });
    await this.#json(res);
  }

  /**
   * Jira transitions are per-workflow and identified by id, so the target
   * status has to be looked up rather than assumed. A status this workflow
   * does not offer returns false instead of throwing: a tracker that cannot
   * represent one of our states is a configuration gap, not a run failure.
   */
  async transition(key: string, state: TrackerState): Promise<boolean> {
    const wanted = (this.#o.statusMap?.[state] ?? DEFAULT_STATUS[state]).toLowerCase();

    const res = await this.#call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const { transitions } = (await this.#json(res)) as {
      transitions: { id: string; name: string; to: { name: string } }[];
    };

    const match =
      transitions.find((t) => t.to.name.toLowerCase() === wanted) ??
      transitions.find((t) => t.name.toLowerCase() === wanted);
    if (match === undefined) return false;

    const applied = await this.#call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!applied.ok) throw new JiraError(applied.status, await applied.text());
    return true;
  }

  /** Which of our states this project's workflow can actually represent. */
  async availableStates(key: string): Promise<TrackerState[]> {
    const res = await this.#call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const { transitions } = (await this.#json(res)) as { transitions: { to: { name: string } }[] };
    const names = new Set(transitions.map((t) => t.to.name.toLowerCase()));
    return (Object.keys(DEFAULT_STATUS) as TrackerState[]).filter((s) =>
      names.has((this.#o.statusMap?.[s] ?? DEFAULT_STATUS[s]).toLowerCase()),
    );
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const auth = Buffer.from(`${this.#o.email}:${this.#o.token}`).toString('base64');
    return this.#fetch(`${this.#o.site.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  async #json(res: Response): Promise<unknown> {
    if (!res.ok) throw new JiraError(res.status, (await res.text()).slice(0, 400));
    const text = await res.text();
    return text === '' ? {} : JSON.parse(text);
  }
}

/**
 * Pulls Given/When/Then lines out of a description.
 *
 * Anything else is prose for humans and is ignored — a criterion the reviewer
 * cannot check is worse than no criterion, because it produces a verdict that
 * reads as meaningful and is not.
 */
export function parseCriteria(description: string): string[] {
  return description
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => {
      const lower = l.toLowerCase();
      return lower.includes('given') && lower.includes('when') && lower.includes('then');
    });
}
