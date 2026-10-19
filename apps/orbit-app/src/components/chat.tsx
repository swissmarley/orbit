/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, type Tone, scrubControls } from '@orbit/core/browser';
import { type Approval, roleFor } from '@orbit/sdk-client/browser';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AppWindow,
  ArrowUp,
  ArrowUpRight,
  Bot as BotIcon,
  Brain,
  ChevronDown,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  LoaderCircle,
  Play,
  Plug,
  RotateCw,
  Search,
  Send,
  Square,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { useActions } from '../lib/actions';
import { useClient } from '../lib/api';
import { composerKey } from '../lib/chat-keys';
import { cn } from '../lib/cn';
import {
  type ChatItem,
  type ChatTool,
  type ComposerState,
  type ToolKind,
  type ToolState,
  quietLabel,
} from '../lib/conversation';
import { toolDiff } from '../lib/diff';
import { type InboxState, gateInboxKey, onInboxKey } from '../lib/inbox';
import { keys, useBots } from '../lib/queries';
import { ALWAYS_ALLOW_ROLE, needsRoleText, useRole } from '../lib/role';
import { TONE_CLASS } from '../lib/tone';
import { COMPOSER_ID, showComputer } from '../lib/ui';
import { type CardMode, ApprovalCard } from './approval-card';
import { BotAvatar } from './avatar';
import { DiffView } from './diff-view';
import { Markdown } from './markdown';
import { RoleGate } from './role-gate';
import { Time } from './status';
import { Button } from './ui/button';

const ICON: Record<ToolKind, typeof Wrench> = {
  terminal: SquareTerminal,
  read: FileText,
  write: FilePen,
  edit: FilePen,
  search: Search,
  web: Globe,
  browser: AppWindow,
  memory: Brain,
  delegate: Send,
  agent: BotIcon,
  plan: ListChecks,
  plugin: Plug,
  other: Wrench,
};

const STATE: Record<ToolState, { word: string; tone: Tone; mark: string }> = {
  working: { word: 'Working', tone: 'info', mark: '' },
  done: { word: 'Done', tone: 'success', mark: '✔' },
  failed: { word: 'Failed', tone: 'danger', mark: '✘' },
  denied: { word: 'Denied', tone: 'danger', mark: '⛔' },
  held: { word: 'Waiting for you', tone: 'attention', mark: '◆' },
  approved: { word: 'Approved', tone: 'success', mark: '✔' },
};

function StateChip({ state }: { state: ToolState }) {
  const s = STATE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[s.tone],
      )}
    >
      {state === 'working' ? (
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <span aria-hidden>{s.mark}</span>
      )}
      {s.word}
    </span>
  );
}

function lines(text: string, max: number): { shown: string; more: number } {
  const all = text.split('\n');
  return all.length <= max
    ? { shown: text, more: 0 }
    : { shown: all.slice(0, max).join('\n'), more: all.length - max };
}

/** Output of a shell command, in a terminal. */
function TerminalOutput({ tool, botName }: { tool: ChatTool; botName: string }) {
  const [all, setAll] = useState(false);
  const command =
    typeof (tool.input as { command?: unknown } | null)?.command === 'string'
      ? scrubControls((tool.input as { command: string }).command)
      : tool.detail;
  const out = tool.result ? lines(tool.result.content, all ? 400 : 14) : null;
  return (
    <div className="overflow-hidden rounded-lg bg-terminal font-mono text-[12.5px] leading-relaxed text-terminal-fg">
      <div
        className="max-h-80 overflow-auto px-3 py-2"
        tabIndex={0}
        role="group"
        aria-label={`Terminal output on ${botName}'s computer`}
      >
        <div className="break-all whitespace-pre-wrap">
          <span className="text-terminal-dim select-none">$ </span>
          {command}
        </div>
        {out ? (
          <pre className="mt-1 whitespace-pre-wrap text-terminal-fg/90">{out.shown}</pre>
        ) : null}
        {tool.state === 'working' ? (
          <span className="text-terminal-dim" aria-hidden>
            ▍
          </span>
        ) : null}
      </div>
      {out && out.more > 0 ? (
        <button
          type="button"
          className="w-full border-t border-white/10 px-3 py-1 text-left text-xs text-terminal-dim hover:text-terminal-fg"
          onClick={() => setAll(true)}
        >
          Show {out.more} more {out.more === 1 ? 'line' : 'lines'}
        </button>
      ) : null}
    </div>
  );
}

