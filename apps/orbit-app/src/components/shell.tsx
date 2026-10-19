/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, formatLocalTime, formatRelative, scrubControls } from '@orbit/core/browser';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Brain,
  Inbox,
  Keyboard,
  ListTree,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  MoreHorizontal,
  Octagon,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  Sun,
  SunMoon,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { useActions } from '../lib/actions';
import { authStore, isUnauthorized, useClient } from '../lib/api';
import type { AvatarState } from '../lib/avatar';
import { cn } from '../lib/cn';
import { conversationsOf } from '../lib/conversation';
import { type Connection, connectionStore, startLiveFeed } from '../lib/live';
import { otherModalOpen } from '../lib/modal';
import { MOD } from '../lib/platform';
import {
  useBot,
  useBots,
  useDoctor,
  useHealth,
  useKill,
  usePendingApprovals,
  useQueue,
  useRuns,
  useSession,
} from '../lib/queries';
import { useStore } from '../lib/store';
import { type ThemeChoice, setTheme, themeStore } from '../lib/theme';
import { computerOpenStore, drawerStore, lastBotStore, sidebarCollapsedStore } from '../lib/ui';
import { BotAvatar } from './avatar';
import { ComputerPanel } from './computer-panel';
import { ConfirmHost, confirmAction } from './confirm';
import { KeyboardHelp, helpStore } from './keyboard-help';
import { CommandPalette, paletteStore } from './palette';
import { RoleGate } from './role-gate';
import { ListSkeleton } from './states';
import { TakeOverHost } from './takeover';
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

const AUTH_SHORT: Record<string, string> = {
  subscription: 'subscription',
  api_key: 'API key',
  api_key_helper: 'API key helper',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
  claude_cli_other: 'CLI login',
  mock: 'mock',
  none: 'not signed in',
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
  // Short in the header (it must never scroll away); the full label is in the tooltip.
  const text =
    d.driver === 'mock'
      ? 'Demo · mock driver'
      : `${d.driver ?? 'no driver'} · ${AUTH_SHORT[d.authMethod] ?? d.authMethod}`;

  return (
    <Tooltip
      content={
        d.refusal
          ? d.refusal.message
          : `Driver ${d.driver ?? 'none'} (${d.driverSource}); auth: ${d.authLabel}; models ${d.models.default} / ${d.models.triage}`
      }
    >
      <Link to="/settings" search={{ tab: 'engine' }} className="rounded-full">
        <Badge tone={tone} data-testid="driver-badge" className="uppercase tracking-wide">
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
    <div className="flex min-w-0 items-center gap-1.5" aria-label="Orbit status">
      <Tooltip content={c.meaning}>
        <span role="status" aria-label={`Connection: ${c.label}`}>
          <Badge tone={c.tone}>
            <span aria-hidden>{c.mark}</span>
            <span className="hidden sm:inline">{c.label}</span>
          </Badge>
        </span>
      </Tooltip>
      {queue.data?.pausedUntil ? (
        <Badge tone="warning" title="A usage limit holds every new start until it resets">
          <span aria-hidden>⧗</span> usage limit until {formatLocalTime(queue.data.pausedUntil)}
        </Badge>
      ) : null}
      {queue.data && queue.data.active.length > 0 ? (
        <Badge
          tone="neutral"
          className="hidden xl:inline-flex"
          title="Runs executing / concurrency limit; queued"
        >
          {queue.data.active.length}/{queue.data.limit} running
          {queue.data.queued.length > 0 ? ` · ${queue.data.queued.length} queued` : ''}
        </Badge>
      ) : null}
      <span className="hidden md:inline-flex">
        <DriverBadge />
      </span>
    </div>
  );
}

