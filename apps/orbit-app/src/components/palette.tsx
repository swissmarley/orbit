/** @jsxRuntime automatic @jsxImportSource react */
import { RUN_STATUS, scrubControls } from '@orbit/core/browser';
import { useNavigate } from '@tanstack/react-router';
import { Command, useCommandState } from 'cmdk';
import {
  Bot as BotIcon,
  Brain,
  Inbox,
  LayoutGrid,
  ListTree,
  LogOut,
  Moon,
  Octagon,
  Play,
  Plus,
  Settings,
  Sun,
  SunMoon,
} from 'lucide-react';
import { useEffect } from 'react';
import { useActions } from '../lib/actions';
import { useBots, useKill, usePendingApprovals, useRuns } from '../lib/queries';
import { otherModalOpen } from '../lib/modal';
import { createStore, useStore } from '../lib/store';
import { setTheme } from '../lib/theme';
import { confirmAction } from './confirm';

export const paletteStore = createStore(false);

/** Every Settings tab, findable from the palette (M5 UI review). */
export const SETTINGS_ENTRIES: readonly { tab: string; label: string; keywords: string }[] = [
  { tab: 'general', label: 'General', keywords: 'theme appearance kill switch' },
  { tab: 'engine', label: 'Auth & engine', keywords: 'doctor driver api key subscription model' },
  {
    tab: 'integrations',
    label: 'Integrations',
    keywords: 'plugins mcp github slack gmail calendar browser filesystem webhooks triggers',
  },
  { tab: 'policies', label: 'Policies', keywords: 'rules allow deny tiers' },
  { tab: 'budgets', label: 'Budgets', keywords: 'limits cost tokens triage usage' },
  { tab: 'secrets', label: 'Secrets', keywords: 'vault keys tokens' },
  { tab: 'audit', label: 'Audit log', keywords: 'audit verify export history' },
];

const item =
  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg aria-selected:bg-accent-subtle aria-selected:text-fg [&_svg]:size-4 [&_svg]:text-fg-muted';
const group =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-muted';

/** Settings tabs, listed once the user types (so they never push "Needs you" down). */
function SettingsGroup({ onSelect }: { onSelect: (tab: string) => void }) {
  const searching = useCommandState((s) => s.search.trim().length > 0);
  if (!searching) return null;
  return (
    <Command.Group heading="Settings" className={group}>
      {SETTINGS_ENTRIES.map((s) => (
        <Command.Item
          key={s.tab}
          value={`Settings ${s.label} ${s.keywords}`}
          keywords={['settings', ...s.keywords.split(' ')]}
          className={item}
          onSelect={() => onSelect(s.tab)}
        >
          <Settings aria-hidden /> Settings: {s.label}
        </Command.Item>
      ))}
    </Command.Group>
  );
}

