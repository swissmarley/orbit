/** @jsxRuntime automatic @jsxImportSource react */
import {
  type Bot,
  RUN_STATUS,
  type RunStatus,
  scrubControls,
  triggerLabel,
} from '@orbit/core/browser';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Clock3, ListTree, Play, Plus, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatar } from '../components/avatar';
import {
  ApprovalInChat,
  AssistantMessage,
  ChatNote,
  Composer,
  DelegationCard,
  ToolCard,
  ToolGroup,
  TriggerStartCard,
  Typing,
  TurnFooter,
  UserMessage,
} from '../components/chat';
import { helpStore } from '../components/keyboard-help';
import { paletteStore } from '../components/palette';
import { RoleGate } from '../components/role-gate';
import { ErrorState, ListSkeleton } from '../components/states';
import { Button } from '../components/ui/button';
import { Tooltip } from '../components/ui/tooltip';
import { useActions } from '../lib/actions';
import { useClient } from '../lib/api';
import { type AvatarState } from '../lib/avatar';
import { chatKey, stepConversation } from '../lib/chat-keys';
import {
  type ChatItem,
  buildConversation,
  composerState,
  conversationsOf,
  turnActivity,
} from '../lib/conversation';
import { otherModalOpen } from '../lib/modal';
import {
  keys,
  useBot,
  useComputer,
  useConversation,
  useDoctor,
  useKill,
  usePendingApprovals,
  useRuns,
} from '../lib/queries';
import { useRole } from '../lib/role';
import { COMPOSER_ID, lastBotStore } from '../lib/ui';

/**
 * What the header says the Bot is doing: the shared Run vocabulary for the
 * latest turn (ui review M7); "Here with you" only when nothing is going on.
 */
export function headerStatus(
  bot: Pick<Bot, 'pausedAt'>,
  latestStatus: RunStatus | undefined,
): { text: string; avatar: AvatarState; mark: string | null } {
  if (bot.pausedAt) return { text: 'Paused', avatar: 'paused', mark: '⏸' };
  if (latestStatus === undefined || latestStatus === 'completed')
    return { text: 'Here with you', avatar: 'idle', mark: null };
  const word = RUN_STATUS[latestStatus];
  const text = `${word.label[0]?.toUpperCase() ?? ''}${word.label.slice(1)} — ${word.meaning}`;
  const avatar: AvatarState =
    latestStatus === 'waiting_approval'
      ? 'attention'
      : latestStatus === 'queued' || latestStatus === 'running' || latestStatus === 'delegating'
        ? 'working'
        : latestStatus === 'paused' || latestStatus === 'rate_limited'
          ? 'paused'
          : 'idle';
  return { text, avatar, mark: word.mark };
}

function ItemView({
  item,
  bot,
  onRetry,
}: {
  item: ChatItem;
  bot: Bot;
  onRetry: (runId: string) => void;
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'trigger':
      return <TriggerStartCard item={item} botName={scrubControls(bot.spec.name)} />;
    case 'assistant':
      return <AssistantMessage item={item} botName={scrubControls(bot.spec.name)} />;
    case 'tool':
      // A delegation shows as its own card once it started.
      if (
        item.tool.info.kind === 'delegate' &&
        (item.tool.state === 'done' || item.tool.state === 'working')
      )
        return null;
      return <ToolCard tool={item.tool} bot={bot} />;
    case 'group':
      return <ToolGroup tools={item.tools} />;
    case 'approval':
      return <ApprovalInChat item={item} />;
    case 'delegation':
      return <DelegationCard item={item} />;
    case 'note':
      return <ChatNote item={item} onRetry={() => onRetry(item.runId)} />;
    case 'end':
      return <TurnFooter item={item} />;
  }
}

/** Starting points: they fill the message box, they never send (ui review M16). */
function Starters({ bot, onPick }: { bot: Bot; onPick: (text: string) => void }) {
  const goal = scrubControls(bot.spec.goal);
  const starters = [
    { label: 'Work on your goal', text: goal },
    { label: 'What can you do for me?', text: 'What can you do for me? Keep it short.' },
    {
      label: 'What is on your computer?',
      text: 'List what is in your workspace and tell me what each file is for.',
    },
  ];
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {starters.map((s) => (
        <Button
          key={s.label}
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => onPick(s.text)}
        >
          {s.label}
        </Button>
      ))}
    </div>
  );
}

