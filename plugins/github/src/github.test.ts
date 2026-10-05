import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolContext, handle } from '@orbit/plugin-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tools } from './tools';

const TOKEN = 'ghp_FAKEtoken0123456789abcdef';
/** A string matcher typed as a string (expect's asymmetric matchers are `any`). */
const matching = (re: RegExp) => expect.stringMatching(re) as unknown as string;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}
type Route = (req: Seen) => { status?: number; body: unknown };

let server: Server;
let apiUrl: string;
let seen: Seen[];
let routes: Record<string, Route>;
let ctx: ToolContext;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      const s: Seen = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      };
      seen.push(s);
      const route = routes[`${s.method} ${s.path}`];
      const out = route ? route(s) : { status: 404, body: { message: 'Not Found' } };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  seen = [];
  routes = {};
  ctx = {
    workspace: tmpdir(),
    env: { GITHUB_API_URL: apiUrl, GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: 'acme/widgets' },
  };
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await handle(
    { name: 'github', version: '0', tools },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  const text = result.content[0]?.text ?? '';
  // The token never appears in any result or error, whatever happened.
  expect(text).not.toContain(TOKEN);
  return { text, isError: result.isError };
};

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  state: 'open',
  user: { login: 'alice' },
  comments: 3,
  labels: [{ name: 'bug' }],
  ...extra,
});

