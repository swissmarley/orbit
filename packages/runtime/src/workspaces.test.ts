import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BotSpecInput,
  OrbitConfig,
  OrbitError,
  Redactor,
  type RunEventBody,
  event,
} from '@orbit/core';
import { ApprovalQueue, PolicyEngine } from '@orbit/policy';
import { type CommandRunner, SandboxManager } from '@orbit/sandbox';
import { BotRepo, Controls, EventStore, openDatabase } from '@orbit/store';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentDriver, DriverRunRequest } from './drivers/types';
import { Orchestrator, type PreparedWorkspace } from './orchestrator';
import { keyProxyCredential, sandboxWorkspaces } from './workspaces';

const root = mkdtempSync(join(tmpdir(), 'orbit-ws-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const fresh = () => join(root, `h${++n}`);

/** A Docker daemon that has the image and no container yet; records every command. */
function daemon(): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'inspect') {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'Error: No such object' });
    }
    if (args[0] === 'version') return Promise.resolve({ code: 0, stdout: '29.0.0\n', stderr: '' });
    return Promise.resolve({ code: 0, stdout: 'sha256:img\n', stderr: '' });
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const SUPPORT = {
  docker: { available: true, version: '29.0.0', error: null },
  engineSandbox: { available: false, missing: ['bwrap'], platform: 'linux' },
};

describe('keyProxyCredential (where the key proxies get the key, ADR-018)', () => {
  it('uses orbitd’s API key, then the apiKeyHelper; refuses Bedrock and Vertex', async () => {
    const key = keyProxyCredential({ ANTHROPIC_API_KEY: ' sk-ant-1 ' }, null);
    expect(key.kind).toBe('key');
    expect(key.kind === 'key' ? await key.source.get() : null).toBe('sk-ant-1');
    expect(keyProxyCredential({}, 'printf sk-ant-2').kind).toBe('key');
    expect(
      keyProxyCredential({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'x' }, null),
    ).toEqual({ kind: 'unsupported', provider: 'bedrock' });
    expect(keyProxyCredential({ CLAUDE_CODE_USE_VERTEX: 'true' }, null)).toEqual({
      kind: 'unsupported',
      provider: 'vertex',
    });
    expect(keyProxyCredential({}, null)).toEqual({ kind: 'none' });
  });
});

describe('sandboxWorkspaces — docker without the experimental gate', () => {
  const docker = (spec: Partial<BotSpecInput['sandbox']> = {}) => ({
    kind: 'docker' as const,
    ...spec,
  });

  async function prepare(sandbox: ReturnType<typeof docker>, driver: 'sdk' | 'cli' | 'mock') {
    const home = fresh();
    const db = openDatabase(':memory:');
    const bot = new BotRepo(db).create({ name: 'Box', goal: 'g', sandbox });
    const manager = new SandboxManager({
      orbitHome: home,
      run: daemon(),
      support: SUPPORT,
      credential: keyProxyCredential({ ANTHROPIC_API_KEY: 'sk-ant-api03-WSSECRET' }, null),
    });
    try {
      const provider = sandboxWorkspaces(manager, { ANTHROPIC_API_KEY: 'sk-ant-api03-WSSECRET' });
      return await provider(bot, driver);
    } finally {
      await manager.close();
    }
  }

  it('prepares a docker Bot in API-key mode with no ORBIT_EXPERIMENTAL_DOCKER', async () => {
    const ws = await prepare(docker(), 'sdk');
    expect(typeof ws.spawnEngine).toBe('function');
    expect(ws.apiKeyProxied).toBe(true);
    // No network, no key in the container: Bash counts as sandboxed.
    expect(ws.shellContained).toBe(true);
    expect(ws.mounts).toEqual([{ container: '/workspace', host: ws.path, writable: true }]);
    expect(typeof ws.release).toBe('function');
    expect(JSON.stringify(ws)).not.toContain('WSSECRET');
  });

  it('keeps Bash EXTERNAL with an allowlist', async () => {
    const ws = await prepare(docker({ network: 'allowlist', allowedDomains: ['pypi.org'] }), 'sdk');
    expect(ws.shellContained).toBe(false);
  });

  it('still refuses the subscription (CLI) driver', async () => {
    const err = await prepare(docker(), 'cli').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrbitError);
    expect((err as OrbitError).hint).toMatch(/ADR-004/);
  });
});

