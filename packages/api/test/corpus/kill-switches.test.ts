import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, RunEvent, RunState } from '@orbit/core';
import { signWebhook } from '@orbit/runtime';
import { Controls, openDatabase } from '@orbit/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { Step } from './engine';
import { type World, corpusWorld, setSlackToken } from './world';

/**
 * Kill switches (PLAN §2.6): a Run in any state × every control ends where
 * a human expects, nothing restarts after the switch is released, and while
 * the global kill is on no trigger starts a Run, triage is refused and an
 * approval decided meanwhile does not resume its Run.
 */

const email: Step = {
  tool: 'mcp__gmail__send_email',
  input: { to: 'ada@example.com', subject: 'Report', body: 'Weekly report' },
};
const slow: Step = { tool: 'mcp__corpus__lookup_slowly', input: { id: 'q1' } };

async function until<T>(what: string, probe: () => T | undefined | null | false, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A plugin server is gone once its heartbeat file stops changing. */
const beating = (file: string) => existsSync(file) && Date.now() - statSync(file).mtimeMs < 500;

const started = (events: RunEvent[]) => events.filter((e) => e.type === 'run.started').length;

/** A Run in the state under test, and what the checks need to know about it. */
interface Arranged {
  run: string;
  bot: Bot;
  /** Plugin server processes that must be gone afterwards. */
  /** Heartbeat files of the plugin servers the Run started. */
  heartbeats: () => string[];
  /** Runs that must end with the target (delegated children). */
  children: () => string[];
  approval: () => string | null;
  /** Bystander Runs (the one holding the slot) to stop once the checks are done. */
  bystanders?: string[];
}

interface State {
  id: string;
  scenario: string;
  plugin?: boolean;
  /** A running engine (the kill switch aborts it rather than closing a parked Run). */
  live: boolean;
  concurrency?: number;
  arrange(w: World): Promise<Arranged>;
}

function heartbeatOf(w: World, bot: Bot): string[] {
  const dir = join(w.workspace(bot.id), '.corpus');
  return existsSync(join(dir, 'started')) ? [join(dir, 'heartbeat')] : [];
}

const STATES: readonly State[] = [
  {
    id: 'queued',
    scenario: 'queued behind a busy slot',
    plugin: true,
    live: false,
    concurrency: 1,
    async arrange(w) {
      const blocker = await w.bot({
        name: 'Blocker',
        plugins: ['corpus'],
        fixture: w.fixture([slow]),
      });
      const holding = await w.start(blocker.id);
      await until('the blocker to hold the slot', () => heartbeatOf(w, blocker).some(beating));
      const bot = await w.bot({ name: 'Waiting', fixture: w.fixture([{ say: 'Hi' }]) });
      const run = await w.start(bot.id);
      expect(w.run(run).status).toBe('queued');
      return {
        run,
        bot,
        heartbeats: () => [],
        children: () => [],
        approval: () => null,
        bystanders: [holding],
      };
    },
  },
  {
    id: 'mid-tool',
    scenario: 'running, in the middle of a plugin call',
    plugin: true,
    live: true,
    async arrange(w) {
      const bot = await w.bot({ name: 'Busy', plugins: ['corpus'], fixture: w.fixture([slow]) });
      const run = await w.start(bot.id);
      await until('the plugin call to start', () => heartbeatOf(w, bot).some(beating));
      expect(w.run(run).status).toBe('running');
      return {
        run,
        bot,
        heartbeats: () => heartbeatOf(w, bot),
        children: () => [],
        approval: () => null,
      };
    },
  },
  {
    id: 'asking',
    scenario: 'asking for approval (inside the park window)',
    live: true,
    async arrange(w) {
      const bot = await w.bot({
        name: 'Asking',
        fixture: w.fixture([email]),
        approvals: { parkWindowSeconds: 30 },
      });
      const run = await w.start(bot.id);
      const approval = await until('the approval', () => w.approvals(run)[0]?.id);
      expect(w.run(run).status).toBe('running');
      return { run, bot, heartbeats: () => [], children: () => [], approval: () => approval };
    },
  },
  {
    id: 'parked',
    scenario: 'parked, waiting for approval',
    live: false,
    async arrange(w) {
      const bot = await w.bot({ name: 'Parked', fixture: w.fixture([email]) });
      const run = await w.start(bot.id);
      await w.settle();
      expect(w.run(run).status).toBe('waiting_approval');
      const approval = w.approvals(run)[0]?.id ?? null;
      return { run, bot, heartbeats: () => [], children: () => [], approval: () => approval };
    },
  },
  {
    id: 'delegating',
    scenario: 'delegating, its child mid plugin call',
    plugin: true,
    live: false,
    async arrange(w) {
      const peer = await w.bot({
        name: 'Slow Peer',
        plugins: ['corpus'],
        fixture: w.fixture([slow]),
      });
      const fixture = w.fixture([
        { tool: 'mcp__orbit__delegate_to_bot', input: { bot: 'Slow Peer', task: 'Look it up' } },
      ]);
      w.resumedFixture(fixture, []);
      const bot = await w.bot({
        name: 'Delegator',
        fixture,
        delegation: { allowedBots: ['Slow Peer'] },
      });
      const run = await w.start(bot.id);
      await until('the child’s plugin call', () => heartbeatOf(w, peer).some(beating));
      await until('the parent to park', () => w.run(run).status === 'delegating');
      return {
        run,
        bot,
        heartbeats: () => heartbeatOf(w, peer),
        children: () => w.run(run).children.map((c) => c.runId),
        approval: () => null,
      };
    },
  },
  {
    id: 'rate-limited',
    scenario: 'paused on the usage limit',
    live: false,
    async arrange(w) {
      const bot = await w.bot({
        name: 'Limited',
        fixture: w.fixture([{ say: 'Working' }], { usageLimit: true }),
      });
      const run = await w.start(bot.id);
      await w.settle();
      expect(w.run(run).status).toBe('rate_limited');
      return { run, bot, heartbeats: () => [], children: () => [], approval: () => null };
    },
  },
];

interface Control {
  id: string;
  scenario: string;
  /** The kill scope a live Run records. */
  scope: 'run' | 'bot' | 'global';
  apply(w: World, a: Arranged): Promise<void>;
  release(w: World, a: Arranged): Promise<void>;
}

const otherProcess = (w: World) => {
  const db = openDatabase(join(w.home, 'orbit.db'));
  return { controls: new Controls(db), close: () => db.close() };
};

const CONTROLS: readonly Control[] = [
  {
    id: 'stop',
    scenario: 'the owner stops the Run',
    scope: 'run',
    async apply(w, a) {
      expect((await w.h.json('POST', `/v1/runs/${a.run}/stop`)).status).toBe(200);
    },
    async release() {
      // Nothing to release.
    },
  },
  {
    id: 'pause',
    scenario: 'the owner pauses the Bot',
    scope: 'bot',
    async apply(w, a) {
      expect((await w.h.json('POST', `/v1/bots/${a.bot.id}/pause`)).status).toBe(200);
    },
    async release(w, a) {
      expect((await w.h.json('POST', `/v1/bots/${a.bot.id}/resume`)).status).toBe(200);
    },
  },
  {
    id: 'global',
    scenario: 'the owner engages the global kill switch',
    scope: 'global',
    async apply(w) {
      expect((await w.h.json('POST', '/v1/kill', { on: true })).status).toBe(200);
    },
    async release(w) {
      expect((await w.h.json('POST', '/v1/kill', { on: false })).status).toBe(200);
    },
  },
  {
    id: 'cross-process',
    scenario: 'the global kill is set from another process (the shared database)',
    scope: 'global',
    async apply(w) {
      const other = otherProcess(w);
      other.controls.setGlobalKill(true, 'owner@other-terminal');
      other.close();
      // orbitd notices on its kill poll (live Runs) and its housekeeping tick.
      w.h.service.tick();
    },
    async release(w) {
      const other = otherProcess(w);
      other.controls.setGlobalKill(false, 'owner@other-terminal');
      other.close();
      w.h.service.tick();
    },
  },
];

describe.each(STATES)('a Run $scenario', (state) => {
  let w: World | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  it.each(CONTROLS)(
    '$scenario → it ends, and nothing restarts after the release',
    async (control) => {
      w = await corpusWorld({
        config: { limits: { maxConcurrentRuns: { mock: state.concurrency ?? 16 } } },
      });
      if (state.plugin) await w.enableCorpusPlugin();
      const a = await state.arrange(w);
      const before = Date.now();
      await control.apply(w, a);
      const world = w;
      const ended = await until(
        'the Run to end',
        () => {
          const r = world.run(a.run);
          return r.status === 'cancelled' || r.status === 'failed' ? r : null;
        },
        5000,
      );
      // Promptly, even with a plugin call in flight (it would take 20 s).
      expect(Date.now() - before).toBeLessThan(5000);
      expect(ended.status).toBe('cancelled');
      if (state.live) expect(ended.killedBy).toBe(control.scope);
      else expect(ended.killedBy).not.toBeNull();
      // Its children end too; its plugin servers are gone; its approval is closed.
      for (const child of a.children()) {
        await until('the child to end', () => world.run(child).status === 'cancelled', 5000);
      }
      for (const file of a.heartbeats())
        await until('the plugin process to exit', () => !beating(file), 5000);
      const approval = a.approval();
      if (approval) {
        expect(w.h.service.approvals.get(approval)?.status).toBe('cancelled');
        // Deciding it now does not bring the Run back.
        const late = await w.h.json('POST', `/v1/approvals/${approval}/approve`, {});
        expect(late.status).toBeGreaterThanOrEqual(400);
      }
      const startsBefore = started(w.events(a.run));
      for (const other of a.bystanders ?? []) {
        await w.h.json('POST', `/v1/runs/${other}/stop`);
        await until('the bystander to end', () => world.run(other).endedAt !== null, 5000);
      }

      await control.release(w, a);
      w.h.clock.advance(6 * 3_600_000); // past any usage-limit reset
      w.h.service.tick();
      await w.settle();
      const after: RunState = w.run(a.run);
      expect(after.status).toBe('cancelled');
      expect(started(w.events(a.run))).toBe(startsBefore);
      for (const child of a.children()) expect(w.run(child).status).toBe('cancelled');
      expect(existsSync(join(w.workspace(a.bot.id), '.corpus', 'finished'))).toBe(false);
    },
    30_000,
  );
});

describe('an approval decided under a kill switch', () => {
  let w: World | undefined;
  afterEach(async () => {
    await w?.close();
    w = undefined;
  });

  it('set from another process and not yet noticed: the decision does not resume the Run', async () => {
    w = await corpusWorld();
    const bot = await w.bot({ name: 'Parked', fixture: w.fixture([email]) });
    const run = await w.start(bot.id);
    await w.settle();
    const [approval] = w.approvals(run);
    const other = otherProcess(w);
    other.controls.setGlobalKill(true, 'owner@other-terminal');
    // The owner approves before orbitd's housekeeping has seen the switch.
    const decided = await w.h.json<{ resumed: boolean }>(
      'POST',
      `/v1/approvals/${approval?.id}/approve`,
      {},
    );
    expect(decided.status).toBe(200);
    expect(decided.body.resumed).toBe(false);
    w.h.service.tick();
    other.controls.setGlobalKill(false, 'owner@other-terminal');
    other.close();
    w.h.service.tick();
    await w.settle();
    expect(w.run(run).status).toBe('cancelled');
    expect(started(w.events(run))).toBe(1);
  });

  // Positive control: without a kill switch the same decision resumes the Run.
  it('without a kill switch the same decision resumes and completes the Run', async () => {
    w = await corpusWorld();
    const bot = await w.bot({ name: 'Parked', fixture: w.fixture([email]) });
    const run = await w.start(bot.id);
    await w.settle();
    const [approval] = w.approvals(run);
    const decided = await w.h.json<{ resumed: boolean }>(
      'POST',
      `/v1/approvals/${approval?.id}/approve`,
      {},
    );
    expect(decided.body.resumed).toBe(true);
    await w.settle();
    expect(w.run(run).status).toBe('completed');
  });
});

describe('while the global kill switch is on', () => {
  let w: World | undefined;
  let scratch = '';
  afterEach(async () => {
    await w?.close();
    w = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('no trigger starts a Run, triage is refused, and after the release only new deliveries count', async () => {
    w = await corpusWorld();
    setSlackToken(w);
    scratch = mkdtempSync(join(tmpdir(), 'orbit-corpus-kill-'));
    const dropbox = join(scratch, 'drop');
    const repo = join(scratch, 'repo');
    for (const dir of [dropbox, repo]) mkdirSync(dir, { recursive: true });
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: scratch,
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'initial');
    const fixture = w.fixture([{ say: 'Looked.' }]);
    const bot = await w.bot({
      name: 'Watcher',
      fixture,
      triggers: [
        { kind: 'cron', cron: '* * * * *', name: 'every minute' },
        { kind: 'webhook', name: 'hook' },
        { kind: 'slack', channels: ['C0KILL001'], users: ['U0OWNER01'] },
        { kind: 'file', name: 'drop', paths: [dropbox], events: ['add'], debounceSeconds: 1 },
        { kind: 'git', name: 'repo', repo, branch: 'main', debounceSeconds: 1 },
      ],
    });
    const { secret } = (
      await w.h.json<{ secret: string }>('POST', `/v1/bots/${bot.id}/webhooks/hook/secret`)
    ).body;
    const world = w;
    world.h.service.tick();
    await until('every listener', () =>
      world.h.service
        .inboundTriggers()
        .filter((t) => t.kind !== 'webhook')
        .every((t) => t.state === 'listening'),
    );
    const runs = () => world.h.service.store.listRuns({ botId: bot.id, limit: 100 });
    const hook = (body: string) => {
      const ts = String(Math.floor(world.h.clock.now().getTime() / 1000));
      return world.h.app.request(`/hooks/${bot.id}/hook`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-orbit-timestamp': ts,
          'x-orbit-signature': signWebhook(secret, ts, body),
        },
        body,
      });
    };

    expect((await w.h.json('POST', '/v1/kill', { on: true })).status).toBe(200);
    // Every kind of trigger delivers while the switch is on…
    w.h.clock.advance(2 * 60_000);
    w.h.service.tick(); // the cron trigger is due
    const delivered = await hook('deploy finished');
    expect(delivered.status).toBe(202);
    expect(((await delivered.json()) as { runId: string | null }).runId).toBeNull();
    w.slack.message('C0KILL001', 'U0OWNER01', 'please look');
    writeFileSync(join(dropbox, 'new.txt'), 'x');
    git('commit', '-q', '--allow-empty', '-m', 'during the kill');
    await new Promise((r) => setTimeout(r, 2500)); // past the watchers' debounce
    // …and none of it starts a Run.
    expect(runs()).toEqual([]);
    // The triage path is refused too.
    const proposal = await w.h.json('POST', '/v1/triage/bot-proposal', { goal: 'Notes' });
    expect(proposal.status).toBe(409);
    // Listeners stop on the next housekeeping tick.
    w.h.service.tick();
    await until('the listeners to stop', () =>
      world.h.service
        .inboundTriggers()
        .filter((t) => t.kind === 'file' || t.kind === 'git')
        .every((t) => t.state === 'off'),
    );

    // Released: what arrived meanwhile does not start Runs now…
    expect((await w.h.json('POST', '/v1/kill', { on: false })).status).toBe(200);
    w.h.service.tick();
    await until('every listener again', () =>
      world.h.service
        .inboundTriggers()
        .filter((t) => t.kind !== 'webhook')
        .every((t) => t.state === 'listening'),
    );
    await new Promise((r) => setTimeout(r, 1500));
    await w.settle();
    expect(runs()).toEqual([]);
    // …but a new delivery does (positive control: the trigger itself works).
    const fresh = await hook('next deploy');
    expect(((await fresh.json()) as { runId: string | null }).runId).toMatch(/^run_/);
    await w.settle();
    expect(runs()).toHaveLength(1);
  }, 30_000);
});
