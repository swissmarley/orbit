/** @jsxRuntime automatic @jsxImportSource react */
import {
  MEMORY_KIND_WORD,
  RUN_STATUS,
  TERMINAL_RUN_STATUSES,
  type RunEvent,
  type RunState,
  formatCost,
  formatDuration,
  formatFull,
  formatLocalTime,
  formatTimeOfDay,
  formatTokens,
  pauseNextStep,
  pauseReason,
  replayRun,
  scrubControls,
} from '@orbit/core/browser';
import { Link, useParams } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Pause,
  ThumbsDown,
  ThumbsUp,
  Play,
  Radio,
  RotateCcw,
  Square,
  StepBack,
  StepForward,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { roleFor } from '@orbit/sdk-client/browser';
import { confirmAction } from '../components/confirm';
import { RoleGate } from '../components/role-gate';
import { Meter } from '../components/sparkline';
import { TakeOverButton } from '../components/takeover';
import { ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { StatusBadge, Time } from '../components/status';
import { Timeline } from '../components/timeline';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Kbd } from '../components/ui/misc';
import { cn } from '../lib/cn';
import { TONE_TEXT, textMark } from '../lib/tone';
import { useActions } from '../lib/actions';
import { otherModalOpen } from '../lib/modal';
import { needsRoleText, useRole } from '../lib/role';
import { Textarea } from '../components/ui/input';
import { type DelegationNode, delegationTree, treeSize } from '../lib/delegation';
import {
  useBot,
  useBots,
  usePendingApprovals,
  useRun,
  useRunEvents,
  useRunMemory,
  useRunTree,
} from '../lib/queries';
import { type SubagentNode, buildTimeline, subagentTree } from '../lib/timeline';
import { TrustBadge } from './memory';

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
  );
}

/**
 * The Run's controls, always in one order so the row does not jump with its
 * status: the Run's own ([Resume run | Pause run] [Pause now] [Stop], or
 * [Run again] once it ended), then, after a divider, the Bot's ([Pause Bot]
 * [Take over]). Each needs a role (hosted mode, ADR-015): it is disabled with
 * the reason for a principal without it.
 */