/** Hosted mode (ADR-015): who is signed in, with what role, and the way out. */
function SignedInAs() {
  const session = useSession();
  const health = useHealth();
  const actions = useActions();
  const p = session.data?.principal;
  if (health.data?.signIn !== 'oidc' || !p) return null;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        className="max-w-[12ch] truncate text-xs text-fg-muted"
        data-testid="signed-in-as"
        title={`${p.name} · ${p.role}`}
      >
        {p.name} <span className="text-fg-subtle">· {p.role}</span>
      </span>
      <Tooltip content={`Signed in as ${p.name} (${p.role}). Sign out`}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Sign out ${p.name}`}
          onClick={() => void actions.signOut()}
        >
          <LogOut aria-hidden />
        </Button>
      </Tooltip>
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
      <RoleGate route="setKill">
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
      </RoleGate>
    </div>
  );
}

/** The Bot a chat route is about (null elsewhere). */
function useChatBotId(): string | null {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const m = /^\/chat\/([^/]+)/.exec(path);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

// ── sidebar ─────────────────────────────────────────────────────────────

function Wordmark() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2 rounded-md px-2 text-[19px] font-bold tracking-tight text-fg"
      aria-label="Orbit home"
    >
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <circle cx="16" cy="16" r="5" fill="var(--brand)" />
        <ellipse
          cx="16"
          cy="16"
          rx="13"
          ry="6"
          fill="none"
          stroke="var(--brand)"
          strokeWidth="2.5"
          transform="rotate(-25 16 16)"
        />
        <circle cx="27" cy="10.5" r="2.4" fill="var(--accent)" />
      </svg>
      Orbit
    </Link>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-5 mb-1 flex items-center justify-between px-2">
      <h2 className="text-[11px] font-semibold tracking-[0.14em] text-fg-subtle uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** A Bot in the sidebar: its face (working, needs you, paused), name, and its settings. */
function BotRow({
  bot,
  active,
  pending,
  working,
}: {
  bot: Bot;
  active: boolean;
  pending: number;
  working: boolean;
}) {
  const name = scrubControls(bot.spec.name);
  const state: AvatarState = bot.pausedAt
    ? 'paused'
    : pending > 0
      ? 'attention'
      : working
        ? 'working'
        : 'idle';
  return (
    <li
      className={cn(
        'group flex items-center rounded-lg transition-colors',
        active ? 'bg-accent-subtle' : 'hover:bg-surface-2',
      )}
    >
      <Link
        to="/chat/$botId"
        params={{ botId: bot.id }}
        onClick={() => drawerStore.set(false)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fg"
        {...(active ? { 'aria-current': 'page' as const } : {})}
        data-testid="sidebar-bot"
      >
        <BotAvatar bot={bot} size={26} decorative state={state} />
        <span className={cn('min-w-0 flex-1 truncate', active && 'font-medium')}>{name}</span>
        {pending > 0 ? (
          <Badge tone="attention" aria-label={`${pending} waiting for you`}>
            {pending}
          </Badge>
        ) : working ? (
          <span className="text-xs text-info">
            <span
              aria-hidden
              className="inline-block size-1.5 animate-pulse rounded-full bg-info"
            />
            <span className="sr-only">working</span>
          </span>
        ) : bot.pausedAt ? (
          <span className="text-xs text-warning">
            <span aria-hidden>⏸&#xFE0E;</span>
            <span className="sr-only">paused</span>
          </span>
        ) : null}
      </Link>
      <Tooltip content={`${name}'s settings`}>
        <Link
          to="/bots/$botId"
          params={{ botId: bot.id }}
          onClick={() => drawerStore.set(false)}
          aria-label={`${name}'s settings`}
          className="mr-1 rounded-md p-1 text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Link>
      </Tooltip>
    </li>
  );
}

