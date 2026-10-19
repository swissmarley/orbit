import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../test/harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function bot(name: string, fixture: string, extra: Record<string, unknown> = {}) {
  if (!h) throw new Error('no harness');
  const res = await h.json<{ id: string }>('POST', '/v1/bots', {
    name,
    goal: 'Help me',
    mock: { fixture },
    approvals: { parkWindowSeconds: 0 },
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('conversations (ADR-020)', () => {
  it('a reply continues the conversation and lists with it; the latest turn only', async () => {
    h = harness();
    const id = await bot('Scout', 'pong');
    const first = await h.json<RunState>('POST', `/v1/bots/${id}/runs`, { prompt: 'Hello' });
    expect(first.status).toBe(202);
    await h.service.queue.idle();
    const reply = await h.json<RunState>('POST', `/v1/bots/${id}/runs`, {
      prompt: 'And now?',
      continues: first.body.runId,
    });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({
      conversationId: first.body.runId,
      continuesRunId: first.body.runId,
      prompt: 'And now?',
    });
    await h.service.queue.idle();
    const list = await h.json<RunState[]>('GET', `/v1/runs?conversation=${first.body.runId}`);
    expect(list.body.map((r) => r.runId).sort()).toEqual(
      [first.body.runId, reply.body.runId].sort(),
    );
    const done = h.service.store.getRun(reply.body.runId);
    expect(done?.status).toBe('completed');
    // The first turn has been answered: replying to it again would fork.
    const fork = await h.json<{ error: { code: string } }>('POST', `/v1/bots/${id}/runs`, {
      prompt: 'Other branch',
      continues: first.body.runId,
    });
    expect(fork.status).toBe(409);
    expect(fork.body.error.code).toBe('conflict');
  });

  it('refuses to answer a turn that waits for approval (409, with what to do)', async () => {
    h = harness();
    const id = await bot('Mailer', 'send-email');
    const run = await h.json<RunState>('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    expect(h.service.store.getRun(run.body.runId)?.status).toBe('waiting_approval');
    const res = await h.json<{ error: { code: string; hint: string | null } }>(
      'POST',
      `/v1/bots/${id}/runs`,
      { prompt: 'Did you send it?', continues: run.body.runId },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.hint).toMatch(/approvals/);
  });

  it("refuses another Bot's turn and an unknown one", async () => {
    h = harness();
    const a = await bot('Scout', 'pong');
    const b = await bot('Writer', 'pong');
    const theirs = await h.json<RunState>('POST', `/v1/bots/${b}/runs`, {});
    await h.service.queue.idle();
    const other = await h.call('POST', `/v1/bots/${a}/runs`, { continues: theirs.body.runId });
    expect(other.status).toBe(400);
    const unknown = await h.call('POST', `/v1/bots/${a}/runs`, { continues: 'run_unknown' });
    expect(unknown.status).toBe(404);
  });
});

describe("the Bot's computer (ADR-020)", () => {
  interface Status {
    state: string;
    runId: string | null;
    workspace: { kind: string; path: string; exists: boolean; network: string };
    web: { browser: string; fetch: boolean };
    shellCommand: string | null;
  }

  it('says what the computer is doing, where it works and how it reaches the web', async () => {
    h = harness();
    const id = await bot('Scout', 'pong');
    const before = await h.json<Status>('GET', `/v1/bots/${id}/computer`);
    expect(before.body).toMatchObject({
      state: 'idle',
      runId: null,
      workspace: { kind: 'directory', exists: false, network: 'none' },
      web: { browser: 'not_added', fetch: true },
      shellCommand: 'orbit shell scout',
    });
    await h.json('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    expect((await h.json<Status>('GET', `/v1/bots/${id}/computer`)).body.workspace.exists).toBe(
      true,
    );
    await h.json('POST', `/v1/bots/${id}/pause`);
    expect((await h.json<Status>('GET', `/v1/bots/${id}/computer`)).body.state).toBe('paused');
    await h.json('POST', '/v1/kill', { on: true });
    expect((await h.json<Status>('GET', `/v1/bots/${id}/computer`)).body.state).toBe('stopped');
  });

  it('a Run waiting for approval makes it "needs you", with that Run', async () => {
    h = harness();
    const id = await bot('Mailer', 'send-email', { tools: ['Read'] });
    const run = await h.json<{ runId: string }>('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    const s = await h.json<Status>('GET', `/v1/bots/${id}/computer`);
    expect(s.body).toMatchObject({
      state: 'needs_you',
      runId: run.body.runId,
      web: { fetch: false },
    });
  });

  it('lists and previews workspace files, marking what untrusted content wrote', async () => {
    h = harness();
    const id = await bot('Watcher', 'web-then-write');
    await h.json('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    // The demo replay wrote notes/page.md (after WebFetch: untrusted); the owner adds one.
    const { workspace } = (await h.json<Status>('GET', `/v1/bots/${id}/computer`)).body;
    writeFileSync(join(workspace.path, 'clean.md'), 'mine');
    const root = await h.json<{ entries: { name: string; kind: string; tainted: boolean }[] }>(
      'GET',
      `/v1/bots/${id}/computer/files`,
    );
    expect(root.status).toBe(200);
    expect(root.body.entries).toEqual([
      expect.objectContaining({ name: 'notes', kind: 'directory', tainted: true }),
      expect.objectContaining({ name: 'clean.md', kind: 'file', tainted: false }),
    ]);
    const notes = await h.json<{ entries: { path: string; tainted: boolean }[] }>(
      'GET',
      `/v1/bots/${id}/computer/files?path=notes`,
    );
    expect(notes.body.entries).toEqual([
      expect.objectContaining({ path: 'notes/page.md', tainted: true }),
    ]);
    const file = await h.json<{ text: string; tainted: boolean; redacted: boolean }>(
      'GET',
      `/v1/bots/${id}/computer/file?path=notes/page.md`,
    );
    expect(file.body).toMatchObject({
      text: 'Launch page: owner Ada.\n',
      tainted: true,
      redacted: false,
    });
  });

  it('masks credentials in previews, never follows links and hides .git', async () => {
    h = harness();
    const id = await bot('Scout', 'pong');
    await h.json('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    const { workspace } = (await h.json<Status>('GET', `/v1/bots/${id}/computer`)).body;
    writeFileSync(join(workspace.path, 'env.txt'), 'ANTHROPIC=sk-ant-api03-abcdefghijklmnop\n');
    const masked = await h.json<{ text: string; redacted: boolean }>(
      'GET',
      `/v1/bots/${id}/computer/file?path=env.txt`,
    );
    expect(masked.body.redacted).toBe(true);
    expect(masked.body.text).not.toContain('sk-ant-api03-abcdefghijklmnop');
    symlinkSync(join(h.home, 'orbit.db'), join(workspace.path, 'db'));
    expect((await h.call('GET', `/v1/bots/${id}/computer/file?path=db`)).status).toBe(400);
    expect((await h.call('GET', `/v1/bots/${id}/computer/file?path=../orbit.db`)).status).toBe(400);
    mkdirSync(join(workspace.path, '.git'));
    expect((await h.call('GET', `/v1/bots/${id}/computer/files?path=.git`)).status).toBe(400);
    const listed = await h.json<{ entries: { name: string; kind: string }[] }>(
      'GET',
      `/v1/bots/${id}/computer/files`,
    );
    expect(listed.body.entries.map((e) => e.name)).not.toContain('.git');
    expect(listed.body.entries).toContainEqual(
      expect.objectContaining({ name: 'db', kind: 'symlink' }),
    );
  });

  it("returns the Bot's latest tool calls with decisions and results, newest first", async () => {
    h = harness();
    const id = await bot('Watcher', 'web-then-write');
    const run = await h.json<{ runId: string }>('POST', `/v1/bots/${id}/runs`, {});
    await h.service.queue.idle();
    const activity = await h.json<
      {
        runId: string;
        conversationId: string;
        name: string;
        decision: { behavior: string; tier: string | null } | null;
        result: { isError: boolean; content: string } | null;
      }[]
    >('GET', `/v1/bots/${id}/computer/activity?limit=10`);
    expect(activity.status).toBe(200);
    expect(activity.body.map((a) => a.name)).toEqual(['Write', 'WebFetch']);
    expect(activity.body[0]).toMatchObject({
      runId: run.body.runId,
      conversationId: run.body.runId,
      decision: { behavior: 'allow', tier: 'WRITE_LOCAL' },
      result: { isError: false },
    });
    expect(activity.body[1]?.result?.content).toMatch(/Launch page/);
    const one = await h.json<unknown[]>('GET', `/v1/bots/${id}/computer/activity?limit=1`);
    expect(one.body).toHaveLength(1);
  });
});
