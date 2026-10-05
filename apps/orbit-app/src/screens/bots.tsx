/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, type RunState, formatTokens, scrubControls } from '@orbit/core/browser';
import { Link } from '@tanstack/react-router';
import { Bot as BotIcon, LayoutGrid, List, Pause, Play, Plus } from 'lucide-react';
import { useState } from 'react';
import { confirmAction } from '../components/confirm';
import { IfRole, RoleGate } from '../components/role-gate';
import { TakeOverButton } from '../components/takeover';
import { RunSparkline } from '../components/sparkline';
import { EmptyState, ErrorState, PageHeader } from '../components/states';
import { PausedBadge, StatusBadge, Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Skeleton } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { cn } from '../lib/cn';
import { useBots, usePendingApprovals, useRuns, useSchedules } from '../lib/queries';

type View = 'grid' | 'list';
const VIEW_KEY = 'orbit.bots.view';

function initialView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function BotActions({ bot, compact = false }: { bot: Bot; compact?: boolean }) {
  const actions = useActions();
  const name = scrubControls(bot.spec.name);
  const paused = bot.pausedAt !== null;
  return (
    <div className="flex items-center gap-1.5">
      <RoleGate route="startRun">
        <Button
          size={compact ? 'sm' : 'md'}
          variant="secondary"
          disabled={paused}
          title={paused ? 'Resume the Bot to run it' : undefined}
          aria-label={`Run ${name} now`}
          onClick={() => void actions.runBot(bot).catch(() => undefined)}
        >
          <Play aria-hidden /> Run
        </Button>
      </RoleGate>
      <RoleGate route={paused ? 'resumeBot' : 'pauseBot'}>
        <Button
          size={compact ? 'sm' : 'md'}
          variant="ghost"
          aria-label={paused ? `Resume ${name}` : `Pause ${name}`}
          onClick={() =>
            void (async () => {
              if (!paused) {
                const ok = await confirmAction({
                  title: `Pause ${name}?`,
                  body: 'Its Runs stop now and nothing new starts until you resume it.',
                  confirm: 'Pause',
                  danger: true,
                });
                if (!ok) return;
              }
              await actions.setBotPaused(bot, !paused);
            })().catch(() => undefined)
          }
        >
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />} {paused ? 'Resume' : 'Pause'}
        </Button>
      </RoleGate>
      {compact ? null : <TakeOverButton bot={bot} />}
    </div>
  );
}

interface Row {
  bot: Bot;
  runs: RunState[];
  pending: number;
  nextAt: string | null;
}

function usage(runs: RunState[]): string {
  const tokens = runs.reduce((n, r) => n + r.totals.tokens, 0);
  const cost = runs.reduce((n, r) => n + r.totals.costUsd, 0);
  if (tokens === 0 && cost === 0) return '';
  return `${formatTokens(tokens)} tokens${cost > 0 ? ` · ~$${cost.toFixed(2)}` : ''}`;
}

function BotStatus({ row }: { row: Row }) {
  const latest = row.runs[0];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.bot.pausedAt ? (
        <PausedBadge />
      ) : latest?.status === 'waiting_approval' && row.pending > 0 ? (
        // One badge, not two saying the same thing.
        <Badge
          tone="attention"
          title={`${row.pending} approval${row.pending === 1 ? '' : 's'} waiting`}
        >
          <span aria-hidden>◆</span>
          needs you · {row.pending}
        </Badge>
      ) : latest ? (
        <StatusBadge status={latest.status} />
      ) : (
        <Badge>new</Badge>
      )}
      {row.pending > 0 && latest?.status !== 'waiting_approval' ? (
        <Badge
          tone="attention"
          title={`${row.pending} approval${row.pending === 1 ? '' : 's'} waiting`}
        >
          <span aria-hidden>⚑</span>
          {row.pending} waiting
        </Badge>
      ) : null}
    </div>
  );
}

