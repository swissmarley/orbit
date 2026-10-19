import {
  type Bot,
  type RunEvent,
  type RunState,
  type RunStatus,
  type Tier,
  type Tone,
  type TriggerRef,
  formatLocalTime,
  pauseReason,
  scrubControls,
} from '@orbit/core/browser';
import { summarizeToolInput } from './timeline';

/**
 * The chat (ADR-020): a conversation is a chain of Runs. This folds their
 * events into what a person reads: their messages, the Bot's answers, its
 * tool calls as cards, approvals, delegations and the few notes that matter.
 * Pure, so it is unit-tested and the screen only renders.
 */

/** The tab of the Bot's computer a tool call belongs to. */
export type ComputerTab = 'browser' | 'files' | 'terminal' | 'activity';

export type ToolKind =
  | 'terminal'
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'web'
  | 'browser'
  | 'memory'
  | 'delegate'
  | 'agent'
  | 'plan'
  | 'plugin'
  | 'other';

export interface ToolInfo {
  kind: ToolKind;
  /** What the Bot is doing, in a few words ("Running a command"). */
  label: string;
  /** Reads that need no card of their own: runs of them fold into one. */
  quiet: boolean;
  tab: ComputerTab | null;
}

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const cap = (s: string) => (s ? `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}` : s);

