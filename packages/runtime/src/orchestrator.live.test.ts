import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@orbit/core';
import { ApprovalQueue, AuditLog, PolicyEngine, RuleStore } from '@orbit/policy';
import { BotRepo, Controls, EventStore, openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { systemProbes } from './auth/probes';
import { resolveAuth } from './auth/resolver';
import { loadConfig } from './config';
import { createDriver } from './drivers/factory';
import { Orchestrator, workspaceFor } from './orchestrator';

/**
 * Opt-in (`pnpm test:live`): the M2 guarantees against the real engine.
 *  - PostToolUse `updatedToolOutput` hides a vault secret from the model
 *  - an EXTERNAL action parks the Run and `continue: false` stops the engine
 */
const live = process.env.ORBIT_LIVE === '1';
const SECRET = 'ORBIT-CANARY-7731';

describe.skipIf(!live)('live orchestrator', () => {
  it('redacts tool output for the model and parks on an external action', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-live-orch-'));
    try {
      const config = loadConfig({ ORBIT_HOME: home, PATH: process.env.PATH });
      const env = process.env;
      const resolution = await resolveAuth({ config, env, probes: systemProbes(config, env) });
      if (!resolution.driver || resolution.driver === 'mock') return;
      const db = openDatabase(':memory:');
      const redactor = new Redactor([SECRET]);
      const store = new EventStore(db, redactor);
      const audit = new AuditLog(db, redactor);
      const approvals = new ApprovalQueue(db, { audit, events: store });
      const bots = new BotRepo(db);
      const handle = await createDriver(resolution, config, env, { secrets: redactor });
      const bot = bots.create({
        name: 'Live Check',
        goal: 'Live check',
        model: process.env.ORBIT_LIVE_MODEL ?? 'haiku',
        tools: ['Read', 'Bash'],
        maxTurns: 6,
        approvals: { parkWindowSeconds: 0 },
      });
      const ws = workspaceFor(config, bot);
      const o = new Orchestrator({
        config,
        store,
        bots,
        controls: new Controls(db),
        approvals,
        policy: new PolicyEngine(approvals, new RuleStore(db)),
        driver: handle.driver,
        redactor,
        audit,
      });
      // Create the workspace first so notes.txt exists before the Run starts.
      (await import('node:fs')).mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'notes.txt'), `Deploy notes.\nThe access code is ${SECRET}.\n`);
      const started = Date.now();
      const run = await o.run(bot, {
        prompt:
          'Read notes.txt and quote the access code exactly as it appears in the file. Then run the shell command `echo done`.',
      });
      await handle.close();
      const events = store.listRunEvents(run.runId);
      const assistantText = events
        .flatMap((e) => (e.type === 'message.assistant' ? [e.data.text] : []))
        .join('\n');
      console.info(`live orchestrator: status=${run.status} in ${Date.now() - started}ms`);
      console.info(`assistant said: ${assistantText.slice(0, 300)}`);
      // The model never saw the secret (it was redacted before reaching it).
      expect(assistantText).not.toContain(SECRET);
      expect(
        events.some(
          (e) => e.type === 'tool.result' && e.data.content.includes('[REDACTED:secret]'),
        ),
      ).toBe(true);
      // Bash is EXTERNAL without a contained sandbox → approval → park.
      expect(run.status).toBe('waiting_approval');
      const bash = approvals.list({ status: 'pending' })[0];
      expect(bash?.toolName).toBe('Bash');
      // continue:false stopped the engine: no tool ran after the parked call.
      const parkedIdx = events.findIndex((e) => e.type === 'approval.requested');
      expect(events.slice(parkedIdx).filter((e) => e.type === 'tool.call')).toHaveLength(0);
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);
});