/** What a page read looked like: the address and the text the Bot got (untrusted). */
function PageView({ tool, botName }: { tool: ChatTool; botName: string }) {
  const o = (tool.input ?? {}) as Record<string, unknown>;
  const url = typeof o.url === 'string' ? scrubControls(o.url) : tool.detail;
  const text = tool.result?.content ?? '';
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        <span className="truncate">
          {botName}’s computer · {tool.info.kind === 'browser' ? 'Browser' : 'Web'}
        </span>
        <span className="ml-auto shrink-0 rounded bg-warning-bg px-1.5 text-[11px] text-warning">
          untrusted
        </span>
      </div>
      {url ? (
        <div
          className="truncate border-b border-border bg-surface px-3 py-1.5 font-mono text-xs text-fg-muted"
          title={url}
        >
          {url}
        </div>
      ) : null}
      {text ? (
        <pre
          className="max-h-48 overflow-auto px-3 py-2 font-sans text-xs whitespace-pre-wrap text-fg"
          tabIndex={0}
        >
          {lines(text, 12).shown}
        </pre>
      ) : null}
    </div>
  );
}

function ResultDetails({ tool }: { tool: ChatTool }) {
  // A held or denied call's "result" is Orbit's own refusal: the reason is shown already.
  if (
    !tool.result?.content ||
    tool.state === 'held' ||
    tool.state === 'denied' ||
    tool.state === 'approved'
  )
    return null;
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        {tool.result.isError ? 'Error' : 'Result'}
      </summary>
      <pre
        tabIndex={0}
        className="mt-1 max-h-64 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-fg"
      >
        {lines(tool.result.content, 60).shown}
      </pre>
    </details>
  );
}

/** One tool call, as a card in the chat (OpenDots-style, built from RunEvents). */
export function ToolCard({ tool, bot }: { tool: ChatTool; bot: Bot }) {
  const Icon = ICON[tool.info.kind];
  const name = scrubControls(bot.spec.name);
  const diff =
    tool.info.kind === 'write' || tool.info.kind === 'edit'
      ? toolDiff(tool.name, tool.input)
      : null;
  // A command that did not run (held, denied) shows as one line, not a terminal.
  const showsTerminal =
    tool.info.kind === 'terminal' &&
    tool.state !== 'denied' &&
    tool.state !== 'held' &&
    tool.state !== 'approved';
  return (
    <article
      className="rounded-xl border border-border bg-surface shadow-card"
      aria-label={`${name}: ${tool.info.label}`}
      data-testid="tool-card"
    >
      <header className="flex items-center gap-2 px-3.5 pt-3">
        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <strong className="min-w-0 truncate text-sm font-semibold text-fg">
          {tool.info.label}
        </strong>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <StateChip state={tool.state} />
          {tool.info.tab ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Show on ${name}'s computer`}
              title={`Show on ${name}'s computer`}
              onClick={() =>
                showComputer(
                  tool.info.tab ?? 'activity',
                  tool.info.tab === 'files' && tool.detail && !tool.detail.startsWith('/')
                    ? tool.detail
                    : null,
                )
              }
            >
              <ArrowUpRight aria-hidden />
            </Button>
          ) : null}
        </span>
      </header>
      <div className="flex flex-col gap-2 px-3.5 pt-1 pb-3">
        {tool.detail && (tool.info.kind !== 'terminal' || !showsTerminal) ? (
          <p className="truncate font-mono text-xs text-fg-muted" title={tool.detail}>
            {tool.info.kind === 'terminal' ? `$ ${tool.detail}` : tool.detail}
          </p>
        ) : null}
        {tool.state === 'denied' && tool.reason ? (
          <p className="text-xs text-danger">{tool.reason}</p>
        ) : null}
        {showsTerminal ? <TerminalOutput tool={tool} botName={name} /> : null}
        {(tool.info.kind === 'web' || tool.info.kind === 'browser') &&
        tool.result &&
        !tool.result.isError ? (
          <PageView tool={tool} botName={name} />
        ) : null}
        {diff && diff.length > 0 ? (
          <details className="group">
            <summary className="flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg">
              <ChevronDown
                className="size-3.5 transition-transform group-open:rotate-180"
                aria-hidden
              />
              Show the changes
            </summary>
            <DiffView
              lines={diff}
              label={`Changes to ${tool.detail}`}
              className="mt-1"
              maxHeight="max-h-64"
            />
          </details>
        ) : null}
        {tool.info.kind === 'agent' && (tool.children.length > 0 || tool.messages > 0) ? (
          <ul className="flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-fg-muted">
            {tool.children.map((c) => {
              const ChildIcon = ICON[c.info.kind];
              return (
                <li key={c.key} className="flex min-w-0 items-center gap-1.5">
                  <ChildIcon className="size-3.5 shrink-0" aria-hidden />
                  <span className="shrink-0">{c.info.label}</span>
                  <span className="truncate font-mono">{c.detail}</span>
                </li>
              );
            })}
            {tool.messages > 0 ? (
              <li>
                {tool.messages} {tool.messages === 1 ? 'message' : 'messages'} from the helper
              </li>
            ) : null}
          </ul>
        ) : null}
        {tool.info.kind !== 'terminal' &&
        tool.info.kind !== 'web' &&
        tool.info.kind !== 'browser' &&
        tool.info.kind !== 'write' &&
        tool.info.kind !== 'edit' ? (
          <ResultDetails tool={tool} />
        ) : tool.result?.isError ? (
          <ResultDetails tool={tool} />
        ) : null}
      </div>
    </article>
  );
}

