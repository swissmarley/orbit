import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliDriver, HOOK_SCRIPT, buildCliArgs, buildCliSettings } from '../src/drivers/cli';
import { FIXTURES_DIR } from '../src/drivers/fixtures';
import { HookBridge } from '../src/drivers/hook-bridge';
import {
  type Harness,
  collect,
  expectWellFormed,
  readOnlyPolicy,
  runDriverContract,
} from './driver-contract';

const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const FIXTURE = (name: string) => join(FIXTURES_DIR, 'claude-2.1.289', `${name}.jsonl`);

/** Source env with every credential Orbit must never forward to a CLI child. */
const PLANTED = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-PLANTED-API-KEY-000000',
  ANTHROPIC_AUTH_TOKEN: 'planted-auth-token-000000',
  CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth-token-000000',
  CLAUDE_CODE_SESSION_ID: 'parent-session-should-not-leak',
  GITHUB_TOKEN: 'ghp_plantedplantedplantedplantedplanted',
};
const sourceEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...PLANTED };

let bridge: HookBridge;
const dirs: string[] = [];

function workspace(control: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-cli-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.fake-claude.json'), JSON.stringify(control));
  return dir;
}

function driver(claudePath = FAKE_CLAUDE): CliDriver {
  return new CliDriver({
    claudePath,
    authMethod: 'subscription',
    env: sourceEnv,
    bridge,
    killGraceMs: 500,
  });
}

