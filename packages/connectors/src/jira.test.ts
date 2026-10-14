import { describe, expect, it, vi } from 'vitest';
import { adfToText, textToAdf } from './adf.js';
import { JiraError, JiraTracker, parseCriteria } from './tracker-jira.js';

/** A Jira that answers from a script, so the suite needs no network. */
function fakeJira(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    calls.push({
      url: path,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    });
    const route = routes[`${method} ${path}`] ?? routes[path];
    const status = route?.status ?? (route === undefined ? 404 : 200);
    return new Response(JSON.stringify(route?.body ?? {}), { status });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

const base = { site: 'https://x.atlassian.net', email: 'a@b.c', token: 't', project: 'KAN' };

describe('ADF, both directions', () => {
  // Jira stores descriptions as a node tree. Treating the field as a string
  // puts "[object Object]" in the ticket, which only shows up in production.
  it('flattens a description to text, keeping list bullets', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro line.' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Given X when Y then Z' }] }] },
          ],
        },
      ],
    };
    const text = adfToText(doc);
    expect(text).toContain('Intro line.');
    expect(text).toContain('Given X when Y then Z');
  });

  it('survives an empty description', () => {
    expect(adfToText({ type: 'doc', version: 1, content: [] })).toBe('');
  });

  it('builds a comment Jira will accept', () => {
    const doc = textToAdf('line one\nline two') as { content: { content?: unknown[] }[] };
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.content).toEqual([{ type: 'text', text: 'line one' }]);
  });

  // Jira rejects a paragraph carrying an empty content array.
  it('omits the content array for a blank line rather than sending []', () => {
    const doc = textToAdf('a\n\nb') as { content: { content?: unknown[] }[] };
    expect(doc.content[1]).toEqual({ type: 'paragraph' });
  });
});

describe('criteria come from the description', () => {
  it('keeps only lines in Given/When/Then form', () => {
    const criteria = parseCriteria(
      [
        'Some prose for humans.',
        '- Given a filter, when listed, then only matches are returned',
        '- the code should be clean',
        '* Given none, when listed, then all are returned',
      ].join('\n'),
    );
    expect(criteria).toHaveLength(2);
    expect(criteria[0]).toMatch(/^Given a filter/);
  });

  // A criterion the reviewer cannot check produces a verdict that reads as
  // meaningful and is not.
  it('returns nothing when a ticket has no checkable criteria', () => {
    expect(parseCriteria('Make the orders page better.')).toEqual([]);
  });
});

describe('reading and writing', () => {
  it('reads an issue into our shape', async () => {
    const { fetch } = fakeJira({
      '/rest/api/3/issue/KAN-1': {
        body: {
          key: 'KAN-1',
          fields: {
            summary: 'Filter orders',
            status: { name: 'To Do' },
            issuetype: { name: 'Story' },
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Given a, when b, then c' }] }],
            },
          },
        },
      },
    });
    const item = await new JiraTracker({ ...base, fetch }).get('KAN-1');
    expect(item).toMatchObject({ key: 'KAN-1', title: 'Filter orders', state: 'To Do' });
    expect(item?.criteria).toHaveLength(1);
  });

  it('reports a missing issue as absent rather than throwing', async () => {
    const { fetch } = fakeJira({});
    expect(await new JiraTracker({ ...base, fetch }).get('KAN-9')).toBeUndefined();
  });

  it('raises other failures with the status', async () => {
    const { fetch } = fakeJira({ '/rest/api/3/issue/KAN-1': { status: 403 } });
    await expect(new JiraTracker({ ...base, fetch }).get('KAN-1')).rejects.toThrow(JiraError);
  });

  it('posts a comment as ADF, not a string', async () => {
    const { fetch, calls } = fakeJira({ 'POST /rest/api/3/issue/KAN-1/comment': { body: {} } });
    await new JiraTracker({ ...base, fetch }).comment('KAN-1', 'checks passed');
    const sent = calls.find((c) => c.method === 'POST')?.body as { body: { type: string } };
    expect(sent.body.type).toBe('doc');
  });
});

describe('transitions', () => {
  const transitions = {
    '/rest/api/3/issue/KAN-1/transitions': {
      body: {
        transitions: [
          { id: '11', name: 'Start', to: { name: 'In Progress' } },
          { id: '21', name: 'Review', to: { name: 'In Review' } },
        ],
      },
    },
  };

  // Transition ids are per-workflow, so the target has to be looked up.
  it('looks up the transition id for a target status', async () => {
    const { fetch, calls } = fakeJira(transitions);
    expect(await new JiraTracker({ ...base, fetch }).transition('KAN-1', 'in_progress')).toBe(true);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ transition: { id: '11' } });
  });

  // A workflow that cannot represent one of our states is a configuration gap,
  // not a run failure.
  it('returns false for a status this workflow does not offer', async () => {
    const { fetch } = fakeJira(transitions);
    expect(await new JiraTracker({ ...base, fetch }).transition('KAN-1', 'done')).toBe(false);
  });

  it('honours a statusMap for a Jira that names things differently', async () => {
    const { fetch, calls } = fakeJira({
      '/rest/api/3/issue/KAN-1/transitions': {
        body: { transitions: [{ id: '31', name: 'x', to: { name: 'Code Review' } }] },
      },
    });
    const jira = new JiraTracker({ ...base, fetch, statusMap: { in_review: 'Code Review' } });
    expect(await jira.transition('KAN-1', 'in_review')).toBe(true);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ transition: { id: '31' } });
  });

  it('reports which of our states a workflow can represent', async () => {
    const { fetch } = fakeJira(transitions);
    expect(await new JiraTracker({ ...base, fetch }).availableStates('KAN-1')).toEqual([
      'in_progress',
      'in_review',
    ]);
  });
});