/** Quiet reads in a row, folded: "Read 3 files". */
export function ToolGroup({ tools }: { tools: ChatTool[] }) {
  return (
    <details
      className="group rounded-xl border border-border bg-surface px-3.5 py-2.5"
      data-testid="tool-group"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-fg-muted hover:text-fg">
        <Search className="size-4" aria-hidden />
        {quietLabel(tools)}
        <ChevronDown
          className="ml-auto size-4 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-xs text-fg-muted">
        {tools.map((t) => {
          const Icon = ICON[t.info.kind];
          return (
            <li key={t.key} className="flex min-w-0 items-center gap-1.5">
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="shrink-0 text-fg">{t.info.label}</span>
              <span className="truncate font-mono">{t.detail}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

const isField = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);

/**
 * A request waiting in the chat: the whole approval card, decided right
 * here. With focus in it the Inbox's keys work (a, e, d, ⇧A, y/n, Esc)
 * through the same pure model; each step focuses its own control, and a
 * decision hands the focus back to the composer (ui review H2).
 */
export function ApprovalInChat({ item }: { item: Extract<ChatItem, { kind: 'approval' }> }) {
  const c = useClient();
  const actions = useActions();
  const role = useRole();
  const [mode, setModeState] = useState<CardMode>('card');
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  /** The control that opened the current step; it gets the focus back. */
  const opener = useRef<HTMLElement | null>(null);
  /** A decision made here: once the card collapses, the composer takes the focus. */
  const refocus = useRef(false);
  const approval = useQuery({
    queryKey: [...keys.approvals, 'one', item.approvalId],
    queryFn: () => c.approvals.get(item.approvalId),
  });
  const a: Approval | undefined = approval.data;
  const decided = item.decision !== null || (a !== undefined && a.status !== 'pending');

  useEffect(() => {
    if (!decided || !refocus.current) return;
    refocus.current = false;
    document.getElementById(COMPOSER_ID)?.focus();
  }, [decided]);

  useEffect(() => {
    const el = section.current;
    if (!el) return;
    if (mode === 'always') {
      const confirm = el.querySelector<HTMLElement>('[role="alertdialog"]');
      confirm?.focus();
      confirm?.scrollIntoView({ block: 'nearest' });
    } else if (mode === 'card') {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
      else if (back) el.focus();
    } else {
      el.querySelector('textarea')?.scrollIntoView({ block: 'nearest' });
    }
  }, [mode]);

  const setMode = (m: CardMode) => {
    if (m !== 'card' && mode === 'card') {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    }
    setModeState(m);
  };
  const decide = (fn: () => Promise<void>) => {
    refocus.current = true;
    setBusy(true);
    void fn()
      .catch(() => {
        refocus.current = false;
      })
      .finally(() => setBusy(false));
  };

  if (decided) {
    const d = item.decision?.decision ?? a?.status ?? 'decided';
    const ok = d === 'approved';
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2 text-sm">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            TONE_CLASS[ok ? 'success' : 'danger'],
          )}
        >
          <span aria-hidden>{ok ? '✔' : '✘'}</span> {d[0]?.toUpperCase()}
          {d.slice(1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg">{item.summary}</span>
        {item.decision?.reason ? (
          <span className="w-full text-xs text-fg-muted">“{item.decision.reason}”</span>
        ) : null}
      </div>
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // Enter and Space on a focused control belong to it.
    if (e.key === 'Enter' || e.key === ' ') return;
    const state: InboxState = { selectedId: a.id, moved: false, mode: { kind: mode, id: a.id } };
    const r = gateInboxKey(
      state,
      onInboxKey(state, [a], { key: e.key, inField: isField(e.target) }),
      { decide: role.can('approve'), always: role.atLeast(ALWAYS_ALLOW_ROLE) },
      {
        decide: `${needsRoleText(roleFor('approve'))} to approve or deny`,
        always: `${needsRoleText(ALWAYS_ALLOW_ROLE)} to always allow a tool`,
      },
    );
    if (r.state === state && !r.command) return;
    e.preventDefault();
    // There is no list in a chat: "back to the list" is the card.
    const next = r.state.mode.kind === 'list' ? 'card' : r.state.mode.kind;
    if (next !== mode) setMode(next);
    const cmd = r.command;
    if (cmd?.kind === 'notice') toast(cmd.text);
    // Same gate as the buttons: FINANCIAL is never approved (handed back).
    if (cmd?.kind === 'approve' && !busy && a.tier !== 'FINANCIAL')
      decide(() => actions.approve(a, { always: cmd.always }));
  };

  return (
    <article
      ref={section}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-attention/40 bg-surface shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Needs your decision: ${item.summary}`}
      data-testid="chat-approval"
    >
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span aria-hidden className="text-attention">
          ◆
        </span>
        <strong className="text-sm font-semibold text-fg">Ready for your review</strong>
      </header>
      <div className="px-3.5 py-3">
        {a ? (
          <ApprovalCard
            approval={a}
            mode={mode}
            onMode={setMode}
            busy={busy}
            inline
            onApprove={(opts) => decide(() => actions.approve(a, opts))}
            onDeny={(reason) => decide(() => actions.deny(a, reason))}
          />
        ) : (
          <p className="text-sm text-fg-muted">{item.summary}</p>
        )}
      </div>
    </article>
  );
}

/** Another Bot was asked to help: who, what, and its answer (untrusted for this Bot). */
export function DelegationCard({ item }: { item: Extract<ChatItem, { kind: 'delegation' }> }) {
  const bots = useBots();
  const peer = bots.data?.find((b) => b.id === item.childBotId);
  const working = item.status === 'working';
  return (
    <article
      className="rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card"
      aria-label={`Asked ${item.childBotName}`}
      data-testid="delegation-card"
    >
      <header className="flex items-center gap-2">
        {peer ? (
          <BotAvatar bot={peer} size={24} decorative state={working ? 'working' : 'idle'} />
        ) : null}
        <strong className="min-w-0 truncate text-sm font-semibold text-fg">
          Asked {item.childBotName}
        </strong>
        <span className="ml-auto">
          <StateChip
            state={working ? 'working' : item.status === 'completed' ? 'done' : 'failed'}
          />
        </span>
      </header>
      <p className="mt-1.5 text-sm whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">
        {item.task}
      </p>
      {item.result ? (
        <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <p className="mb-1 text-xs text-fg-subtle">
            {item.childBotName}’s answer · untrusted data
          </p>
          <Markdown text={item.result} />
        </div>
      ) : null}
      <Link
        to="/chat/$botId"
        params={{ botId: item.childBotId }}
        search={{ c: item.childRunId }}
        className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
      >
        Open {item.childBotName}’s side <ArrowUpRight className="size-3" aria-hidden />
      </Link>
    </article>
  );
}

const NOTE_MARK: Record<Tone, string> = {
  neutral: '·',
  info: 'ℹ',
  success: '✔',
  warning: '⚠',
  danger: '✘',
  attention: '◆',
};

/** A quiet line in the chat: paused, stopped, untrusted content, a failure. */
export function ChatNote({
  item,
  onRetry,
}: {
  item: Extract<ChatItem, { kind: 'note' }>;
  onRetry?: () => void;
}) {
  const actions = useActions();
  return (
    <div className="flex flex-col items-center gap-1 text-center" data-testid="chat-note">
      <span
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
          TONE_CLASS[item.tone],
        )}
      >
        <span aria-hidden>{NOTE_MARK[item.tone]}</span>
        <span className="min-w-0">{item.text}</span>
      </span>
      {item.detail ? (
        <p className="max-w-xl text-xs break-words text-fg-muted">{item.detail}</p>
      ) : null}
      {item.action === 'resume' ? (
        <RoleGate route="resumeRun">
          <Button size="sm" variant="secondary" onClick={() => void actions.resumeRun(item.runId)}>
            <Play aria-hidden /> Resume
          </Button>
        </RoleGate>
      ) : null}
      {item.action === 'retry' && onRetry ? (
        <RoleGate route="startRun">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RotateCw aria-hidden /> Try again
          </Button>
        </RoleGate>
      ) : null}
    </div>
  );
}

export function UserMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="user-message">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-sm whitespace-pre-wrap text-bubble-fg shadow-sm [overflow-wrap:anywhere]">
        <span className="sr-only">You: </span>
        {item.text}
      </div>
    </div>
  );
}

/**
 * A turn nobody typed (ADR-014, ui review H3): what started it and the task
 * as a note, and what the trigger delivered as untrusted data — never as the
 * owner's own message, and without Orbit's note to the model.
 */
export function TriggerStartCard({
  item,
  botName,
}: {
  item: Extract<ChatItem, { kind: 'trigger' }>;
  botName: string;
}) {
  const { start } = item;
  const payload = start.payload ? lines(start.payload.text, 12) : null;
  return (
    <article
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3"
      aria-label={`Started by ${start.via}`}
      data-testid="trigger-start"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <Zap className="size-3.5 shrink-0" aria-hidden />
        Started by {start.via}
        <span className="text-fg-subtle">
          · <Time iso={item.ts} />
        </span>
      </p>
      {start.task ? (
        <div className="text-sm whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
          {start.taskByBot ? (
            <span className="mb-1 block text-xs text-fg-subtle">
              Written by another Bot · untrusted data for {botName}
            </span>
          ) : null}
          {start.task}
        </div>
      ) : null}
      {start.payload && payload ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
            <span className="min-w-0 truncate">{start.payload.source}</span>
            <span className="ml-auto shrink-0 rounded bg-warning-bg px-1.5 text-[11px] text-warning">
              untrusted
            </span>
          </div>
          <pre
            tabIndex={0}
            aria-label={`What ${start.payload.source} delivered`}
            className="max-h-48 overflow-auto px-3 py-2 font-sans text-xs whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"
          >
            {payload.shown}
            {payload.more > 0 ? `\n… ${payload.more} more lines` : ''}
          </pre>
        </div>
      ) : null}
    </article>
  );
}

export function AssistantMessage({
  item,
  botName,
}: {
  item: Extract<ChatItem, { kind: 'assistant' }>;
  botName: string;
}) {
  return (
    <div className="text-[15px] leading-relaxed text-fg">
      <span className="sr-only">{botName}: </span>
      <Markdown text={item.text} />
    </div>
  );
}

/** After a turn: when, its details, and thumbs (feedback becomes memory). */
export function TurnFooter({ item }: { item: Extract<ChatItem, { kind: 'end' }> }) {
  const actions = useActions();
  const [rating, setRating] = useState(item.rating);
  const rate = (r: 'up' | 'down') => {
    setRating(r);
    void actions.feedback(item.runId, r).catch(() => setRating(item.rating));
  };
  return (
    <div className="flex items-center gap-1 text-xs text-fg-subtle">
      <Time iso={item.ts} />
      <span aria-hidden>·</span>
      <Link
        to="/runs/$runId"
        params={{ runId: item.runId }}
        className="hover:text-fg hover:underline"
      >
        Details
      </Link>
      {item.status === 'completed' ? (
        <span className="ml-1 flex items-center">
          <RoleGate route="runFeedback">
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-7', rating === 'up' && 'text-success')}
              aria-label="Good answer"
              aria-pressed={rating === 'up'}
              onClick={() => rate('up')}
            >
              <ThumbsUp aria-hidden />
            </Button>
          </RoleGate>
          <RoleGate route="runFeedback">
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-7', rating === 'down' && 'text-danger')}
              aria-label="Bad answer"
              aria-pressed={rating === 'down'}
              onClick={() => rate('down')}
            >
              <ThumbsDown aria-hidden />
            </Button>
          </RoleGate>
        </span>
      ) : null}
    </div>
  );
}

/** The Bot is working: three dots and what it is doing. */
export function Typing({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-fg-subtle"
            style={{ animation: `orbit-typing 1.2s ${i * 0.15}s ease-in-out infinite` }}
          />
        ))}
      </span>
      {text}
    </div>
  );
}

/** The message box: Enter sends, Shift+Enter breaks the line; Stop while the Bot works. */
export function Composer({
  botName,
  state,
  onSend,
  onStop,
  footer,
  action,
  seed,
  autoFocus = false,
}: {
  botName: string;
  state: ComposerState;
  onSend: (text: string) => Promise<boolean>;
  onStop?: () => void;
  footer?: ReactNode;
  /** A control next to the hint (resume the Bot, go to the request). */
  action?: ReactNode;
  /** Text to put in the box (a starter); focuses it. */
  seed?: { text: string; n: number } | null;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const name = scrubControls(botName);
  const can = state.canSend && !sending && text.trim().length > 0;
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    box.current?.focus();
  }, [seed]);
  const submit = (e?: SyntheticEvent) => {
    e?.preventDefault();
    if (!can) return;
    setSending(true);
    void onSend(text.trim())
      .then((ok) => {
        if (ok) setText('');
      })
      .finally(() => setSending(false));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const cmd = composerKey({
      key: e.key,
      shift: e.shiftKey,
      composing: e.nativeEvent.isComposing,
    });
    if (cmd === 'send') {
      e.preventDefault();
      submit();
    } else if (cmd === 'leave') {
      e.preventDefault();
      box.current?.blur();
    }
  };
  // A long name would wrap the placeholder over several lines (ui review L17).
  const placeholder = name.length > 24 ? 'Message…' : `Message ${name}…`;
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" aria-label={`Message ${name}`}>
      <div className="flex items-end gap-2 rounded-2xl border border-border-input bg-surface px-3 py-2 shadow-card focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <textarea
          ref={box}
          id={COMPOSER_ID}
          aria-label={`Message ${name}`}
          placeholder={placeholder}
          rows={1}
          value={text}
          maxLength={20_000}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] text-fg outline-none placeholder:text-fg-subtle field-sizing-content"
        />
        {state.stoppable && onStop ? (
          <RoleGate route="stopRun">
            <Button
              type="button"
              variant="primary"
              size="icon"
              className="size-9 rounded-full"
              aria-label="Stop"
              onClick={onStop}
            >
              <Square className="fill-current" aria-hidden />
            </Button>
          </RoleGate>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size="icon"
            className="size-9 rounded-full"
            aria-label="Send"
            disabled={!can}
          >
            <ArrowUp aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex min-h-4 flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 text-center text-xs text-fg-subtle">
        <span>{state.hint ?? footer}</span>
        {state.hint ? action : null}
      </div>
    </form>
  );
}
