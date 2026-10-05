import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Bot,
  type BotSpecInput,
  type OrbitConfigInput,
  type RunEvent,
  type RunState,
  pluginSecretKey,
} from '@orbit/core';
import type { Approval } from '@orbit/policy';
import type { SocketLike } from '@orbit/runtime';
import { type Harness, harness } from '../harness';
import type { ServiceOptions } from '../../src/service';
import {
  RecordingDriver,
  type Step,
  type TranscriptOptions,
  transcript,
  writeFixture,
} from './engine';

export const CORPUS_PLUGIN = join(fileURLToPath(new URL('.', import.meta.url)), 'plugin');
/** The corpus plugin's own secret: it must never surface anywhere but in the plugin. */
export const PLUGIN_SECRET = 'corpus-plugin-secret-7f3a9c21d4';
/** A vault secret of the owner's (redaction tests). */
export const VAULT_SECRET = 'sk-corpus-vault-5e8b1d0c9a7f';

/** Slack Socket Mode without a network: Orbit's socket talks to this double. */
export class FakeSlack {
  private readonly sockets = new Set<{ emit: (data: string) => void; closed: boolean }>();
  private envelopes = 0;

  readonly fetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, url: 'wss://slack.test/socket' })));

  readonly connect = (_url: string): SocketLike => {
    const listeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
    const entry = {
      closed: false,
      emit: (data: string) => {
        for (const fn of listeners.message ?? []) fn({ data });
      },
    };
    this.sockets.add(entry);
    queueMicrotask(() => entry.emit(JSON.stringify({ type: 'hello' })));
    return {
      addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
        (listeners[type] ??= []).push(fn);
      },
      send: () => undefined,
      close: () => {
        entry.closed = true;
        this.sockets.delete(entry);
      },
    };
  };

  get connected(): number {
    return this.sockets.size;
  }

  /** Deliver a message event to every open socket. */
  message(
    channel: string,
    user: string,
    text: string,
    type: 'app_mention' | 'message' = 'app_mention',
  ) {
    this.envelopes += 1;
    const ts = `1759651200.${String(this.envelopes).padStart(6, '0')}`;
    const frame = JSON.stringify({
      envelope_id: `env-${this.envelopes}`,
      type: 'events_api',
      payload: { event: { type, channel, user, text, ts } },
    });
    for (const s of this.sockets) s.emit(frame);
  }
}

export interface World {
  h: Harness;
  home: string;
  engine: RecordingDriver;
  slack: FakeSlack;
  /** Write a synthetic transcript and return its fixture name. */
  fixture(steps: readonly Step[], opts?: TranscriptOptions & { name?: string }): string;
  /** Write `<name>-resumed`: what a parked Run replays when it resumes. */
  resumedFixture(name: string, steps: readonly Step[], opts?: TranscriptOptions): void;
  bot(spec: Partial<BotSpecInput> & { name: string; fixture?: string }): Promise<Bot>;
  /** Start a manual Run through the API; returns its id. */
  start(bot: string, body?: { fixture?: string; prompt?: string }): Promise<string>;
  /** Until nothing executes and nothing dispatchable waits (summaries included). */
  settle(): Promise<void>;
  run(runId: string): RunState;
  events(runId: string): RunEvent[];
  approvals(runId: string): Approval[];
  workspace(botId: string): string;
  /** Add, set up and enable the corpus plugin (its server runs for real). */
  enableCorpusPlugin(): Promise<void>;
  close(): Promise<void>;
}

