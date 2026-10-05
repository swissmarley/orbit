import {
  RUN_STATUS,
  type RunEvent,
  type Tier,
  type Tone,
  formatDuration,
  formatLocalTime,
  formatTokens,
  scrubControls,
} from '@orbit/core/browser';
import { type DiffLine, toolDiff } from './diff';

/** One row of the Run timeline (built from events; tool I/O collapsed into its call). */
export type TimelineItem =
  | { kind: 'prompt'; key: string; seq: number; ts: string; text: string }
  | {
      kind: 'message';
      key: string;
      seq: number;
      ts: string;
      text: string;
      depth: number;
      thinking: boolean;
    }
  | {
      kind: 'tool';
      key: string;
      seq: number;
      ts: string;
      depth: number;
      toolUseId: string;
      name: string;
      summary: string;
      input: unknown;
      diff: DiffLine[] | null;
      decision: {
        behavior: 'allow' | 'deny';
        reason: string;
        tier: Tier | null;
        approvalId: string | null;
        held: boolean;
      } | null;
      result: { isError: boolean; content: string; truncated: boolean } | null;
    }
  | {
      kind: 'subagent';
      key: string;
      seq: number;
      ts: string;
      depth: number;
      text: string;
      done: boolean;
    }
  | {
      kind: 'note';
      key: string;
      seq: number;
      ts: string;
      mark: string;
      tone: Tone;
      text: string;
      detail?: string;
      approvalId?: string;
    };

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short description of a tool call's input (path, command, recipient, …). */
export function summarizeToolInput(input: unknown, cwd: string | null): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  const path = o.file_path ?? o.notebook_path ?? o.path;
  if (typeof path === 'string') {
    return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  }
  if (typeof o.command === 'string') return oneLine(o.command, 80);
  const to = o.to ?? o.channel ?? o.recipient;
  if (typeof to === 'string') {
    return `→ ${to}${typeof o.subject === 'string' ? ` · ${oneLine(o.subject, 60)}` : ''}`;
  }
  if (typeof o.pattern === 'string') return oneLine(o.pattern, 80);
  if (typeof o.description === 'string') return oneLine(o.description, 80);
  if (typeof o.url === 'string') return o.url;
  if (typeof o.query === 'string') return oneLine(o.query, 80);
  return oneLine(JSON.stringify(o), 80);
}

const HELD = 'Waiting for your owner';

