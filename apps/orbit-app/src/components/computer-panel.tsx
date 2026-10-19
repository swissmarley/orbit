/** @jsxRuntime automatic @jsxImportSource react */
import { type Bot, type Tone, formatBytes, scrubControls } from '@orbit/core/browser';
import type { RouteResponse } from '@orbit/sdk-client/browser';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  ChevronRight,
  File,
  Folder,
  Globe,
  Link2,
  Monitor,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorText } from '../lib/api';
import { cn } from '../lib/cn';
import { type ComputerTab, describeTool } from '../lib/conversation';
import {
  useComputer,
  useComputerActivity,
  useComputerFile,
  useComputerFiles,
} from '../lib/queries';
import { useRole } from '../lib/role';
import { useStore } from '../lib/store';
import { TONE_CLASS } from '../lib/tone';
import { computerOpenStore, computerPathStore, computerTabStore } from '../lib/ui';
import { BotAvatar } from './avatar';
import { ListSkeleton } from './states';
import { TierBadge, Time } from './status';
import { TakeOverButton } from './takeover';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

type Status = RouteResponse<'getComputer'>;
type Action = RouteResponse<'computerActivity'>[number];

const STATE: Record<Status['state'], { word: string; tone: Tone; mark: string }> = {
  stopped: { word: 'Stopped (kill switch)', tone: 'danger', mark: '■' },
  taken_over: { word: 'Taken over', tone: 'warning', mark: '⌨' },
  paused: { word: 'Paused', tone: 'warning', mark: '⏸︎' },
  working: { word: 'Working', tone: 'info', mark: '●' },
  needs_you: { word: 'Needs you', tone: 'attention', mark: '◆' },
  waiting: { word: 'Waiting', tone: 'neutral', mark: '◌' },
  idle: { word: 'Idle', tone: 'success', mark: '○' },
};

/** "Folder · no network", "Git worktree of ~/code/app", "Docker container · 2 allowed domains". */
export function workspaceWords(w: Status['workspace']): string {
  const kind =
    w.kind === 'worktree'
      ? `Git worktree${w.repo ? ` of ${w.repo}` : ''}`
      : w.kind === 'docker'
        ? 'Docker container'
        : 'Folder on this machine';
  const net =
    w.network === 'none'
      ? 'no network for commands'
      : `network: ${w.allowedDomains.length} allowed ${w.allowedDomains.length === 1 ? 'domain' : 'domains'}`;
  return `${kind} · ${net}`;
}

function StatePill({ state }: { state: Status['state'] }) {
  const s = STATE[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[s.tone],
      )}
    >
      <span aria-hidden>{s.mark}</span>
      {s.word}
    </span>
  );
}

const inputOf = (a: Action) =>
  typeof a.input === 'object' && a.input !== null ? (a.input as Record<string, unknown>) : {};
const outcome = (a: Action): { word: string; tone: Tone } =>
  a.decision?.behavior === 'deny'
    ? a.decision.approvalId
      ? { word: 'waiting for you', tone: 'attention' }
      : { word: 'denied', tone: 'danger' }
    : a.result
      ? a.result.isError
        ? { word: 'failed', tone: 'danger' }
        : { word: 'done', tone: 'success' }
      : { word: 'working', tone: 'info' };

// ── Browser ───────────────────────────────────────────────────────────────

