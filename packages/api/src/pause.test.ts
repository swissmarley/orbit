import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Bot, type RunEvent, type RunEventBody, type RunState, event } from '@orbit/core';
import { openDatabase } from '@orbit/store';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN, type Harness, harness } from '../test/harness';
import { createApp } from './app';
import type { z } from 'zod';
import { CSRF_HEADER, type Takeover } from './contract';
import { SessionStore } from './session';

/** ADR-016: per-Run pause, retry of interrupted Runs, take-over through `orbit shell`. */

let current: Harness | undefined;
let h: Harness;
const homes: string[] = [];
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
});

function start(options: Parameters<typeof harness>[0] = {}): Harness {
  h = current = harness(options);
  return h;
}

async function createBot(spec: Record<string, unknown>): Promise<Bot> {
  const res = await h.json<Bot>('POST', '/v1/bots', { goal: 'Do the task', ...spec });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await h.service.queue.idle();
    await new Promise((r) => setTimeout(r, 5));
    const q = h.service.queue.snapshot();
    if (q.active.length === 0 && q.queued.length === 0) return;
  }
}

const run = async (id: string) => (await h.json<RunState>('GET', `/v1/runs/${id}`)).body;
const types = (id: string) => h.service.store.listRunEvents(id).map((e) => e.type);

/** Call `fn` once the first event matching `pred` is appended. */
function when(pred: (e: RunEvent) => boolean, fn: (e: RunEvent) => void): void {
  const off = h.service.store.subscribe((e) => {
    if (!pred(e)) return;
    off();
    queueMicrotask(() => fn(e));
  });
}

