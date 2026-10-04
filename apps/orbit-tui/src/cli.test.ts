import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, type RunEvent } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './cli';
import type { Io } from './io';

const FAKE_CLAUDE = join(import.meta.dirname, '../test/fake-claude-auth.mjs');

function harness(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    env,
    color: false,
    onInterrupt: () => () => undefined,
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
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const mockEnv = () => ({ ORBIT_HOME: home, ORBIT_DRIVER: 'mock', PATH: process.env.PATH });

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

  it('doctor refuses subscription mode when hosted (exit 4) and explains the API-key path', async () => {
    const h = harness({
      ORBIT_HOME: home,
      ORBIT_MODE: 'hosted',
      ORBIT_CLAUDE_PATH: FAKE_CLAUDE,
      PATH: process.env.PATH,
    });
    expect(await h.run('doctor', '--json')).toBe(ExitCode.complianceRefused);
    const report = h.json<{ driver: null; refusal: { code: string; message: string } }>();
    expect(report.driver).toBeNull();
    expect(report.refusal.code).toBe('compliance_refused');
    expect(report.refusal.message).toMatch(/ORBIT_MODE=hosted/);
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

  it('the real bin sets the process exit code', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'bin.ts'), 'doctor', '--json'],
      {
        env: {
          PATH: process.env.PATH,
          ORBIT_HOME: home,
          ORBIT_MODE: 'hosted',
          ORBIT_CLAUDE_PATH: FAKE_CLAUDE,
        },
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(ExitCode.complianceRefused);
  }, 30_000);

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
