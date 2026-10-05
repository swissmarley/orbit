import { relative } from 'node:path';
import type { RunEvent, RunState } from '@orbit/core';
import { type painter } from './io';

type Paint = ReturnType<typeof painter>;

// C0/C1 controls (but newline and tab), DEL, and bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Neutralise terminal escapes in text a model, tool or web page wrote: an
 * ESC sequence could move the cursor, recolour or fake a line ("✔ approved").
 */
export function scrubControls(text: string): string {
  return text.replace(CONTROLS, '\ufffd');
}

function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubControls(value) as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)])) as T;
  }
  return value;
}

/** Every string of an event scrubbed: what the renderers below may print. */
export function safeEvent(e: RunEvent): RunEvent {
  return { ...e, data: scrubDeep(e.data) } as RunEvent;
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function summarizeToolInput(name: string, input: unknown, cwd: string | null): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  const path = o.file_path ?? o.notebook_path ?? o.path;
  if (typeof path === 'string')
    return cwd && path.startsWith(cwd) ? relative(cwd, path) || '.' : path;
  if (typeof o.command === 'string') return oneLine(o.command, 80);
  const to = o.to ?? o.channel ?? o.recipient;
  if (typeof to === 'string')
    return `→ ${to}${typeof o.subject === 'string' ? ` · ${oneLine(o.subject, 60)}` : ''}`;
  if (typeof o.pattern === 'string') return oneLine(o.pattern, 80);
  if (typeof o.description === 'string') return oneLine(o.description, 80);
  if (typeof o.url === 'string') return o.url;
  return oneLine(JSON.stringify(o), 80);
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function formatRelative(iso: string, now = Date.now()): string {
  const sec = Math.round((now - Date.parse(iso)) / 1000);
  if (sec < 60) return `${Math.max(0, sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

/** Colorize a unified diff (header lines dropped). */
export function renderDiff(diff: string, paint: Paint): string[] {
  return diff
    .split('\n')
    .filter(
      (l) =>
        !l.startsWith('===') && !l.startsWith('Index:') && l !== '\\ No newline at end of file',
    )
    .map(scrubControls)
    .map((l) => {
      if (l.startsWith('+++') || l.startsWith('---')) return paint('dim', l);
      if (l.startsWith('+')) return paint('green', l);
      if (l.startsWith('-')) return paint('red', l);
      if (l.startsWith('@@')) return paint('cyan', l);
      return l;
    });
}

/** Human-readable rendering of one event; null = not shown. */
export function renderEvent(raw: RunEvent, paint: Paint, cwd: string | null): string | null {
  const e = safeEvent(raw);
  const indent =
    (e.type === 'tool.call' || e.type === 'message.assistant') &&
    'parentToolUseId' in e.data &&
    e.data.parentToolUseId
      ? '    '
      : '  ';
  switch (e.type) {
    case 'run.started':
      return paint(
        'dim',
        `  driver ${e.data.driver} · ${e.data.authMethod} · model ${e.data.model ?? 'default'}`,
      );
    case 'session.init':
      return paint(
        'dim',
        `  session ${e.data.sessionId.slice(0, 8)} · ${e.data.model ?? 'model?'} · engine ${e.data.engineVersion ?? '?'}`,
      );
    case 'message.assistant':
      return `${indent}${paint('cyan', '✦')} ${e.data.text
        .trim()
        .split('\n')
        .map((l, i) => (i === 0 || l.trim() === '' ? l.trim() : `${indent}  ${l}`))
        .join('\n')}`;
    case 'message.thinking':
      return paint('dim', `${indent}… ${oneLine(e.data.text)}`);
    case 'tool.call':
      return `${indent}${paint('yellow', '⚙')} ${paint('bold', e.data.name)} ${paint('dim', summarizeToolInput(e.data.name, e.data.input, cwd))}`;
    case 'permission.decision': {
      const tier = e.data.tier ? paint('dim', ` [${e.data.tier}]`) : '';
      return e.data.behavior === 'allow'
        ? `${paint('green', `      ✓ allowed — ${e.data.reason}`)}${tier}`
        : `${paint('red', `      ✗ denied — ${e.data.reason}`)}${tier}`;
    }
    case 'approval.requested':
      return `  ${paint('magenta', '⚑ approval needed')} ${paint('bold', e.data.summary)} ${paint('dim', `(${e.data.approvalId})`)}`;
    case 'approval.decided':
      return `  ${paint(e.data.decision === 'approved' ? 'green' : 'red', `⚑ ${e.data.decision}`)} by ${e.data.by}${e.data.edited ? ' (edited)' : ''}${e.data.reason ? ` — ${e.data.reason}` : ''}`;
    case 'run.tainted':
      return paint(
        'yellow',
        `  ⚠ untrusted content entered the run (${e.data.source}); external actions now always ask`,
      );
    case 'budget.exceeded':
      return paint(
        'red',
        `  ⛔ ${e.data.budget} budget exceeded (${e.data.actual} > ${e.data.limit})`,
      );
    case 'run.killed':
      return paint('red', `  ■ ${e.data.scope} kill switch (${e.data.by})`);
    case 'run.parked':
      return paint('magenta', `⏸ waiting for your approval (${e.data.approvalIds.join(', ')})`);
    case 'run.resumed':
      return paint('cyan', `▶ resumed after ${e.data.reason.replace('_', ' ')}`);
    case 'run.resume_scheduled':
      return paint('cyan', `  ⏰ resumes automatically at ${formatLocalTime(e.data.at)}`);
    case 'tool.result': {
      if (!e.data.isError) {
        const lines = e.data.content.split('\n').filter((l) => l.trim()).length;
        return paint(
          'dim',
          `      ↳ ${lines} line${lines === 1 ? '' : 's'}${e.data.truncated ? ' (truncated)' : ''}`,
        );
      }
      return paint('red', `      ↳ ${oneLine(e.data.content)}`);
    }
    case 'subagent.started':
      return `  ${paint('magenta', '⇢')} subagent ${paint('bold', e.data.agentType ?? 'agent')} ${paint('dim', e.data.description ?? '')}`;
    case 'subagent.stopped':
      return `  ${paint('magenta', '⇠')} subagent finished${e.data.isError ? paint('red', ' with an error') : ''}`;
    case 'status.summary':
      return e.data.needsAction
        ? `  ${paint('yellow', '⚑ needs you:')} ${e.data.needsAction}`
        : null;
    case 'usage_limit':
      return e.data.status === 'allowed'
        ? null
        : paint(
            'yellow',
            `  ⚠ usage ${e.data.status === 'rejected' ? 'limit reached' : 'nearing limit'}${e.data.limitType ? ` (${e.data.limitType})` : ''}`,
          );
    case 'api.retry':
      return paint(
        'dim',
        `  ↻ retrying API call${e.data.attempt ? ` (attempt ${e.data.attempt})` : ''}`,
      );
    case 'usage': {
      const cost = e.data.costUsd !== null ? ` · ~$${e.data.costUsd.toFixed(3)}` : '';
      return paint(
        'dim',
        `  Σ ${e.data.numTurns} turn${e.data.numTurns === 1 ? '' : 's'} · ${tokens(e.data.inputTokens + e.data.cacheReadTokens + e.data.cacheCreationTokens)} in / ${tokens(e.data.outputTokens)} out${cost} · ${duration(e.data.durationMs)}`,
      );
    }
    case 'diagnostic':
      return paint(
        e.data.level === 'error' ? 'red' : 'dim',
        `  ${e.data.level}: ${e.data.message}`,
      );
    case 'run.completed':
      return paint('green', '✔ completed');
    case 'run.failed':
      return paint('red', `✘ failed (${e.data.code}): ${e.data.message}`);
    case 'run.cancelled':
      return paint('yellow', '■ cancelled');
    case 'run.rate_limited':
      return paint(
        'yellow',
        `⏸ Usage limit reached${e.data.resetsAt ? ` — resumes at ${formatLocalTime(e.data.resetsAt)}` : ''}. The run is paused, not failed.`,
      );
    default:
      return null;
  }
}

export function renderRunRow(r: RunState, paint: Paint): string {
  const status: Record<string, Parameters<Paint>[0]> = {
    completed: 'green',
    failed: 'red',
    cancelled: 'yellow',
    rate_limited: 'yellow',
    running: 'cyan',
    queued: 'dim',
    waiting_approval: 'magenta',
    paused: 'yellow',
  };
  return `${r.runId}  ${paint(status[r.status] ?? 'white', r.status.padEnd(14))} ${paint('dim', r.createdAt)}  ${oneLine(r.prompt, 60)}`;
}
