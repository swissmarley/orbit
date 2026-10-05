/** @jsxRuntime automatic @jsxImportSource react */
import {
  TERMINAL_RUN_STATUSES,
  type RunEvent,
  type RunState,
  formatDuration,
  formatFull,
  formatLocalTime,
  formatTokens,
  replayRun,
  scrubControls,
} from '@orbit/core/browser';
import { Link, useParams } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Square,
  StepBack,
  StepForward,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { confirmAction } from '../components/confirm';
import { Meter } from '../components/sparkline';
import { ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { StatusBadge, Time } from '../components/status';
import { Timeline } from '../components/timeline';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Kbd } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { useBot, usePendingApprovals, useRun, useRunEvents } from '../lib/queries';
import { type SubagentNode, buildTimeline, subagentTree } from '../lib/timeline';

function Controls({ run }: { run: RunState }) {
  const actions = useActions();
  const bot = useBot(run.botId);
  const live = !TERMINAL_RUN_STATUSES.includes(run.status);
  const resumable =
    (run.status === 'waiting_approval' && run.pendingApprovals.length === 0) ||
    run.status === 'rate_limited';
  const paused = (bot.data?.pausedAt ?? null) !== null;
  return (
    <>
      {resumable ? (
        <Button
          variant="primary"
          onClick={() => void actions.resumeRun(run.runId).catch(() => undefined)}
        >
          <Play aria-hidden /> Resume run
        </Button>
      ) : null}
      {bot.data ? (
        <Button
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
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />}{' '}
          {paused ? 'Resume Bot' : 'Pause Bot'}
        </Button>
      ) : null}
      {live ? (
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
      ) : bot.data ? (
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
      ) : null}
    </>
  );
}

function Meters({ run }: { run: RunState }) {
  const bot = useBot(run.botId);
  const b = bot.data?.spec.budgets;
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
          label="Tokens"
          value={tokens}
          max={b?.maxTokensPerRun ?? null}
          format={formatTokens}
        />
        <Meter
          label="Tool calls"
          value={run.counts.toolCalls}
          max={b?.maxToolCallsPerRun ?? null}
        />
        <Meter
          label="Cost (engine estimate)"
          value={run.totals.costUsd}
          max={b?.maxCostUsdPerRun ?? null}
          format={(n) => `$${n.toFixed(3)}`}
        />
        <Meter
          label="Active time"
          value={run.totals.activeMs}
          max={b ? b.maxWallClockMinutes * 60_000 : null}
          format={formatDuration}
        />
        <p className="text-xs text-fg-muted">
          {run.totals.turns} turns · {run.counts.messages} messages · {run.counts.denied} denied ·{' '}
          {run.counts.subagents} subagents
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
        {current ? ` · ${formatLocalTime(current.ts)}` : ''}
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
  const [pos, setPos] = useState<number | null>(null);
  const all = events.data ?? [];
  const shown = pos === null ? all : all.slice(0, pos);
  const items = useMemo(() => buildTimeline(shown), [shown]);
  const tree = useMemo(() => subagentTree(shown), [shown]);
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
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to="/bots/$botId"
              params={{ botId: r.botId }}
              className="text-accent hover:underline"
            >
              {bot.data ? scrubControls(bot.data.spec.name) : r.botId}
            </Link>
            <span>· {r.trigger?.kind ?? 'manual'}</span>
            <span>
              · queued <Time iso={r.createdAt} />
            </span>
            {r.endedAt ? (
              <span>
                · ended <Time iso={r.endedAt} />
              </span>
            ) : null}
            <span className="font-mono text-xs">{r.runId}</span>
          </span>
        }
        actions={<Controls run={r} />}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={state.status} />
          {replayed ? <Badge tone="info">replaying — not live</Badge> : null}
          {r.model ? <Badge>{r.model}</Badge> : null}
          {r.driver ? (
            <Badge>
              {r.driver} · {r.authMethod}
            </Badge>
          ) : null}
          {r.resumeAt ? <Badge tone="info">⏰ resumes {formatLocalTime(r.resumeAt)}</Badge> : null}
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
      {r.usageLimit ? (
        <div
          role="status"
          className="rounded-lg border border-warning/40 bg-warning-bg px-4 py-2 text-sm text-warning"
        >
          <span aria-hidden>⧗</span> {scrubControls(r.usageLimit.message)} Paused, not failed
          {r.usageLimit.resetsAt ? ` — resets ${formatLocalTime(r.usageLimit.resetsAt)}` : ''}.
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-2">
          <Scrubber events={all} pos={pos} setPos={setPos} />
          {events.isPending ? (
            <ListSkeleton rows={6} />
          ) : events.isError ? (
            <ErrorState error={events.error} retry={() => void events.refetch()} />
          ) : (
            <Timeline items={items} className="h-[62vh] min-h-80" />
          )}
        </div>
        <aside className="flex flex-col gap-4" aria-label="Run details">
          <Meters run={r} />
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
          <Link to="/runs" className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
            <ChevronLeft className="size-3" aria-hidden /> All runs
          </Link>
        </aside>
      </div>
    </div>
  );
}