/** Fold a Run's events into timeline rows. Pure: the replay scrubber calls it on a prefix. */
export function buildTimeline(events: readonly RunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
  const early = new Map<string, NonNullable<Extract<TimelineItem, { kind: 'tool' }>['decision']>>();
  const depthOf = new Map<string, number>();
  const subagents = new Map<string, Extract<TimelineItem, { kind: 'subagent' }>>();
  let cwd: string | null = null;
  const depth = (parent: string | null | undefined) =>
    parent ? (depthOf.get(parent) ?? 0) + 1 : 0;
  const note = (
    e: RunEvent,
    mark: string,
    tone: Tone,
    text: string,
    extra: { detail?: string; approvalId?: string } = {},
  ) =>
    items.push({
      kind: 'note',
      key: String(e.id),
      seq: e.seq,
      ts: e.ts,
      mark,
      tone,
      text: scrubControls(text),
      ...(extra.detail !== undefined ? { detail: scrubControls(extra.detail) } : {}),
      ...(extra.approvalId ? { approvalId: extra.approvalId } : {}),
    });

  for (const e of events) {
    const base = { key: String(e.id), seq: e.seq, ts: e.ts };
    switch (e.type) {
      case 'run.queued':
        items.push({ kind: 'prompt', ...base, text: scrubControls(e.data.prompt) });
        break;
      case 'run.started':
        cwd = e.data.cwd;
        note(
          e,
          '▶',
          'info',
          `Started · driver ${e.data.driver} · auth ${e.data.authMethod}${e.data.model ? ` · requested model ${e.data.model}` : ''}`,
        );
        break;
      case 'message.assistant':
      case 'message.thinking':
        items.push({
          kind: 'message',
          ...base,
          text: scrubControls(e.data.text.trim()),
          depth: depth(e.data.parentToolUseId),
          thinking: e.type === 'message.thinking',
        });
        break;
      case 'tool.call': {
        const d = depth(e.data.parentToolUseId);
        depthOf.set(e.data.toolUseId, d);
        const item: Extract<TimelineItem, { kind: 'tool' }> = {
          kind: 'tool',
          ...base,
          depth: d,
          toolUseId: e.data.toolUseId,
          name: scrubControls(e.data.name),
          summary: scrubControls(summarizeToolInput(e.data.input, cwd)),
          input: e.data.input,
          diff: toolDiff(e.data.name, e.data.input),
          decision: early.get(e.data.toolUseId) ?? null,
          result: null,
        };
        tools.set(e.data.toolUseId, item);
        items.push(item);
        break;
      }
      case 'permission.decision': {
        const decision = {
          behavior: e.data.behavior,
          reason: scrubControls(e.data.reason),
          tier: e.data.tier,
          approvalId: e.data.approvalId,
          held:
            e.data.behavior === 'deny' &&
            e.data.approvalId !== null &&
            e.data.reason.startsWith(HELD),
        };
        const t = e.data.toolUseId ? tools.get(e.data.toolUseId) : undefined;
        if (t) t.decision = decision;
        else if (e.data.toolUseId) early.set(e.data.toolUseId, decision);
        break;
      }
      case 'tool.result': {
        const t = tools.get(e.data.toolUseId);
        if (t)
          t.result = {
            isError: e.data.isError,
            content: scrubControls(e.data.content),
            truncated: e.data.truncated,
          };
        break;
      }
      case 'subagent.started': {
        const d = depth(e.data.parentToolUseId);
        depthOf.set(e.data.toolUseId, Math.max(depthOf.get(e.data.toolUseId) ?? 0, d));
        const s = {
          kind: 'subagent' as const,
          ...base,
          depth: d,
          text: scrubControls(
            `${e.data.agentType ?? 'agent'}${e.data.description ? ` — ${e.data.description}` : ''}`,
          ),
          done: false,
        };
        subagents.set(e.data.toolUseId, s);
        items.push(s);
        break;
      }
      case 'subagent.stopped': {
        const s = subagents.get(e.data.toolUseId);
        if (s) s.done = true;
        if (e.data.isError) note(e, '⇠', 'danger', 'Subagent finished with an error');
        break;
      }
      case 'approval.requested':
        note(e, '⚑', 'attention', `Approval needed: ${e.data.summary}`, {
          approvalId: e.data.approvalId,
        });
        break;
      case 'approval.decided':
        note(
          e,
          '⚑',
          e.data.decision === 'approved' ? 'success' : 'danger',
          `${e.data.decision[0]?.toUpperCase()}${e.data.decision.slice(1)} by ${e.data.by}${e.data.edited ? ' (edited)' : ''}`,
          e.data.reason ? { detail: e.data.reason } : {},
        );
        break;
      case 'run.tainted':
        note(
          e,
          '⚠',
          'warning',
          `Untrusted content entered the run (${e.data.source}); external actions now always ask`,
        );
        break;
      case 'budget.exceeded':
        note(
          e,
          '⛔',
          'danger',
          `${e.data.budget} budget exceeded (${e.data.actual} > ${e.data.limit})`,
        );
        break;
      case 'run.killed':
        note(e, '■', 'danger', `Stopped by the ${e.data.scope} kill switch (${e.data.by})`);
        break;
      case 'run.parked':
        note(e, RUN_STATUS.waiting_approval.mark, 'attention', 'Waiting for your approval', {
          ...(e.data.approvalIds[0] ? { approvalId: e.data.approvalIds[0] } : {}),
        });
        break;
      case 'run.resumed':
        note(e, '▶', 'info', `Resumed after ${e.data.reason.replace('_', ' ')}`);
        break;
      case 'run.resume_scheduled':
        note(e, '⏰', 'info', `Resumes automatically at ${formatLocalTime(e.data.at)}`);
        break;
      case 'status.summary':
        if (e.data.needsAction) note(e, '⚑', 'warning', `Needs you: ${e.data.needsAction}`);
        break;
      case 'usage_limit':
        if (e.data.status !== 'allowed')
          note(
            e,
            '⚠',
            'warning',
            `Usage ${e.data.status === 'rejected' ? 'limit reached' : 'nearing its limit'}${e.data.limitType ? ` (${e.data.limitType})` : ''}`,
          );
        break;
      case 'api.retry':
        note(
          e,
          '↻',
          'neutral',
          `Retrying an API call${e.data.attempt ? ` (attempt ${e.data.attempt})` : ''}`,
        );
        break;
      case 'usage':
        note(
          e,
          'Σ',
          'neutral',
          `${e.data.numTurns} turn${e.data.numTurns === 1 ? '' : 's'} · ${formatTokens(e.data.inputTokens + e.data.cacheReadTokens + e.data.cacheCreationTokens)} in / ${formatTokens(e.data.outputTokens)} out${e.data.costUsd !== null ? ` · ~$${e.data.costUsd.toFixed(3)}` : ''} · ${formatDuration(e.data.durationMs)}`,
        );
        break;
      case 'diagnostic':
        if (e.data.level !== 'info')
          note(
            e,
            e.data.level === 'error' ? '✘' : '⚠',
            e.data.level === 'error' ? 'danger' : 'warning',
            e.data.message,
          );
        break;
      case 'run.completed':
        note(
          e,
          RUN_STATUS.completed.mark,
          'success',
          'Completed',
          e.data.result ? { detail: e.data.result } : {},
        );
        break;
      case 'run.failed':
        note(e, RUN_STATUS.failed.mark, 'danger', `Failed (${e.data.code})`, {
          detail: e.data.message,
        });
        break;
      case 'run.cancelled':
        note(e, RUN_STATUS.cancelled.mark, 'warning', 'Cancelled', { detail: e.data.reason });
        break;
      case 'run.rate_limited':
        note(
          e,
          RUN_STATUS.rate_limited.mark,
          'warning',
          `Usage limit reached${e.data.resetsAt ? ` — resumes at ${formatLocalTime(e.data.resetsAt)}` : ''}. Paused, not failed.`,
        );
        break;
      default:
        break;
    }
  }
  return items;
}