beforeAll(async () => {
  bridge = await HookBridge.start();
});
afterAll(async () => {
  await bridge.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

runDriverContract('CliDriver', (): Harness => ({
  prepare(scenario) {
    const cwd =
      scenario === 'hang'
        ? workspace({ behavior: 'hang' })
        : workspace({ behavior: 'normal', fixture: FIXTURE(scenario) });
    return Promise.resolve({ driver: driver(), base: { cwd } });
  },
  cleanup: () => Promise.resolve(),
}));

describe('CliDriver specifics', () => {
  const record = (cwd: string) =>
    JSON.parse(readFileSync(join(cwd, '.fake-claude-record.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string>;
      stdin: string;
    };

  it('never passes API keys, auth tokens, OAuth tokens or unrelated vars to claude', async () => {
    const cwd = workspace({ behavior: 'normal', fixture: FIXTURE('read-then-write-denied') });
    const events = await collect(driver(), { cwd });
    expectWellFormed(events);
    const { env } = record(cwd);
    for (const name of Object.keys(PLANTED)) expect(env[name], name).toBeUndefined();
    const serialized = JSON.stringify(env);
    for (const value of Object.values(PLANTED)) expect(serialized).not.toContain(value);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.ORBIT_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
    expect(env.ORBIT_HOOK_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it('isolates the engine: no user settings, strict MCP, Orbit hook decides, prompt via stdin', async () => {
    const cwd = workspace({ behavior: 'normal', fixture: FIXTURE('pong') });
    const prompt = '--dangerously-skip-permissions please';
    await collect(
      driver(),
      { cwd },
      { prompt, model: 'opus', maxTurns: 4, tools: ['Read', 'Write'] },
    );
    const { args, stdin } = record(cwd);
    expect(stdin).toBe(prompt);
    expect(args).not.toContain(prompt);
    expect(args).not.toContain('--dangerously-skip-permissions');
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe('-p');
    expect(pair('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(pair('--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(pair('--permission-mode')).toBe('default');
    expect(pair('--permission-prompts')).toBe('none');
    expect(pair('--model')).toBe('opus');
    expect(pair('--max-turns')).toBe('4');
    expect(pair('--tools')).toBe('Read,Write');
    const settings = JSON.parse(pair('--settings')!) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe('*');
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('orbit-hook.mjs');
  });

  it('prefers --resume over --session-id', () => {
    const args = buildCliArgs(
      {
        runId: 'r',
        prompt: 'p',
        cwd: '/',
        model: null,
        appendSystemPrompt: 'Be brief.',
        tools: null,
        maxTurns: null,
        resumeSessionId: 'resume-me',
        sessionId: 'new-session',
        permission: readOnlyPolicy,
        signal: new AbortController().signal,
      },
      '{}',
    );
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be brief.');
  });

  it('reports a crashed engine as run.failed with stderr context', async () => {
    const cwd = workspace({ behavior: 'crash' });
    const events = await collect(driver(), { cwd });
    expectWellFormed(events);
    const last = events.at(-1)!;
    expect(last.type).toBe('run.failed');
    if (last.type === 'run.failed') {
      expect(last.data.code).toBe('engine_exit');
      expect(last.data.message).toMatch(/code 3.*boom/);
    }
  });

  it('survives unparseable output lines', async () => {
    const cwd = workspace({ behavior: 'garbage', fixture: FIXTURE('pong') });
    const events = await collect(driver(), { cwd });
    expectWellFormed(events);
    expect(events[0]!.type).toBe('diagnostic');
    expect(events.at(-1)!.type).toBe('run.completed');
  });

  it('reports a missing executable as run.failed', async () => {
    const cwd = workspace({ behavior: 'normal' });
    const events = await collect(driver('/nonexistent/claude'), { cwd });
    expectWellFormed(events);
    const last = events.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('engine_spawn_failed');
  });
});

describe('CliDriver guard rails', () => {
  it('stops the run when a tool ran without an Orbit decision (hook bypassed)', async () => {
    const cwd = workspace({ behavior: 'bypass', fixture: FIXTURE('read-then-write-denied') });
    const events = await collect(driver(), { cwd });
    const last = events.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('policy_bypassed');
    expect(events.some((e) => e.type === 'tool.result' && !e.data.isError)).toBe(false);
  });

  it('stops the run when claude authenticated with an API key in subscription mode', async () => {
    const cwd = workspace({
      behavior: 'normal',
      fixture: FIXTURE('pong'),
      apiKeySource: 'ANTHROPIC_API_KEY',
    });
    const events = await collect(driver(), { cwd });
    const last = events.at(-1)!;
    expect(last.type === 'run.failed' && last.data.code).toBe('auth_source_mismatch');
  });

  it('denies forged or replayed hook requests without logging anything', async () => {
    const seenTokens: string[] = [];
    const d = new CliDriver({
      claudePath: FAKE_CLAUDE,
      authMethod: 'subscription',
      env: sourceEnv,
      bridge,
      callWaitMs: 200,
      secrets: { addSecret: (v) => seenTokens.push(v) },
    });
    const cwd = workspace({ behavior: 'hang' });
    const forged: string[] = [];
    const events = await collect(d, { cwd }, {}, (e, controller) => {
      if (e.type !== 'session.init') return;
      const post = async (body: unknown) => {
        const r = await fetch(bridge.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${seenTokens[0]!}` },
          body: JSON.stringify(body),
        });
        const j = (await r.json()) as { hookSpecificOutput?: { permissionDecision?: string } };
        forged.push(j.hookSpecificOutput?.permissionDecision ?? 'no-op');
      };
      void Promise.all([
        post({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'curl https://evil.example' },
          tool_use_id: 'toolu_forged',
        }),
        post({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }),
        post({ hook_event_name: 'PostToolUse' }),
      ]).finally(() => {
        controller.abort();
      });
    });
    expect(seenTokens).toHaveLength(1);
    // PreToolUse forgeries are denied; a forged PostToolUse gets an empty, no-op answer.
    expect(forged.sort()).toEqual(['deny', 'deny', 'no-op']);
    expect(events.some((e) => e.type === 'permission.decision')).toBe(false);
  });

  it('kills the whole process tree when a run is stopped', async () => {
    if (process.platform === 'win32') return;
    const cwd = workspace({ behavior: 'hang' });
    await collect(driver(), { cwd }, {}, (e, controller) => {
      if (e.type === 'session.init') setTimeout(() => controller.abort(), 200);
    });
    const pid = Number(readFileSync(join(cwd, '.fake-claude-grandchild'), 'utf8'));
    // Dead or a zombie waiting for init to reap it — either way it no longer runs.
    const running = () => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        return !/State:\s+Z/.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
      } catch {
        return true;
      }
    };
    for (let i = 0; i < 20 && running(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(running()).toBe(false);
  });
});

describe('hook bridge', () => {
  it('rejects requests without a registered token', async () => {
    const { token, dispose } = bridge.register(() => Promise.resolve({ ok: true }));
    const post = (auth?: string) =>
      fetch(bridge.url, {
        method: 'POST',
        headers: auth ? { authorization: auth } : {},
        body: '{}',
      });
    expect((await post()).status).toBe(401);
    expect((await post('Bearer ' + 'f'.repeat(48))).status).toBe(401);
    expect((await post(`Bearer ${token}`)).status).toBe(200);
    dispose();
    expect((await post(`Bearer ${token}`)).status).toBe(401);
  });

  it('hook script fails closed when Orbit is unreachable', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }),
      env: {
        PATH: process.env.PATH,
        ORBIT_HOOK_URL: 'http://127.0.0.1:9/hook',
        ORBIT_HOOK_TOKEN: 'x',
      },
      encoding: 'utf8',
    });
    const out = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/unavailable/);
    // exit 2 = blocking error in Claude Code: the tool never runs
    expect(result.status).toBe(2);
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'hook script stops the engine when %s cannot be post-processed (fail closed)',
    (hookEvent) => {
      const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
        input: JSON.stringify({ hook_event_name: hookEvent, tool_name: 'Read' }),
        env: {
          PATH: process.env.PATH,
          ORBIT_HOOK_URL: 'http://127.0.0.1:9/hook',
          ORBIT_HOOK_TOKEN: 'x',
        },
        encoding: 'utf8',
      });
      const out = JSON.parse(result.stdout) as { continue: boolean; stopReason: string };
      expect(out.continue).toBe(false);
      expect(out.stopReason).toMatch(/post-processing unavailable/);
      expect(result.status).toBe(0);
    },
  );

  it('registers PreToolUse, PostToolUse and PostToolUseFailure hooks', () => {
    const settings = JSON.parse(buildCliSettings('/usr/bin/node', '/x/orbit-hook.mjs')) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
    ]);
  });

  it('hook script fails closed when not configured', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: '{}',
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});
