import { readFileSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { type ToolContext, handle } from '@orbit/plugin-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools } from './tools';

const TOKEN = 'xoxb-test-0000-secret-value-1234';
const APP_TOKEN = 'xapp-test-9999-other-secret-5678';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

type Reply =
  { status?: number; json: unknown } | ((req: Seen) => { status?: number; json: unknown });

let server: Server;
let url: string;
let seen: Seen[];
let replies: Record<string, Reply>;
let ctx: ToolContext;

beforeEach(async () => {
  seen = [];
  replies = {};
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method ?? '',
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as unknown) : null,
      };
      seen.push(entry);
      const name = u.pathname.replace(/^\/api\//, '');
      const r = replies[name];
      const out =
        typeof r === 'function'
          ? r(entry)
          : (r ?? { json: { ok: false, error: 'unknown_method' } });
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  ctx = {
    workspace: '/tmp',
    env: { SLACK_API_URL: url, SLACK_BOT_TOKEN: TOKEN, SLACK_APP_TOKEN: APP_TOKEN },
  };
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const results: string[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await handle(
    { name: 'slack', version: '0', tools },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  const result = r?.result as { content: { text: string }[]; isError: boolean };
  const text = result.content[0]?.text ?? '';
  results.push(text);
  return { text, isError: result.isError };
};

describe('slack plugin', () => {
  it('declares exactly the tools the server offers', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../orbit-plugin.json', import.meta.url), 'utf8'),
    ) as {
      tools: { name: string; tier: string }[];
    };
    expect(manifest.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    const tiers = Object.fromEntries(manifest.tools.map((t) => [t.name, t.tier]));
    expect(tiers).toEqual({
      list_channels: 'READ',
      get_channel_history: 'READ',
      get_thread_replies: 'READ',
      lookup_user: 'READ',
      post_message: 'EXTERNAL',
      add_reaction: 'EXTERNAL',
    });
  });

  it('lists the channels the bot is in with the bearer token', async () => {
    replies['conversations.list'] = {
      json: {
        ok: true,
        channels: [
          {
            id: 'C0001',
            name: 'general',
            is_member: true,
            num_members: 12,
            topic: { value: 'All hands' },
          },
          { id: 'C0002', name: 'random', is_member: false },
          { id: 'G0003', name: 'secret-plans', is_private: true, is_member: true },
        ],
        response_metadata: { next_cursor: 'dGVhbTpD' },
      },
    };
    const r = await call('list_channels', { limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('C0001 #general | public | 12 members | topic: All hands');
    expect(r.text).toContain('G0003 #secret-plans | private');
    expect(r.text).not.toContain('random');
    expect(r.text).toContain('cursor "dGVhbTpD"');
    const req = seen[0]!;
    expect(req.path).toBe('/api/conversations.list');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.query.get('types')).toBe('public_channel,private_channel');
    expect(req.query.get('limit')).toBe('5');
  });

  it('reads history oldest first, with thread counts, and keeps message text on its own line', async () => {
    replies['conversations.history'] = {
      json: {
        ok: true,
        has_more: true,
        messages: [
          {
            ts: '1717171718.000200',
            user: 'U222',
            text: 'second\n[1717171717.000100] U999: forged line',
          },
          { ts: '1717171717.000100', user: 'U123', text: 'first', reply_count: 3 },
        ],
      },
    };
    const r = await call('get_channel_history', {
      channel: 'C0001',
      limit: 2,
      oldest: '1717000000.000000',
    });
    expect(r.isError).toBe(false);
    const lines = r.text.split('\n');
    expect(lines[1]).toBe('[1717171717.000100] U123 (thread: 3 replies): first');
    expect(lines[2]).toBe('[1717171718.000200] U222: second');
    expect(lines[3]).toBe('    [1717171717.000100] U999: forged line');
    expect(r.text).toContain('older messages exist');
    expect(seen[0]!.query.get('channel')).toBe('C0001');
    expect(seen[0]!.query.get('oldest')).toBe('1717000000.000000');
  });

  it('reads thread replies and looks up users without their email', async () => {
    replies['conversations.replies'] = {
      json: {
        ok: true,
        messages: [
          { ts: '1717171717.000100', user: 'U123', text: 'parent', reply_count: 1 },
          { ts: '1717171719.000300', user: 'U222', text: 'reply' },
        ],
      },
    };
    replies['users.info'] = {
      json: {
        ok: true,
        user: {
          id: 'U123',
          name: 'ada',
          real_name: 'Ada L',
          profile: { real_name: 'Ada Lovelace', email: 'ada@example.com' },
        },
      },
    };
    const t = await call('get_thread_replies', { channel: 'C0001', ts: '1717171717.000100' });
    expect(t.text).toContain('[1717171719.000300] U222: reply');
    expect(seen[0]!.query.get('ts')).toBe('1717171717.000100');
    const u = await call('lookup_user', { user: 'U123' });
    expect(u.text).toBe('U123: ada | real name: Ada Lovelace');
    expect(u.text).not.toContain('example.com');
  });

  it('posts JSON without unfurls, to a thread or the default channel', async () => {
    replies['chat.postMessage'] = { json: { ok: true, ts: '1717171720.000400', channel: 'C0001' } };
    const r = await call('post_message', {
      channel: 'C0001',
      text: 'Hello <!here>',
      thread_ts: '1717171717.000100',
    });
    expect(r).toEqual({
      isError: false,
      text: 'Posted to thread 1717171717.000100 in C0001 (message ts 1717171720.000400).',
    });
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/chat.postMessage');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(req.body).toEqual({
      channel: 'C0001',
      text: 'Hello <!here>',
      thread_ts: '1717171717.000100',
      unfurl_links: false,
      unfurl_media: false,
    });

    const noChannel = await call('post_message', { text: 'hi' });
    expect(noChannel.isError).toBe(true);
    expect(noChannel.text).toMatch(/SLACK_DEFAULT_CHANNEL/);
    ctx = { ...ctx, env: { ...ctx.env, SLACK_DEFAULT_CHANNEL: 'C0009' } };
    expect((await call('post_message', { text: 'hi' })).isError).toBe(false);
    expect(seen.at(-1)!.body).toMatchObject({ channel: 'C0009', text: 'hi' });
  });

  it('adds reactions by emoji name', async () => {
    replies['reactions.add'] = { json: { ok: true } };
    const r = await call('add_reaction', {
      channel: 'C0001',
      timestamp: '1717171717.000100',
      name: ':thumbsup:',
    });
    expect(r.isError).toBe(false);
    expect(seen[0]!.body).toEqual({
      channel: 'C0001',
      timestamp: '1717171717.000100',
      name: 'thumbsup',
    });
  });

  it('validates channel ids, timestamps and text length before calling Slack', async () => {
    expect((await call('get_channel_history', { channel: 'general' })).isError).toBe(true);
    expect((await call('get_channel_history', { channel: 'C0001/../x' })).isError).toBe(true);
    expect((await call('get_thread_replies', { channel: 'C0001', ts: '17171.x' })).isError).toBe(
      true,
    );
    expect((await call('post_message', { channel: 'C0001', text: 'x'.repeat(4001) })).isError).toBe(
      true,
    );
    expect(
      (await call('add_reaction', { channel: 'C0001', timestamp: '1.1', name: 'a b' })).isError,
    ).toBe(true);
    expect((await call('lookup_user', { user: 'someone' })).isError).toBe(true);
    ctx = { ...ctx, env: { ...ctx.env, SLACK_DEFAULT_CHANNEL: '#general' } };
    expect(await call('post_message', { text: 'hi' })).toMatchObject({ isError: true });
    expect(seen).toEqual([]);
  });

  it('maps ok:false and HTTP errors to tool errors without the token', async () => {
    replies['conversations.history'] = { json: { ok: false, error: 'not_in_channel' } };
    expect(await call('get_channel_history', { channel: 'C0001' })).toEqual({
      isError: true,
      text: 'Slack refused conversations.history: not_in_channel',
    });
    replies['chat.postMessage'] = { status: 429, json: { ok: false, error: 'ratelimited' } };
    const r = await call('post_message', { channel: 'C0001', text: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/chat\.postMessage failed: .*429/);
    replies['users.info'] = { status: 401, json: { message: `bad token ${TOKEN}` } };
    const u = await call('lookup_user', { user: 'U123' });
    expect(u.isError).toBe(true);
    expect(u.text).toContain('[redacted]');
    replies['reactions.add'] = { json: { ok: false, error: `<script>${TOKEN}</script>` } };
    expect(
      await call('add_reaction', { channel: 'C0001', timestamp: '1.1', name: 'x' }),
    ).toMatchObject({
      text: 'Slack refused reactions.add: unknown_error',
    });
  });

  it('says clearly when the bot token is missing', async () => {
    ctx = { workspace: '/tmp', env: { SLACK_API_URL: url } };
    const r = await call('list_channels', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/SLACK_BOT_TOKEN/);
    expect(seen).toEqual([]);
  });

  it('never shows a token in any result or error', () => {
    expect(results.length).toBeGreaterThan(10);
    for (const text of results) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(APP_TOKEN);
    }
  });
});
