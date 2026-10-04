import { relative } from 'node:path';
import type { RunEvent, RunState } from '@orbit/core';
import { type painter } from './io';

type Paint = ReturnType<typeof painter>;

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

/** Human-readable rendering of one event; null = not shown. */
export function renderEvent(e: RunEvent, paint: Paint, cwd: string | null): string | null {
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
    case 'permission.decision':
      return e.data.behavior === 'allow'
        ? paint('green', `      ✓ allowed — ${e.data.reason}`)
        : paint('red', `      ✗ denied — ${e.data.reason}`);
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
