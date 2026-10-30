import { describe, expect, it, vi } from 'vitest';
import { GitHubError, GitHubVcs } from './vcs-github.js';

function fakeGitHub(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/repos/me/app', '') + u.search;
    const method = init?.method ?? 'GET';
    calls.push({
      path,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    });
    const route = routes[`${method} ${path}`] ?? routes[path];
    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? (route === undefined ? 404 : 200),
    });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

const base = {
  owner: 'me',
  repo: 'app',
  token: 'tok',
  checkCommand: ['true'] as const,
  workDir: '/tmp',
  // No real clone in these tests: they exercise the API surface, and the local
  // sync is covered by the live run.
  syncRef: async () => {},
};

describe('branches', () => {
  // The first live run failed here: the branch was created on GitHub and the
  // local clone had never heard of it, so the worktree could not be made.
  it('brings the new branch into the local clone', async () => {
    const synced: string[] = [];
    const { fetch } = fakeGitHub({
      '/git/ref/heads/main': { body: { object: { sha: 'abc' } } },
      'POST /git/refs': { status: 201, body: {} },
    });
    await new GitHubVcs({
      ...base, fetch, syncRef: async (r) => { synced.push(r); },
    }).createBranch('main', 'feature/X-1');
    expect(synced).toContain('feature/X-1');
  });

  it('creates a branch from the base sha', async () => {
    const { fetch, calls } = fakeGitHub({
      '/git/ref/heads/main': { body: { object: { sha: 'abc123' } } },
      'POST /git/refs': { status: 201, body: {} },
    });
    await new GitHubVcs({ ...base, fetch }).createBranch('main', 'feature/X-1');
    expect(calls.at(-1)?.body).toEqual({ ref: 'refs/heads/feature/X-1', sha: 'abc123' });
  });

  // A rework attempt reuses its branch; that must not be an error.
  it('tolerates a branch that already exists', async () => {
    const { fetch } = fakeGitHub({
      '/git/ref/heads/main': { body: { object: { sha: 'abc' } } },
      'POST /git/refs': { status: 422 },
    });
    await expect(new GitHubVcs({ ...base, fetch }).createBranch('main', 'x')).resolves.toBeUndefined();
  });

  // The commonest first-run failure, and the error should say so.
  it('explains that an empty repository has no branches', async () => {
    const { fetch } = fakeGitHub({ '/git/ref/heads/main': { status: 404 } });
    await expect(new GitHubVcs({ ...base, fetch }).createBranch('main', 'x')).rejects.toThrow(
      /add a README so it has one/,
    );
  });
});