describe('per-Run pause', () => {
  it('POST /v1/runs/:run/pause parks a running Run at its next tool call; resume continues it', async () => {
    start({ service: { mock: { delayMs: 25 } } });
    await createBot({ name: 'Reader', mock: { fixture: 'many-reads' } });
    let paused: { status: number; body: RunState } | undefined;
    when(
      (e) => e.type === 'session.init',
      (e) => {
        void h.json<RunState>('POST', `/v1/runs/${e.runId}/pause`, {}).then((r) => (paused = r));
      },
    );
    const started = (await h.json<RunState>('POST', '/v1/bots/reader/runs', {})).body;
    await settle();
    expect(paused?.status).toBe(200);
    expect(paused?.body.pauseRequested).toMatchObject({ by: 'owner', now: false });
    const r = await run(started.runId);
    expect(r.status).toBe('paused');
    expect(r.pause).toMatchObject({ reason: 'owner', by: 'owner', toolName: 'Read' });
    // The slot is free and nothing resumes it by itself.
    expect(h.service.queue.snapshot().active).toEqual([]);
    h.service.tick();
    await settle();
    expect((await run(started.runId)).status).toBe('paused');
    // The Bot may start other Runs meanwhile; the pause concerns this Run only.
    const resumed = await h.json<RunState>('POST', `/v1/runs/${started.runId}/resume`, {});
    expect(resumed.status).toBe(202);
    await settle();
    expect((await run(started.runId)).status).toBe('completed');
  });

  it('refuses queued, paused and ended Runs with a hint; `now` ends paused, not cancelled', async () => {
    start({ service: { mock: { delayMs: 25 } } });
    await createBot({ name: 'Reader', mock: { fixture: 'many-reads' } });
    const queued = h.service.orchestrator.enqueue('reader');
    const refused = await h.json<{ error: { code: string; hint: string } }>(
      'POST',
      `/v1/runs/${queued.runId}/pause`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.hint).toMatch(/orbit stop/);
    h.service.orchestrator.cancelQueued(queued.runId, 'owner');
    expect((await h.call('POST', `/v1/runs/${queued.runId}/pause`, {})).status).toBe(400);

    when(
      (e) => e.type === 'tool.result',
      (e) => void h.call('POST', `/v1/runs/${e.runId}/pause`, { now: true }),
    );
    const started = (await h.json<RunState>('POST', '/v1/bots/reader/runs', {})).body;
    await settle();
    const r = await run(started.runId);
    expect(r.status).toBe('paused');
    expect(r.killedBy).toBeNull();
    expect(r.pause?.interruptedTurn).toBe(true);
    const again = await h.json<{ error: { message: string } }>(
      'POST',
      `/v1/runs/${started.runId}/pause`,
      {},
    );
    expect(again.body.error.message).toMatch(/already paused/);
  });

  it('stop, the Bot kill switch and the global kill switch close paused Runs', async () => {
    start({ service: { mock: { delayMs: 25 } } });
    await createBot({ name: 'Reader', mock: { fixture: 'many-reads' } });
    const pausedRun = async () => {
      when(
        (e) => e.type === 'session.init',
        (e) => void h.call('POST', `/v1/runs/${e.runId}/pause`, {}),
      );
      const s = (await h.json<RunState>('POST', '/v1/bots/reader/runs', {})).body;
      await settle();
      expect((await run(s.runId)).status).toBe('paused');
      return s.runId;
    };
    const a = await pausedRun();
    await h.call('POST', `/v1/runs/${a}/stop`);
    expect((await run(a)).status).toBe('cancelled');
    const b = await pausedRun();
    await h.call('POST', '/v1/bots/reader/pause');
    expect((await run(b)).status).toBe('cancelled');
    await h.call('POST', '/v1/bots/reader/resume');
    const c = await pausedRun();
    await h.call('POST', '/v1/kill', { on: true });
    expect((await run(c)).status).toBe('cancelled');
  });

  it('delegation: a delegating parent cannot be paused; pausing a running child pauses only it', async () => {
    start({ service: { mock: { delayMs: 10 } } });
    const researcher = await createBot({ name: 'Researcher', mock: { fixture: 'many-reads' } });
    await createBot({
      name: 'Lead',
      mock: { fixture: 'delegate-to-peer' },
      delegation: { allowedBots: ['Researcher'] },
    });
    when(
      (e) => e.botId === researcher.id && e.type === 'session.init',
      (e) => void h.call('POST', `/v1/runs/${e.runId}/pause`, {}),
    );
    const lead = (await h.json<RunState>('POST', '/v1/bots/lead/runs', {})).body;
    await settle();
    const parent = await run(lead.runId);
    expect(parent.status).toBe('delegating');
    const childId = parent.children[0]!.runId;
    expect((await run(childId)).status).toBe('paused');
    const refused = await h.json<{ error: { hint: string } }>(
      'POST',
      `/v1/runs/${lead.runId}/pause`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.hint).toMatch(/delegated/);
    // Resuming the child lets the parent continue with its answer.
    await h.call('POST', `/v1/runs/${childId}/resume`, {});
    await settle();
    expect((await run(childId)).status).toBe('completed');
    expect((await run(lead.runId)).status).toBe('completed');
  });
});

