import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent, RunState } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { harness } from '../test/harness';

/**
 * Opt-in (`pnpm test:live`, ORBIT_LIVE=1): M6 against the real engine.
 *  - a subagent's tool calls (Task → Read) go through Orbit's PreToolUse hook
 *    with their parent tool-use id (PLAN §7: deferred from M1)
 *  - the CLI engine reaches Orbit's loopback /mcp/orbit endpoint with its
 *    segment token, and the call runs only after the policy allowed it
 * One small haiku run; never in CI.
 */
const live = process.env.ORBIT_LIVE === '1';

describe.skipIf(!live)('live M6: subagents and Orbit MCP tools', () => {
  it('a subagent reads a file under policy and the Bot saves a memory note over /mcp/orbit', async () => {
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
      const bot = h.service.createBot({
        name: 'Live Team',
        goal: 'Answer from the notes',
        model: process.env.ORBIT_LIVE_MODEL ?? 'haiku',
        tools: ['Read', 'Task'],
        maxTurns: 8,
        subagents: {
          reader: {
            description: 'Reads one file and reports what it says. Use it for any file reading.',
            prompt:
              'Read the file you are given with the Read tool and report its content briefly.',
            tools: ['Read'],
            model: 'haiku',
          },
        },
        memory: { summarize: 'off' },
      });
      const ws = join(h.home, 'workspaces', bot.id);
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'notes.txt'), 'Launch owner: Ada. Window: Tuesday 09:00 UTC.\n');
      const queued = await h.service.startRun(bot.id, {
        prompt:
          'Use the reader subagent (Task tool) to read notes.txt. Then save one memory note with the mcp__orbit__memory_write tool, titled "Launch owner", saying who owns the launch. Then reply with one sentence.',
      });
      let run: RunState | undefined;
      for (let i = 0; i < 170; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        run = h.service.store.getRun(queued.runId);
        if (run && ['completed', 'failed', 'cancelled', 'rate_limited'].includes(run.status)) break;
      }
      const events: RunEvent[] = h.service.store.listRunEvents(queued.runId);
      const summary = events.map((e) =>
        e.type === 'tool.call'
          ? `${e.type} ${e.data.name} parent=${e.data.parentToolUseId ?? '-'}`
          : e.type === 'permission.decision'
            ? `${e.type} ${e.data.toolName} ${e.data.behavior}`
            : e.type === 'tool.result'
              ? `${e.type} err=${e.data.isError} ${e.data.content.slice(0, 80)}`
              : e.type,
      );
      console.log(summary.join('\n'));
      expect(run?.status, JSON.stringify(run?.error)).toBe('completed');
      // The subagent's Read was decided by Orbit, with its parent tool-use id.
      const subRead = events.find(
        (e) => e.type === 'tool.call' && e.data.name === 'Read' && e.data.parentToolUseId,
      );
      expect(subRead).toBeDefined();
      const decided = events.find(
        (e) =>
          e.type === 'permission.decision' &&
          subRead?.type === 'tool.call' &&
          e.data.toolUseId === subRead.data.toolUseId,
      );
      expect(decided?.type === 'permission.decision' && decided.data.behavior).toBe('allow');
      // The engine called Orbit's tool over /mcp/orbit; it ran once, after the policy allowed it.
      const written = events.find((e) => e.type === 'memory.written' && e.data.source === 'bot');
      expect(written).toBeDefined();
      expect(h.service.memory.list({ botId: bot.id, kind: 'note' })[0]?.title).toMatch(/launch/i);
      expect(h.service.orbitSessions.size).toBe(0);
    } finally {
      await h.close();
    }
  });
});