describe('github plugin: REST calls', () => {
  it('lists issues with the API version, user agent and bearer token; pull requests left out', async () => {
    routes['GET /repos/acme/widgets/issues'] = () => ({
      body: [
        issue(12),
        issue(13, { pull_request: { url: 'x' } }),
        issue(14, { comments: 1, labels: [] }),
      ],
    });
    const r = await call('list_issues', { limit: 5 });
    expect(r).toEqual({
      isError: false,
      text: '#12 [open] Issue 12 — by alice, 3 comments · bug\n#14 [open] Issue 14 — by alice, 1 comment',
    });
    const req = seen[0]!;
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['x-github-api-version']).toBe('2022-11-28');
    expect(req.headers['user-agent']).toBe('orbit-plugin-github');
    expect(req.headers.accept).toBe('application/vnd.github+json');
    expect(req.query.get('state')).toBe('open');
  });

  it('sends no Authorization header without a token, and takes the repo argument over the setting', async () => {
    ctx = { workspace: tmpdir(), env: { GITHUB_API_URL: apiUrl } };
    routes['GET /repos/octo/hello.world/pulls'] = () => ({
      body: [
        {
          number: 5,
          title: 'Add things',
          state: 'open',
          draft: true,
          user: { login: 'bob' },
          head: { ref: 'orbit/demo' },
          base: { ref: 'main' },
        },
        {
          number: 4,
          title: 'Old',
          state: 'closed',
          merged_at: '2026-01-01T00:00:00Z',
          user: null,
          head: { ref: 'fix' },
          base: { ref: 'main' },
        },
      ],
    });
    const r = await call('list_pull_requests', {
      repo: 'octo/hello.world',
      state: 'all',
      limit: 2,
    });
    expect(r.text).toBe(
      '#5 [draft] Add things — by bob, orbit/demo → main\n#4 [merged] Old — by ghost, fix → main',
    );
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.query.get('per_page')).toBe('2');
  });

  it('needs a valid repository: a clear error, and no request', async () => {
    ctx = { workspace: tmpdir(), env: { GITHUB_API_URL: apiUrl } };
    expect(await call('list_issues')).toMatchObject({
      isError: true,
      text: matching(/GITHUB_REPOSITORY/),
    });
    for (const repo of ['acme', 'acme/../x', '-acme/x', 'acme/x/y', 'acme/..', 'ac me/x']) {
      expect(await call('list_issues', { repo })).toMatchObject({ isError: true });
    }
    ctx = { workspace: tmpdir(), env: { GITHUB_API_URL: apiUrl, GITHUB_REPOSITORY: 'not a repo' } };
    expect(await call('list_issues')).toMatchObject({
      isError: true,
      text: matching(/owner\/name/),
    });
    expect(seen).toEqual([]);
  });

  it('reads an issue with its latest comments, truncating long bodies and stripping control characters', async () => {
    routes['GET /repos/acme/widgets/issues/7'] = () => ({
      body: issue(7, {
        comments: 101,
        body: `\u001b[31mred${'x'.repeat(9000)}`,
        html_url: 'https://github.com/acme/widgets/issues/7',
      }),
    });
    routes['GET /repos/acme/widgets/issues/7/comments'] = (req) => {
      const page = Number(req.query.get('page'));
      const all = Array.from({ length: 101 }, (_, i) => ({
        user: { login: `u${i}` },
        body: `comment ${i}`,
        created_at: '2026-10-01T10:00:00Z',
      }));
      return { body: all.slice((page - 1) * 100, page * 100) };
    };
    const r = await call('get_issue', { number: 7, comments: 3 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^#7 \[open\] Issue 7\nBy alice · opened \? · updated \? · labels: bug/);
    expect(r.text).toContain('https://github.com/acme/widgets/issues/7');
    expect(r.text).not.toContain('\u001b');
    expect(r.text).toMatch(/truncated, \d+ more characters/);
    expect(r.text).toContain('Comments (latest 3 of 101):');
    expect(r.text).toContain('— u98 on 2026-10-01:\ncomment 98');
    expect(r.text).toContain('comment 100');
    expect(r.text).not.toContain('comment 97');
    // The last page held one comment, so the one before it was read too.
    expect(
      seen.filter((s) => s.path.endsWith('/comments')).map((s) => s.query.get('page')),
    ).toEqual(['2', '1']);
  });

  it('reads a pull request with a summary of its changed files', async () => {
    routes['GET /repos/acme/widgets/pulls/9'] = () => ({
      body: {
        number: 9,
        title: 'Refactor',
        state: 'open',
        user: { login: 'carol' },
        head: { ref: 'orbit/dev', label: 'acme:orbit/dev' },
        base: { ref: 'main' },
        body: 'Makes it nicer.',
        commits: 2,
        additions: 12,
        deletions: 3,
        changed_files: 3,
        mergeable: true,
      },
    });
    routes['GET /repos/acme/widgets/pulls/9/files'] = () => ({
      body: [
        { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 1 },
        {
          filename: 'src/b.ts',
          status: 'renamed',
          previous_filename: 'src/old.ts',
          additions: 2,
          deletions: 2,
        },
      ],
    });
    const r = await call('get_pull_request', { number: 9 });
    expect(r.text).toBe(
      [
        '#9 [open] Refactor',
        'By carol · acme:orbit/dev → main · 2 commits, +12 −3 in 3 files · mergeable: yes',
        '',
        'Makes it nicer.',
        '',
        'Changed files:',
        'M src/a.ts (+10 −1)',
        'R src/old.ts → src/b.ts (+2 −2)',
        '… and 1 more files',
      ].join('\n'),
    );
  });

  it('comments and creates issues with exactly the given bodies', async () => {
    routes['POST /repos/acme/widgets/issues/3/comments'] = () => ({
      status: 201,
      body: { id: 1, html_url: 'https://github.com/acme/widgets/issues/3#issuecomment-1' },
    });
    routes['POST /repos/acme/widgets/issues'] = () => ({
      status: 201,
      body: { number: 44, html_url: 'https://github.com/acme/widgets/issues/44' },
    });
    expect((await call('comment_on_issue', { number: 3, body: 'Looks good' })).text).toBe(
      'Commented on #3 in acme/widgets: https://github.com/acme/widgets/issues/3#issuecomment-1',
    );
    expect(seen[0]).toMatchObject({ method: 'POST', body: { body: 'Looks good' } });
    expect(
      (await call('create_issue', { title: 'Bug', body: 'It broke', labels: ['bug'] })).text,
    ).toBe('Created issue #44 in acme/widgets: https://github.com/acme/widgets/issues/44');
    expect(seen[1]!.body).toEqual({ title: 'Bug', body: 'It broke', labels: ['bug'] });
    expect(seen.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("opens a pull request from the workspace's branch into the default branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-gh-pr-'));
    try {
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@x',
      };
      const repo = join(dir, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'trunk', repo], { env });
      execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
      // A worktree Bot: its .git lives in the owner's repository, outside the workspace.
      const wt = join(dir, 'wt');
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'orbit/demo', wt], { env });
      ctx = { ...ctx, workspace: wt };
      routes['GET /repos/acme/widgets'] = () => ({ body: { default_branch: 'trunk' } });
      routes['POST /repos/acme/widgets/pulls'] = () => ({
        status: 201,
        body: { number: 8, html_url: 'https://github.com/acme/widgets/pull/8' },
      });
      expect((await call('create_pull_request', { title: 'Feature', body: 'Adds it' })).text).toBe(
        'Opened pull request #8 in acme/widgets (orbit/demo → trunk): https://github.com/acme/widgets/pull/8',
      );
      expect(seen.at(-1)!.body).toEqual({
        title: 'Feature',
        body: 'Adds it',
        head: 'orbit/demo',
        base: 'trunk',
        draft: false,
      });
      seen = [];
      await call('create_pull_request', {
        title: 'X',
        head: 'octo:topic',
        base: 'main',
        draft: true,
      });
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /repos/acme/widgets/pulls']);
      expect(seen[0]!.body).toMatchObject({ head: 'octo:topic', base: 'main', draft: true });
      expect(await call('create_pull_request', { title: 'X', head: '--force' })).toMatchObject({
        isError: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps GitHub errors to clear messages without the token', async () => {
    routes['GET /repos/acme/widgets/issues/1'] = () => ({
      status: 401,
      body: { message: `Bad credentials: ${TOKEN}` },
    });
    expect(await call('get_issue', { number: 1 })).toMatchObject({
      isError: true,
      text: matching(/refused the credentials \(401\).*GITHUB_TOKEN/),
    });
    expect(await call('get_issue', { number: 2 })).toMatchObject({
      isError: true,
      text: matching(/could not find issue #2 in acme\/widgets \(404\)/),
    });
    routes['POST /repos/acme/widgets/pulls'] = () => ({
      status: 422,
      body: { message: `Validation Failed for ${TOKEN}` },
    });
    const r = await call('create_pull_request', { title: 'X', head: 'a', base: 'b' });
    expect(r).toMatchObject({
      isError: true,
      text: matching(/rejected the request \(422\)/),
    });
    expect(r.text).toContain('[redacted]');
    routes['GET /repos/acme/widgets/issues'] = () => ({
      status: 403,
      body: { message: 'API rate limit exceeded' },
    });
    expect(await call('list_issues')).toMatchObject({
      isError: true,
      text: matching(/\(403\): API rate limit exceeded/),
    });
    routes['GET /repos/acme/widgets/pulls'] = () => ({ body: { not: 'a list' } });
    expect(await call('list_pull_requests')).toMatchObject({
      isError: true,
      text: matching(/unexpected shape/),
    });
    ctx = { ...ctx, env: { ...ctx.env, GITHUB_API_URL: 'http://127.0.0.1:1' } };
    expect(await call('list_issues')).toMatchObject({
      isError: true,
      text: matching(/Could not reach GitHub at 127\.0\.0\.1:1/),
    });
  });

  it('refuses a token that could inject a header', async () => {
    ctx = { ...ctx, env: { ...ctx.env, GITHUB_TOKEN: 'abc\r\nX-Evil: 1' } };
    expect(await call('list_issues')).toMatchObject({
      isError: true,
      text: matching(/GITHUB_TOKEN is malformed/),
    });
    expect(seen).toEqual([]);
  });
});