export async function corpusWorld(
  options: {
    config?: Partial<OrbitConfigInput>;
    service?: Partial<ServiceOptions>;
    delayMs?: number;
  } = {},
): Promise<World> {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'orbit-corpus-fx-'));
  const slack = new FakeSlack();
  const h = harness({
    config: {
      limits: { maxConcurrentRuns: { mock: 16 } },
      ...options.config,
    },
    service: {
      pluginsDir: null,
      mock: { delayMs: 0, fixturesDir },
      slack: { fetch: slack.fetch, connect: slack.connect },
      ...options.service,
    },
  });
  // Resolve the (mock) engine once, then put the recording tap in front of it.
  await h.service.ensureEngine();
  const engine = new RecordingDriver({
    fixturesDir,
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
  });
  h.service.orchestrator.setDriver(engine);
  let n = 0;

  const w: World = {
    h,
    home: h.home,
    engine,
    slack,
    fixture(steps, opts = {}) {
      const name = opts.name ?? `corpus-${++n}`;
      writeFixture(fixturesDir, name, transcript(steps, opts));
      return name;
    },
    resumedFixture(name, steps, opts = {}) {
      writeFixture(fixturesDir, `${name}-resumed`, transcript(steps, opts));
    },
    async bot({ fixture, ...spec }) {
      const res = await h.json<Bot>('POST', '/v1/bots', {
        goal: 'Look after the inbox and report',
        approvals: { parkWindowSeconds: 0 },
        budgets: { maxRunsPerDay: 1000 },
        memory: { summarize: 'result' },
        ...(fixture ? { mock: { fixture } } : {}),
        ...spec,
      });
      if (res.status !== 201) throw new Error(`bot ${spec.name}: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async start(bot, body = {}) {
      const res = await h.json<RunState>('POST', `/v1/bots/${bot}/runs`, body);
      if (res.status !== 201 && res.status !== 202) {
        throw new Error(`start ${bot}: ${JSON.stringify(res.body)}`);
      }
      return res.body.runId;
    },
    async settle() {
      for (let i = 0; i < 400; i++) {
        await h.service.queue.idle();
        await new Promise((r) => setTimeout(r, 10));
        const snap = h.service.queue.snapshot();
        const dispatchable = snap.queued.filter((j) => !j.heldBy);
        if (snap.active.length === 0 && dispatchable.length === 0) {
          await h.service.summariesIdle();
          return;
        }
      }
      throw new Error('the queue did not settle');
    },
    run(runId) {
      return h.service.requireRun(runId);
    },
    events(runId) {
      return h.service.store.listRunEvents(runId);
    },
    approvals(runId) {
      return h.service.approvals.list({ runId });
    },
    workspace(botId) {
      const dir = join(h.home, 'workspaces', botId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    async enableCorpusPlugin() {
      const added = await h.json('POST', '/v1/plugins', { dir: CORPUS_PLUGIN });
      if (added.status !== 201) throw new Error(`add plugin: ${JSON.stringify(added.body)}`);
      await h.json('PUT', '/v1/plugins/corpus/secrets/CORPUS_TOKEN', { value: PLUGIN_SECRET });
      const enabled = await h.json('POST', '/v1/plugins/corpus/enable');
      if (enabled.status !== 200) throw new Error(`enable plugin: ${JSON.stringify(enabled.body)}`);
    },
    async close() {
      await h.close();
      rmSync(fixturesDir, { recursive: true, force: true });
    },
  };
  return w;
}

/** Put a document the corpus plugin's `get_document` will return into a Bot's workspace. */
export function plantDocument(w: World, botId: string, id: string, text: string): void {
  const dir = join(w.workspace(botId), 'docs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.txt`), text);
}

/** The Slack app token the Slack trigger reads from the vault (a fake). */
export function setSlackToken(w: World): void {
  w.h.service.vault.set(pluginSecretKey('slack', 'SLACK_APP_TOKEN'), 'xapp-1-corpus-app-token');
}

/** Every string Orbit stored or would show: events, approvals, audit, memory. */
export async function everythingStored(w: World): Promise<string> {
  const audit = await (await w.h.call('GET', '/v1/audit/export')).text();
  const runs = w.h.service.store.listRuns({ limit: 10_000 });
  const events = runs.flatMap((r) => w.events(r.runId));
  const memories = w.h.service.memory.list({ limit: 10_000 });
  return [
    audit,
    JSON.stringify(runs),
    JSON.stringify(events),
    JSON.stringify(w.h.service.approvals.list()),
    JSON.stringify(memories),
  ].join('\n');
}
