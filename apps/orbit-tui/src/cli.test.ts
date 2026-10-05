import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, type RunEvent } from '@orbit/core';
import { type Daemon, startDaemon } from '@orbit/orbitd';
import { localClient, readDaemonInfo } from '@orbit/sdk-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './cli';
import { waitForDaemonExit } from './daemon-control';
import type { Io } from './io';

const FAKE_CLAUDE = join(import.meta.dirname, '../test/fake-claude-auth.mjs');

/** Daemons the CLI auto-started in this process (one per test home). */
const daemons: Daemon[] = [];

function harness(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env,
    color: false,
    onInterrupt: () => () => undefined,
    // Auto-start orbitd in-process (the real CLI spawns it detached).
    startDaemon: async (e) => {
      daemons.push(
        await startDaemon({
          env: e,
          port: 0,
          log: () => undefined,
          service: { vaultKeySource: 'file', mock: { delayMs: 0 } },
        }),
      );
    },
  };
  return {
    run: (...argv: string[]) => main(argv, io),
    out,
    err,
    text: () => out.join('\n'),
    json: <T>() => JSON.parse(out.join('\n')) as T,
    ndjson: () => out.map((l) => JSON.parse(l) as RunEvent),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

describe('orbit CLI', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orbit-cli-'));
  });
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop();
    // A daemon the real bin started as its own process.
    const info = readDaemonInfo(home);
    if (info && info.pid !== process.pid) {
      await localClient(home)
        ?.stopDaemon()
        .catch(() => undefined);
      await waitForDaemonExit(home);
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** Two human principals: subscription (CLI driver) use must be refused. */
  const sharedConfig = () =>
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        principals: [
          { id: 'ada', kind: 'human' },
          { id: 'bob', kind: 'human' },
        ],
      }),
    );

  const mockEnv = () => ({ ORBIT_HOME: home, ORBIT_DRIVER: 'mock', PATH: process.env.PATH });

  it('app prints a one-time sign-in link the App can redeem once (ADR-011)', async () => {
    const cli = harness(mockEnv());
    expect(await cli.run('app', '--json')).toBe(0);
    const { url } = cli.json<{ url: string; expiresAt: string }>();
    const m = /^(http:\/\/127\.0\.0\.1:\d+)\/login#ticket=([\w-]+)$/.exec(url);
    expect(m).not.toBeNull();
    const [, origin, ticket] = m ?? [];
    const redeem = () =>
      fetch(`${origin}/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orbit-csrf': '1', origin: origin ?? '' },
        body: JSON.stringify({ ticket }),
      });
    const first = await redeem();
    expect(first.status).toBe(201);
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await redeem()).status).toBe(401);

    cli.reset();
    expect(await cli.run('app', '--origin', 'https://evil.example', '--json')).toBe(ExitCode.usage);
    cli.reset();
    expect(await cli.run('app', '--no-open', '--origin', 'http://localhost:5173')).toBe(0);
    expect(cli.text()).toMatch(/Open Orbit: http:\/\/localhost:5173\/login#ticket=/);
  });

  it('doctor reports the active driver and auth method (human and --json)', async () => {
    const h = harness(mockEnv());
    expect(await h.run('doctor')).toBe(ExitCode.ok);
    expect(h.text()).toMatch(/Driver\s+mock \(forced by ORBIT_DRIVER\)/);
    expect(h.text()).toMatch(/Auth\s+Demo mode/);
    h.reset();
    expect(await h.run('doctor', '--json')).toBe(ExitCode.ok);
    const report = h.json<{ driver: string; authMethod: string; models: { default: string } }>();
    expect(report).toMatchObject({
      driver: 'mock',
      authMethod: 'mock',
      models: { default: 'opus' },
    });
  });

  it('doctor guides onboarding when nothing is configured (exit 3)', async () => {
    const h = harness({ ORBIT_HOME: home, PATH: '/nonexistent' });
    expect(await h.run('doctor')).toBe(ExitCode.authRequired);
    expect(h.text()).toMatch(/Get started/);
    expect(h.text()).toMatch(/claude auth login/);
    expect(h.text()).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('doctor refuses subscription mode for several people (exit 4) and explains the API-key path', async () => {
    sharedConfig();
    const h = harness({ ORBIT_HOME: home, ORBIT_CLAUDE_PATH: FAKE_CLAUDE, PATH: process.env.PATH });
    expect(await h.run('doctor', '--json')).toBe(ExitCode.complianceRefused);
    const report = h.json<{
      driver: null;
      refusal: { code: string; message: string; hint: string };
    }>();
    expect(report.driver).toBeNull();
    expect(report.refusal.code).toBe('compliance_refused');
    expect(report.refusal.message).toMatch(/human principals/);
    expect(`${report.refusal.message} ${report.refusal.hint}`).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('hosted mode: orbitd refuses to start, so nothing can use a subscription', async () => {
    const h = harness({ ORBIT_HOME: home, ORBIT_MODE: 'hosted', ORBIT_CLAUDE_PATH: FAKE_CLAUDE });
    expect(await h.run('doctor')).toBe(ExitCode.usage);
    expect(h.err.join('\n')).toMatch(/Hosted mode is not available yet/);
  });

  it('doctor warns about a stray API key while a subscription login exists', async () => {
    const h = harness({
      ORBIT_HOME: home,
      ORBIT_CLAUDE_PATH: FAKE_CLAUDE,
      ANTHROPIC_API_KEY: 'sk-ant-api03-stray-key-000000000',
      PATH: process.env.PATH,
    });
    expect(await h.run('doctor')).toBe(ExitCode.ok);
    expect(h.text()).toMatch(/Driver\s+sdk/);
    expect(h.text()).toMatch(/pay-as-you-go/);
    expect(h.text()).not.toContain('sk-ant-api03-stray-key');
  });

  it('login-help explains both auth modes and the compliance limits', async () => {
    const h = harness(mockEnv());
    expect(await h.run('login-help')).toBe(0);
    expect(h.text()).toMatch(/subscription/i);
    expect(h.text()).toMatch(/single-user/);
  });

  it('creates a bot, runs it, streams NDJSON and replays it from the log', async () => {
    const h = harness(mockEnv());
    expect(
      await h.run(
        'bot',
        'create',
        '--name',
        'Notes',
        '--goal',
        'Summarize notes',
        '--fixture',
        'read-then-write-denied',
      ),
    ).toBe(0);
    h.reset();
    expect(await h.run('bot', 'list', '--json')).toBe(0);
    expect(h.json<{ spec: { name: string } }[]>().map((b) => b.spec.name)).toEqual(['Notes']);

    h.reset();
    expect(await h.run('run', 'notes', '--json')).toBe(ExitCode.ok);
    const events = h.ndjson();
    expect(events[0]!.type).toBe('run.queued');
    expect(events.at(-1)!.type).toBe('run.completed');
    expect(events.some((e) => e.type === 'permission.decision')).toBe(true);
    const runId = events[0]!.runId;

    h.reset();
    expect(await h.run('logs', runId, '--json')).toBe(0);
    expect(h.ndjson()).toEqual(events);

    h.reset();
    expect(await h.run('runs', '--json')).toBe(0);
    expect(h.json<{ runId: string; status: string }[]>()[0]).toMatchObject({
      runId,
      status: 'completed',
    });
  });

  it('human run output shows tools, decisions and the result', async () => {
    const h = harness(mockEnv());
    await h.run('bot', 'create', '--name', 'Notes', '--goal', 'Summarize notes');
    h.reset();
    expect(await h.run('run', 'Notes', '--fixture', 'read-then-write-denied')).toBe(0);
    expect(h.text()).toMatch(/⚙ Read notes\.txt/);
    expect(h.text()).toMatch(/✓ allowed — Read-only/);
    expect(h.text()).toMatch(/✔ completed/);
  });

  it('exits 75 with a resume time when a usage limit pauses the run', async () => {
    const h = harness(mockEnv());
    await h.run('bot', 'create', '--name', 'Notes', '--goal', 'x', '--fixture', 'usage-limit');
    h.reset();
    expect(await h.run('run', 'Notes')).toBe(ExitCode.rateLimited);
    expect(h.text()).toMatch(/Usage limit reached — resumes at/);
    expect(h.text()).toMatch(/paused, not failed/);
  });

  it('exits 5 when a run fails', async () => {
    const h = harness(mockEnv());
    await h.run('bot', 'create', '--name', 'Notes', '--goal', 'x', '--fixture', 'max-turns');
    expect(await h.run('run', 'Notes')).toBe(ExitCode.runFailed);
  });

  it('creates bots from YAML files', async () => {
    const file = join(home, 'bot.yaml');
    writeFileSync(
      file,
      'name: Inbox Triage\ngoal: Triage my inbox and draft replies\ntools: [Read, Grep]\nmaxTurns: 8\n',
    );
    const h = harness(mockEnv());
    expect(await h.run('bot', 'create', '--file', file, '--json')).toBe(0);
    expect(h.json<{ spec: unknown }>().spec).toMatchObject({
      name: 'Inbox Triage',
      tools: ['Read', 'Grep'],
      maxTurns: 8,
    });
  });

  it('uses distinct exit codes for usage errors and missing things', async () => {
    const h = harness(mockEnv());
    expect(await h.run('run')).toBe(ExitCode.usage);
    expect(await h.run('run', 'nope')).toBe(ExitCode.notFound);
    expect(await h.run('logs', 'run_missing')).toBe(ExitCode.notFound);
    expect(await h.run('bot', 'create', '--name', 'only-name')).toBe(ExitCode.usage);
    expect(await h.run('--version')).toBe(0);
  });

  it('the real bin auto-starts orbitd in the background and sets the process exit code', () => {
    sharedConfig();
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'bin.ts'), 'doctor', '--json'],
      {
        // Any free port: a developer's own orbitd may hold the default one.
        env: {
          PATH: process.env.PATH,
          ORBIT_HOME: home,
          ORBIT_CLAUDE_PATH: FAKE_CLAUDE,
          ORBIT_PORT: '0',
        },
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(ExitCode.complianceRefused);
    const info = readDaemonInfo(home);
    expect(info?.pid).not.toBe(process.pid); // its own detached process
    expect((JSON.parse(r.stdout) as { daemon: { pid: number } }).daemon.pid).toBe(info?.pid);
  }, 30_000);

  it('the real bin exits once the followed run ends (no stream left open)', () => {
    const bin = join(import.meta.dirname, 'bin.ts');
    const env = { ...mockEnv(), ORBIT_PORT: '0' };
    const create = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        bin,
        'bot',
        'create',
        '--name',
        'Notes',
        '--goal',
        'x',
        '--fixture',
        'pong',
      ],
      { env, encoding: 'utf8' },
    );
    expect(create.status, create.stderr).toBe(0);
    const run = spawnSync(process.execPath, ['--import', 'tsx', bin, 'run', 'notes'], {
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(run.signal, 'the CLI hung after the run ended').toBeNull();
    expect(run.status, run.stderr).toBe(ExitCode.ok);
    expect(run.stdout).toMatch(/✔ completed/);
  }, 40_000);

  it('does not start a daemon when ORBIT_NO_AUTOSTART=1', async () => {
    const h = harness({ ...mockEnv(), ORBIT_NO_AUTOSTART: '1' });
    expect(await h.run('bot', 'list')).toBe(ExitCode.error);
    expect(h.err.join('\n')).toMatch(/orbitd is not running/);
    expect(daemons).toHaveLength(0);
  });

  describe('M4: tail, bot run/logs, --json, completions', () => {
    it('tail replays a finished Run and exits with its outcome; bot logs shows the newest Run', async () => {
      const h = harness(mockEnv());
      await h.run('bot', 'create', '--name', 'Notes', '--goal', 'x', '--fixture', 'pong');
      h.reset();
      expect(await h.run('bot', 'run', 'notes', '--json')).toBe(0);
      const runId = h.ndjson()[0]!.runId;
      h.reset();
      expect(await h.run('tail', runId)).toBe(ExitCode.ok);
      expect(h.text()).toMatch(/already ended \(completed\)/);
      expect(h.text()).toMatch(/✔ completed/);
      h.reset();
      expect(await h.run('bot', 'logs', 'notes', '--json')).toBe(0);
      expect(h.ndjson().at(-1)?.runId).toBe(runId);
    });

    it('tail follows a parked Run to completion after an approval elsewhere', async () => {
      const h = harness(mockEnv());
      await h.run(
        'bot',
        'create',
        '--file',
        writeSpec(
          home,
          'm.yaml',
          'name: Mailer\ngoal: x\nmock: { fixture: send-email }\napprovals: { parkWindowSeconds: 0 }\n',
        ),
      );
      h.reset();
      expect(await h.run('run', 'mailer', '--json')).toBe(ExitCode.waitingApproval);
      const runId = h.ndjson()[0]!.runId;
      h.reset();
      expect(await h.run('tail', runId, '--segment')).toBe(ExitCode.waitingApproval);
      h.reset();
      const other = harness(mockEnv());
      await other.run('approvals', '--json');
      const [pending] = other.json<{ id: string }[]>();
      const tailing = h.run('tail', runId, '--json');
      await other.run('approve', pending!.id, '--no-resume');
      await other.run('resume', runId, '--json');
      expect(await tailing).toBe(ExitCode.ok);
      expect(h.ndjson().at(-1)?.type).toBe('run.completed');
    });

    it('--json errors are machine-readable on stdout too', async () => {
      const h = harness(mockEnv());
      expect(await h.run('bot', 'list', '--json')).toBe(0);
      h.reset();
      expect(await h.run('logs', 'run_missing', '--json')).toBe(ExitCode.notFound);
      expect(h.json<{ error: { code: string } }>().error.code).toBe('not_found');
    });

    it('every command that prints data takes --json', async () => {
      const h = harness(mockEnv());
      expect(await h.run('completion', 'bash')).toBe(0);
      const cases = [...h.text().matchAll(/^\s+"([^"]*)"\) opts="([^"]*)"/gm)].map((m) => ({
        path: m[1]!,
        opts: m[2]!.split(' '),
      }));
      const leaves = cases.filter(
        (c) => c.path !== '' && !cases.some((o) => o.path.startsWith(`${c.path} `)),
      );
      // Not data: the TUI itself, the completion script, JSONL export.
      const exempt = new Set(['tui', 'completion', 'audit export']);
      const missing = leaves.filter((c) => !exempt.has(c.path) && !c.opts.includes('--json'));
      expect(leaves.length).toBeGreaterThan(25);
      expect(missing.map((c) => c.path)).toEqual([]);
    });

    it('generates bash, zsh and fish completions; bash completes subcommands and options', async () => {
      const h = harness(mockEnv());
      expect(await h.run('completion', 'bash')).toBe(0);
      const script = join(home, 'orbit.bash');
      writeFileSync(script, h.text());
      const complete = (...words: string[]) =>
        spawnSync(
          'bash',
          [
            '-c',
            `source ${script}; COMP_WORDS=(orbit ${words.map((w) => `'${w}'`).join(' ')}); COMP_CWORD=${words.length}; _orbit_complete; printf '%s\\n' "\${COMPREPLY[@]}"`,
          ],
          { encoding: 'utf8' },
        )
          .stdout.trim()
          .split('\n');
      expect(complete('ta')).toEqual(['tail']);
      expect(complete('bot', '')).toEqual(
        expect.arrayContaining(['create', 'list', 'run', 'logs', 'pause']),
      );
      expect(complete('approve', 'apr_123', '--al')).toEqual(['--always']);
      expect(complete('daemon', 'st')).toEqual(['start', 'stop', 'status']);
      h.reset();
      expect(await h.run('completion', 'zsh')).toBe(0);
      expect(h.text()).toMatch(/^#compdef orbit/);
      h.reset();
      expect(await h.run('completion', 'fish')).toBe(0);
      expect(h.text()).toMatch(/complete -c orbit -f -n '__fish_use_subcommand' -a 'tail'/);
      expect(await h.run('completion', 'powershell')).toBe(ExitCode.usage);
    });
  });

  describe('M3: daemon, queue, schedules', () => {
    it('daemon status / stop / start, and the CLI reconnects to a fresh daemon', async () => {
      const h = harness(mockEnv());
      expect(await h.run('daemon', 'status')).toBe(ExitCode.error);
      expect(h.text()).toMatch(/not running/);
      h.reset();
      expect(await h.run('daemon', 'start', '--json')).toBe(0);
      expect(h.json<{ running: boolean; url: string }>()).toMatchObject({ running: true });
      h.reset();
      expect(await h.run('daemon', 'stop')).toBe(0);
      expect(h.text()).toMatch(/orbitd stopped/);
      expect(readDaemonInfo(home)).toBeNull();
      h.reset();
      // Data survives the restart: the next command auto-starts a new daemon.
      await h.run('bot', 'create', '--name', 'Keep', '--goal', 'x');
      await h.run('daemon', 'restart', '--json');
      h.reset();
      expect(await h.run('bot', 'list', '--json')).toBe(0);
      expect(h.json<{ spec: { name: string } }[]>().map((b) => b.spec.name)).toEqual(['Keep']);
    });

    it('creates scheduled bots and lists their next fire', async () => {
      const h = harness(mockEnv());
      expect(
        await h.run(
          'bot',
          'create',
          '--name',
          'Digest',
          '--goal',
          'x',
          '--cron',
          '0 9 * * 1-5',
          '--json',
        ),
      ).toBe(0);
      expect(h.json<{ spec: { triggers: unknown[] } }>().spec.triggers).toEqual([
        { kind: 'cron', cron: '0 9 * * 1-5', enabled: true },
      ]);
      await h.run('bot', 'create', '--name', 'Poller', '--goal', 'x', '--every', '15');
      expect(await h.run('bot', 'create', '--name', 'Bad', '--goal', 'x', '--cron', 'soon')).toBe(
        ExitCode.usage,
      );
      h.reset();
      expect(await h.run('schedules')).toBe(0);
      expect(h.text()).toMatch(/Digest\s+cron 0 9 \* \* 1-5\s+next /);
      expect(h.text()).toMatch(/Poller\s+every 15m\s+next /);
      h.reset();
      expect(await h.run('schedules', '--bot', 'poller', '--json')).toBe(0);
      expect(h.json<{ kind: string }[]>().map((e) => e.kind)).toEqual(['interval']);
    });

    it('shows the queue with its concurrency limit', async () => {
      const h = harness({ ...mockEnv(), ORBIT_MAX_CONCURRENT_RUNS: '2' });
      expect(await h.run('queue', '--json')).toBe(0);
      expect(h.json<{ limit: number; active: unknown[] }>()).toMatchObject({
        limit: 2,
        active: [],
      });
      h.reset();
      expect(await h.run('queue')).toBe(0);
      expect(h.text()).toMatch(/0\/2 running · 0 waiting/);
    });

    it('a usage limit says when the run resumes by itself', async () => {
      const h = harness(mockEnv());
      await h.run('bot', 'create', '--name', 'Notes', '--goal', 'x', '--fixture', 'usage-limit');
      h.reset();
      expect(await h.run('run', 'Notes')).toBe(ExitCode.rateLimited);
      expect(h.text()).toMatch(/resumes by itself at/);
    });
  });

  describe('M2: approvals, kill switches, audit, rules, secrets', () => {
    const mailer = (h: ReturnType<typeof harness>, extra: string[] = []) =>
      h.run(
        'bot',
        'create',
        '--file',
        writeSpec(
          home,
          'mailer.yaml',
          'name: Mailer\ngoal: Reply to Ada\nmock: { fixture: send-email }\napprovals: { parkWindowSeconds: 0 }\n',
        ),
        ...extra,
      );

    it('parks on an external action (exit 10) and approve resumes it to completion', async () => {
      const h = harness(mockEnv());
      await mailer(h);
      h.reset();
      expect(await h.run('run', 'mailer')).toBe(ExitCode.waitingApproval);
      expect(h.text()).toMatch(/approval needed/);
      h.reset();
      expect(await h.run('approvals', '--json')).toBe(0);
      const [pending] = h.json<{ id: string; card: { what: string } }[]>();
      expect(pending!.card.what).toBe('send email (gmail) → ada@example.com');
      h.reset();
      expect(await h.run('approvals')).toBe(0);
      expect(h.text()).toMatch(/What\s+send email/);
      h.reset();
      expect(await h.run('approve', pending!.id)).toBe(ExitCode.ok);
      expect(h.text()).toMatch(/✔ Approved/);
      expect(h.text()).toMatch(/✔ completed/);
      h.reset();
      expect(await h.run('audit', 'verify', '--json')).toBe(0);
      expect(h.json<{ ok: boolean; count: number }>()).toMatchObject({ ok: true });
    });

    it('deny with a reason and --no-resume leaves the run parked-but-decided', async () => {
      const h = harness(mockEnv());
      await mailer(h);
      await h.run('run', 'mailer');
      h.reset();
      await h.run('approvals', '--json');
      const [pending] = h.json<{ id: string; runId: string }[]>();
      h.reset();
      expect(await h.run('deny', pending!.id, '--reason', 'wrong tone', '--no-resume')).toBe(0);
      expect(h.text()).toMatch(/Denied .* — wrong tone/);
      h.reset();
      expect(await h.run('approve', pending!.id)).toBe(ExitCode.usage);
    });

    it('--always creates a rule that is listed and can be revoked', async () => {
      const h = harness(mockEnv());
      await mailer(h);
      await h.run('run', 'mailer');
      h.reset();
      await h.run('approvals', '--json');
      const [pending] = h.json<{ id: string }[]>();
      await h.run('approve', pending!.id, '--always', '--expires', '7d', '--no-resume');
      h.reset();
      expect(await h.run('rules', 'list', '--json')).toBe(0);
      const [rule] =
        h.json<{ id: string; toolPattern: string; effect: string; expiresAt: string }[]>();
      expect(rule).toMatchObject({ toolPattern: 'mcp__gmail__send_email', effect: 'allow' });
      expect(Date.parse(rule!.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect(await h.run('rules', 'revoke', rule!.id)).toBe(0);
    });

    it('refuses allow rules for financial tools', async () => {
      const h = harness(mockEnv());
      expect(
        await h.run('rules', 'add', '--tool', 'mcp__bank__transfer_funds', '--effect', 'allow'),
      ).toBe(ExitCode.usage);
      expect(h.err.join('\n')).toMatch(/never be allowed/);
    });

    it('global kill switch blocks runs (exit 7) until released', async () => {
      const h = harness(mockEnv());
      await h.run('bot', 'create', '--name', 'Notes', '--goal', 'x', '--fixture', 'pong');
      expect(await h.run('kill')).toBe(0);
      expect(await h.run('run', 'notes')).toBe(ExitCode.blocked);
      expect(h.err.join('\n')).toMatch(/kill switch is engaged/);
      h.reset();
      expect(await h.run('kill', '--status', '--json')).toBe(0);
      expect(h.json<{ engaged: boolean }>().engaged).toBe(true);
      await h.run('kill', '--off');
      expect(await h.run('run', 'notes')).toBe(0);
    });

    it('pausing a bot blocks its runs; stop cancels a parked run', async () => {
      const h = harness(mockEnv());
      await mailer(h);
      await h.run('bot', 'pause', 'mailer');
      expect(await h.run('run', 'mailer')).toBe(ExitCode.blocked);
      await h.run('bot', 'resume', 'mailer');
      await h.run('run', 'mailer');
      h.reset();
      await h.run('runs', '--json');
      const [parked] = h.json<{ runId: string; status: string }[]>();
      expect(parked!.status).toBe('waiting_approval');
      expect(await h.run('stop', parked!.runId)).toBe(0);
      h.reset();
      await h.run('runs', '--json');
      expect(h.json<{ status: string }[]>()[0]!.status).toBe('cancelled');
    });

    it('stores secrets encrypted, never prints them, and audits names only', async () => {
      const h = harness(mockEnv());
      const valueFile = join(home, 'token.txt');
      writeFileSync(valueFile, 'ghp_supersecretvalue1234567890abcdefgh\n');
      expect(await h.run('secret', 'set', 'GITHUB_TOKEN', '--value-file', valueFile)).toBe(0);
      h.reset();
      expect(await h.run('secret', 'list', '--json')).toBe(0);
      expect(h.text()).toContain('GITHUB_TOKEN');
      expect(h.text()).not.toContain('supersecret');
      h.reset();
      await h.run('audit', 'export');
      expect(h.text()).toContain('secret.set');
      expect(h.text()).not.toContain('supersecret');
      expect(await h.run('secret', 'rm', 'GITHUB_TOKEN')).toBe(0);
      expect(await h.run('secret', 'rm', 'GITHUB_TOKEN')).toBe(ExitCode.notFound);
    });
  });
});

function writeSpec(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
