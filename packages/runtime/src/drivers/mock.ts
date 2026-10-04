import { setTimeout as sleep } from 'node:timers/promises';
import { type RunEventBody, event, isTerminalEvent } from '@orbit/core';
import { FIXTURES_DIR, loadFixture } from './fixtures';
import { Normalizer } from './normalize';
import { decide, postProcess } from './permission';
import type { AgentDriver, DriverRunRequest } from './types';

export interface MockDriverOptions {
  /** Delay between replayed messages; 0 in tests, ~100–300 ms for demos. */
  delayMs?: number;
  defaultFixture?: string;
  fixturesDir?: string;
}

type Msg = Record<string, unknown>;
/** Read through a function so TypeScript does not narrow across awaits. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;
const isObj = (v: unknown): v is Msg => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fixtures are recorded in `/workspace`; replay them inside the Run's real workspace. */
export const FIXTURE_WORKSPACE = '/workspace';

function relocate(value: unknown, cwd: string): unknown {
  if (typeof value === 'string') return value.split(FIXTURE_WORKSPACE).join(cwd);
  if (Array.isArray(value)) return value.map((v) => relocate(v, cwd));
  if (isObj(value)) {
    const out: Msg = {};
    for (const [k, v] of Object.entries(value)) out[k] = relocate(v, cwd);
    return out;
  }
  return value;
}

/** Tool-use ids the recording shows as denied (so replay stays consistent). */
function recordedDenials(messages: unknown[]): Set<string> {
  const denied = new Set<string>();
  for (const m of messages) {
    if (!isObj(m)) continue;
    if (m.type === 'result' && Array.isArray(m.permission_denials)) {
      for (const d of m.permission_denials) {
        if (isObj(d) && typeof d.tool_use_id === 'string') denied.add(d.tool_use_id);
      }
    }
  }
  return denied;
}

const zeroUsage = () =>
  event('usage', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    numTurns: 1,
    durationMs: 0,
    models: [],
  });

/**
 * Replays recorded engine transcripts through the shared normalizer. Tool
 * calls go through the real permission handler; when today's decision differs
 * from the recording, the driver ends the run with a consistent synthetic
 * outcome instead of replaying a now-impossible transcript.
 */
export class MockDriver implements AgentDriver {
  readonly kind = 'mock' as const;
  readonly authMethod = 'mock' as const;
  private readonly delayMs: number;
  private readonly defaultFixture: string;
  private readonly fixturesDir: string;

  constructor(options: MockDriverOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.defaultFixture = options.defaultFixture ?? 'read-then-write-denied';
    this.fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
  }

  async *run(req: DriverRunRequest): AsyncGenerator<RunEventBody> {
    const name = req.mockFixture ?? this.defaultFixture;
    const sessionId = req.resumeSessionId ?? req.sessionId;
    const cancelled = () => event('run.cancelled', { reason: 'Run was stopped', sessionId });
    const messages = loadFixture(name, this.fixturesDir);
    if (!messages) {
      yield event('run.failed', {
        code: 'fixture_not_found',
        message: `Mock fixture "${name}" does not exist`,
        retryable: false,
        sessionId,
      });
      return;
    }
    const denied = recordedDenials(messages);
    const allowed = new Set<string>();
    const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
    const n = new Normalizer();

    for (const [index, raw] of messages.entries()) {
      if (req.signal.aborted) {
        yield cancelled();
        return;
      }
      if (this.delayMs > 0 && index > 0) {
        try {
          await sleep(this.delayMs, undefined, { signal: req.signal });
        } catch {
          {
            yield cancelled();
            return;
          }
        }
      }
      const placed = relocate(raw, req.cwd);
      const msg = isObj(placed) && sessionId ? { ...placed, session_id: sessionId } : placed;
      const bodies = n.push(msg);
      for (const raw of bodies) {
        let body = raw;
        // Tool output passes through Orbit's post-processing (redaction), as with real engines.
        if (body.type === 'tool.result' && !body.data.isError && allowed.has(body.data.toolUseId)) {
          const call = calls.get(body.data.toolUseId);
          const post = await postProcess(req.toolResult, {
            toolName: call?.name ?? 'unknown',
            toolUseId: body.data.toolUseId,
            input: call?.input ?? {},
            response: body.data.content,
          });
          if (typeof post.updatedOutput === 'string') {
            body = { ...body, data: { ...body.data, content: post.updatedOutput } };
          }
        }
        yield body;
        if (isTerminalEvent(body)) return;
        if (body.type !== 'tool.call') continue;

        const { toolUseId, name: toolName, input, parentToolUseId } = body.data;
        const { decision, event: decisionEvent } = await decide(
          req.permission,
          {
            toolName,
            input: isObj(input) ? input : {},
            toolUseId,
            parentToolUseId,
          },
          req.signal,
        );
        yield decisionEvent;
        if (isAborted(req.signal)) {
          yield cancelled();
          return;
        }

        if (decision.behavior === 'allow') {
          allowed.add(toolUseId);
          calls.set(toolUseId, { name: toolName, input: isObj(input) ? input : {} });
        }
        if (decision.behavior === 'deny' && decision.interrupt) {
          // Like `continue: false`: the engine stops right after the denial.
          yield event('tool.result', {
            toolUseId,
            isError: true,
            content: decision.reason,
            truncated: false,
            parentToolUseId,
          });
          yield zeroUsage();
          yield event('run.completed', {
            result: decision.reason,
            stopReason: 'hook_stopped',
            sessionId: n.sessionId,
            permissionDenials: [{ toolName, toolUseId }],
          });
          return;
        }
        const recordedDeny = denied.has(toolUseId);
        if (decision.behavior === 'deny' && !recordedDeny) {
          yield event('tool.result', {
            toolUseId,
            isError: true,
            content: `Denied by Orbit policy: ${decision.reason}`,
            truncated: false,
            parentToolUseId,
          });
          const text = `I was not allowed to use ${toolName} (${decision.reason}). Stopping here so you can review.`;
          yield event('message.assistant', { messageId: null, text, parentToolUseId: null });
          yield zeroUsage();
          yield event('run.completed', {
            result: text,
            stopReason: 'end_turn',
            sessionId: n.sessionId,
            permissionDenials: [{ toolName, toolUseId }],
          });
          return;
        }
        if (decision.behavior === 'allow' && recordedDeny) {
          yield event('tool.result', {
            toolUseId,
            isError: false,
            content: `(demo) ${toolName} completed`,
            truncated: false,
            parentToolUseId,
          });
          const text = `Done (demo mode): ${toolName} completed.`;
          yield event('message.assistant', { messageId: null, text, parentToolUseId: null });
          yield zeroUsage();
          yield event('run.completed', {
            result: text,
            stopReason: 'end_turn',
            sessionId: n.sessionId,
            permissionDenials: [],
          });
          return;
        }
      }
    }
    yield event('run.failed', {
      code: 'fixture_incomplete',
      message: `Mock fixture "${name}" ended without a result`,
      retryable: false,
      sessionId: n.sessionId,
    });
  }
}