/** The selected Bot's conversations, latest first. */
function Conversations({ bot }: { bot: Bot }) {
  const runs = useRuns({ bot: bot.id, limit: 300 });
  const path = useRouterState({ select: (s) => s.location });
  const current = (path.search as { c?: string }).c;
  const list = conversationsOf(runs.data ?? []).slice(0, 40);
  const name = scrubControls(bot.spec.name);
  return (
    <>
      <SectionTitle
        action={
          <Tooltip content={`New conversation with ${name}`}>
            <Link
              to="/chat/$botId"
              params={{ botId: bot.id }}
              onClick={() => drawerStore.set(false)}
              aria-label={`New conversation with ${name}`}
              className="rounded-md p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <Plus className="size-3.5" aria-hidden />
            </Link>
          </Tooltip>
        }
      >
        Conversations
      </SectionTitle>
      {runs.isPending ? (
        <ListSkeleton rows={2} className="px-2" />
      ) : list.length === 0 ? (
        <p className="px-2 py-1 text-xs text-fg-subtle">Your first conversation will live here.</p>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label={`Conversations with ${name}`}>
          {list.map((c) => {
            const active = current === c.id;
            const busy = ['queued', 'running', 'delegating'].includes(c.latest.status);
            const waiting = c.latest.status === 'waiting_approval';
            return (
              <li key={c.id}>
                <Link
                  to="/chat/$botId"
                  params={{ botId: bot.id }}
                  search={{ c: c.id }}
                  onClick={() => drawerStore.set(false)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
                    active
                      ? 'bg-accent-subtle text-fg'
                      : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                  )}
                  {...(active ? { 'aria-current': 'page' as const } : {})}
                >
                  <MessageCircle className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {waiting ? (
                    <span className="shrink-0 text-xs text-attention" title="Waiting for you">
                      <span aria-hidden>◆</span>
                      <span className="sr-only">waiting for you</span>
                    </span>
                  ) : busy ? (
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
                    />
                  ) : (
                    <span className="shrink-0 text-[11px] text-fg-subtle tabular-nums">
                      {formatRelative(c.at)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function NavRow({
  to,
  icon,
  children,
  count,
}: {
  to: '/inbox' | '/runs' | '/memory' | '/settings';
  icon: ReactNode;
  children: ReactNode;
  count?: number;
}) {
  return (
    <Link
      to={to}
      onClick={() => drawerStore.set(false)}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg [&_svg]:size-4"
      activeProps={{ className: 'bg-accent-subtle !text-fg font-medium', 'aria-current': 'page' }}
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

function SidebarContent() {
  const bots = useBots();
  const runs = useRuns();
  const approvals = usePendingApprovals();
  const health = useHealth();
  const navigate = useNavigate();
  const chatBot = useChatBotId();
  const lastBot = useStore(lastBotStore);
  const currentId = chatBot ?? lastBot;
  const current = bots.data?.find((b) => b.id === currentId) ?? bots.data?.[0];
  const pendingFor = (id: string) => approvals.data?.filter((a) => a.botId === id).length ?? 0;
  const workingFor = (id: string) =>
    runs.data?.some(
      (r) => r.botId === id && ['queued', 'running', 'delegating'].includes(r.status),
    ) ?? false;
  const pending = approvals.data?.length ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-5 pb-3">
      <Wordmark />
      <p className="mt-1 px-2 text-[10px] font-medium tracking-[0.18em] text-fg-subtle uppercase">
        Always-on Bots
      </p>
      <div className="mt-5 flex flex-col gap-1">
        <Button
          variant="secondary"
          className="h-9 justify-start rounded-lg border-border bg-surface px-3 text-fg shadow-sm"
          onClick={() => {
            drawerStore.set(false);
            void (current
              ? navigate({ to: '/chat/$botId', params: { botId: current.id } })
              : navigate({ to: '/bots/new' }));
          }}
        >
          <Plus aria-hidden /> New chat
        </Button>
        <button
          type="button"
          onClick={() => paletteStore.set(true)}
          className="flex h-8 items-center gap-2 rounded-lg px-3 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
          aria-label="Search and commands"
        >
          <Search className="size-4" aria-hidden /> Search
          <Kbd className="ml-auto">{MOD}K</Kbd>
        </button>
      </div>
      <nav aria-label="Main" className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SectionTitle
          action={
            <RoleGate route="createBot">
              <Link
                to="/bots/new"
                onClick={() => drawerStore.set(false)}
                aria-label="New Bot"
                className="rounded-md p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <Plus className="size-3.5" aria-hidden />
              </Link>
            </RoleGate>
          }
        >
          <Link to="/bots" onClick={() => drawerStore.set(false)} className="hover:text-fg">
            Bots
          </Link>
        </SectionTitle>
        {bots.isPending ? (
          <ListSkeleton rows={2} className="px-2" />
        ) : (bots.data ?? []).length === 0 ? (
          <p className="px-2 py-1 text-xs text-fg-subtle">
            No Bots yet.{' '}
            <Link to="/bots/new" className="text-accent hover:underline">
              Create one
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Bots">
            {(bots.data ?? []).map((b) => (
              <BotRow
                key={b.id}
                bot={b}
                active={chatBot === b.id}
                pending={pendingFor(b.id)}
                working={workingFor(b.id)}
              />
            ))}
          </ul>
        )}
        {current ? <Conversations bot={current} /> : null}
        <div className="mt-auto flex flex-col gap-0.5 pt-5">
          <NavRow to="/inbox" icon={<Inbox aria-hidden />} count={pending}>
            Inbox
          </NavRow>
          <NavRow to="/runs" icon={<ListTree aria-hidden />}>
            Activity
          </NavRow>
          <NavRow to="/memory" icon={<Brain aria-hidden />}>
            Memory
          </NavRow>
          <NavRow to="/settings" icon={<Settings2 aria-hidden />}>
            Settings
          </NavRow>
        </div>
      </nav>
      <div className="mt-2 flex items-center gap-0.5 border-t border-border pt-2">
        <ThemeToggle />
        <Tooltip content="Keyboard shortcuts (?)">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Keyboard shortcuts"
            onClick={() => helpStore.set(true)}
          >
            <Keyboard aria-hidden />
          </Button>
        </Tooltip>
        <SignedInAs />
        <span className="ml-auto pr-1 text-[10px] tracking-wide text-fg-subtle uppercase">
          {health.data ? `v${health.data.version}` : ''}
        </span>
      </div>
    </div>
  );
}

function Sidebar() {
  const collapsed = useStore(sidebarCollapsedStore);
  const drawer = useStore(drawerStore);
  return (
    <>
      {collapsed ? null : (
        <aside
          className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-sidebar lg:block"
          aria-label="Bots and conversations"
        >
          <SidebarContent />
        </aside>
      )}
      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            aria-hidden
            className="absolute inset-0 bg-black/30"
            onClick={() => drawerStore.set(false)}
          />
          <aside
            className="absolute inset-y-0 left-0 w-72 border-r border-border bg-sidebar shadow-card"
            aria-label="Bots and conversations"
          >
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-2"
              aria-label="Close the menu"
              onClick={() => drawerStore.set(false)}
            >
              <X aria-hidden />
            </Button>
            <SidebarContent />
          </aside>
        </div>
      ) : null}
    </>
  );
}

// ── top bar ─────────────────────────────────────────────────────────────

const SECTION: Record<string, string> = {
  inbox: 'Inbox',
  runs: 'Activity',
  memory: 'Memory',
  settings: 'Settings',
  bots: 'Bots',
  welcome: 'Welcome',
};

function Crumbs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const parts = path.split('/').filter(Boolean);
  const chatBot = parts[0] === 'chat' ? (parts[1] ?? '') : '';
  const botPage = parts[0] === 'bots' && parts[1] && parts[1] !== 'new' ? parts[1] : '';
  const bot = useBot(chatBot || botPage);
  const name = bot.data ? scrubControls(bot.data.spec.name) : '…';
  const crumbs: string[] =
    parts[0] === 'chat'
      ? ['Bots', name]
      : parts[0] === 'bots' && parts[1] === 'new'
        ? ['Bots', 'New Bot']
        : botPage
          ? ['Bots', name, 'Settings']
          : parts[0] === 'runs' && parts[1]
            ? ['Activity', 'Run']
            : ['Orbit', SECTION[parts[0] ?? ''] ?? 'Home'];
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
        {crumbs.map((c, i) => (
          <li key={`${c}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 ? <span aria-hidden>/</span> : null}
            <span
              className={cn('truncate', i === crumbs.length - 1 && 'font-medium text-fg')}
              {...(i === crumbs.length - 1 ? { 'aria-current': 'page' as const } : {})}
            >
              {c}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StopAll() {
  const kill = useKill();
  const actions = useActions();
  if (kill.data?.engaged) return null;
  return (
    <RoleGate
      route="setKill"
      hint="Kill switch: stop every Run now; nothing starts until you release it"
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label="Stop all Bots"
        onClick={() =>
          void confirmAction({
            title: 'Stop all Bots?',
            body: 'Every Run stops now and nothing new starts until you release the kill switch.',
            confirm: 'Stop everything',
            danger: true,
          }).then((ok) => (ok ? actions.setKill(true) : undefined))
        }
      >
        <Octagon aria-hidden /> <span className="hidden sm:inline">Stop all</span>
      </Button>
    </RoleGate>
  );
}

function TopBar({ chatBot }: { chatBot: string | null }) {
  const collapsed = useStore(sidebarCollapsedStore);
  const open = useStore(computerOpenStore);
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-bg/90 px-3 backdrop-blur sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open the menu"
        onClick={() => drawerStore.set(true)}
      >
        <Menu aria-hidden />
      </Button>
      <Tooltip content={collapsed ? 'Show the sidebar' : 'Hide the sidebar'}>
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={collapsed ? 'Show the sidebar' : 'Hide the sidebar'}
          aria-pressed={!collapsed}
          onClick={() => sidebarCollapsedStore.set(!collapsed)}
        >
          <PanelLeft aria-hidden />
        </Button>
      </Tooltip>
      <Crumbs />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <StatusChips />
        <StopAll />
        {chatBot ? (
          <Tooltip content={open ? 'Hide the computer' : 'Show the computer'}>
            <Button
              variant={open ? 'secondary' : 'ghost'}
              size="icon"
              aria-label={open ? 'Hide the computer' : 'Show the computer'}
              aria-expanded={open}
              aria-controls="computer-dock"
              onClick={() => computerOpenStore.set(!open)}
            >
              <Monitor aria-hidden />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}

/** The Bot's computer beside its chat; over it on narrow screens (ADR-020). */
function ComputerDock({ botId }: { botId: string }) {
  const open = useStore(computerOpenStore);
  const bot = useBot(botId);
  if (!open || !bot.data) return null;
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-30 bg-black/30 xl:hidden"
        onClick={() => computerOpenStore.set(false)}
      />
      <div
        id="computer-dock"
        className="fixed inset-y-0 right-0 z-40 w-full max-w-md border-l border-border shadow-card xl:sticky xl:top-14 xl:z-auto xl:h-[calc(100dvh-3.5rem)] xl:w-[440px] xl:max-w-none xl:shadow-none"
      >
        <ComputerPanel bot={bot.data} />
      </div>
    </>
  );
}

/** The signed-in frame: sidebar (Bots, conversations), top bar, the page, the Bot's computer. */
export function AppShell() {
  const client = useClient();
  const qc = useQueryClient();
  const session = useSession();
  const auth = useStore(authStore);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const chatBot = useChatBotId();

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

  // Escape closes the drawer and, where it covers the page, the computer (narrow screens).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || otherModalOpen()) return;
      if (drawerStore.get()) drawerStore.set(false);
      else if (computerOpenStore.get() && !window.matchMedia('(min-width: 1280px)').matches) {
        computerOpenStore.set(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (auth === 'signed-out') return <SignedOut />;
  if (auth === 'unknown') {
    return (
      <div className="mx-auto max-w-3xl p-8">
        {session.isError ? <SignedOut error={session.error} /> : <ListSkeleton rows={5} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <KillBanner />
        <TopBar chatBot={chatBot} />
        <div className="flex min-w-0 flex-1">
          <main
            id="main"
            tabIndex={-1}
            className={cn('min-w-0 flex-1 focus:outline-none', chatBot ? '' : 'px-4 py-6 sm:px-8')}
          >
            {chatBot ? (
              <Outlet />
            ) : (
              <div
                className={cn('mx-auto', path.startsWith('/runs/') ? 'max-w-none' : 'max-w-6xl')}
              >
                <Outlet />
              </div>
            )}
          </main>
          {chatBot ? <ComputerDock botId={chatBot} /> : null}
        </div>
      </div>
      <CommandPalette />
      <KeyboardHelp />
      <TakeOverHost />
      <ConfirmHost />
    </div>
  );
}