/** How a tool call is shown: icon kind, words, and where it lives on the computer. */
export function describeTool(name: string, input?: unknown): ToolInfo {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  switch (name) {
    case 'Bash':
      return { kind: 'terminal', label: 'Running a command', quiet: false, tab: 'terminal' };
    case 'BashOutput':
      return { kind: 'terminal', label: 'Reading command output', quiet: true, tab: 'terminal' };
    case 'KillShell':
    case 'KillBash':
      return { kind: 'terminal', label: 'Stopping a command', quiet: false, tab: 'terminal' };
    case 'Read':
    case 'NotebookRead':
      return { kind: 'read', label: 'Reading a file', quiet: true, tab: 'files' };
    case 'Write':
      return { kind: 'write', label: 'Saving a file', quiet: false, tab: 'files' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', label: 'Editing a file', quiet: false, tab: 'files' };
    case 'Glob':
      return { kind: 'search', label: 'Looking for files', quiet: true, tab: 'files' };
    case 'Grep':
      return { kind: 'search', label: 'Searching the files', quiet: true, tab: 'files' };
    case 'LS':
      return { kind: 'search', label: 'Listing a folder', quiet: true, tab: 'files' };
    case 'WebFetch':
      return { kind: 'web', label: 'Reading a web page', quiet: false, tab: 'browser' };
    case 'WebSearch':
      return { kind: 'web', label: 'Searching the web', quiet: false, tab: 'browser' };
    case 'TodoWrite':
      return { kind: 'plan', label: 'Updating its plan', quiet: true, tab: null };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', label: 'Working with a helper', quiet: false, tab: null };
    default:
      break;
  }
  const m = /^mcp__([a-z][a-z0-9-]*)__(.+)$/.exec(name);
  if (m) {
    const server = m[1] ?? '';
    const tool = m[2] ?? '';
    if (server === 'orbit') {
      if (tool === 'delegate_to_bot') {
        const peer = typeof o.bot === 'string' ? scrubControls(o.bot) : 'another Bot';
        return { kind: 'delegate', label: `Asking ${peer}`, quiet: false, tab: null };
      }
      if (tool === 'memory_write')
        return { kind: 'memory', label: 'Remembering', quiet: false, tab: 'activity' };
      if (tool === 'memory_search')
        return { kind: 'memory', label: 'Searching its memory', quiet: true, tab: 'activity' };
      if (tool === 'memory_read')
        return { kind: 'memory', label: 'Reading a memory', quiet: true, tab: 'activity' };
    }
    if (server === 'browser') {
      const label =
        tool === 'open_page'
          ? 'Opening a website'
          : tool === 'get_text'
            ? 'Reading the page'
            : tool === 'list_links'
              ? 'Looking at the links'
              : tool === 'click'
                ? 'Clicking in the browser'
                : tool === 'fill'
                  ? 'Typing into a form'
                  : `Browser: ${words(tool)}`;
      return { kind: 'browser', label, quiet: false, tab: 'browser' };
    }
    return {
      kind: 'plugin',
      label: `${cap(words(server))}: ${words(tool)}`,
      quiet: false,
      tab: 'activity',
    };
  }
  return { kind: 'other', label: `Using ${name}`, quiet: false, tab: 'activity' };
}

/** held: waiting for the owner; approved: the owner said yes (the Bot retries the call). */
export type ToolState = 'working' | 'done' | 'failed' | 'denied' | 'held' | 'approved';

export interface ChatTool {
  key: string;
  runId: string;
  toolUseId: string;
  name: string;
  info: ToolInfo;
  /** The path, command, address or recipient, in one line. */
  detail: string;
  input: unknown;
  state: ToolState;
  tier: Tier | null;
  /** Why it was denied or held. */
  reason: string | null;
  approvalId: string | null;
  result: { isError: boolean; content: string; truncated: boolean } | null;
  /** A helper's (subagent's) own calls, nested under its Task call. */
  children: ChatTool[];
  /** Messages the helper wrote (shown as a count). */
  messages: number;
}

export type ChatItem =
  | {
      kind: 'user';
      key: string;
      runId: string;
      ts: string;
      text: string;
      /** How the turn started when it was not typed: "Scheduled", "Webhook deploys"… */
      via: string | null;
    }
  | { kind: 'assistant'; key: string; runId: string; ts: string; text: string }
  | { kind: 'tool'; key: string; runId: string; tool: ChatTool }
  | { kind: 'group'; key: string; runId: string; tools: ChatTool[] }
  | {
      kind: 'approval';
      key: string;
      runId: string;
      ts: string;
      approvalId: string;
      summary: string;
      tier: Tier;
      decision: { decision: string; by: string; reason: string | null; edited: boolean } | null;
    }
  | {
      kind: 'delegation';
      key: string;
      runId: string;
      ts: string;
      childRunId: string;
      childBotId: string;
      childBotName: string;
      task: string;
      status: 'working' | 'completed' | 'failed' | 'cancelled';
      result: string | null;
    }
  | {
      kind: 'note';
      key: string;
      runId: string;
      ts: string;
      tone: Tone;
      text: string;
      detail?: string;
      /** A control the note offers. */
      action?: 'resume' | 'retry';
    }
  | {
      kind: 'end';
      key: string;
      runId: string;
      ts: string;
      status: RunStatus;
      rating: 'up' | 'down' | null;
    };

export interface Turn {
  run: RunState;
  /** Undefined while loading. */
  events: readonly RunEvent[] | undefined;
}

const VIA: Partial<Record<TriggerRef['kind'], string>> = {
  cron: 'Scheduled',
  interval: 'Scheduled',
  webhook: 'Webhook',
  slack: 'Slack',
  file: 'File change',
  git: 'Git',
  delegation: 'Asked by another Bot',
};

/** How a turn started when nobody typed it ("Scheduled", "Webhook deploys"). */
export function turnVia(trigger: TriggerRef | null): string | null {
  if (!trigger || trigger.kind === 'manual' || trigger.kind === 'resume') return null;
  const base = VIA[trigger.kind] ?? trigger.kind;
  return trigger.source && trigger.kind !== 'cron' && trigger.kind !== 'interval'
    ? `${base} · ${scrubControls(trigger.source)}`
    : base;
}

const ENDED: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
const HELD = 'Waiting for your owner';

const RESUMED: Partial<
  Record<Extract<RunEvent, { type: 'run.resumed' }>['data']['reason'], string>
> = {
  approval: 'Continuing after your decision',
  usage_limit: 'The usage limit reset; continuing',
  manual: 'Resumed',
  pause: 'Resumed',
  interrupted: 'Continuing after an interruption (it checks unfinished steps first)',
};

function oneTurn(turn: Turn): ChatItem[] {
  const { run } = turn;
  const items: ChatItem[] = [
    {
      kind: 'user',
      key: `${run.runId}:prompt`,
      runId: run.runId,
      ts: run.createdAt,
      text: scrubControls(run.prompt).trim(),
      via: turnVia(run.trigger),
    },
  ];
  const events = turn.events ?? [];
  const tools = new Map<string, ChatTool>();
  const parentOf = new Map<string, string | null>();
  const approvals = new Map<string, Extract<ChatItem, { kind: 'approval' }>>();
  const delegations = new Map<string, Extract<ChatItem, { kind: 'delegation' }>>();
  const early = new Map<string, Extract<RunEvent, { type: 'permission.decision' }>['data']>();
  /** Calls held for an approval, so its decision can be shown on them. */
  const held = new Map<string, ChatTool[]>();
  let cwd: string | null = null;
  let lastText: string | null = null;
  let tainted = false;
  const note = (
    e: RunEvent,
    tone: Tone,
    text: string,
    extra: { detail?: string; action?: 'resume' | 'retry' } = {},
  ) =>
    items.push({
      kind: 'note',
      key: `${run.runId}:${e.seq}`,
      runId: run.runId,
      ts: e.ts,
      tone,
      text: scrubControls(text),
      ...(extra.detail ? { detail: scrubControls(extra.detail) } : {}),
      ...(extra.action ? { action: extra.action } : {}),
    });
  /** The top-level Task call a nested call belongs to (helpers can nest). */
  const owner = (parent: string | null): ChatTool | undefined => {
    let p = parent;
    let top: ChatTool | undefined;
    for (let hops = 0; p && hops < 20; hops++) {
      const t = tools.get(p);
      if (t) top = t;
      p = parentOf.get(p) ?? null;
    }
    return top;
  };
  const decide = (
    t: ChatTool,
    d: Extract<RunEvent, { type: 'permission.decision' }>['data'],
  ): void => {
    t.tier = d.tier;
    t.approvalId = d.approvalId;
    if (d.behavior === 'allow') {
      if (t.state !== 'done' && t.state !== 'failed') t.state = 'working';
      t.reason = null;
    } else {
      const waits = d.approvalId !== null && d.reason.startsWith(HELD);
      t.state = waits ? 'held' : 'denied';
      t.reason = scrubControls(d.reason);
      if (waits && d.approvalId) held.set(d.approvalId, [...(held.get(d.approvalId) ?? []), t]);
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'run.queued':
        // A reply starts with the conversation's taint: it was already said.
        // (Events logged before M6 have no inheritedTaint: the log is never rewritten.)
        if (Array.isArray(e.data.inheritedTaint) && e.data.inheritedTaint.length > 0)
          tainted = true;
        break;
      case 'run.started':
        cwd = e.data.cwd;
        break;
      case 'message.assistant': {
        const text = scrubControls(e.data.text).trim();
        if (!text) break;
        if (e.data.parentToolUseId) {
          const t = owner(e.data.parentToolUseId);
          if (t) t.messages += 1;
          break;
        }
        lastText = text;
        items.push({
          kind: 'assistant',
          key: `${run.runId}:${e.seq}`,
          runId: run.runId,
          ts: e.ts,
          text,
        });
        break;
      }
      case 'tool.call': {
        parentOf.set(e.data.toolUseId, e.data.parentToolUseId);
        const t: ChatTool = {
          key: `${run.runId}:${e.data.toolUseId}`,
          runId: run.runId,
          toolUseId: e.data.toolUseId,
          name: scrubControls(e.data.name),
          info: describeTool(e.data.name, e.data.input),
          detail: scrubControls(summarizeToolInput(e.data.input, cwd)),
          input: e.data.input,
          state: 'working',
          tier: null,
          reason: null,
          approvalId: null,
          result: null,
          children: [],
          messages: 0,
        };
        const d = early.get(e.data.toolUseId);
        if (d) decide(t, d);
        const parent = e.data.parentToolUseId ? owner(e.data.parentToolUseId) : undefined;
        tools.set(e.data.toolUseId, t);
        if (parent) parent.children.push(t);
        else items.push({ kind: 'tool', key: t.key, runId: run.runId, tool: t });
        break;
      }
      case 'permission.decision': {
        if (!e.data.toolUseId) break;
        const t = tools.get(e.data.toolUseId);
        if (t) decide(t, e.data);
        else early.set(e.data.toolUseId, e.data);
        break;
      }
      case 'tool.result': {
        const t = tools.get(e.data.toolUseId);
        if (!t) break;
        t.result = {
          isError: e.data.isError,
          content: scrubControls(e.data.content),
          truncated: e.data.truncated,
        };
        if (t.state !== 'denied' && t.state !== 'held')
          t.state = e.data.isError ? 'failed' : 'done';
        break;
      }
      case 'approval.requested': {
        const a: Extract<ChatItem, { kind: 'approval' }> = {
          kind: 'approval',
          key: `${run.runId}:approval:${e.data.approvalId}`,
          runId: run.runId,
          ts: e.ts,
          approvalId: e.data.approvalId,
          summary: scrubControls(e.data.summary),
          tier: e.data.tier,
          decision: null,
        };
        approvals.set(e.data.approvalId, a);
        items.push(a);
        break;
      }
      case 'approval.decided': {
        for (const t of held.get(e.data.approvalId) ?? []) {
          if (t.state !== 'held') continue;
          t.state = e.data.decision === 'approved' ? 'approved' : 'denied';
          t.reason = e.data.decision === 'approved' ? null : (e.data.reason ?? e.data.decision);
        }
        const a = approvals.get(e.data.approvalId);
        if (a) {
          a.decision = {
            decision: e.data.decision,
            by: scrubControls(e.data.by),
            reason: e.data.reason ? scrubControls(e.data.reason) : null,
            edited: e.data.edited,
          };
        }
        break;
      }
      case 'delegation.started': {
        const d: Extract<ChatItem, { kind: 'delegation' }> = {
          kind: 'delegation',
          key: `${run.runId}:delegation:${e.data.childRunId}`,
          runId: run.runId,
          ts: e.ts,
          childRunId: e.data.childRunId,
          childBotId: e.data.childBotId,
          childBotName: scrubControls(e.data.childBotName),
          task: scrubControls(e.data.task),
          status: 'working',
          result: null,
        };
        delegations.set(e.data.childRunId, d);
        items.push(d);
        break;
      }
      case 'delegation.finished': {
        const d = delegations.get(e.data.childRunId);
        if (d) {
          d.status = e.data.status;
          d.result = scrubControls(e.data.result);
        }
        break;
      }
      case 'run.tainted':
        if (!tainted) {
          tainted = true;
          note(
            e,
            'warning',
            `Read untrusted content (${e.data.source}). Anything it wants to send now needs your approval.`,
          );
        }
        break;
      case 'budget.exceeded':
        note(
          e,
          'danger',
          `Stopped: its ${e.data.budget} budget ran out (${e.data.actual} of ${e.data.limit})`,
        );
        break;
      case 'run.killed':
        note(e, 'danger', `Stopped by the ${e.data.scope} kill switch (${e.data.by})`);
        break;
      case 'run.parked':
        if (e.data.approvalIds.length === 0 && e.data.delegations.length > 0) {
          const names = e.data.delegations.map(
            (id) => delegations.get(id)?.childBotName ?? 'a peer',
          );
          note(e, 'info', `Waiting for ${[...new Set(names)].join(' and ')} to answer`);
        }
        break;
      case 'run.resumed': {
        const text = RESUMED[e.data.reason];
        if (text) note(e, 'neutral', text);
        break;
      }
      case 'run.paused':
        note(e, 'warning', pauseReason({ ...e.data, at: e.ts }), {
          ...(e.data.autoResume ? {} : { action: 'resume' as const }),
        });
        break;
      case 'run.rate_limited':
        note(
          e,
          'warning',
          e.data.resetsAt
            ? `Usage limit reached — it continues at ${formatLocalTime(e.data.resetsAt)}`
            : 'Usage limit reached — resume it once the limit resets',
        );
        break;
      case 'diagnostic':
        if (e.data.level !== 'info')
          note(e, e.data.level === 'error' ? 'danger' : 'warning', e.data.message);
        break;
      case 'run.failed':
        note(e, 'danger', 'Something went wrong', { detail: e.data.message, action: 'retry' });
        break;
      case 'run.cancelled':
        note(e, 'neutral', 'Stopped', { detail: e.data.reason });
        break;
      case 'run.completed': {
        const result = scrubControls(e.data.result).trim();
        // The result usually repeats the last answer; show it only when it adds something.
        if (result && result !== lastText) {
          items.push({
            kind: 'assistant',
            key: `${run.runId}:result`,
            runId: run.runId,
            ts: e.ts,
            text: result,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  if (ENDED.includes(run.status)) {
    items.push({
      kind: 'end',
      key: `${run.runId}:end`,
      runId: run.runId,
      ts: run.endedAt ?? run.createdAt,
      status: run.status,
      rating: run.rating,
    });
  }
  return foldQuiet(items);
}

/** Two or more quiet reads in a row become one card ("Looked through 4 files"). */
function foldQuiet(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let run: Extract<ChatItem, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0];
      if (first) {
        out.push({
          kind: 'group',
          key: `${first.key}:group`,
          runId: first.runId,
          tools: run.map((r) => r.tool),
        });
      }
    } else out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' && item.tool.info.quiet && item.tool.state === 'done') run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** The chat for a conversation's turns (oldest first). */
export function buildConversation(turns: readonly Turn[]): ChatItem[] {
  return turns.flatMap(oneTurn);
}

/** The turns of a conversation, oldest first (the API lists newest first). */
export function orderTurns(runs: readonly RunState[]): RunState[] {
  return [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId),
  );
}

export interface ConversationSummary {
  id: string;
  botId: string;
  /** The first message, on one line. */
  title: string;
  turns: number;
  first: RunState;
  latest: RunState;
  /** When something last happened. */
  at: string;
  via: string | null;
}

/** The owner's conversations among a Bot's Runs, latest activity first (delegated Runs live in their parent's chat). */
export function conversationsOf(runs: readonly RunState[]): ConversationSummary[] {
  const byId = new Map<string, RunState[]>();
  for (const r of runs) {
    if (r.parentRunId) continue;
    const list = byId.get(r.conversationId) ?? [];
    list.push(r);
    byId.set(r.conversationId, list);
  }
  const out: ConversationSummary[] = [];
  for (const [id, list] of byId) {
    const ordered = orderTurns(list);
    const first = ordered[0];
    const latest = ordered.at(-1);
    if (!first || !latest) continue;
    const flat = scrubControls(first.prompt).replace(/\s+/g, ' ').trim();
    out.push({
      id,
      botId: first.botId,
      title: flat.length > 80 ? `${flat.slice(0, 79)}…` : flat || 'Untitled',
      turns: ordered.length,
      first,
      latest,
      at: latest.endedAt ?? latest.startedAt ?? latest.createdAt,
      via: turnVia(first.trigger),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What the Bot is doing in a conversation right now, for the header and the typing row. */
export function turnActivity(
  run: RunState | undefined,
  botName: string,
): { busy: boolean; text: string } | null {
  if (!run) return null;
  switch (run.status) {
    case 'queued':
      return { busy: true, text: `${botName} is about to start` };
    case 'running':
      return { busy: true, text: `${botName} is working` };
    case 'waiting_approval':
      return { busy: false, text: `${botName} is waiting for your decision` };
    case 'delegating':
      return { busy: true, text: `${botName} is waiting for another Bot` };
    case 'rate_limited':
      return {
        busy: false,
        text: run.resumeAt
          ? `Usage limit — ${botName} continues at ${formatLocalTime(run.resumeAt)}`
          : 'Usage limit reached',
      };
    case 'paused':
      return { busy: false, text: `${botName} is paused` };
    default:
      return null;
  }
}

export interface ComposerState {
  /** A message may be sent now. */
  canSend: boolean;
  /** Why not (or what sending will do), in words. */
  hint: string | null;
  /** The latest turn can be stopped from the composer. */
  stoppable: boolean;
  /** The latest turn waits to be resumed by the owner. */
  resumable: boolean;
}

/** Whether the composer can send, and what it says otherwise. */
export function composerState(input: {
  bot: Pick<Bot, 'pausedAt'> & { spec: { name: string } };
  latest: RunState | undefined;
  killed: boolean;
  canStart: boolean;
  takenOver?: boolean;
  /** The latest turn holds a call for the owner's decision (it may still be running). */
  decisionPending?: boolean;
}): ComposerState {
  const name = scrubControls(input.bot.spec.name);
  const st = input.latest?.status;
  const stoppable = st === 'queued' || st === 'running' || st === 'delegating';
  const resumable = st === 'paused' || st === 'rate_limited';
  const no = (hint: string): ComposerState => ({ canSend: false, hint, stoppable, resumable });
  if (!input.canStart)
    return no('Viewers can read along; an operator or the owner can message Bots.');
  if (input.killed) return no('The kill switch is on: nothing runs until it is released.');
  if (input.takenOver) return no(`${name}'s computer is taken over in a terminal (orbit shell).`);
  if (input.bot.pausedAt) return no(`${name} is paused. Resume it to continue.`);
  if (input.decisionPending) return no('Decide the request above first.');
  if (st === 'queued' || st === 'running')
    return no(`${name} is working. Stop it to send something else.`);
  if (st === 'waiting_approval') return no('Decide the request above first.');
  if (st === 'delegating') return no(`${name} is waiting for another Bot to answer.`);
  if (st === 'paused') return no(`This conversation is paused. Resume or stop it first.`);
  if (st === 'rate_limited') return no('Waiting for the usage limit to reset.');
  return { canSend: true, hint: null, stoppable, resumable };
}