/** Subagents of a Run as a tree (for the side panel). */
export interface SubagentNode {
  toolUseId: string;
  label: string;
  done: boolean;
  error: boolean;
  children: SubagentNode[];
}

export function subagentTree(events: readonly RunEvent[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();
  const parentOfCall = new Map<string, string | null>();
  const roots: SubagentNode[] = [];
  for (const e of events) {
    if (e.type === 'tool.call') parentOfCall.set(e.data.toolUseId, e.data.parentToolUseId);
    if (e.type === 'subagent.started') {
      const n: SubagentNode = {
        toolUseId: e.data.toolUseId,
        label: scrubControls(
          `${e.data.agentType ?? 'agent'}${e.data.description ? ` — ${e.data.description}` : ''}`,
        ),
        done: false,
        error: false,
        children: [],
      };
      nodes.set(e.data.toolUseId, n);
      const parent = e.data.parentToolUseId ?? parentOfCall.get(e.data.toolUseId) ?? null;
      const p = parent ? nodes.get(parent) : undefined;
      (p ? p.children : roots).push(n);
    }
    if (e.type === 'subagent.stopped') {
      const n = nodes.get(e.data.toolUseId);
      if (n) {
        n.done = true;
        n.error = e.data.isError;
      }
    }
  }
  return roots;
}
