/** @jsxRuntime automatic @jsxImportSource react */
import { formatLocalTime } from '@orbit/core/browser';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Command as CommandIcon,
  Inbox,
  LayoutGrid,
  ListTree,
  Moon,
  Octagon,
  Settings,
  Sun,
  SunMoon,
} from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useActions } from '../lib/actions';
import { authStore, isUnauthorized, useClient } from '../lib/api';
import { cn } from '../lib/cn';
import { type Connection, connectionStore, startLiveFeed } from '../lib/live';
import { useDoctor, useKill, usePendingApprovals, useQueue, useSession } from '../lib/queries';
import { useStore } from '../lib/store';
import { type ThemeChoice, setTheme, themeStore } from '../lib/theme';
import { ConfirmHost, confirmAction } from './confirm';
import { CommandPalette, paletteStore } from './palette';
import { ListSkeleton } from './states';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Kbd } from './ui/misc';
import { Tooltip } from './ui/tooltip';
import { SignedOut } from '../screens/sign-in';

const CONNECTION: Record<
  Connection,
  {
    mark: string;
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
    meaning: string;
  }
> = {
  connecting: { mark: '○', label: 'connecting', tone: 'neutral', meaning: 'Connecting to orbitd…' },
  live: { mark: '●', label: 'live', tone: 'success', meaning: 'Live updates from orbitd' },
  reconnecting: {
    mark: '◌',
    label: 'reconnecting',
    tone: 'warning',
    meaning: 'Lost the live feed; reconnecting and catching up',
  },
  offline: {
    mark: '✕',
    label: 'offline',
    tone: 'danger',
    meaning: 'orbitd is not answering; retrying',
  },
};

/** Driver and auth method, always visible (never hidden behind a menu). */
function DriverBadge() {
  const doctor = useDoctor();
  if (!doctor.data) return <Badge tone="neutral">…</Badge>;
  const d = doctor.data;
  const tone = d.refusal
    ? 'danger'
    : d.driver === 'mock'
      ? 'attention'
      : d.authMethod === 'subscription'
        ? 'info'
        : 'neutral';
  const text =
    d.driver === 'mock' ? 'Demo mode · mock driver' : `${d.driver ?? 'no driver'} · ${d.authLabel}`;
  return (
    <Tooltip
      content={
        d.refusal
          ? d.refusal.message
          : `Driver ${d.driver ?? 'none'} (${d.driverSource}); auth: ${d.authLabel}; models ${d.models.default} / ${d.models.triage}`
      }
    >
      <Link to="/settings" search={{ tab: 'engine' }} className="rounded-full">
        <Badge tone={tone} data-testid="driver-badge">
          <span aria-hidden>{d.refusal ? '✘' : '◇'}</span>
          {text}
        </Badge>
      </Link>
    </Tooltip>
  );
}

function StatusChips() {
  const conn = useStore(connectionStore);
  const queue = useQueue();
  const c = CONNECTION[conn];
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Orbit status">
      <Tooltip content={c.meaning}>
        <span role="status" aria-label={`Connection: ${c.label}`}>
          <Badge tone={c.tone}>
            <span aria-hidden>{c.mark}</span>
            {c.label}
          </Badge>
        </span>
      </Tooltip>
      {queue.data?.pausedUntil ? (
        <Badge tone="warning" title="A usage limit holds every new start until it resets">
          <span aria-hidden>⧗</span> usage limit until {formatLocalTime(queue.data.pausedUntil)}
        </Badge>
      ) : null}
      {queue.data ? (
        <Badge
          tone="neutral"
          className="hidden sm:inline-flex"
          title="Runs executing / concurrency limit; queued"
        >
          {queue.data.active.length}/{queue.data.limit} running
          {queue.data.queued.length > 0 ? ` · ${queue.data.queued.length} queued` : ''}
        </Badge>
      ) : null}
      <DriverBadge />
    </div>
  );
}

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