/** Cmd/Ctrl+K: go anywhere, find any Bot, Run or approval, act on it. */
export function CommandPalette() {
  const open = useStore(paletteStore);
  const navigate = useNavigate();
  const actions = useActions();
  const bots = useBots();
  const runs = useRuns();
  const approvals = usePendingApprovals();
  const kill = useKill();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Never over another dialog (an approval card, a confirmation): close only.
        paletteStore.set((o) => (o ? false : !otherModalOpen()));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = (fn: () => unknown) => () => {
    paletteStore.set(false);
    void Promise.resolve(fn()).catch(() => undefined);
  };
  const botName = (id: string) =>
    scrubControls(bots.data?.find((b) => b.id === id)?.spec.name ?? id);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => paletteStore.set(o)}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/40"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-card"
    >
      <Command.Input
        placeholder="Search Bots, runs, approvals, actions…"
        className="h-11 w-full border-b border-border bg-transparent px-4 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        <Command.Empty className="px-2 py-6 text-center text-sm text-fg-muted">
          Nothing matches.
        </Command.Empty>
        <Command.Group heading="Go to" className={group}>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/inbox' }))}>
            <Inbox aria-hidden /> Inbox — needs you
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/bots' }))}>
            <LayoutGrid aria-hidden /> Bots
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/runs' }))}>
            <ListTree aria-hidden /> Runs
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/bots/new' }))}>
            <Plus aria-hidden /> New Bot
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/memory' }))}>
            <Brain aria-hidden /> Memory — what Bots remember
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => navigate({ to: '/settings' }))}>
            <Settings aria-hidden /> Settings
          </Command.Item>
        </Command.Group>
        <SettingsGroup
          onSelect={(tab) => run(() => navigate({ to: '/settings', search: { tab } }))()}
        />
        {approvals.data && approvals.data.length > 0 ? (
          <Command.Group heading="Needs you" className={group}>
            {approvals.data.map((a) => (
              <Command.Item
                key={a.id}
                value={`${a.card.what} ${a.card.botName} ${a.id}`}
                keywords={['approval', 'needs you']}
                className={item}
                onSelect={run(() => navigate({ to: '/inbox', search: { approval: a.id } }))}
              >
                <span aria-hidden className="text-attention">
                  ◆
                </span>{' '}
                {scrubControls(a.card.what)}{' '}
                <span className="ml-auto text-xs text-fg-subtle">
                  {scrubControls(a.card.botName)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {bots.data && bots.data.length > 0 ? (
          <Command.Group heading="Bots" className={group}>
            {bots.data.map((b) => (
              <Command.Item
                key={b.id}
                value={`${b.spec.name} ${b.id}`}
                keywords={['bot', 'open']}
                className={item}
                onSelect={run(() => navigate({ to: '/bots/$botId', params: { botId: b.id } }))}
              >
                <BotIcon aria-hidden /> {scrubControls(b.spec.name)}
              </Command.Item>
            ))}
            {bots.data.map((b) => (
              <Command.Item
                key={`run-${b.id}`}
                value={`Run ${b.spec.name} now`}
                keywords={['start']}
                className={item}
                disabled={b.pausedAt !== null}
                onSelect={run(() => actions.runBot(b))}
              >
                <Play aria-hidden /> Run {scrubControls(b.spec.name)} now
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {runs.data && runs.data.length > 0 ? (
          <Command.Group heading="Recent runs" className={group}>
            {runs.data.slice(0, 8).map((r) => (
              <Command.Item
                key={r.runId}
                value={`${botName(r.botId)} ${RUN_STATUS[r.status].label} ${r.runId}`}
                keywords={['run', r.status]}
                className={item}
                onSelect={run(() => navigate({ to: '/runs/$runId', params: { runId: r.runId } }))}
              >
                <span aria-hidden>{RUN_STATUS[r.status].mark}</span> {botName(r.botId)}{' '}
                <span className="text-fg-muted">· {RUN_STATUS[r.status].label}</span>
                <span className="ml-auto font-mono text-xs text-fg-subtle">
                  {r.runId.slice(-8)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        <Command.Group heading="Actions" className={group}>
          <Command.Item className={item} onSelect={run(() => setTheme('light'))}>
            <Sun aria-hidden /> Theme: light
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => setTheme('dark'))}>
            <Moon aria-hidden /> Theme: dark
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => setTheme('system'))}>
            <SunMoon aria-hidden /> Theme: follow the system
          </Command.Item>
          <Command.Item
            className={item}
            keywords={['kill switch', 'stop everything', 'emergency']}
            onSelect={run(async () => {
              const engaged = kill.data?.engaged === true;
              const ok = await confirmAction(
                engaged
                  ? {
                      title: 'Release the kill switch?',
                      body: 'Bots may run again.',
                      confirm: 'Release',
                    }
                  : {
                      title: 'Engage the global kill switch?',
                      body: 'Every Run stops now and nothing new starts until you release it.',
                      confirm: 'Stop everything',
                      danger: true,
                    },
              );
              if (ok) await actions.setKill(!engaged);
            })}
          >
            <Octagon aria-hidden />{' '}
            {kill.data?.engaged ? 'Release the kill switch' : 'Kill switch — stop everything'}
          </Command.Item>
          <Command.Item className={item} onSelect={run(() => actions.signOut())}>
            <LogOut aria-hidden /> Sign out
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