/** One conversation with a Bot (ADR-020): its turns as a chat, the composer below. */
function Conversation({ bot, conversationId }: { bot: Bot; conversationId: string }) {
  const c = useClient();
  const navigate = useNavigate();
  const actions = useActions();
  const role = useRole();
  const kill = useKill();
  const doctor = useDoctor();
  const computer = useComputer(bot.id);
  const conversation = useConversation(conversationId);
  const pending = usePendingApprovals();
  const turns = useMemo(() => conversation.data ?? [], [conversation.data]);
  const events = useQueries({
    queries: turns.map((r) => ({
      queryKey: keys.runEvents(r.runId),
      queryFn: () => c.runs.events(r.runId),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  // Cheap to rebuild: a fold over the conversation's events.
  const items = buildConversation(turns.map((run, i) => ({ run, events: events[i]?.data })));
  const latest = turns.at(-1);
  const name = scrubControls(bot.spec.name);
  // A call held in the park window: the Run still runs, but it waits for you.
  const decisionPending =
    latest !== undefined && (pending.data ?? []).some((a) => a.runId === latest.runId);
  const state = composerState({
    bot,
    latest,
    killed: kill.data?.engaged === true,
    canStart: role.can('startRun'),
    takenOver: computer.data?.state === 'taken_over',
    decisionPending,
  });
  const activity = decisionPending ? null : turnActivity(latest, name);
  const header = headerStatus(bot, decisionPending ? 'waiting_approval' : latest?.status);

  // Stay at the bottom while new things arrive, unless the reader scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastKey = items.at(-1)?.key ?? '';
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, lastKey, activity?.text]);

  const send = async (text: string): Promise<boolean> => {
    try {
      const run = await actions.sendMessage(bot, text, conversationId ? latest?.runId : undefined);
      stick.current = true;
      // A first message, or one sent from a conversation that is gone, starts a new one.
      if (run.conversationId !== conversationId) {
        await navigate({
          to: '/chat/$botId',
          params: { botId: bot.id },
          search: { c: run.conversationId },
        });
      }
      return true;
    } catch {
      return false;
    }
  };
  const retry = (runId: string) => {
    const failed = turns.find((t) => t.runId === runId);
    if (failed) void send(failed.prompt);
  };
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);

  // The chat's keys (src/lib/chat-keys.ts): /, r, n, [ ].
  const runs = useRuns({ bot: bot.id, limit: 300 });
  const conversationIds = useMemo(
    () => conversationsOf(runs.data ?? []).map((x) => x.id),
    [runs.data],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || otherModalOpen() || paletteStore.get() || helpStore.get()) return;
      const t = e.target;
      const cmd = chatKey({
        key: e.key,
        inField:
          t instanceof HTMLElement &&
          (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)),
        modified: e.metaKey || e.ctrlKey || e.altKey,
      });
      if (!cmd) return;
      if (cmd === 'composer') document.getElementById(COMPOSER_ID)?.focus();
      else if (cmd === 'request') {
        const card = document.querySelector<HTMLElement>('[data-testid="chat-approval"]');
        if (!card) return;
        card.focus();
        card.scrollIntoView({ block: 'nearest' });
      } else if (cmd === 'new') {
        void navigate({ to: '/chat/$botId', params: { botId: bot.id } });
      } else {
        const next = stepConversation(conversationIds, conversationId, cmd);
        if (!next) return;
        void navigate({ to: '/chat/$botId', params: { botId: bot.id }, search: { c: next } });
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bot.id, conversationId, conversationIds, navigate]);

  const hintAction =
    state.action === 'resume-bot' ? (
      <RoleGate route="resumeBot">
        <Button size="sm" variant="secondary" onClick={() => void actions.setBotPaused(bot, false)}>
          <Play aria-hidden /> Resume {name}
        </Button>
      </RoleGate>
    ) : state.action === 'decide' ? (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          const card = document.querySelector<HTMLElement>('[data-testid="chat-approval"]');
          card?.focus();
          card?.scrollIntoView({ block: 'nearest' });
        }}
      >
        Go to the request
      </Button>
    ) : null;
  const triggers = bot.spec.triggers.filter((t) => t.enabled);
  const footer =
    doctor.data?.driver === 'mock'
      ? 'Demo mode: replies replay recorded runs; policy still decides every step.'
      : `${name} works on its own computer; anything outside it asks you first.`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6 sm:px-6">
          <header className="sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b border-border bg-bg px-4 py-2 sm:-mx-6 sm:px-6 sm:py-3">
            <BotAvatar bot={bot} size={40} state={header.avatar} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-fg">{name}</h1>
              {/* The chat's one live region (ui review M12). */}
              <p className="truncate text-xs text-fg-muted" role="status">
                {header.mark ? <span aria-hidden>{header.mark} </span> : null}
                {header.text}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              {conversationId ? (
                <Tooltip content="New conversation">
                  <Button variant="ghost" size="icon" aria-label="New conversation" asChild>
                    <Link to="/chat/$botId" params={{ botId: bot.id }}>
                      <Plus aria-hidden />
                    </Link>
                  </Button>
                </Tooltip>
              ) : null}
              {latest ? (
                <Tooltip content="Details of the latest turn">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Details of the latest turn"
                    asChild
                  >
                    <Link to="/runs/$runId" params={{ runId: latest.runId }}>
                      <ListTree aria-hidden />
                    </Link>
                  </Button>
                </Tooltip>
              ) : null}
              <Tooltip
                content={
                  triggers.length > 0
                    ? `Schedules and triggers: ${triggers.map(triggerLabel).join(', ')}`
                    : 'Schedules and triggers'
                }
              >
                <Button variant="ghost" size="icon" aria-label="Schedules and triggers" asChild>
                  <Link to="/bots/$botId" params={{ botId: bot.id }} search={{ tab: 'config' }}>
                    <Clock3 aria-hidden />
                  </Link>
                </Button>
              </Tooltip>
              <Tooltip content={`${name}'s settings`}>
                <Button variant="ghost" size="icon" aria-label={`${name}'s settings`} asChild>
                  <Link to="/bots/$botId" params={{ botId: bot.id }}>
                    <Settings2 aria-hidden />
                  </Link>
                </Button>
              </Tooltip>
            </div>
          </header>

          {!conversationId ? (
            <div className="flex flex-col items-center gap-3 pt-10 text-center">
              <BotAvatar bot={bot} size={112} state={header.avatar} />
              <h2 className="text-2xl font-semibold tracking-tight text-fg">
                What should {name} do?
              </h2>
              <p className="max-w-lg text-sm whitespace-pre-wrap text-fg-muted">
                {scrubControls(bot.spec.goal)}
              </p>
              {triggers.length > 0 ? (
                <p className="text-xs text-fg-subtle">
                  Also runs by itself: {triggers.map(triggerLabel).join(' · ')}
                </p>
              ) : null}
            </div>
          ) : conversation.isPending ? (
            <ListSkeleton rows={3} className="pt-4" />
          ) : conversation.isError ? (
            <ErrorState error={conversation.error} retry={() => void conversation.refetch()} />
          ) : (
            <div
              role="log"
              aria-label={`Conversation with ${name}`}
              className="flex flex-col gap-4 pt-2"
              data-testid="chat-log"
            >
              {items.map((item) => (
                <div key={item.key}>
                  <ItemView item={item} bot={bot} onRetry={retry} />
                </div>
              ))}
              {turns.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  This conversation is not there (any more): a message starts a new one.{' '}
                  <Link
                    to="/chat/$botId"
                    params={{ botId: bot.id }}
                    className="text-accent hover:underline"
                  >
                    New conversation
                  </Link>
                </p>
              ) : null}
            </div>
          )}
          {activity?.busy ? <Typing text={activity.text} /> : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-3 sm:px-6">
        {!conversationId && state.canSend ? (
          <div className="mb-3">
            <Starters bot={bot} onPick={(text) => setSeed((p) => ({ text, n: (p?.n ?? 0) + 1 }))} />
          </div>
        ) : null}
        <Composer
          botName={bot.spec.name}
          state={state}
          onSend={send}
          {...(latest && state.stoppable
            ? { onStop: () => void actions.stopRun(latest.runId) }
            : {})}
          footer={footer}
          action={hintAction}
          seed={seed}
          autoFocus={!conversationId}
        />
      </div>
    </div>
  );
}

/** /chat/$botId?c=<conversation>: talk to a Bot (ADR-020). */
export function ChatScreen() {
  const params: { botId?: string } = useParams({ strict: false });
  const search: { c?: string | undefined } = useSearch({ strict: false });
  const bot = useBot(params.botId ?? '');
  useEffect(() => {
    if (bot.data) lastBotStore.set(bot.data.id);
  }, [bot.data]);
  if (bot.isPending) return <ListSkeleton rows={4} className="mx-auto max-w-3xl p-6" />;
  if (bot.isError)
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ErrorState error={bot.error} retry={() => void bot.refetch()} />
      </div>
    );
  return (
    <Conversation
      key={`${bot.data.id}:${search.c ?? ''}`}
      bot={bot.data}
      conversationId={search.c ?? ''}
    />
  );
}