function ThemeToggle() {
  const theme = useStore(themeStore);
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon;
  return (
    <Tooltip
      content={`Theme: ${theme === 'system' ? 'follows the system' : theme} (click to change)`}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Theme: ${theme}. Change theme`}
        onClick={() => setTheme(THEME_NEXT[theme])}
      >
        <Icon aria-hidden />
      </Button>
    </Tooltip>
  );
}

function NavLink({
  to,
  icon,
  children,
  count,
}: {
  to: '/inbox' | '/bots' | '/runs' | '/settings';
  icon: ReactNode;
  children: ReactNode;
  count?: number;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg [&_svg]:size-4"
      activeProps={{ className: 'bg-surface-2 !text-fg font-medium', 'aria-current': 'page' }}
    >
      {icon}
      <span>{children}</span>
      {count !== undefined && count > 0 ? (
        <Badge tone="attention" className="ml-auto" aria-label={`${count} waiting`}>
          {count}
        </Badge>
      ) : null}
    </Link>
  );
}

function KillBanner() {
  const kill = useKill();
  const actions = useActions();
  if (!kill.data?.engaged) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-3 bg-danger px-4 py-1.5 text-sm font-medium text-on-solid"
    >
      <Octagon className="size-4" aria-hidden /> Global kill switch engaged
      {kill.data.by ? ` by ${kill.data.by}` : ''} — no Bot runs until you release it.
      <Button
        size="sm"
        className="border-on-solid/40 bg-transparent text-on-solid hover:bg-black/10"
        onClick={() =>
          void confirmAction({
            title: 'Release the kill switch?',
            body: 'Bots may run again.',
            confirm: 'Release',
          }).then((ok) => (ok ? actions.setKill(false) : undefined))
        }
      >
        Release
      </Button>
    </div>
  );
}

/** The signed-in frame: header (status, driver/auth), nav, live feed, palette. */
export function AppShell() {
  const client = useClient();
  const qc = useQueryClient();
  const session = useSession();
  const auth = useStore(authStore);
  const approvals = usePendingApprovals();
  const path = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (session.isSuccess) authStore.set('signed-in');
    if (session.isError && isUnauthorized(session.error)) authStore.set('signed-out');
  }, [session.isSuccess, session.isError, session.error]);

  useEffect(() => {
    if (auth !== 'signed-in') return;
    const ctl = new AbortController();
    startLiveFeed(client, qc, { signal: ctl.signal });
    return () => ctl.abort();
  }, [auth, client, qc]);

  if (auth === 'signed-out') return <SignedOut />;
  if (auth === 'unknown') {
    return (
      <div className="mx-auto max-w-3xl p-8">
        {session.isError ? <SignedOut error={session.error} /> : <ListSkeleton rows={5} />}
      </div>
    );
  }

  const pending = approvals.data?.length ?? 0;
  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <KillBanner />
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
        <Link
          to="/inbox"
          className="flex items-center gap-2 font-semibold text-fg"
          aria-label="Orbit home"
        >
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
            <circle cx="16" cy="16" r="5" fill="var(--accent)" />
            <ellipse
              cx="16"
              cy="16"
              rx="13"
              ry="6"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.5"
              transform="rotate(-25 16 16)"
            />
          </svg>
          <span className="hidden sm:inline">Orbit</span>
        </Link>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <StatusChips />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => paletteStore.set(true)}
          aria-label="Open the command palette"
          className="hidden text-fg-muted sm:inline-flex"
        >
          <CommandIcon aria-hidden /> Search <Kbd>⌘K</Kbd>
        </Button>
        <ThemeToggle />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Main"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2 md:w-52 md:flex-col md:border-r md:border-b-0 md:px-3 md:py-4"
        >
          <NavLink to="/inbox" icon={<Inbox aria-hidden />} count={pending}>
            Inbox
          </NavLink>
          <NavLink to="/bots" icon={<LayoutGrid aria-hidden />}>
            Bots
          </NavLink>
          <NavLink to="/runs" icon={<ListTree aria-hidden />}>
            Runs
          </NavLink>
          <NavLink to="/settings" icon={<Settings aria-hidden />}>
            Settings
          </NavLink>
        </nav>
        <main
          id="main"
          tabIndex={-1}
          className={cn(
            'min-w-0 flex-1 px-4 py-5 sm:px-6 focus:outline-none',
            path.startsWith('/runs/') ? 'max-w-none' : 'max-w-6xl',
          )}
        >
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <ConfirmHost />
    </div>
  );
}