describe('Orchestrator with a container workspace', () => {
  function setup(ws: (home: string, botId: string) => PreparedWorkspace) {
    const home = fresh();
    const db = openDatabase(':memory:');
    const store = new EventStore(db, new Redactor());
    const approvals = new ApprovalQueue(db, { events: store });
    const bots = new BotRepo(db);
    const controls = new Controls(db);
    const seen: { req: DriverRunRequest | null; decisions: [string, string][] } = {
      req: null,
      decisions: [],
    };
    const driver: AgentDriver = {
      kind: 'sdk',
      authMethod: 'api_key',
      run: async function* (req): AsyncIterable<RunEventBody> {
        seen.req = req;
        const calls: [string, Record<string, unknown>][] = [
          ['Write', { file_path: '/workspace/out.txt', content: 'x' }],
          ['Read', { file_path: '/workspace/out.txt' }],
          ['Read', { file_path: '/etc/passwd' }],
          ['Write', { file_path: join(home, 'workspaces', 'x.txt'), content: 'x' }],
          ['Bash', { command: 'make test' }],
        ];
        for (const [toolName, input] of calls) {
          const d = await req.permission(
            { toolName, input, toolUseId: `tu_${toolName}`, parentToolUseId: null },
            req.signal,
          );
          seen.decisions.push([
            `${toolName} ${String(input.file_path ?? input.command)}`,
            d.behavior,
          ]);
        }
        yield event('run.completed', {
          result: 'done',
          stopReason: 'end_turn',
          sessionId: null,
          permissionDenials: [],
        });
      },
    };
    const orchestrator = new Orchestrator({
      config: OrbitConfig.parse({ home }),
      store,
      bots,
      controls,
      approvals,
      policy: new PolicyEngine(approvals, approvals.ruleStore),
      driver,
      redactor: new Redactor(),
      workspaces: (bot) => Promise.resolve(ws(home, bot.id)),
    });
    const bot = bots.create({ name: 'Box', goal: 'g', approvals: { parkWindowSeconds: 0 } });
    return { orchestrator, bot, seen, controls };
  }

  it('maps /workspace paths for policy, passes apiKeyProxied and releases the proxies once', async () => {
    let released = 0;
    const { orchestrator, bot, seen } = setup((home, botId) => {
      const path = join(home, 'workspaces', botId);
      return {
        path,
        shellContained: true,
        engineSandbox: null,
        apiKeyProxied: true,
        mounts: [{ container: '/workspace', host: path, writable: true }],
        release: () => {
          released += 1;
        },
      };
    });
    const run = await orchestrator.run(bot);
    expect(run.status).toBe('completed');
    expect(seen.req?.apiKeyProxied).toBe(true);
    expect(seen.decisions.map(([, d]) => d)).toEqual([
      'allow', // Write /workspace/out.txt
      'allow', // Read /workspace/out.txt
      'deny', // Read /etc/passwd
      'deny', // a host path means nothing inside the container
      'allow', // Bash: no network in the container (WRITE_LOCAL)
    ]);
    expect(released).toBe(1);
  });

  it('releases the proxies when a kill switch stops the Run before the engine starts', async () => {
    let released = 0;
    let controlsRef: Controls | null = null;
    const { orchestrator, bot, controls } = setup((home, botId) => {
      controlsRef?.setGlobalKill(true, 'owner');
      return {
        path: join(home, 'workspaces', botId),
        shellContained: true,
        engineSandbox: null,
        release: () => {
          released += 1;
        },
      };
    });
    controlsRef = controls;
    const run = await orchestrator.run(bot);
    expect(run.status).toBe('cancelled');
    expect(released).toBe(1);
  });

  it('releases the proxies the moment a budget stops the Run, before the engine has wound down', async () => {
    const home = fresh();
    const db = openDatabase(':memory:');
    const store = new EventStore(db, new Redactor());
    const approvals = new ApprovalQueue(db, { events: store });
    const bots = new BotRepo(db);
    let released = 0;
    let releasedAtStop: number | null = null;
    const driver: AgentDriver = {
      kind: 'sdk',
      authMethod: 'api_key',
      run: async function* (req): AsyncIterable<RunEventBody> {
        for (const n of [1, 2]) {
          await req.permission(
            {
              toolName: 'Read',
              input: { file_path: 'a' },
              toolUseId: `tu_${n}`,
              parentToolUseId: null,
            },
            req.signal,
          );
        }
        // The second call broke the tool-call budget: the engine is still running here.
        releasedAtStop = released;
        yield event('run.cancelled', { reason: 'Run was stopped', sessionId: null });
      },
    };
    const orchestrator = new Orchestrator({
      config: OrbitConfig.parse({ home }),
      store,
      bots,
      controls: new Controls(db),
      approvals,
      policy: new PolicyEngine(approvals, approvals.ruleStore),
      driver,
      redactor: new Redactor(),
      workspaces: (bot) =>
        Promise.resolve({
          path: join(home, 'workspaces', bot.id),
          shellContained: true,
          engineSandbox: null,
          apiKeyProxied: true,
          release: () => {
            released += 1;
          },
        }),
    });
    const bot = bots.create({ name: 'Box', goal: 'g', budgets: { maxToolCallsPerRun: 1 } });
    const run = await orchestrator.run(bot);
    expect(run.status).not.toBe('completed');
    expect(releasedAtStop).toBe(1);
    expect(released).toBe(1);
  });
});
