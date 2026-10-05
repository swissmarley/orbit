import { relative } from 'node:path';
import {
  RUN_STATUS,
  type RunEvent,
  type RunState,
  formatDuration as duration,
  formatLocalTime,
  formatTokens as tokens,
  formatWhen,
  scrubControls,
} from '@orbit/core';
import { type painter } from './io';

type Paint = ReturnType<typeof painter>;

export { scrubControls };

/** Every string inside `value` scrubbed (for data shown in a terminal). */
export function scrubDeep<T>(value: T): T {
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
      if (e.data.behavior === 'allow')
        return `${paint('green', `      ✓ allowed — ${e.data.reason}`)}${tier}`;
      // A call held for an approval is a pause, not a failure.
      if (e.data.approvalId && e.data.reason.startsWith('Waiting for your owner'))
        return `${paint('magenta', `      ⏸ held for your approval (${e.data.approvalId})`)}${tier}`;
      return `${paint('red', `      ✗ denied — ${e.data.reason}`)}${tier}`;
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
      return e.data.approvalIds.length > 0
        ? paint('magenta', `⏸ waiting for your approval (${e.data.approvalIds.join(', ')})`)
        : paint('cyan', `⇢ waiting for delegated Runs (${e.data.delegations.join(', ')})`);
    case 'delegation.started':
      return `  ${paint('cyan', '⇢')} delegated to ${paint('bold', e.data.childBotName)} ${paint('dim', `(${e.data.childRunId})`)} ${oneLine(e.data.task, 80)}`;
    case 'delegation.finished':
      return `  ${paint(e.data.status === 'completed' ? 'green' : 'yellow', '⇠')} ${paint('dim', e.data.childRunId)} ${e.data.status}: ${oneLine(e.data.result, 80)}`;
    case 'memory.written':
      return paint(
        'dim',
        `  ✎ memory ${e.data.source === 'summarizer' ? 'summary' : 'note'} saved: ${oneLine(e.data.title, 70)}${e.data.tainted ? ' (untrusted)' : ''}`,
      );
    case 'memory.recalled':
      return e.data.via === 'context'
        ? paint(
            'dim',
            `  ⌕ ${e.data.memoryIds.length} memor${e.data.memoryIds.length === 1 ? 'y' : 'ies'} offered as context`,
          )
        : paint(
            e.data.tainted ? 'yellow' : 'dim',
            `  ⌕ memory ${e.data.via}: ${e.data.memoryIds.length} found${e.data.tainted ? ' (untrusted)' : ''}`,
          );
    case 'memory.summarized':
      if (e.data.error) return paint('yellow', `  ✎ no summary: ${oneLine(e.data.error, 100)}`);
      return e.data.mode === 'triage'
        ? paint(
            'dim',
            `  ✎ summarized by ${e.data.model ?? 'the triage model'} · ${tokens(e.data.inputTokens)} in / ${tokens(e.data.outputTokens)} out${e.data.costUsd !== null ? ` · ~$${e.data.costUsd.toFixed(4)}` : ''}`,
          )
        : null;
    case 'feedback.recorded':
      return paint(
        'dim',
        `  ${e.data.signal === 'thumbs_up' ? '▲' : e.data.signal === 'thumbs_down' ? '▼' : '✎'} feedback recorded (${e.data.signal.replace('_', ' ')})`,
      );
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
  const color: Record<string, Parameters<Paint>[0]> = {
    neutral: 'dim',
    info: 'cyan',
    success: 'green',
    warning: 'yellow',
    danger: 'red',
    attention: 'magenta',
  };
  const s = RUN_STATUS[r.status];
  return `${r.runId}  ${paint(color[s.tone] ?? 'white', `${s.mark} ${s.label}`.padEnd(14))} ${paint('dim', formatWhen(r.createdAt).padEnd(22))}  ${oneLine(scrubControls(r.prompt), 60)}`;
}