describe('pull requests', () => {
  it('opens one and returns its number', async () => {
    const { fetch } = fakeGitHub({
      'POST /pulls': { status: 201, body: { number: 41, html_url: 'https://github.com/me/app/pull/41' } },
    });
    const ref = await new GitHubVcs({ ...base, fetch }).openChangeRequest({
      branch: 'feature/X-1', base: 'main', title: 'X-1', body: 'criteria',
    });
    expect(ref).toMatchObject({ id: '41', branch: 'feature/X-1' });
  });

  it('reuses the open pull request when one already exists', async () => {
    const { fetch } = fakeGitHub({
      'POST /pulls': { status: 422 },
      '/pulls?head=me:feature%2FX-1&state=open': { body: [{ number: 7, html_url: 'u' }] },
    });
    const ref = await new GitHubVcs({ ...base, fetch }).openChangeRequest({
      branch: 'feature/X-1', base: 'main', title: 't', body: 'b',
    });
    expect(ref.id).toBe('7');
  });

  it('raises other failures with the status', async () => {
    const { fetch } = fakeGitHub({ 'POST /pulls': { status: 403 } });
    await expect(
      new GitHubVcs({ ...base, fetch }).openChangeRequest({ branch: 'b', base: 'main', title: 't', body: '' }),
    ).rejects.toThrow(GitHubError);
  });

  it('asks for a draft when the caller wants one', async () => {
    const { fetch, calls } = fakeGitHub({
      'POST /pulls': { status: 201, body: { number: 42, html_url: 'u' } },
    });
    await new GitHubVcs({ ...base, fetch }).openChangeRequest({
      branch: 'feature/X-1', base: 'main', title: 't', body: 'b', draft: true,
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ draft: true });
  });

  it('does not send draft at all when none was asked for', async () => {
    const { fetch, calls } = fakeGitHub({
      'POST /pulls': { status: 201, body: { number: 42, html_url: 'u' } },
    });
    await new GitHubVcs({ ...base, fetch }).openChangeRequest({
      branch: 'feature/X-1', base: 'main', title: 't', body: 'b',
    });
    expect(calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('draft');
  });

  /*
   * Draft pull requests are not available on every plan — a private repository
   * on the free plan refuses `draft: true` with a 422. The caller asked for a
   * draft because a person has to take the work over, and that is served far
   * better by an ordinary pull request than by none at all, so the draft is
   * dropped and the pull request still opens.
   */
  it('falls back to an ordinary pull request where drafts are unavailable', async () => {
    const posted: unknown[] = [];
    const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST' && path.endsWith('/pulls')) {
        const body = JSON.parse(String(init.body)) as { draft?: boolean };
        posted.push(body);
        return body.draft === true
          ? new Response('{"message":"Draft pull requests are not supported in this repository."}', {
              status: 422,
            })
          : new Response(JSON.stringify({ number: 9, html_url: 'u' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });

    const ref = await new GitHubVcs({
      ...base,
      fetch: f as unknown as typeof fetch,
    }).openChangeRequest({ branch: 'feature/X-1', base: 'main', title: 't', body: 'b', draft: true });

    expect(ref.id).toBe('9');
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ draft: true });
    expect(posted[1]).not.toHaveProperty('draft');
  });

  /*
   * A 422 that is not about drafts still means "one is already open for this
   * branch", which is the rework case. Retrying it without the draft flag
   * would open nothing and lose the existing pull request.
   */
  it('still reuses an existing pull request when a draft was asked for', async () => {
    const { fetch } = fakeGitHub({
      'POST /pulls': { status: 422, body: { message: 'A pull request already exists.' } },
      '/pulls?head=me:feature%2FX-1&state=open': { body: [{ number: 7, html_url: 'u' }] },
    });
    const ref = await new GitHubVcs({ ...base, fetch }).openChangeRequest({
      branch: 'feature/X-1', base: 'main', title: 't', body: 'b', draft: true,
    });
    expect(ref.id).toBe('7');
  });
});

describe('diffs', () => {
  // The loop asks for a diff before a pull request exists, so this cannot be
  // the pull request's own file list.
  it('compares branch to base rather than reading a pull request', async () => {
    const { fetch } = fakeGitHub({
      '/compare/main...b': { body: { files: [{ filename: 'src/a.ts', patch: '@@ -1 +1 @@' }] } },
    });
    const diff = await new GitHubVcs({ ...base, fetch }).getDiff({ id: '41', branch: 'b', base: 'main' });
    expect(diff.files).toEqual(['src/a.ts']);
  });

  // The failure that cost six dollars and shipped three scratch files.
  it('refuses a pull request carrying generated files', async () => {
    const { fetch } = fakeGitHub({
      '/compare/main...b': { body: { files: [{ filename: 'src/a.ts' }, { filename: 'pnpm-lock.yaml' }] } },
    });
    await expect(
      new GitHubVcs({ ...base, fetch }).getDiff({ id: '41', branch: 'b', base: 'main' }),
    ).rejects.toThrow(/generated file/);
  });

  it('refuses node_modules too', async () => {
    const { fetch } = fakeGitHub({
      '/compare/main...b': { body: { files: [{ filename: 'node_modules/react/index.js' }] } },
    });
    await expect(
      new GitHubVcs({ ...base, fetch }).getDiff({ id: '41', branch: 'b', base: 'main' }),
    ).rejects.toThrow(/generated file/);
  });
});

describe('the verdict on the pull request', () => {
  // An APPROVE would carry the token owner's identity: it would look like a
  // human signed off. An agent must never appear to have done that.
  it('posts as a comment, never as an approval', async () => {
    const { fetch, calls } = fakeGitHub({ 'POST /pulls/41/reviews': { status: 200, body: {} } });
    await new GitHubVcs({ ...base, fetch }).postVerdict(
      { id: '41', branch: 'b', base: 'main' }, 'PASS 3/3', true,
    );
    expect((calls.at(-1)?.body as { event: string }).event).toBe('COMMENT');
  });
});