function BrowserTab({ bot, status, activity }: { bot: Bot; status: Status; activity: Action[] }) {
  const pages = activity.filter((a) => {
    const k = describeTool(a.name).kind;
    return k === 'web' || k === 'browser';
  });
  const [picked, setPicked] = useState<string | null>(null);
  // The newest page it actually read (a newer visit may still wait for your decision).
  const current =
    pages.find((p) => p.toolUseId + p.runId === picked) ??
    pages.find((p) => p.result !== null) ??
    pages[0];
  const name = scrubControls(bot.spec.name);
  if (status.web.browser === 'not_added' && !status.web.fetch && pages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-fg-muted">
        <Globe className="size-8 text-fg-subtle" aria-hidden />
        <p className="font-medium text-fg">{name} has no way onto the web</p>
        <p>
          Give it the Browser plugin (Settings → Integrations, then the Bot’s config) or the
          WebFetch tool.
        </p>
      </div>
    );
  }
  const input = current ? inputOf(current) : {};
  const url =
    typeof input.url === 'string'
      ? scrubControls(input.url)
      : typeof input.query === 'string'
        ? `search: ${scrubControls(input.query)}`
        : '';
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
          <span className="flex gap-1" aria-hidden>
            <span className="size-2.5 rounded-full bg-danger/60" />
            <span className="size-2.5 rounded-full bg-warning/60" />
            <span className="size-2.5 rounded-full bg-success/60" />
          </span>
          <div
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-fg-muted"
            title={url}
          >
            {url || 'No page yet'}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pt-2 text-xs text-fg-subtle">
          <span>
            {status.web.browser === 'ready'
              ? `${name} reads pages as text: this is what it read.`
              : `What ${name} read from the web.`}
          </span>
          {current ? (
            <span className="shrink-0 rounded bg-warning-bg px-1.5 text-warning">untrusted</span>
          ) : null}
        </div>
        <pre
          tabIndex={0}
          className="max-h-80 min-h-32 overflow-auto px-3 py-2 font-sans text-sm whitespace-pre-wrap text-fg"
          aria-label={`Page text ${name} read`}
        >
          {current?.result?.content ??
            (current
              ? current.decision?.behavior === 'deny'
                ? 'Not opened: it waits for your decision, or was denied.'
                : 'Opening…'
              : `${name} has not opened a page yet.`)}
        </pre>
      </div>
      {pages.length > 0 ? (
        <section aria-label="Pages visited">
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Pages visited
          </h3>
          <ul className="flex flex-col">
            {pages.slice(0, 20).map((p) => {
              const i = inputOf(p);
              const label =
                typeof i.url === 'string'
                  ? i.url
                  : typeof i.query === 'string'
                    ? `search: ${i.query}`
                    : p.name;
              const selected = p === current;
              return (
                <li key={p.runId + p.toolUseId}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setPicked(p.toolUseId + p.runId)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2',
                      selected && 'bg-surface-2',
                    )}
                  >
                    <Link2 className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">
                      {scrubControls(label)}
                    </span>
                    <Time iso={p.at} className="shrink-0 text-fg-subtle" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ── Files ─────────────────────────────────────────────────────────────────

function Untrusted() {
  return (
    <span
      className="shrink-0 rounded bg-warning-bg px-1.5 text-[11px] font-medium text-warning"
      title="Written while untrusted content was in a Run"
    >
      untrusted
    </span>
  );
}

function FilePreview({ bot, path, onBack }: { bot: Bot; path: string; onBack: () => void }) {
  const file = useComputerFile(bot.id, path);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden /> Files
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={path}>
          {path}
        </span>
        {file.data?.tainted ? <Untrusted /> : null}
      </div>
      {file.isPending ? (
        <ListSkeleton rows={2} />
      ) : file.isError ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-muted" role="status">
          {errorText(file.error)}
        </p>
      ) : file.data.kind === 'binary' ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-muted">
          A binary file ({formatBytes(file.data.size)}): not shown.
        </p>
      ) : (
        <>
          <pre
            tabIndex={0}
            aria-label={`Contents of ${path}`}
            className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg"
          >
            {scrubControls(file.data.text ?? '')}
          </pre>
          <p className="text-xs text-fg-subtle">
            {formatBytes(file.data.size)} · changed <Time iso={file.data.modifiedAt} />
            {file.data.truncated ? ' · only the start is shown' : ''}
            {file.data.redacted ? ' · secrets in it are masked' : ''}
          </p>
        </>
      )}
    </div>
  );
}

function FilesTab({ bot, status }: { bot: Bot; status: Status }) {
  const wanted = useStore(computerPathStore);
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<string | null>(null);
  // A tool card asked for a file: open its folder and show it.
  useEffect(() => {
    if (wanted === null) return;
    const parts = wanted.split('/');
    setDir(parts.slice(0, -1).join('/'));
    setFile(wanted);
    computerPathStore.set(null);
  }, [wanted]);
  // A viewer sees what Run events show; the files are the operator's (ADR-020).
  const browse = useRole().can('computerFiles');
  const listing = useComputerFiles(bot.id, dir, browse && file === null);
  const name = scrubControls(bot.spec.name);
  if (!browse) {
    return (
      <p className="px-2 py-8 text-center text-sm text-fg-muted">
        Browsing {name}’s files needs the operator role. Activity and Terminal show what it read and
        wrote.
      </p>
    );
  }
  if (file !== null) return <FilePreview bot={bot} path={file} onBack={() => setFile(null)} />;
  if (!status.workspace.exists) {
    return (
      <p className="px-2 py-8 text-center text-sm text-fg-muted">
        {name}’s computer is empty: its workspace is made when it first works.
      </p>
    );
  }
  const crumbs = dir ? dir.split('/') : [];
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-0.5 text-xs">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 font-medium text-fg hover:bg-surface-2"
          onClick={() => setDir('')}
        >
          workspace
        </button>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 text-fg-subtle" aria-hidden />
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-fg hover:bg-surface-2"
              onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}
            >
              {c}
            </button>
          </span>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Refresh the files"
          onClick={() => void listing.refetch()}
        >
          <RefreshCw aria-hidden />
        </Button>
      </nav>
      {listing.isPending ? (
        <ListSkeleton rows={3} />
      ) : listing.isError ? (
        <p className="text-sm text-fg-muted" role="status">
          {errorText(listing.error)}
        </p>
      ) : listing.data.entries.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-fg-muted">This folder is empty.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Files">
          {listing.data.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                disabled={e.kind === 'symlink' || e.kind === 'other'}
                onClick={() => (e.kind === 'directory' ? setDir(e.path) : setFile(e.path))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
                title={
                  e.kind === 'symlink' ? 'A link: Orbit never follows links in a workspace' : e.path
                }
              >
                {e.kind === 'directory' ? (
                  <Folder className="size-4 shrink-0 text-accent" aria-hidden />
                ) : e.kind === 'symlink' ? (
                  <Link2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                ) : (
                  <File className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-fg">{scrubControls(e.name)}</span>
                {e.tainted ? <Untrusted /> : null}
                {e.kind === 'file' && e.size !== null ? (
                  <span className="shrink-0 text-xs text-fg-subtle">{formatBytes(e.size)}</span>
                ) : e.kind === 'symlink' ? (
                  <span className="shrink-0 text-xs text-fg-subtle">link</span>
                ) : null}
              </button>
            </li>
          ))}
          {listing.data.truncated ? (
            <li className="px-2 py-1 text-xs text-fg-subtle">More files than shown here.</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

// ── Terminal ──────────────────────────────────────────────────────────────

function TerminalTab({ bot, status, activity }: { bot: Bot; status: Status; activity: Action[] }) {
  const commands = activity.filter((a) => describeTool(a.name).kind === 'terminal').reverse();
  const name = scrubControls(bot.spec.name);
  const prompt = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'bot'}@computer`;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div
        className="max-h-[60vh] min-h-48 overflow-auto rounded-xl bg-terminal px-3 py-2 font-mono text-[12.5px] leading-relaxed text-terminal-fg"
        tabIndex={0}
        role="log"
        aria-label={`Commands ${name} ran`}
      >
        {commands.length === 0 ? (
          <p className="text-terminal-dim">No commands yet.</p>
        ) : (
          commands.map((c) => {
            const i = inputOf(c);
            const o = outcome(c);
            return (
              <div key={c.runId + c.toolUseId} className="mb-2">
                <div className="break-all whitespace-pre-wrap">
                  <span className="text-terminal-dim select-none">{prompt} $ </span>
                  {scrubControls(typeof i.command === 'string' ? i.command : c.name)}
                </div>
                {o.word === 'denied' || o.word === 'waiting for you' ? (
                  <div className="text-terminal-dim">
                    [{o.word}
                    {c.decision?.reason ? `: ${scrubControls(c.decision.reason)}` : ''}]
                  </div>
                ) : c.result ? (
                  <pre className="whitespace-pre-wrap text-terminal-fg/90">
                    {scrubControls(c.result.content)}
                  </pre>
                ) : (
                  <span className="text-terminal-dim">▍</span>
                )}
              </div>
            );
          })
        )}
      </div>
      <p className="text-xs text-fg-muted">
        Read-only: the commands {name} ran, each one through Orbit’s policy.
        {status.shellCommand ? (
          <>
            {' '}
            To work on this computer yourself, run{' '}
            <code className="rounded bg-surface-2 px-1 font-mono">{status.shellCommand}</code> in a
            terminal.
          </>
        ) : null}
      </p>
    </div>
  );
}

// ── Activity ──────────────────────────────────────────────────────────────

function ActivityTab({ bot, activity }: { bot: Bot; activity: Action[] }) {
  if (activity.length === 0) {
    return <p className="px-2 py-8 text-center text-sm text-fg-muted">Nothing yet.</p>;
  }
  return (
    <ol className="flex flex-col" aria-label="Recent activity">
      {activity.map((a) => {
        const info = describeTool(a.name, a.input);
        const o = outcome(a);
        const detail = (() => {
          const i = inputOf(a);
          const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.query ?? i.pattern ?? i.to;
          return typeof v === 'string' ? scrubControls(v) : '';
        })();
        return (
          <li
            key={a.runId + a.toolUseId}
            className="flex flex-col gap-0.5 border-b border-border px-1 py-2 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                {info.label}
              </span>
              {a.decision?.tier ? <TierBadge tier={a.decision.tier} /> : null}
              <span
                className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE_CLASS[o.tone])}
              >
                {o.word}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-fg-subtle">
              <span className="min-w-0 flex-1 truncate font-mono" title={detail}>
                {detail}
              </span>
              <Time iso={a.at} className="shrink-0" />
              <Link
                to="/chat/$botId"
                params={{ botId: bot.id }}
                search={{ c: a.conversationId }}
                className="shrink-0 text-accent hover:underline"
              >
                chat
              </Link>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A Bot's computer (ADR-020), beside its chat: what it is doing, the pages it
 * read, its workspace files, the commands it ran and every call with its
 * tier and decision. Read-only: commands run only through the Bot (and
 * Orbit's policy) or the owner's `orbit shell`.
 */
export function ComputerPanel({ bot, onClose }: { bot: Bot; onClose?: () => void }) {
  const tab = useStore(computerTabStore);
  const status = useComputer(bot.id);
  const activity = useComputerActivity(bot.id);
  const name = scrubControls(bot.spec.name);
  const acts = useMemo(() => activity.data ?? [], [activity.data]);
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface"
      aria-label={`${name}'s computer`}
      data-testid="computer-panel"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Monitor className="size-4 text-fg-muted" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold text-fg">{name}’s computer</h2>
        {status.data ? <StatePill state={status.data.state} /> : null}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Close the computer"
          onClick={() => (onClose ? onClose() : computerOpenStore.set(false))}
        >
          <X aria-hidden />
        </Button>
      </header>
      {status.isPending ? (
        <div className="p-4">
          <ListSkeleton rows={3} />
        </div>
      ) : status.isError ? (
        <p className="p-4 text-sm text-danger" role="alert">
          {errorText(status.error)}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <BotAvatar
              bot={bot}
              size={32}
              decorative
              state={
                status.data.state === 'working'
                  ? 'working'
                  : status.data.state === 'needs_you'
                    ? 'attention'
                    : status.data.state === 'paused' || status.data.state === 'taken_over'
                      ? 'paused'
                      : 'idle'
              }
            />
            <p className="min-w-0 flex-1 text-xs text-fg-muted">
              {workspaceWords(status.data.workspace)}
            </p>
          </div>
          <Tabs
            value={tab}
            onValueChange={(v) => computerTabStore.set(v as ComputerTab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="px-3">
              <TabsTrigger value="browser">Browser</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <TabsContent value="browser">
                <BrowserTab bot={bot} status={status.data} activity={acts} />
              </TabsContent>
              <TabsContent value="files">
                <FilesTab bot={bot} status={status.data} />
              </TabsContent>
              <TabsContent value="terminal">
                <TerminalTab bot={bot} status={status.data} activity={acts} />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityTab bot={bot} activity={acts} />
              </TabsContent>
            </div>
          </Tabs>
          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <code
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle"
              title={status.data.workspace.path}
            >
              {status.data.workspace.path}
            </code>
            {status.data.shellCommand ? <TakeOverButton bot={bot} size="sm" /> : null}
          </footer>
        </>
      )}
    </section>
  );
}
