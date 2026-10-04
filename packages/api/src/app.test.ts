import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, RunEvent, RunState } from '@orbit/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, TOKEN, harness } from '../test/harness';
import { type Approval, routes } from './contract';
import { buildOpenApi } from './openapi';

let current: Harness | undefined;
let h: Harness;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function createBot(spec: Record<string, unknown>): Promise<Bot> {
  const res = await h.json<Bot>('POST', '/v1/bots', { goal: 'Do the task', ...spec });
  expect(res.status).toBe(201);
  return res.body;
}

async function settle(): Promise<void> {
  await h.service.queue.idle();
}

/** Read SSE frames from a fetch response until `stop` says so. */
async function readSse(
  res: Response,
  stop: (events: RunEvent[], comments: number) => boolean,
): Promise<{ events: RunEvent[]; ids: string[]; comments: number }> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: RunEvent[] = [];
  const ids: string[] = [];
  let comments = 0;
  while (!stop(events, comments)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (frame.startsWith(':')) comments += 1;
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      const id = frame.split('\n').find((l) => l.startsWith('id:'));
      if (id) ids.push(id.slice(3).trim());
      if (data) events.push(JSON.parse(data) as RunEvent);
    }
  }
  await reader.cancel();
  return { events, ids, comments };
}

describe('orbitd API — access control', () => {
  it('health is public; everything else needs the bearer token', async () => {
    h = current = harness();
    const health = await h.app.request('/v1/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, api: '1', version: '0.1.0-test' });
    expect((await h.app.request('/v1/bots')).status).toBe(401);
    const wrong = await h.app.request('/v1/bots', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect((await h.call('GET', '/v1/bots')).status).toBe(200);
    // Same length, different token: still refused.
    const sameLength = await h.app.request('/v1/bots', {
      headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
    });
    expect(sameLength.status).toBe(401);
  });

  it('refuses cross-origin (browser) requests and foreign Host names', async () => {
    h = current = harness();
    const cross = await h.call('GET', '/v1/bots', undefined, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const { createApp } = await import('./app');
    const strict = createApp({
      service: h.service,
      token: TOKEN,
      allowedHosts: ['127.0.0.1:7420'],
    });
    const rebound = await strict.request('http://attacker.example:7420/v1/health');
    expect(rebound.status).toBe(403);
    expect((await strict.request('http://127.0.0.1:7420/v1/health')).status).toBe(200);
  });

  it('maps errors to statuses with a JSON error body', async () => {
    h = current = harness();
    expect((await h.json('GET', '/v1/bots/nope')).status).toBe(404);
    const bad = await h.json<{ error: { code: string; message: string } }>('POST', '/v1/bots', {
      name: '',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_input');
    const malformed = await h.app.request('/v1/bots', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    const huge = await h.call('PUT', '/v1/secrets/BIG', { value: 'x'.repeat(2 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect((await h.call('GET', '/v1/nothing-here')).status).toBe(404);
  });
});

describe('orbitd API — bots and runs', () => {
  it('creates, versions, validates triggers and lists Bots', async () => {
    h = current = harness();
    const bot = await createBot({ name: 'Notes', triggers: [{ kind: 'cron', cron: '0 9 * * *' }] });
    expect(bot.spec.triggers).toHaveLength(1);
    const bad = await h.json<{ error: { message: string } }>('POST', '/v1/bots', {
      name: 'Bad cron',
      goal: 'g',
      triggers: [{ kind: 'cron', cron: 'whenever' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/Invalid cron trigger/);
    const v2 = await h.json<Bot>('PUT', `/v1/bots/${bot.id}`, { ...bot.spec, goal: 'New goal' });
    expect(v2.body.version).toBe(2);
    const versions = await h.json<{ version: number }[]>('GET', '/v1/bots/notes/versions');
    expect(versions.body.map((v) => v.version)).toEqual([1, 2]);
    const list = await h.json<Bot[]>('GET', '/v1/bots');
    expect(list.body.map((b) => b.spec.name)).toEqual(['Notes']);
    expect(h.service.audit.list({ action: 'bot.updated' })).toHaveLength(1);
  });

  it('queues a Run (202), executes it and replays its events', async () => {
    h = current = harness();
    await createBot({ name: 'Notes', mock: { fixture: 'read-then-write-denied' } });
    const started = await h.json<RunState>('POST', '/v1/bots/notes/runs', { prompt: 'Summarize' });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ prompt: 'Summarize', priority: 10 });
    await settle();
    const run = await h.json<RunState>('GET', `/v1/runs/${started.body.runId}`);
    expect(run.body.status).toBe('completed');
    const events = await h.json<RunEvent[]>('GET', `/v1/runs/${started.body.runId}/events`);
    expect(events.body[0]?.type).toBe('run.queued');
    expect(events.body.at(-1)?.type).toBe('run.completed');
    const tail = await h.json<RunEvent[]>(
      'GET',
      `/v1/runs/${started.body.runId}/events?afterSeq=${events.body.length - 1}`,
    );
    expect(tail.body.map((e) => e.type)).toEqual(['run.completed']);
    const runs = await h.json<RunState[]>('GET', '/v1/runs?status=completed&bot=notes');
    expect(runs.body.map((r) => r.runId)).toEqual([started.body.runId]);
    expect((await h.json('GET', '/v1/runs?status=bogus')).status).toBe(400);
  });

  it('enforces the global concurrency limit through the queue', async () => {
    h = current = harness({
      config: { limits: { maxConcurrentRuns: { mock: 1 } } },
      service: { mock: { delayMs: 15 } },
    });
    await createBot({ name: 'Slow', mock: { fixture: 'many-reads' } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body.runId);
    let maxActive = 0;
    const off = h.service.store.subscribe(() => {
      maxActive = Math.max(maxActive, h.service.queue.snapshot().active.length);
    });
    const snap = await h.json<{ limit: number; active: unknown[]; queued: unknown[] }>(
      'GET',
      '/v1/queue',
    );
    expect(snap.body.limit).toBe(1);
    expect(snap.body.active.length + snap.body.queued.length).toBeGreaterThan(0);
    await settle();
    off();
    expect(maxActive).toBe(1);
    for (const id of ids) expect(h.service.store.getRun(id)?.status).toBe('completed');
  });

  it('stops a queued Run before it starts', async () => {
    h = current = harness({
      config: { limits: { maxConcurrentRuns: { mock: 1 } } },
      service: { mock: { delayMs: 20 } },
    });
    await createBot({ name: 'Slow', mock: { fixture: 'many-reads' } });
    const first = (await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body;
    const second = (await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body;
    const stopped = await h.json<RunState>('POST', `/v1/runs/${second.runId}/stop`);
    expect(stopped.body.status).toBe('cancelled');
    await settle();
    expect(h.service.store.getRun(first.runId)?.status).toBe('completed');
    expect(h.service.store.listRunEvents(second.runId).map((e) => e.type)).toEqual([
      'run.queued',
      'run.killed',
      'run.cancelled',
    ]);
  });

  it('refuses a fixture unless the daemon runs the mock driver', async () => {
    h = current = harness({
      config: { driver: 'sdk' },
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-test-0000000000000000' },
    });
    await createBot({ name: 'A' });
    const res = await h.json<{ error: { code: string } }>('POST', '/v1/bots/a/runs', {
      fixture: 'pong',
    });
    expect(res.status).toBe(400);
  });

  it('explains missing credentials instead of queueing a doomed Run (503)', async () => {
    h = current = harness({
      config: { driver: null },
      env: { PATH: '/nonexistent' },
      service: {
        probes: {
          findClaude: () => Promise.resolve(null),
          cliStatus: () => Promise.reject(new Error('n/a')),
        },
      },
    });
    await createBot({ name: 'A' });
    const res = await h.json<{ error: { code: string; hint: string } }>(
      'POST',
      '/v1/bots/a/runs',
      {},
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('auth_required');
    expect(h.service.store.listRuns()).toEqual([]);
  });
});

describe('orbitd API — approvals, controls and housekeeping', () => {
  it('park → approve → automatic resume → completed', async () => {
    h = current = harness();
    await createBot({
      name: 'Mailer',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const run = (await h.json<RunState>('POST', '/v1/bots/mailer/runs', {})).body;
    await settle();
    expect(h.service.store.getRun(run.runId)?.status).toBe('waiting_approval');
    const pending = await h.json<Approval[]>('GET', '/v1/approvals');
    expect(pending.body).toHaveLength(1);
    const approval = pending.body[0]!;
    expect(approval.expiresAt).not.toBeNull();
    const decided = await h.json<{ approval: Approval; resumed: boolean }>(
      'POST',
      `/v1/approvals/${approval.id}/approve`,
      {},
    );
    expect(decided.body).toMatchObject({ resumed: true, approval: { status: 'approved' } });
    await settle();
    expect(h.service.store.getRun(run.runId)?.status).toBe('completed');
    // Deciding twice is a 400, not a second resume.
    expect((await h.json('POST', `/v1/approvals/${approval.id}/deny`, {})).status).toBe(400);
    expect((await h.json<Approval[]>('GET', '/v1/approvals?all=true')).body).toHaveLength(1);
  });

  it('deny with resume:false leaves the Run parked for a manual resume', async () => {
    h = current = harness();
    await createBot({
      name: 'Mailer',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const run = (await h.json<RunState>('POST', '/v1/bots/mailer/runs', {})).body;
    await settle();
    const [approval] = (await h.json<Approval[]>('GET', '/v1/approvals')).body;
    const denied = await h.json<{ resumed: boolean }>(
      'POST',
      `/v1/approvals/${approval!.id}/deny`,
      {
        reason: 'Not today',
        resume: false,
      },
    );
    expect(denied.body.resumed).toBe(false);
    expect(h.service.store.getRun(run.runId)?.status).toBe('waiting_approval');
    const resumed = await h.json<RunState>('POST', `/v1/runs/${run.runId}/resume`, {
      fixture: 'pong',
    });
    expect(resumed.status).toBe(202);
    await settle();
    expect(h.service.store.getRun(run.runId)?.status).toBe('completed');
    expect((await h.json('POST', `/v1/runs/${run.runId}/resume`, {})).status).toBe(400);
  });

  it('expires undecided approvals on the housekeeping tick and resumes the Run', async () => {
    h = current = harness();
    await createBot({
      name: 'Mailer',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0, expireAfterHours: 1 },
    });
    const run = (await h.json<RunState>('POST', '/v1/bots/mailer/runs', {})).body;
    await settle();
    h.clock.advance(2 * 3_600_000);
    h.service.tick();
    await settle();
    const [approval] = (await h.json<Approval[]>('GET', '/v1/approvals?all=true')).body;
    expect(approval?.status).toBe('expired');
    // The Run resumed (the fixture then asks again, so it parks on a new approval).
    const types = h.service.store.listRunEvents(run.runId).map((e) => e.type);
    expect(types.indexOf('run.resumed')).toBeGreaterThan(types.indexOf('approval.decided'));
  });

  it('global kill switch cancels queued Runs and refuses new ones (409)', async () => {
    h = current = harness({
      config: { limits: { maxConcurrentRuns: { mock: 1 } } },
      service: { mock: { delayMs: 20 } },
    });
    await createBot({ name: 'Slow', mock: { fixture: 'many-reads' } });
    const a = (await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body;
    const b = (await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body;
    expect((await h.json('POST', '/v1/kill', { on: true })).body).toMatchObject({
      engaged: true,
      by: 'owner',
    });
    await settle();
    expect(h.service.store.getRun(a.runId)?.status).toBe('cancelled');
    expect(h.service.store.getRun(b.runId)?.status).toBe('cancelled');
    const refused = await h.json<{ error: { code: string } }>('POST', '/v1/bots/slow/runs', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('blocked');
    await h.json('POST', '/v1/kill', { on: false });
    expect((await h.json('GET', '/v1/kill')).body).toEqual({ engaged: false, by: null });
  });

  it('pausing a Bot cancels its queued Runs; resuming lets it run again', async () => {
    h = current = harness({
      config: { limits: { maxConcurrentRuns: { mock: 1 } } },
      service: { mock: { delayMs: 20 } },
    });
    await createBot({ name: 'Slow', mock: { fixture: 'many-reads' } });
    await h.json('POST', '/v1/bots/slow/runs', {});
    const queued = (await h.json<RunState>('POST', '/v1/bots/slow/runs', {})).body;
    const paused = await h.json<Bot>('POST', '/v1/bots/slow/pause');
    expect(paused.body.pausedAt).not.toBeNull();
    await settle();
    expect(h.service.store.getRun(queued.runId)?.status).toBe('cancelled');
    expect((await h.json('POST', '/v1/bots/slow/runs', {})).status).toBe(409);
    await h.json('POST', '/v1/bots/slow/resume');
    expect((await h.json('POST', '/v1/bots/slow/runs', {})).status).toBe(202);
  });

  it('fires interval triggers on the housekeeping tick and lists schedules', async () => {
    h = current = harness();
    await createBot({
      name: 'Poller',
      mock: { fixture: 'pong' },
      triggers: [{ kind: 'interval', everyMinutes: 10, prompt: 'poll now', name: 'Poll' }],
    });
    h.service.tick();
    const [entry] = (
      await h.json<{ description: string; nextAt: string }[]>('GET', '/v1/schedules?bot=poller')
    ).body;
    expect(entry?.description).toBe('Poll');
    h.clock.set(entry!.nextAt);
    h.service.tick();
    await settle();
    const runs = (await h.json<RunState[]>('GET', '/v1/runs')).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      prompt: 'poll now',
      trigger: { kind: 'interval', source: 'Poll' },
      status: 'completed',
      priority: 0,
    });
  });

  it('usage limit: the Run pauses with a resume time and the queue holds new Runs', async () => {
    h = current = harness();
    await createBot({ name: 'Limited', mock: { fixture: 'usage-limit' } });
    await createBot({ name: 'Other', mock: { fixture: 'pong' } });
    const run = (await h.json<RunState>('POST', '/v1/bots/limited/runs', {})).body;
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    const limited = h.service.store.getRun(run.runId)!;
    expect(limited.status).toBe('rate_limited');
    expect(limited.resumeAt).not.toBeNull();
    const other = (await h.json<RunState>('POST', '/v1/bots/other/runs', {})).body;
    const snap = (
      await h.json<{
        pausedUntil: string | null;
        queued: { runId: string; heldBy: string | null }[];
      }>('GET', '/v1/queue')
    ).body;
    expect(snap.pausedUntil).toBe(limited.usageLimit?.resetsAt);
    expect(snap.queued).toEqual([
      expect.objectContaining({
        runId: other.runId,
        heldBy: expect.stringMatching(/usage limit/) as unknown,
      }),
    ]);
  });

  it('secrets: values are stored, never listed, and redacted from what Runs log', async () => {
    h = current = harness();
    expect(
      (await h.json('PUT', '/v1/secrets/LAUNCH', { value: 'launch window opens' })).status,
    ).toBe(200);
    const list = await h.call('GET', '/v1/secrets');
    expect(await list.text()).not.toContain('launch window opens');
    await createBot({ name: 'Notes', mock: { fixture: 'read-then-write-denied' } });
    const run = (await h.json<RunState>('POST', '/v1/bots/notes/runs', {})).body;
    await settle();
    const events = await h.call('GET', `/v1/runs/${run.runId}/events`);
    const text = await events.text();
    expect(text).toContain('[REDACTED:secret]');
    expect(text).not.toContain('launch window opens');
    expect((await h.json('DELETE', '/v1/secrets/LAUNCH')).status).toBe(200);
    expect((await h.json('DELETE', '/v1/secrets/LAUNCH')).status).toBe(404);
  });

  it('rules, audit list, verify and export', async () => {
    h = current = harness();
    const rule = await h.json<{ id: string }>('POST', '/v1/rules', {
      toolPattern: 'mcp__slack__post_message',
      effect: 'allow',
      expiresAt: null,
    });
    expect(rule.status).toBe(201);
    const financial = await h.json('POST', '/v1/rules', {
      toolPattern: 'mcp__stripe__create_payment',
      effect: 'allow',
      expiresAt: null,
    });
    expect(financial.status).toBe(400);
    await h.json('POST', `/v1/rules/${rule.body.id}/revoke`);
    expect((await h.json<unknown[]>('GET', '/v1/rules')).body).toEqual([]);
    expect((await h.json<unknown[]>('GET', '/v1/rules?all=1')).body).toHaveLength(1);
    expect(
      (await h.json<{ action: string }[]>('GET', '/v1/audit?action=rule.revoked')).body,
    ).toHaveLength(1);
    expect((await h.json('GET', '/v1/audit/verify')).body).toMatchObject({ ok: true });
    const exported = await h.call('GET', '/v1/audit/export');
    expect(exported.headers.get('content-type')).toMatch(/ndjson/);
    expect((await exported.text()).trim().split('\n')).toHaveLength(2);
  });

  it('doctor reports driver, auth and the daemon', async () => {
    h = current = harness();
    const doctor = await h.json<{
      driver: string;
      authMethod: string;
      daemon: { pid: number; concurrency: number };
    }>('GET', '/v1/doctor');
    expect(doctor.body).toMatchObject({
      driver: 'mock',
      authMethod: 'mock',
      daemon: { pid: process.pid, concurrency: 8 },
    });
  });
});

describe('orbitd API — safety review fixes', () => {
  it('stop closes a Run left "running" that nothing executes (orphan)', async () => {
    h = current = harness();
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const q = h.service.orchestrator.enqueue('notes');
    h.service.store.append(q.runId, q.botId, [
      {
        type: 'run.started',
        data: {
          driver: 'mock',
          authMethod: 'mock',
          model: 'opus',
          cwd: h.home,
          resumeSessionId: null,
        },
      },
    ]);
    const stopped = await h.json<RunState>('POST', `/v1/runs/${q.runId}/stop`);
    expect(stopped.body.status).toBe('cancelled');
  });

  it('the global kill switch and Bot pause also close parked Runs (nothing resumes after release)', async () => {
    h = current = harness();
    await createBot({
      name: 'Mailer',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    const a = (await h.json<RunState>('POST', '/v1/bots/mailer/runs', {})).body;
    const b = (await h.json<RunState>('POST', '/v1/bots/mailer/runs', {})).body;
    await settle();
    await h.json('POST', '/v1/kill', { on: true });
    expect(h.service.store.getRun(a.runId)?.status).toBe('cancelled');
    await h.json('POST', '/v1/kill', { on: false });
    await h.json('POST', '/v1/bots/mailer/pause');
    expect(h.service.store.getRun(b.runId)?.status).toBe('cancelled');
    expect(h.service.approvals.list({ status: 'pending' })).toEqual([]);
  });

  it('error bodies never echo request bodies or vault values', async () => {
    h = current = harness();
    await h.json('PUT', '/v1/secrets/DB_PASSWORD', { value: 'correct-horse-battery' });
    const res = await h.app.request('/v1/secrets/OTHER', {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{"value": "correct-horse-battery-staple" oops',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('correct-horse');
    expect(text).toMatch(/Malformed JSON body/);
  });

  it('checks the Host header too, not only the request URL', async () => {
    h = current = harness();
    const { createApp } = await import('./app');
    const strict = createApp({
      service: h.service,
      token: TOKEN,
      allowedHosts: ['127.0.0.1:7420'],
    });
    const res = await strict.request('http://127.0.0.1:7420/v1/health', {
      headers: { host: 'evil.example:7420' },
    });
    expect(res.status).toBe(403);
  });
});

describe('orbitd API — restart recovery', () => {
  it('fails Runs left running, re-queues queued ones', async () => {
    h = current = harness({ start: false });
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const queued = h.service.orchestrator.enqueue('notes');
    const crashed = h.service.orchestrator.enqueue('notes');
    h.service.store.append(crashed.runId, crashed.botId, [
      {
        type: 'run.started',
        data: {
          driver: 'mock',
          authMethod: 'mock',
          model: 'opus',
          cwd: h.home,
          resumeSessionId: null,
        },
      },
    ]);
    h.service.start();
    await settle();
    expect(h.service.store.getRun(crashed.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted', retryable: true },
    });
    expect(h.service.store.getRun(queued.runId)?.status).toBe('completed');
  });
});

describe('orbitd API — SSE', () => {
  it('streams a Run from the start, resumes after Last-Event-ID, and sends heartbeats', async () => {
    h = current = harness();
    const base = await h.listen();
    await createBot({ name: 'Notes', mock: { fixture: 'read-then-write-denied' } });
    const run = (await h.json<RunState>('POST', '/v1/bots/notes/runs', {})).body;
    const res = await fetch(`${base}/v1/events?run=${run.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const first = await readSse(res, (ev) => ev.some((e) => e.type === 'run.completed'));
    const all = h.service.store.listRunEvents(run.runId);
    expect(first.events.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(first.ids).toEqual(all.map((e) => String(e.id)));

    // Reconnect: only what came after the last id the client saw.
    const cut = all[2]!.id;
    const again = await fetch(`${base}/v1/events?run=${run.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(cut) },
    });
    const rest = await readSse(again, (ev) => ev.some((e) => e.type === 'run.completed'));
    expect(rest.events.map((e) => e.id)).toEqual(all.filter((e) => e.id > cut).map((e) => e.id));

    // Live feed with heartbeats: new events of any Run arrive once, in order.
    const live = await fetch(`${base}/v1/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const reading = readSse(
      live,
      (ev, comments) => comments >= 1 && ev.some((e) => e.type === 'run.completed'),
    );
    const second = (await h.json<RunState>('POST', '/v1/bots/notes/runs', {})).body;
    const got = await reading;
    expect(got.events.every((e) => e.runId === second.runId)).toBe(true);
    const ids = got.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(got.comments).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${base}/v1/events`)).status).toBe(401);
  });
});

describe('OpenAPI', () => {
  it('documents every contract route, generated from the zod schemas', () => {
    const doc = buildOpenApi() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops.sort()).toEqual(Object.keys(routes).sort());
  });

  it('the checked-in openapi.json is current (pnpm --filter @orbit/api openapi)', () => {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'openapi.json'), 'utf8'),
    ) as unknown;
    expect(file).toEqual(buildOpenApi());
  });

  it('is served without a token', async () => {
    h = current = harness();
    const res = await h.app.request('/openapi.json');
    expect(res.status).toBe(200);
  });
});