describe('interrupted Runs at startup', () => {
  /** A Run that a dead daemon left `running`, with these events in its segment. */
  function leftRunning(botRef: string, segment: RunEventBody[]): RunState {
    const queued = h.service.orchestrator.enqueue(botRef);
    h.service.store.append(queued.runId, queued.botId, [
      event('run.started', {
        driver: 'mock',
        authMethod: 'mock',
        model: null,
        cwd: h.home,
        resumeSessionId: null,
      }),
      ...segment,
    ]);
    return h.service.store.getRun(queued.runId)!;
  }
  const init = event('session.init', {
    sessionId: '00000000-0000-4000-8000-000000000001',
    model: null,
    tools: [],
    engineVersion: null,
    permissionMode: null,
    apiKeySource: null,
  });
  const call = (id: string, name: string, tier: 'READ' | 'EXTERNAL'): RunEventBody[] => [
    event('tool.call', { toolUseId: id, name, input: {}, parentToolUseId: null }),
    event('permission.decision', {
      toolUseId: id,
      toolName: name,
      input: {},
      behavior: 'allow',
      reason: 'ok',
      tier,
    }),
  ];
  const result = (id: string) =>
    event('tool.result', {
      toolUseId: id,
      isError: false,
      content: 'ok',
      truncated: false,
      parentToolUseId: null,
    });

  it('a safe Run (session known, every outside call answered) resumes by itself through the queue', async () => {
    start({ start: false });
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const r = leftRunning('notes', [init, ...call('t1', 'Read', 'READ'), result('t1')]);
    h.service.start();
    await settle();
    const done = await run(r.runId);
    expect(done.status).toBe('completed');
    expect(done.interruptions).toBe(1);
    const t = types(r.runId);
    expect(t.indexOf('run.paused')).toBeLessThan(t.indexOf('run.resumed'));
    const resumed = h.service.store.listRunEvents(r.runId).find((e) => e.type === 'run.resumed');
    expect(resumed?.type === 'run.resumed' && resumed.data.reason).toBe('interrupted');
    expect(h.service.audit.list({ action: 'run.interrupted' })[0]?.data).toMatchObject({
      autoResume: true,
      attempt: 1,
    });
  });

  it('an allowed EXTERNAL call without a result pauses the Run for the owner, naming the call', async () => {
    start({ start: false });
    await createBot({ name: 'Mailer', mock: { fixture: 'pong' } });
    const r = leftRunning('mailer', [init, ...call('t9', 'mcp__gmail__send_email', 'EXTERNAL')]);
    h.service.start();
    await settle();
    const held = await run(r.runId);
    expect(held.status).toBe('paused');
    expect(held.pause).toMatchObject({
      reason: 'interrupted',
      autoResume: false,
      toolName: 'mcp__gmail__send_email',
      toolUseId: 't9',
    });
    expect(held.pause?.detail).toMatch(/may or may not have happened/);
    // The owner decides: resume (told to verify first) or stop.
    expect((await h.call('POST', `/v1/runs/${r.runId}/resume`, {})).status).toBe(202);
    await settle();
    expect((await run(r.runId)).status).toBe('completed');
  });

  it('an unknown session or the retry limit pauses the Run for the owner', async () => {
    start({ start: false });
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const noSession = leftRunning('notes', []);
    const retried = leftRunning('notes', [init]);
    const interrupted = (n: number): RunEventBody[] =>
      Array.from({ length: n }, () => [
        event('run.paused', {
          reason: 'interrupted',
          by: 'system',
          sessionId: null,
          interruptedTurn: true,
          autoResume: true,
        }),
        event('run.resumed', { reason: 'interrupted', sessionId: null }),
        event('run.started', {
          driver: 'mock',
          authMethod: 'mock',
          model: null,
          cwd: h.home,
          resumeSessionId: null,
        }),
      ]).flat();
    h.service.store.append(retried.runId, retried.botId, interrupted(2));
    h.service.start();
    await settle();
    expect((await run(noSession.runId)).pause?.detail).toMatch(/engine session is unknown/);
    const limited = await run(retried.runId);
    expect(limited.status).toBe('paused');
    expect(limited.interruptions).toBe(3);
    expect(limited.pause?.detail).toMatch(/retries at most 2 times/);
  });

  it('onInterrupt: fail keeps the old outcome; a kill switch at startup resumes nothing', async () => {
    start({ start: false });
    await createBot({ name: 'Strict', onInterrupt: 'fail', mock: { fixture: 'pong' } });
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const strict = leftRunning('strict', [init]);
    h.service.start();
    await settle();
    expect(await run(strict.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted', retryable: true },
    });
    await h.service.stop();

    // Kill switch engaged when the daemon starts: nothing continues.
    const home = h.home;
    const db = h.db;
    const safe = leftRunning('notes', [init]);
    h.service.controls.setGlobalKill(true, 'owner');
    current = undefined;
    start({ home, db });
    await settle();
    expect(await run(safe.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted' },
    });
    await h.close();
    current = undefined;
    db.close();
    homes.push(home);
  });

  it('a graceful daemon stop pauses a safe Run; the next start resumes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-pause-'));
    homes.push(home);
    const db = openDatabase(join(home, 'orbit.db'));
    try {
      start({ home, db, service: { mock: { delayMs: 30 } } });
      await createBot({ name: 'Reader', mock: { fixture: 'many-reads' } });
      const stopped = new Promise<void>((resolve) =>
        when(
          (e) => e.type === 'tool.result',
          () => void h.service.stop().then(resolve),
        ),
      );
      const started = (await h.json<RunState>('POST', '/v1/bots/reader/runs', {})).body;
      await stopped;
      const paused = h.service.store.getRun(started.runId)!;
      expect(paused.status).toBe('paused');
      expect(paused.pause).toMatchObject({ reason: 'interrupted', autoResume: true });
      await h.close();
      start({ home, db, service: { mock: { delayMs: 0 } } });
      await settle();
      expect((await run(started.runId)).status).toBe('completed');
    } finally {
      await current?.close();
      current = undefined;
      db.close();
    }
  });
});

