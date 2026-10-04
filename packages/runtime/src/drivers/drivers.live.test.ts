import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunEventBody, isTerminalEvent } from '@orbit/core';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAuth } from '../auth/resolver';
import { systemProbes } from '../auth/probes';
import { loadConfig } from '../config';
import { createDriver } from './factory';
import type { PermissionHandler } from './types';

/**
 * Opt-in: `pnpm test:live`. Uses whatever real auth is available — SdkDriver
 * with an API key, otherwise CliDriver with a logged-in `claude`. Never runs
 * in CI. Costs one small model call on the cheapest alias.
 */
const live = process.env.ORBIT_LIVE === '1';
const model = process.env.ORBIT_LIVE_MODEL ?? 'haiku';

describe.skipIf(!live)('live driver smoke test', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orbit-live-'));
  writeFileSync(join(ws, 'notes.txt'), 'Orbit live test.\nOwner: Ada.\n');
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  it('runs a real tool-using turn through Orbit’s permission path', async () => {
    const config = loadConfig({ ORBIT_HOME: join(ws, '.orbit'), PATH: process.env.PATH });
    const env = process.env;
    const resolution = await resolveAuth({ config, env, probes: systemProbes(config, env) });
    if (!resolution.driver || resolution.driver === 'mock') {
      console.warn(`live test skipped: ${resolution.onboarding?.reason ?? 'no real driver'}`);
      return;
    }
    console.info(`live driver: ${resolution.driver} (${resolution.label})`);
    const handle = await createDriver(resolution, config, env);
    const decisions: string[] = [];
    const policy: PermissionHandler = (r) => {
      decisions.push(r.toolName);
      return Promise.resolve(
        r.toolName === 'Read' || r.toolName === 'Write'
          ? { behavior: 'allow', reason: 'live test allows Read and Write' }
          : { behavior: 'deny', reason: 'live test allows Read and Write only' },
      );
    };
    const events: RunEventBody[] = [];
    try {
      for await (const e of handle.driver.run({
        runId: 'run_live',
        prompt:
          'Read notes.txt, write the owner name to owner.txt, then reply with only the owner name.',
        cwd: ws,
        model,
        appendSystemPrompt: 'You are a terse test bot.',
        tools: ['Read', 'Write'],
        maxTurns: 4,
        resumeSessionId: null,
        sessionId: null,
        permission: policy,
        signal: AbortSignal.timeout(150_000),
      })) {
        events.push(e);
      }
    } finally {
      await handle.close();
    }
    const terminal = events.filter(isTerminalEvent);
    expect(terminal).toHaveLength(1);
    expect(events.some((e) => e.type === 'session.init')).toBe(true);
    if (terminal[0]!.type === 'run.rate_limited') {
      console.warn('usage limit reached during live test; pause path verified instead');
      return;
    }
    expect(terminal[0]!.type).toBe('run.completed');
    // The hardened bridge only answers when the hook input matches stdout exactly.
    expect(decisions).toEqual(expect.arrayContaining(['Read', 'Write']));
    const allowed = events.filter(
      (e) => e.type === 'permission.decision' && e.data.behavior === 'allow',
    );
    expect(allowed.length).toBeGreaterThanOrEqual(2);
    const init = events.find((e) => e.type === 'session.init');
    console.info(
      `engine apiKeySource: ${init?.type === 'session.init' ? String(init.data.apiKeySource) : '?'}`,
    );
    expect(readFileSync(join(ws, 'owner.txt'), 'utf8')).toMatch(/Ada/);
    expect(events.some((e) => e.type === 'permission.decision' && e.data.toolName === 'Read')).toBe(
      true,
    );
    const done = terminal[0]!;
    expect(done.type === 'run.completed' && done.data.result).toMatch(/Ada/);
  }, 180_000);
});