function BotCard({ row }: { row: Row }) {
  const { bot } = row;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="bot-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-[8rem] flex-1 text-sm font-semibold">
          <Link
            to="/bots/$botId"
            params={{ botId: bot.id }}
            className="block truncate text-fg hover:text-accent"
          >
            {scrubControls(bot.spec.name)}
          </Link>
        </h2>
        <BotStatus row={row} />
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-fg-muted">{scrubControls(bot.spec.goal)}</p>
      <div className="flex items-end justify-between gap-3">
        <RunSparkline runs={row.runs} className="h-8" />
        <div className="text-right text-xs text-fg-subtle">
          <p>{usage(row.runs)}</p>
          <p>
            {row.nextAt ? (
              <>
                next <Time iso={row.nextAt} />
              </>
            ) : (
              'trigger: manual'
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-fg-subtle">
          {row.runs[0] ? (
            <>
              last run <Time iso={row.runs[0].createdAt} mode="relative" />
            </>
          ) : (
            'never run'
          )}
        </span>
        <BotActions bot={bot} compact />
      </div>
    </Card>
  );
}

export function BotsScreen() {
  const bots = useBots();
  const runs = useRuns();
  const approvals = usePendingApprovals();
  const schedules = useSchedules();
  const [view, setView] = useState<View>(initialView);
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  };
  const rows: Row[] = (bots.data ?? []).map((bot) => ({
    bot,
    runs: (runs.data ?? []).filter((r) => r.botId === bot.id),
    pending: (approvals.data ?? []).filter((a) => a.botId === bot.id).length,
    nextAt:
      (schedules.data ?? [])
        .flatMap((s) => (s.botId === bot.id && s.enabled && s.nextAt ? [s.nextAt] : []))
        .sort()[0] ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="Bots"
        description="Always-on agents, each with a goal, its own workspace and its own limits."
        actions={
          <>
            <div
              role="group"
              aria-label="Layout"
              className="flex rounded-md border border-border p-0.5"
            >
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={view === 'grid'}
                className={cn(view === 'grid' && 'bg-surface-2 text-fg')}
                onClick={() => choose('grid')}
              >
                <LayoutGrid aria-hidden /> Grid
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={view === 'list'}
                className={cn(view === 'list' && 'bg-surface-2 text-fg')}
                onClick={() => choose('list')}
              >
                <List aria-hidden /> List
              </Button>
            </div>
            <IfRole route="createBot">
              <Button variant="primary" asChild>
                <Link to="/bots/new">
                  <Plus aria-hidden /> New Bot
                </Link>
              </Button>
            </IfRole>
          </>
        }
      />
      {bots.isPending ? (
        <div
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : bots.isError ? (
        <ErrorState error={bots.error} retry={() => void bots.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BotIcon aria-hidden />}
          title="No Bots yet"
          action={
            <Button variant="primary" asChild>
              <Link to="/bots/new">
                <Plus aria-hidden /> Create your first Bot
              </Link>
            </Button>
          }
        >
          Give a Bot a goal; Orbit suggests the tools, schedule and limits.
        </EmptyState>
      ) : view === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <BotCard key={row.bot.id} row={row} />
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto" tabIndex={0} role="region" aria-label="Bots table">
          <table className="w-full text-sm">
            <caption className="sr-only">Bots</caption>
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Bot
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Recent runs
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Usage
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Next run
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bot.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <Link
                      to="/bots/$botId"
                      params={{ botId: row.bot.id }}
                      className="font-medium text-fg hover:text-accent"
                    >
                      {scrubControls(row.bot.spec.name)}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <BotStatus row={row} />
                  </td>
                  <td className="px-4 py-2">
                    <RunSparkline runs={row.runs} className="h-6" />
                  </td>
                  <td className="px-4 py-2 text-xs text-fg-muted">{usage(row.runs) || '—'}</td>
                  <td className="px-4 py-2 text-xs text-fg-muted">
                    {row.nextAt ? <Time iso={row.nextAt} /> : 'manual'}
                  </td>
                  <td className="px-4 py-2">
                    <BotActions bot={row.bot} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