describe('take-over (orbit shell)', () => {
  const take = (bot: string, pid = process.pid) =>
    h.json<z.infer<typeof Takeover> & { error?: { code: string; message: string; hint: string } }>(
      'POST',
      `/v1/bots/${bot}/takeover`,
      { pid },
    );

  it('holds the Bot, returns its workspace, audits both ends and releases the hold', async () => {
    start();
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const t = await take('notes');
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ botName: 'Notes', pid: process.pid, wasPaused: false });
    expect(existsSync(t.body.workspace)).toBe(true);
    const held = (await h.json<Bot>('GET', '/v1/bots/notes')).body;
    expect(held.pausedAt).not.toBeNull();
    // No Run starts while the take-over lasts.
    const refused = await h.json<{ error: { code: string; message: string } }>(
      'POST',
      '/v1/bots/notes/runs',
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/taken over/);
    expect(h.service.audit.list({ action: 'takeover.started' })).toHaveLength(1);
    const ended = await h.json<Bot>('DELETE', '/v1/bots/notes/takeover');
    expect(ended.status).toBe(200);
    expect(ended.body.pausedAt).toBeNull();
    expect(h.service.audit.list({ action: 'takeover.ended' })[0]?.data).toMatchObject({
      stale: false,
      released: true,
    });
    expect((await h.call('DELETE', '/v1/bots/notes/takeover')).status).toBe(404);
  });

  it('a Bot paused before stays paused; queued Runs wait and run afterwards', async () => {
    start();
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    await h.call('POST', '/v1/bots/notes/pause');
    const t = await take('notes');
    expect(t.body.wasPaused).toBe(true);
    await h.call('DELETE', '/v1/bots/notes/takeover');
    expect((await h.json<Bot>('GET', '/v1/bots/notes')).body.pausedAt).not.toBeNull();
    await h.call('POST', '/v1/bots/notes/resume');
    // Paused on purpose during a take-over: it stays paused afterwards too.
    expect((await take('notes')).body.wasPaused).toBe(false);
    await h.call('POST', '/v1/bots/notes/pause');
    await h.call('DELETE', '/v1/bots/notes/takeover');
    expect((await h.json<Bot>('GET', '/v1/bots/notes')).body.pausedAt).not.toBeNull();
    await h.call('POST', '/v1/bots/notes/resume');

    // A Run queued before the take-over waits for it, then runs.
    const queued = h.service.orchestrator.enqueue('notes');
    const t2 = await take('notes');
    expect(t2.body.waiting).toEqual([queued.runId]);
    h.service.queue.push({
      kind: 'start',
      runId: queued.runId,
      botId: queued.botId,
      priority: 0,
    });
    expect(h.service.queueSnapshot().queued[0]?.heldBy).toMatch(/taken over/);
    await h.call('DELETE', '/v1/bots/notes/takeover');
    await settle();
    expect((await run(queued.runId)).status).toBe('completed');
  });

  it('refuses while a Run is running or parked on an approval, and for Docker Bots', async () => {
    start({ service: { mock: { delayMs: 25 } } });
    await createBot({ name: 'Reader', mock: { fixture: 'many-reads' } });
    let refused: Awaited<ReturnType<typeof take>> | undefined;
    when(
      (e) => e.type === 'session.init',
      () => void take('reader').then((r) => (refused = r)),
    );
    await h.call('POST', '/v1/bots/reader/runs', {});
    await settle();
    expect(refused?.status).toBe(409);
    expect(refused?.body.error?.hint).toMatch(/orbit pause run_/);

    await createBot({
      name: 'Mailer',
      mock: { fixture: 'send-email' },
      approvals: { parkWindowSeconds: 0 },
    });
    await h.call('POST', '/v1/bots/mailer/runs', {});
    await settle();
    const parked = await take('mailer');
    expect(parked.status).toBe(409);
    expect(parked.body.error?.hint).toMatch(/orbit approvals|orbit stop/);

    await createBot({ name: 'Boxed', sandbox: { kind: 'docker' } });
    const docker = await take('boxed');
    expect(docker.status).toBe(400);
    expect(docker.body.error?.hint).toMatch(/docker exec -it orbit-/);
  });

  it('a stale take-over (its CLI gone) ends when a new one starts; a live one refuses; bot resume ends either', async () => {
    const alive = new Set([process.pid]);
    start({ service: { processAlive: (pid) => alive.has(pid) } });
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    expect((await take('notes', 999_001)).status).toBe(201);
    // 999001 is gone: the next take-over replaces it and keeps the hold.
    const next = await take('notes', process.pid);
    expect(next.status).toBe(201);
    expect(next.body.replacedStale).toBe(999_001);
    expect(next.body.wasPaused).toBe(false);
    const live = await take('notes', process.pid);
    expect(live.status).toBe(409);
    expect(live.body.error?.hint).toMatch(/orbit bot resume notes/);
    // The owner's way out (e.g. a reused pid): resuming the Bot ends the take-over.
    const resumed = await h.json<Bot>('POST', '/v1/bots/notes/resume');
    expect(resumed.body.pausedAt).toBeNull();
    expect(h.service.controls.takeover(resumed.body.id)).toBeNull();
    const ends = h.service.audit.list({ action: 'takeover.ended' }).map((a) => a.data);
    expect(ends).toEqual([
      expect.objectContaining({ pid: 999_001, stale: true }),
      expect.objectContaining({ pid: process.pid, via: 'bot_resume' }),
    ]);
  });

  it('only the bearer token may take over: an App session cookie is refused', async () => {
    start();
    await createBot({ name: 'Notes', mock: { fixture: 'pong' } });
    const sessions = new SessionStore();
    const app = createApp({ service: h.service, token: TOKEN, sessions });
    const ticket = sessions.mintTicket({ id: 'owner', name: 'Local owner', role: 'owner' });
    const redeemed = sessions.redeem(ticket.ticket)!;
    const cookie = `orbit_session_80=${redeemed.session}`;
    const res = await app.request('http://localhost/v1/bots/notes/takeover', {
      method: 'POST',
      headers: {
        cookie,
        [CSRF_HEADER]: redeemed.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pid: process.pid }),
    });
    expect(res.status).toBe(403);
    // The App can still read and pause Runs with its session.
    const bots = await app.request('http://localhost/v1/bots', {
      headers: { cookie, [CSRF_HEADER]: redeemed.csrf },
    });
    expect(bots.status).toBe(200);
    expect(h.service.controls.takeover((await h.json<Bot>('GET', '/v1/bots/notes')).body.id)).toBe(
      null,
    );
  });
});
