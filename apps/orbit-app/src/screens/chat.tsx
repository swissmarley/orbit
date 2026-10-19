/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, scrubControls, triggerLabel } from '@orbit/core/browser';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, Clock3, ListTree, Plus, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { BotAvatar } from '../components/avatar';
import {
  ApprovalInChat,
  AssistantMessage,
  ChatNote,
  Composer,
  DelegationCard,
  ToolCard,
  ToolGroup,
  Typing,
  TurnFooter,
  UserMessage,
} from '../components/chat';
import { ErrorState, ListSkeleton } from '../components/states';
import { Button } from '../components/ui/button';
import { Tooltip } from '../components/ui/tooltip';
import { useActions } from '../lib/actions';
import { useClient } from '../lib/api';
import { type AvatarState } from '../lib/avatar';
import { type ChatItem, buildConversation, composerState, turnActivity } from '../lib/conversation';
import {
  keys,
  useBot,
  useComputer,
  useConversation,
  useDoctor,
  useKill,
  usePendingApprovals,
} from '../lib/queries';
import { useRole } from '../lib/role';
import { lastBotStore } from '../lib/ui';

/** What the header says the Bot is doing. */
function headerStatus(
  bot: Bot,
  latestStatus: string | undefined,
): { text: string; avatar: AvatarState } {
  if (bot.pausedAt) return { text: 'Paused', avatar: 'paused' };
  switch (latestStatus) {
    case 'queued':
      return { text: 'About to start…', avatar: 'working' };
    case 'running':
      return { text: 'Working…', avatar: 'working' };
    case 'delegating':
      return { text: 'Waiting for another Bot', avatar: 'working' };
    case 'waiting_approval':
      return { text: 'Needs your decision', avatar: 'attention' };
    case 'paused':
      return { text: 'Paused in this conversation', avatar: 'attention' };
    case 'rate_limited':
      return { text: 'Waiting for the usage limit', avatar: 'idle' };
    default:
      return { text: 'Here with you', avatar: 'idle' };
  }
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
    case 'assistant':
      return <AssistantMessage item={item} />;
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
          {s.label} <ArrowUpRight aria-hidden />
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
      if (!conversationId) {
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
  const triggers = bot.spec.triggers.filter((t) => t.enabled);
  const footer =
    doctor.data?.driver === 'mock'
      ? 'Demo mode: replies replay recorded runs; policy still decides every step.'
      : `${name} works on its own computer; anything outside it asks you first.`;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-6 sm:px-6">
          <header className="sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b border-border bg-bg px-4 py-3 sm:-mx-6 sm:px-6">
            <BotAvatar bot={bot} size={40} state={header.avatar} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold text-fg">{name}</h1>
              <p className="truncate text-xs text-fg-muted" role="status">
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
                <p className="text-sm text-fg-muted">This conversation has no turns.</p>
              ) : null}
            </div>
          )}
          {activity?.busy ? <Typing text={activity.text} /> : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-3 sm:px-6">
        {!conversationId && state.canSend ? (
          <div className="mb-3">
            <Starters bot={bot} onPick={(t) => void send(t)} />
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
