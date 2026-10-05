import { PAYLOADS, TERMINAL_UNSAFE } from '@orbit/api/corpus';
import { type RunEvent, type RunEventBody, event, replayRun } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { clean } from './commands/approvals';
import { renderEvent, renderRunRow } from './render';
import { timelineLines } from './tui/views';

/**
 * The M8 corpus at the terminal: every attacker text (terminal escapes, bidi
 * controls, tag breakouts, long payloads) reaches the CLI (`orbit logs`,
 * `orbit tail`, `orbit runs`, approval cards) and the TUI timeline only
 * scrubbed, so nothing in it can move the cursor, set the clipboard, hide
 * text or reorder what the owner reads.
 */

const paint = (_style: unknown, text: string) => text;

function envelope(bodies: RunEventBody[]): RunEvent[] {
  return bodies.map((b, i) => ({
    ...b,
    id: i + 1,
    runId: 'run_corpus',
    botId: 'bot_corpus',
    seq: i + 1,
    ts: '2026-10-05T12:00:00.000Z',
  }));
}

/** Every event kind that carries model-, tool- or attacker-written text. */
function eventsCarrying(text: string): RunEvent[] {
  return envelope([
    event('run.queued', { trigger: { kind: 'webhook', source: 'inbox' }, prompt: text }),
    event('run.started', {
      driver: 'mock',
      authMethod: 'mock',
      model: 'haiku',
      cwd: '/w',
      resumeSessionId: null,
    }),
    event('message.assistant', { messageId: 'm1', text, parentToolUseId: null }),
    event('message.thinking', { messageId: 'm1', text, parentToolUseId: null }),
    event('tool.call', {
      toolUseId: 't1',
      name: `mcp__corpus__${text.slice(0, 40)}`,
      input: { text, url: text, command: text },
      parentToolUseId: null,
    }),
    event('permission.decision', {
      toolUseId: 't1',
      toolName: text.slice(0, 40),
      input: { text },
      behavior: 'deny',
      reason: text,
    }),
    event('tool.result', {
      toolUseId: 't1',
      isError: false,
      content: text,
      truncated: false,
      parentToolUseId: null,
    }),
    event('approval.requested', {
      approvalId: 'apr_1',
      toolUseId: 't1',
      toolName: 'mcp__corpus__send_message',
      tier: 'EXTERNAL',
      summary: text,
    }),
    event('approval.decided', {
      approvalId: 'apr_1',
      decision: 'denied',
      by: 'owner',
      edited: false,
      reason: text,
      ruleId: null,
    }),
    event('run.tainted', { source: text.slice(0, 80), toolUseId: null }),
    event('delegation.started', {
      childRunId: 'run_child',
      childBotId: 'bot_child',
      childBotName: text.slice(0, 40),
      task: text,
    }),
    event('delegation.finished', {
      childRunId: 'run_child',
      childBotId: 'bot_child',
      status: 'completed',
      result: text,
      totals: { tokens: 0, costUsd: 0, toolCalls: 0 },
    }),
    event('status.summary', { category: 'blocked', detail: text, needsAction: text }),
    event('diagnostic', { level: 'warn', message: text }),
    event('run.completed', {
      result: text,
      stopReason: 'end_turn',
      sessionId: null,
      permissionDenials: [],
    }),
  ]);
}

// Positive control: the oracle flags the raw terminal payloads, so a renderer
// that forgot to scrub would fail the rows below.
it.each(PAYLOADS.filter((p) => p.kind === 'terminal'))('$id is terminal-unsafe raw', (p) => {
  expect(TERMINAL_UNSAFE.test(p.text)).toBe(true);
});

describe.each(PAYLOADS)('$id: $scenario', ({ text, marker }) => {
  const events = eventsCarrying(text);

  it('`orbit logs` / `orbit tail` print it scrubbed', () => {
    const out = events.flatMap((e) => renderEvent(e, paint, '/w') ?? []).join('\n');
    expect(out).toContain(marker);
    expect(TERMINAL_UNSAFE.test(out)).toBe(false);
  });

  it('the TUI timeline shows it scrubbed', () => {
    const out = timelineLines(events, paint).join('\n');
    expect(out).toContain(marker);
    expect(TERMINAL_UNSAFE.test(out)).toBe(false);
  });

  it('`orbit runs` lists it scrubbed', () => {
    const run = replayRun(events);
    expect(run).toBeDefined();
    const row = renderRunRow(run!, paint);
    expect(row).toContain(marker);
    expect(TERMINAL_UNSAFE.test(row)).toBe(false);
  });

  it('an approval card shows it scrubbed, on one line per field', () => {
    for (const field of [text, JSON.stringify({ to: text }, null, 2)]) {
      const shown = clean(field);
      expect(TERMINAL_UNSAFE.test(shown)).toBe(false);
      expect(shown).not.toContain('\n');
    }
    expect(clean(text)).toContain(marker);
  });
});