function Controls({ run }: { run: RunState }) {
  const actions = useActions();
  const role = useRole();
  const bot = useBot(run.botId);
  const live = !TERMINAL_RUN_STATUSES.includes(run.status);
  const resumable =
    ((run.status === 'waiting_approval' || run.status === 'paused') &&
      run.pendingApprovals.length === 0) ||
    run.status === 'rate_limited';
  const running = run.status === 'running';
  const paused = (bot.data?.pausedAt ?? null) !== null;
  const pauseRun = () => void actions.pauseRun(run.runId).catch(() => undefined);

  // P pauses a running Run at its next tool call (listed in RUN_KEYS).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'P' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(e.target) || otherModalOpen()) return;
      e.preventDefault();
      if (!role.can('pauseRun')) toast(`${needsRoleText(roleFor('pauseRun'))} to pause a Run`);
      else if (!running) toast('Only a running Run can be paused');
      else if (run.pauseRequested) toast('A pause is already requested');
      else pauseRun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      {resumable ? (
        <RoleGate route="resumeRun">
          <Button
            variant="primary"
            onClick={() => void actions.resumeRun(run.runId).catch(() => undefined)}
          >
            <Play aria-hidden /> Resume run
          </Button>
        </RoleGate>
      ) : null}
      {running ? (
        <>
          <RoleGate
            route="pauseRun"
            hint="Stops at the run's next tool call; resume it whenever you like (P)"
          >
            <Button disabled={run.pauseRequested !== null} onClick={pauseRun}>
              <Pause aria-hidden /> {run.pauseRequested ? 'Pause requested' : 'Pause run'}
            </Button>
          </RoleGate>
          <RoleGate route="pauseRun">
            <Button
              variant="ghost"
              disabled={run.pauseRequested?.now === true}
              onClick={() =>
                void (async () => {
                  const ok = await confirmAction({
                    title: 'Pause this run now?',
                    body: 'The engine stops mid-turn. When you resume, the Bot is told that a tool call without a result may or may not have happened.',
                    confirm: 'Pause now',
                  });
                  if (ok) await actions.pauseRun(run.runId, true);
                })().catch(() => undefined)
              }
            >
              <Zap aria-hidden /> Pause now
            </Button>
          </RoleGate>
        </>
      ) : null}
      {live ? (
        <RoleGate route="stopRun">
          <Button
            variant="danger"
            onClick={() =>
              void (async () => {
                const ok = await confirmAction({
                  title: 'Stop this run?',
                  body: 'The engine stops now; pending approvals are cancelled. This cannot be undone.',
                  confirm: 'Stop run',
                  danger: true,
                });
                if (ok) await actions.stopRun(run.runId);
              })().catch(() => undefined)
            }
          >
            <Square aria-hidden /> Stop
          </Button>
        </RoleGate>
      ) : bot.data ? (
        <RoleGate route="startRun">
          <Button
            disabled={paused}
            onClick={() =>
              void actions
                .runBot(bot.data, run.prompt ? { prompt: run.prompt } : {})
                .catch(() => undefined)
            }
          >
            <RotateCcw aria-hidden /> Run again
          </Button>
        </RoleGate>
      ) : null}
      {bot.data ? (
        <>
          <span aria-hidden className="mx-1 h-6 w-px self-center bg-border" />
          <RoleGate
            route={paused ? 'resumeBot' : 'pauseBot'}
            hint={
              paused
                ? 'The Bot may start Runs again'
                : 'The whole Bot: this Run and its others stop, and no new Runs start'
            }
          >
            <Button
              variant="ghost"
              onClick={() =>
                void (async () => {
                  if (!paused) {
                    const ok = await confirmAction({
                      title: `Pause ${scrubControls(bot.data.spec.name)}?`,
                      body: 'This Run and any others of the Bot stop; nothing new starts until you resume it.',
                      confirm: 'Pause Bot',
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  await actions.setBotPaused(bot.data, !paused);
                })().catch(() => undefined)
              }
            >
              {paused ? <CirclePlay aria-hidden /> : <CirclePause aria-hidden />}{' '}
              {paused ? 'Resume Bot' : 'Pause Bot'}
            </Button>
          </RoleGate>
          <TakeOverButton bot={bot.data} />
        </>
      ) : null}
    </>
  );
}

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The smaller of a Bot budget and a ceiling inherited from a delegating parent. */
const capped = (own: number | null, cap: number | null): number | null =>
  own === null ? cap : cap === null ? own : Math.min(own, cap);

function Meters({ run, held }: { run: RunState; held: number }) {
  const bot = useBot(run.botId);
  const b = bot.data?.spec.budgets;
  const cap = run.budgetCap;
  const tokens =
    run.totals.tokens +
    (run.liveUsage && run.status === 'running'
      ? run.liveUsage.inputTokens + run.liveUsage.outputTokens
      : 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage & budgets</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Meter
          label={run.delegated.tokens > 0 ? 'Tokens (incl. delegated)' : 'Tokens'}
          value={tokens + run.delegated.tokens}
          max={capped(b?.maxTokensPerRun ?? null, cap?.tokens ?? null)}
          format={formatTokens}
        />
        <Meter
          label={run.delegated.toolCalls > 0 ? 'Tool calls (incl. delegated)' : 'Tool calls'}
          value={run.counts.toolCalls + run.delegated.toolCalls}
          max={capped(b?.maxToolCallsPerRun ?? null, cap?.toolCalls ?? null)}
        />
        <Meter
          label={
            run.delegated.costUsd > 0
              ? 'Cost (engine estimate, incl. delegated)'
              : 'Cost (engine estimate)'
          }
          value={run.totals.costUsd + run.delegated.costUsd}
          max={capped(b?.maxCostUsdPerRun ?? null, cap?.costUsd ?? null)}
          format={(n) => formatCost(n, false)}
        />
        <Meter
          label="Active time"
          value={run.totals.activeMs}
          max={
            b ? (capped(b.maxWallClockMinutes, cap?.wallClockMinutes ?? null) ?? 0) * 60_000 : null
          }
          format={formatDuration}
        />
        {cap ? (
          <p className="text-xs text-fg-muted">Limits include what the delegating Run had left.</p>
        ) : null}
        <p className="text-xs text-fg-muted">
          {[
            n(run.totals.turns, 'turn'),
            n(run.counts.messages, 'message'),
            // A call held for an approval is a pause, not a denial.
            `${Math.max(0, run.counts.denied - held)} denied`,
            held > 0 ? `${held} held for approval` : null,
            n(run.counts.subagents, 'subagent'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {run.budgetExceeded ? (
          <p className="text-xs text-danger">⛔ {run.budgetExceeded} budget exceeded</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Tree({ nodes }: { nodes: SubagentNode[] }) {
  return (
    <ul className="flex flex-col gap-1 border-l border-border pl-3 text-sm">
      {nodes.map((n) => (
        <li key={n.toolUseId}>
          <span className={n.error ? 'text-danger' : n.done ? 'text-fg-muted' : 'text-attention'}>
            <span aria-hidden>{n.error ? '✘' : n.done ? '✔' : '●'}</span> {n.label}
            {n.background && !n.done ? (
              <span className="text-xs text-fg-muted"> · in the background</span>
            ) : null}
            <span className="sr-only">
              {n.error ? ' (failed)' : n.done ? ' (finished)' : ' (working)'}
            </span>
          </span>
          {n.children.length > 0 ? <Tree nodes={n.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

function DelegationList({ node }: { node: DelegationNode }) {
  const w = RUN_STATUS[node.run.status];
  return (
    <li>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={cn('text-xs', TONE_TEXT[w.tone])} title={w.meaning}>
          <span aria-hidden>{textMark(w.mark)}</span> {w.label}
        </span>
        {node.current ? (
          <span aria-current="page" className="font-medium text-fg">
            {scrubControls(node.botName)} <span className="text-xs text-fg-muted">(this run)</span>
          </span>
        ) : (
          <Link
            to="/runs/$runId"
            params={{ runId: node.run.runId }}
            className="text-accent hover:underline"
          >
            {scrubControls(node.botName)}
          </Link>
        )}
      </span>
      {node.children.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1 border-l border-border pl-3">
          {node.children.map((c) => (
            <DelegationList key={c.run.runId} node={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Bots handing work to Bots: the whole tree this Run belongs to, live. */
function Delegation({ run }: { run: RunState }) {
  const tree = useRunTree(run.runId);
  const bots = useBots();
  const name = (id: string) => bots.data?.find((b) => b.id === id)?.spec.name ?? id;
  const root = tree.data ? delegationTree(tree.data.runs, tree.data.root, name, run.runId) : null;
  if (!root || treeSize(root) < 2) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delegation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <ul aria-label="Delegation tree">
          <DelegationList node={root} />
        </ul>
        <p className="text-xs text-fg-muted">
          Each delegated Run has its own approvals and inherits what its parent had left of its
          budget and its untrusted inputs. Stopping a Run stops the Runs it delegated.
        </p>
      </CardContent>
    </Card>
  );
}

/** Thumbs up or down on a finished Run: feedback the Bot sees in future Runs. */
function Feedback({ run }: { run: RunState }) {
  const actions = useActions();
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your feedback</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex gap-2" role="group" aria-label="Rate this run">
          {/* Pressed shows only what is saved; a choice is pending until you save it. */}
          <Button
            size="sm"
            aria-pressed={run.rating === 'up'}
            variant={run.rating === 'up' ? 'primary' : 'secondary'}
            className={rating === 'up' ? 'ring-2 ring-ring' : undefined}
            onClick={() => setRating('up')}
          >
            <ThumbsUp aria-hidden /> Good
          </Button>
          <Button
            size="sm"
            aria-pressed={run.rating === 'down'}
            variant={run.rating === 'down' ? 'primary' : 'secondary'}
            className={rating === 'down' ? 'ring-2 ring-ring' : undefined}
            onClick={() => setRating('down')}
          >
            <ThumbsDown aria-hidden /> Not good
          </Button>
        </div>
        {rating ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void actions
                .feedback(run.runId, rating, comment)
                .then(() => {
                  setRating(null);
                  setComment('');
                })
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
          >
            <p className="text-xs text-fg-muted" role="status">
              Selected: {rating === 'up' ? 'good' : 'not good'} — not saved yet. Add a comment if
              you like, then save.
            </p>
            <Textarea
              aria-label="What was good or bad (optional)"
              placeholder="What was good or bad? (optional)"
              value={comment}
              maxLength={2000}
              rows={3}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy}>
              Save feedback
            </Button>
          </form>
        ) : (
          <p className="text-xs text-fg-muted">
            {run.rating
              ? `Saved: you rated it ${run.rating === 'up' ? 'good' : 'not good'}. Rating again adds another note.`
              : 'The Bot sees your rating and comment as context in future Runs.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Memories this Run wrote: notes, its summary, your feedback. */
function RunMemory({ run }: { run: RunState }) {
  const memory = useRunMemory(run.runId);
  if (!memory.data || memory.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Remembered</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {memory.data.map((m) => (
            <li key={m.id} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <TrustBadge memory={m} />
                <span className="text-xs text-fg-muted">{MEMORY_KIND_WORD[m.kind]}</span>
              </span>
              <Link
                to="/memory"
                search={{ bot: run.botId, memory: m.id }}
                className="line-clamp-2 text-accent hover:underline"
              >
                {scrubControls(m.title)}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Replay scrubber: step through the event log; the timeline and the status
 * show the Run as it was at that event (a pure fold of the prefix).
 */
function Scrubber({
  events,
  pos,
  setPos,
}: {
  events: RunEvent[];
  pos: number | null;
  setPos: (p: number | null) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const n = events.length;
  const at = pos ?? n;
  useEffect(() => {
    if (!playing) return;
    if (at >= n) {
      setPlaying(false);
      setPos(null);
      return;
    }
    const t = setTimeout(() => setPos(at + 1 >= n ? null : at + 1), 350);
    return () => clearTimeout(t);
  }, [playing, at, n, setPos]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
      )
        return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === '[') setPos(Math.max(0, at - 1));
      else if (e.key === ']') setPos(at + 1 >= n ? null : at + 1);
      else if (e.key === 'L') setPos(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, n, setPos]);
  const current = events[at - 1];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <span className="text-xs font-medium text-fg-muted">Replay</span>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Previous event"
        onClick={() => setPos(Math.max(0, at - 1))}
        disabled={at === 0}
      >
        <StepBack aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        onClick={() => {
          if (!playing && pos === null) setPos(0);
          setPlaying((p) => !p);
        }}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Next event"
        onClick={() => setPos(at + 1 >= n ? null : at + 1)}
        disabled={pos === null}
      >
        <StepForward aria-hidden />
      </Button>
      <input
        type="range"
        min={0}
        max={n}
        value={at}
        onChange={(e) => {
          setPlaying(false);
          const v = Number(e.target.value);
          setPos(v >= n ? null : v);
        }}
        aria-label="Replay position"
        aria-valuetext={`event ${at} of ${n}${current ? `, ${formatFull(current.ts)}` : ''}`}
        className="min-w-32 flex-1 accent-[var(--accent)]"
      />
      <span className="text-xs text-fg-muted tabular-nums">
        {at}/{n}
        {current ? ` · ${formatTimeOfDay(current.ts)}` : ''}
      </span>
      <Button
        size="sm"
        variant={pos === null ? 'secondary' : 'primary'}
        onClick={() => {
          setPlaying(false);
          setPos(null);
        }}
        aria-pressed={pos === null}
      >
        <Radio aria-hidden /> Live
      </Button>
      <span className="hidden text-xs text-fg-subtle lg:inline">
        <Kbd>[</Kbd> <Kbd>]</Kbd> step · <Kbd>L</Kbd> live
      </span>
    </div>
  );
}

export function RunScreen() {
  const params: { runId?: string } = useParams({ strict: false });
  const runId = params.runId ?? '';
  const run = useRun(runId);
  const events = useRunEvents(runId);
  const approvals = usePendingApprovals();
  const bot = useBot(run.data?.botId ?? '');
  const parentRun = useRun(run.data?.parentRunId ?? '');
  const parentBot = useBot(parentRun.data?.botId ?? '').data;
  const [pos, setPos] = useState<number | null>(null);
  const all = events.data ?? [];
  const shown = pos === null ? all : all.slice(0, pos);
  const items = useMemo(() => buildTimeline(shown), [shown]);
  const tree = useMemo(() => subagentTree(shown), [shown]);
  // Calls currently held for an approval (counted as denials by the projection).
  const held = useMemo(
    () => buildTimeline(all).filter((i) => i.kind === 'tool' && i.decision?.held).length,
    [all],
  );
  const replayed = useMemo(() => (pos === null ? null : (replayRun(shown) ?? null)), [pos, shown]);

  if (run.isPending) return <ListSkeleton rows={6} />;
  if (run.isError) return <ErrorState error={run.error} retry={() => void run.refetch()} />;
  const r = run.data;
  const state = replayed ?? r;
  const waiting = (approvals.data ?? []).filter((a) => a.runId === r.runId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={<span className="line-clamp-2">{scrubControls(r.prompt) || r.runId}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 [&>*+*]:before:mr-1.5 [&>*+*]:before:content-['·']">
            <Link
              to="/bots/$botId"
              params={{ botId: r.botId }}
              className="text-accent hover:underline"
            >
              {bot.data ? scrubControls(bot.data.spec.name) : r.botId}
            </Link>
            {r.parentRunId ? (
              <span>
                delegated by{' '}
                <Link
                  to="/runs/$runId"
                  params={{ runId: r.parentRunId }}
                  className="text-accent hover:underline"
                >
                  {parentBot ? scrubControls(parentBot.spec.name) : 'a Bot'} (run …
                  {r.parentRunId.slice(-8)})
                </Link>
              </span>
            ) : (
              <span>trigger: {r.trigger?.kind ?? 'manual'}</span>
            )}
            <span>
              queued <Time iso={r.createdAt} />
            </span>
            {r.endedAt ? (
              <span>
                ended <Time iso={r.endedAt} />
              </span>
            ) : null}
            <span className="font-mono text-xs">{r.runId}</span>
            {r.parentRunId ? null : (
              <Link
                to="/chat/$botId"
                params={{ botId: r.botId }}
                search={{ c: r.conversationId }}
                className="text-accent hover:underline"
              >
                open the conversation
              </Link>
            )}
          </span>
        }
        actions={<Controls run={r} />}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={state.status} />
          {replayed ? <Badge tone="info">replaying — not live</Badge> : null}
          {r.model ? <Badge title="The model the engine reported">model {r.model}</Badge> : null}
          {r.driver ? (
            <Badge title="Driver and authentication of this Run">
              {r.driver === 'mock' ? 'Demo · mock driver' : `${r.driver} · ${r.authMethod ?? ''}`}
            </Badge>
          ) : null}
          {r.resumeAt ? <Badge tone="info">↻ resumes {formatLocalTime(r.resumeAt)}</Badge> : null}
          {r.pauseRequested ? (
            <Badge tone="warning" title="Requested by you">
              <span aria-hidden>{textMark(RUN_STATUS.paused.mark)}</span>
              {r.pauseRequested.now ? 'pausing now' : 'pauses at its next tool call'}
            </Badge>
          ) : null}
          {r.taintSources.length > 0 ? (
            <Badge tone="warning" title={`Untrusted content from: ${r.taintSources.join(', ')}`}>
              ⚠ untrusted input — external actions always ask
            </Badge>
          ) : null}
        </div>
      </PageHeader>

      {waiting.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-attention/40 bg-attention-bg px-4 py-2 text-sm text-attention"
        >
          <span aria-hidden>◆</span>
          <span className="flex-1">
            This run is waiting for you: {waiting.map((a) => scrubControls(a.card.what)).join('; ')}
          </span>
          <Button size="sm" variant="primary" asChild>
            <Link to="/inbox" search={{ approval: waiting[0]?.id }}>
              Review <ChevronRight aria-hidden />
            </Link>
          </Button>
        </div>
      ) : null}
      {r.error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-bg px-4 py-2 text-sm text-danger"
        >
          <span aria-hidden>✘</span> Failed ({r.error.code}): {scrubControls(r.error.message)}
          {r.error.retryable ? ' — you can run it again.' : ''}
        </div>
      ) : null}
      {r.status === 'paused' && r.pause ? (
        <div
          data-testid="pause-banner"
          role="status"
          className="rounded-lg border border-warning/40 bg-warning-bg px-4 py-2 text-sm text-warning"
        >
          <span aria-hidden>{textMark(RUN_STATUS.paused.mark)}</span>{' '}
          {scrubControls(pauseReason(r.pause))} {pauseNextStep(r.pause)}
        </div>
      ) : null}
      {r.usageLimit ? (
        <div
          role="status"
          className="rounded-lg border border-warning/40 bg-warning-bg px-4 py-2 text-sm text-warning"
        >
          <span aria-hidden>⧗</span> {scrubControls(r.usageLimit.message)} Paused, not failed
          {r.usageLimit.resetsAt ? ` — resets ${formatLocalTime(r.usageLimit.resetsAt)}` : ''}.
        </div>
      ) : null}

      {/* The answer the user came for comes first once the Run is done. */}
      {r.resultText ? (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap text-fg">{scrubControls(r.resultText)}</p>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-2">
          <Scrubber events={all} pos={pos} setPos={setPos} />
          {events.isPending ? (
            <ListSkeleton rows={6} />
          ) : events.isError ? (
            <ErrorState error={events.error} retry={() => void events.refetch()} />
          ) : (
            <Timeline items={items} className="max-h-[62vh] min-h-40" />
          )}
        </div>
        <aside className="flex flex-col gap-4" aria-label="Run details">
          <Feedback run={r} />
          <Delegation run={r} />
          <Meters run={r} held={held} />
          {tree.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Subagents</CardTitle>
              </CardHeader>
              <CardContent>
                <Tree nodes={tree} />
              </CardContent>
            </Card>
          ) : null}
          <RunMemory run={r} />
          <Link to="/runs" className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
            <ChevronLeft className="size-3" aria-hidden /> All runs
          </Link>
        </aside>
      </div>
    </div>
  );
}
