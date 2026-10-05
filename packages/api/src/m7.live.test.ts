import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent, RunState } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { harness } from '../test/harness';

/**
 * Opt-in (`pnpm test:live`, ORBIT_LIVE=1): M7 against the real engine. The
 * CLI engine reaches a plugin (the Filesystem reference plugin, a real child
 * process orbitd starts) through `/mcp/plugins/filesystem` with its segment
 * token; the call runs only after Orbit's policy allowed it, and its output
 * taints the Run. One small haiku run; never in CI.
 */
const live = process.env.ORBIT_LIVE === '1';

describe.skipIf(!live)('live M7: plugins through Orbit', () => {
  it('the engine calls mcp__filesystem__read_file over /mcp/plugins and Orbit decides it', async () => {
    const h = harness({
      config: { driver: null },
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    });
    try {
      h.service.url = await h.listen();
      const resolution = await h.service.ensureEngine();
      if (resolution.resolution.driver === 'mock') return;
      const notes = join(h.home, 'notes');
      mkdirSync(notes, { recursive: true });
      writeFileSync(join(notes, 'launch.txt'), 'Launch owner: Ada. Window: Tuesday 09:00 UTC.\n');
      h.service.plugins.setSetting('filesystem', 'FS_ROOTS', notes, 'owner');
      await h.service.plugins.enable('filesystem', 'owner');
      const bot = h.service.createBot({
        name: 'Live Plugin',
        goal: 'Answer from the notes',
        model: process.env.ORBIT_LIVE_MODEL ?? 'haiku',
        tools: ['Read'],
        plugins: ['filesystem'],
        maxTurns: 6,
        memory: { summarize: 'off', tools: false },
      });
      const queued = await h.service.startRun(bot.id, {
        prompt:
          'Call the mcp__filesystem__read_file tool with path "launch.txt" (do not use any other tool), then reply with one sentence saying who owns the launch.',
      });
      let run: RunState | undefined;
      for (let i = 0; i < 170; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        run = h.service.store.getRun(queued.runId);
        if (run && ['completed', 'failed', 'cancelled', 'rate_limited'].includes(run.status)) break;
      }
      const events: RunEvent[] = h.service.store.listRunEvents(queued.runId);
      console.log(
        events
          .map((e) =>
            e.type === 'tool.call'
              ? `${e.type} ${e.data.name}`
              : e.type === 'permission.decision'
                ? `${e.type} ${e.data.toolName} ${e.data.behavior} ${e.data.tier ?? ''}`
                : e.type === 'tool.result'
                  ? `${e.type} err=${e.data.isError} ${e.data.content.slice(0, 80)}`
                  : e.type,
          )
          .join('\n'),
      );
      expect(run?.status, JSON.stringify(run?.error)).toBe('completed');
      const decided = events.find(
        (e) => e.type === 'permission.decision' && e.data.toolName === 'mcp__filesystem__read_file',
      );
      expect(decided?.type === 'permission.decision' && decided.data).toMatchObject({
        behavior: 'allow',
        tier: 'READ',
      });
      const result = events.find(
        (e) =>
          e.type === 'tool.result' &&
          decided?.type === 'permission.decision' &&
          e.data.toolUseId === decided.data.toolUseId,
      );
      expect(result?.type === 'tool.result' && result.data.content).toContain('Ada');
      expect(run?.taintSources).toContain('mcp__filesystem__read_file');
      expect(run?.resultText).toMatch(/Ada/);
      // Segment over: the session and the plugin process are gone.
      expect(h.service.orbitSessions.size).toBe(0);
    } finally {
      await h.close();
    }
  });
});
