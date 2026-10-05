/** @jsxRuntime automatic @jsxImportSource react */
import {
  type Bot,
  FEEDBACK_SIGNAL_WORD,
  MEMORY_KIND_WORD,
  MEMORY_SOURCE_WORD,
  MEMORY_TRUST,
  type Memory,
  type MemoryImportResult,
  type MemoryKind,
  formatLocalDate,
  memoryTrust,
  scrubControls,
  slugify,
} from '@orbit/core/browser';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Brain,
  Download,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { confirmAction } from '../components/confirm';
import { RoleGate } from '../components/role-gate';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '../components/ui/dialog';
import { Field, Input, Label, Select, Textarea } from '../components/ui/input';
import { Kbd } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { errorText, useClient } from '../lib/api';
import { cn } from '../lib/cn';
import { importMemoryIntent } from '../lib/intents';
import { exportedBot, memoryListKey, readExportHeader } from '../lib/memory-list';
import { useStore } from '../lib/store';
import { useBots, useMemoryList } from '../lib/queries';

const KINDS: { value: MemoryKind | ''; label: string }[] = [
  { value: '', label: 'Everything' },
  ...(Object.keys(MEMORY_KIND_WORD) as MemoryKind[]).map((k) => ({
    value: k,
    label: MEMORY_KIND_WORD[k],
  })),
];

/** Trust as a symbol + word (never colour alone), its meaning in the tooltip. */
export function TrustBadge({ memory }: { memory: Pick<Memory, 'taint'> }) {
  const w = memoryTrust(memory);
  return (
    <Badge tone={w.tone} title={w.meaning}>
      <span aria-hidden>{w.mark}</span>
      {w.label}
    </Badge>
  );
}

function MemoryRow({
  m,
  botName,
  selected,
  onSelect,
}: {
  m: Memory;
  botName: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-memory-id={m.id}
        onClick={onSelect}
        // One tab stop for the list; j/k and the arrows move inside it.
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left hover:bg-surface-2',
          selected ? 'border-ring bg-accent-subtle' : 'border-border bg-surface',
        )}
      >
        <span className="flex flex-wrap items-center gap-2">
          <TrustBadge memory={m} />
          <span className="text-xs text-fg-muted">{MEMORY_KIND_WORD[m.kind]}</span>
          {m.pinned ? (
            <span className="text-xs text-fg-muted">
              <Pin className="inline size-3" aria-hidden /> pinned
            </span>
          ) : null}
          <span className="ml-auto text-xs text-fg-muted">
            <Time iso={m.createdAt} />
          </span>
        </span>
        <span className="line-clamp-2 text-sm font-medium text-fg">{scrubControls(m.title)}</span>
        <span className="text-xs text-fg-muted">
          by {MEMORY_SOURCE_WORD[m.source]}
          {botName ? ` · ${scrubControls(botName)}` : ''}
        </span>
      </button>
    </li>
  );
}

function EditDialog({
  memory,
  open,
  onOpenChange,
}: {
  memory: Memory;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const ids = useId();
  const actions = useActions();
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const [pinned, setPinned] = useState(memory.pinned);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const untrusted = memory.taint.length > 0;
  useEffect(() => {
    if (!open) return;
    setTitle(memory.title);
    setBody(memory.body);
    setPinned(memory.pinned);
    setReviewed(false);
  }, [open, memory]);
  const canPin = !untrusted || reviewed;
  const save = async () => {
    setBusy(true);
    try {
      await actions.updateMemory(memory, {
        ...(title !== memory.title ? { title } : {}),
        ...(body !== memory.body ? { body } : {}),
        ...(pinned !== memory.pinned ? { pinned: pinned && canPin } : {}),
        ...(reviewed ? { trusted: true as const } : {}),
      });
      onOpenChange(false);
    } catch {
      // the toast says what went wrong
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Edit memory"
        description="Bots see memories as context, never as instructions."
        wide
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field id={`${ids}-title`} label="Title">
            <Input
              id={`${ids}-title`}
              value={title}
              maxLength={200}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-body`} label="Text (markdown)">
            <Textarea
              id={`${ids}-body`}
              value={body}
              maxLength={8000}
              rows={10}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {untrusted ? (
            <div className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              <p>
                <span aria-hidden>{MEMORY_TRUST.untrusted.mark}</span> Untrusted content shaped this
                memory ({scrubControls(memory.taint.join(', '))}). Editing keeps it untrusted.
              </p>
              <label className="mt-2 flex items-start gap-2 text-fg">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I reviewed it: treat it as trusted. Runs may then see it automatically. (Recorded
                  in the audit log.)
                </span>
              </label>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={pinned && canPin}
              disabled={!canPin}
              onChange={(e) => setPinned(e.target.checked)}
            />
            Pin: offer it to every new Run
            {!canPin ? (
              <span className="text-xs text-fg-muted">(only trusted memories)</span>
            ) : null}
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || title.trim() === ''}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({
  bots,
  initialBot,
  open,
  onOpenChange,
}: {
  bots: Bot[];
  initialBot: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const ids = useId();
  const actions = useActions();
  const [botId, setBotId] = useState(initialBot);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (open) {
      setBotId(initialBot !== '' ? initialBot : (bots[0]?.id ?? ''));
      setTitle('');
      setBody('');
      setPinned(false);
    }
  }, [open, initialBot, bots]);
  const bot = bots.find((b) => b.id === botId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a memory"
        description="A fact or preference you want a Bot to know. Written by you, so it is trusted."
        wide
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!bot) return;
            void actions
              .createMemory(bot, { title, body, kind: 'fact', pinned })
              .then(() => onOpenChange(false))
              .catch(() => undefined);
          }}
        >
          <Field id={`${ids}-bot`} label="Bot">
            <Select id={`${ids}-bot`} value={botId} onChange={(e) => setBotId(e.target.value)}>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {scrubControls(b.spec.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${ids}-title`} label="Title">
            <Input
              id={`${ids}-title`}
              value={title}
              maxLength={200}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-body`} label="Text (markdown)">
            <Textarea
              id={`${ids}-body`}
              value={body}
              maxLength={8000}
              rows={6}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin: offer it to every new Run
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!bot || title.trim() === ''}>
              Save memory
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  m,
  botName,
  headingRef,
}: {
  m: Memory;
  botName: string | null;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const untrusted = m.taint.length > 0;
  // After an action that re-renders the card, keep keyboard focus on it.
  const refocus = () => setTimeout(() => headingRef.current?.focus(), 0);
  return (
    <Card role="region" aria-label="Selected memory">
      <CardHeader className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TrustBadge memory={m} />
          <Badge>{MEMORY_KIND_WORD[m.kind]}</Badge>
          {m.pinned ? (
            <Badge tone="info">
              <Pin className="size-3" aria-hidden /> pinned
            </Badge>
          ) : null}
        </div>
        <CardTitle className="break-words">
          <span ref={headingRef} tabIndex={-1} className="focus:outline-none">
            {scrubControls(m.title)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm whitespace-pre-wrap break-words text-fg">{scrubControls(m.body)}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">Written by</dt>
          <dd>
            {MEMORY_SOURCE_WORD[m.source]}
            {botName ? ` · for ${scrubControls(botName)}` : ''}
          </dd>
          <dt className="text-fg-muted">When</dt>
          <dd>
            <Time iso={m.createdAt} />
            {m.editedAt ? ' · edited by you' : ''}
          </dd>
          {m.runId ? (
            <>
              <dt className="text-fg-muted">From run</dt>
              <dd>
                <Link
                  to="/runs/$runId"
                  params={{ runId: m.runId }}
                  className="font-mono text-accent hover:underline"
                >
                  {m.runId.slice(-8)}
                </Link>
              </dd>
            </>
          ) : null}
          {m.signal ? (
            <>
              <dt className="text-fg-muted">Feedback</dt>
              <dd>{FEEDBACK_SIGNAL_WORD[m.signal]}</dd>
            </>
          ) : null}
          <dt className="text-fg-muted">Trust</dt>
          <dd>
            {untrusted
              ? `untrusted — from ${scrubControls(m.taint.join(', '))}. Never offered to Runs automatically; reading it taints a Run.`
              : 'trusted — Runs may see it as context.'}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <RoleGate route="updateMemory">
            <Button onClick={() => setEditing(true)}>
              <Pencil aria-hidden /> Edit
            </Button>
          </RoleGate>
          {untrusted ? (
            <RoleGate route="updateMemory">
              <Button
                onClick={() =>
                  void (async () => {
                    const ok = await confirmAction({
                      title: 'Mark this memory as trusted?',
                      body: 'Do this only after reading it: trusted memories can be offered to Runs automatically. The audit log records it.',
                      confirm: 'Mark trusted',
                    });
                    if (ok) await actions.updateMemory(m, { trusted: true });
                    refocus();
                  })().catch(() => undefined)
                }
              >
                <ShieldCheck aria-hidden /> I reviewed it
              </Button>
            </RoleGate>
          ) : (
            <RoleGate route="updateMemory">
              <Button
                onClick={() =>
                  void actions.updateMemory(m, { pinned: !m.pinned }).catch(() => undefined)
                }
              >
                {m.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}{' '}
                {m.pinned ? 'Unpin' : 'Pin'}
              </Button>
            </RoleGate>
          )}
          <RoleGate route="deleteMemory">
            <Button
              variant="danger"
              onClick={() =>
                void (async () => {
                  const ok = await confirmAction({
                    title: 'Delete this memory?',
                    body: 'The Bot forgets it and its markdown file is removed. This cannot be undone.',
                    confirm: 'Delete',
                    danger: true,
                  });
                  if (ok) {
                    await actions.deleteMemory(m);
                    refocus();
                  }
                })().catch(() => undefined)
              }
            >
              <Trash2 aria-hidden /> Delete
            </Button>
          </RoleGate>
        </div>
      </CardContent>
      <EditDialog memory={m} open={editing} onOpenChange={setEditing} />
    </Card>
  );
}

/** What an import would do, before it does it (ADR-012, M8). */
function ImportPreview({ r, untrusted }: { r: MemoryImportResult; untrusted: boolean }) {
  if (r.errors.length > 0) {
    return (
      <div
        role="alert"
        className="rounded-md border border-danger/40 px-3 py-2 text-sm text-danger"
      >
        <p className="font-medium">
          <span aria-hidden>✘</span> This file cannot be imported; nothing will be written.
        </p>
        <ul className="mt-1 list-disc pl-5">
          {r.errors.map((e) => (
            <li key={e.line}>
              line {e.line}: {scrubControls(e.message)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="import-preview">
      <p>
        {r.total} {r.total === 1 ? 'memory' : 'memories'}:{' '}
        <span aria-hidden>{MEMORY_TRUST.trusted.mark}</span> {r.trusted} trusted,{' '}
        <span aria-hidden>{MEMORY_TRUST.untrusted.mark}</span> {r.untrusted} untrusted
        {untrusted ? ' (all marked untrusted)' : ''}.
      </p>
      {r.claimsOwner > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-warning">
          <span aria-hidden>{MEMORY_TRUST.untrusted.mark}</span> {r.claimsOwner}{' '}
          {r.claimsOwner === 1 ? 'says it was' : 'say they were'} written by you. They count as
          trusted only because you choose to import this file, and trusted memories can be offered
          to Runs. Mark everything untrusted if you did not write it.
        </p>
      ) : null}
      {r.evicts > 0 ? (
        <p className="text-fg-muted">
          To stay within the per-Bot limit, the Bot's {r.evicts} oldest notes and summaries will be
          dropped.
        </p>
      ) : null}
    </div>
  );
}

function ImportDialog({
  bots,
  initialBot,
  open,
  onOpenChange,
}: {
  bots: Bot[];
  initialBot: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const ids = useId();
  const client = useClient();
  const actions = useActions();
  const [botId, setBotId] = useState(initialBot);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [untrusted, setUntrusted] = useState(false);
  const [preview, setPreview] = useState<MemoryImportResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      // No guess: the Bot the file names is chosen once a file is picked, else the owner picks.
      setBotId(initialBot);
      setFile(null);
      setUntrusted(false);
      setPreview(null);
      setProblem(null);
    }
  }, [open, initialBot]);
  // Every change of Bot, file or trust choice previews again (a dry run: nothing is written).
  useEffect(() => {
    setPreview(null);
    setProblem(null);
    setChecking(false);
    if (!file || !botId) return;
    let live = true;
    setChecking(true);
    client.memory
      .import(botId, { jsonl: file.text, untrusted, dryRun: true })
      .then((r) => {
        if (live) setPreview(r);
      })
      .catch((err: unknown) => {
        if (live) setProblem(errorText(err));
      })
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [client, botId, file, untrusted]);
  const header = file ? readExportHeader(file.text) : null;
  const bot = bots.find((b) => b.id === botId);
  const ready = preview !== null && preview.errors.length === 0 && preview.total > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import memories"
        description="A file exported from Orbit. You see what it holds before anything is written."
        wide
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!bot || !file || !ready) return;
            setBusy(true);
            void actions
              .importMemory(bot, { jsonl: file.text, untrusted })
              .then(() => onOpenChange(false))
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          <Field id={`${ids}-bot`} label="Into Bot">
            <Select id={`${ids}-bot`} value={botId} onChange={(e) => setBotId(e.target.value)}>
              <option value="" disabled>
                Choose a Bot
              </option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {scrubControls(b.spec.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${ids}-file`} label="Export file (.jsonl)">
            <input
              id={`${ids}-file`}
              type="file"
              accept=".jsonl,application/x-ndjson,application/json,text/plain"
              className="text-sm text-fg-muted file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-border-input file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg hover:file:bg-surface-2"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void f.text().then((text) => {
                  setFile({ name: f.name, text });
                  const from = exportedBot(readExportHeader(text), bots);
                  if (from) setBotId(from);
                });
              }}
            />
          </Field>
          {header ? (
            <p className="text-sm text-fg-muted" data-testid="import-from">
              From:{' '}
              {header.bots.length
                ? scrubControls(header.bots.map((b) => b.name).join(', '))
                : 'no Bot'}{' '}
              (exported {formatLocalDate(header.exportedAt)})
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={untrusted}
              onChange={(e) => setUntrusted(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Mark everything untrusted: never offered to Runs automatically, whatever the file
              says.
            </span>
          </label>
          {problem ? (
            <p role="alert" className="text-sm text-danger">
              <span aria-hidden>✘</span> {problem}
            </p>
          ) : null}
          {checking ? (
            <p role="status" className="text-sm text-fg-muted">
              Checking the file…
            </p>
          ) : null}
          {preview ? <ImportPreview r={preview} untrusted={untrusted} /> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !ready}>
              {preview && ready
                ? `Import ${preview.total} ${preview.total === 1 ? 'memory' : 'memories'}`
                : 'Import'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The memory browser: what Bots remember, with provenance; view, edit, delete. */
export function MemoryScreen() {
  const search: {
    bot?: string | undefined;
    q?: string | undefined;
    kind?: string | undefined;
    memory?: string | undefined;
  } = useSearch({ strict: false });
  const navigate = useNavigate();
  const ids = useId();
  const bots = useBots();
  const [query, setQuery] = useState(search.q ?? '');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const actions = useActions();
  // The palette's "Import memories…" lands here.
  const importAsked = useStore(importMemoryIntent);
  useEffect(() => {
    if (importAsked && bots.data?.length) {
      importMemoryIntent.set(false);
      setImporting(true);
    }
  }, [importAsked, bots.data]);
  const searchRef = useRef<HTMLInputElement>(null);
  const kind = KINDS.some((k) => k.value === search.kind) ? (search.kind as MemoryKind) : undefined;
  const list = useMemoryList({
    ...(search.bot ? { bot: search.bot } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(kind ? { kind } : {}),
    limit: 200,
  });
  const set = (patch: Record<string, string | undefined>) =>
    void navigate({ to: '/memory', search: { ...search, ...patch }, replace: true });
  // Debounced full-text search, kept in the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== query) set({ q: query || undefined });
    }, 250);
    return () => clearTimeout(t);
    // Only the typed text drives the search; `search` and `set` follow the URL.
  }, [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      if (
        e.target instanceof HTMLElement &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const name = (id: string) => bots.data?.find((b) => b.id === id)?.spec.name ?? null;
  const items = list.data ?? [];
  const selected = items.find((m) => m.id === search.memory) ?? items[0] ?? null;
  const detailRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const select = (id: string, via: 'pointer' | 'keys') => {
    set({ memory: id });
    if (via === 'keys') {
      setTimeout(
        () =>
          listRef.current?.querySelector<HTMLButtonElement>(`[data-memory-id="${id}"]`)?.focus(),
        0,
      );
    } else if (!window.matchMedia('(min-width: 1024px)').matches) {
      // One column: the detail is below the list; bring it (and focus) to the user.
      setTimeout(() => {
        detailRef.current?.scrollIntoView({ block: 'start' });
        headingRef.current?.focus();
      }, 0);
    }
  };
  const filtered = Boolean(search.q) || Boolean(search.bot) || kind !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Memory"
        description="What your Bots remember — their notes, run summaries and your feedback — and who wrote each one."
        actions={
          <>
            <RoleGate route="exportMemory">
              <Button
                onClick={() => {
                  const slug = search.bot
                    ? slugify(bots.data?.find((b) => b.id === search.bot)?.spec.name ?? 'bot')
                    : 'all';
                  void actions
                    .exportMemory(
                      search.bot,
                      `orbit-memory-${slug}-${new Date().toISOString().slice(0, 10)}.jsonl`,
                    )
                    .catch(() => undefined);
                }}
                disabled={!bots.data?.length}
              >
                <Download aria-hidden /> {search.bot ? 'Export this Bot' : 'Export all'}
              </Button>
            </RoleGate>
            <RoleGate route="importMemory">
              <Button onClick={() => setImporting(true)} disabled={!bots.data?.length}>
                <Upload aria-hidden /> Import…
              </Button>
            </RoleGate>
            <RoleGate route="createMemory">
              <Button
                variant="primary"
                onClick={() => setAdding(true)}
                disabled={!bots.data?.length}
              >
                <Plus aria-hidden /> Add memory
              </Button>
            </RoleGate>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`${ids}-bot`} label="Bot" className="w-48">
          <Select
            id={`${ids}-bot`}
            value={search.bot ?? ''}
            onChange={(e) => set({ bot: e.target.value || undefined, memory: undefined })}
          >
            <option value="">All Bots</option>
            {(bots.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {scrubControls(b.spec.name)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={`${ids}-kind`} label="Kind" className="w-44">
          <Select
            id={`${ids}-kind`}
            value={kind ?? ''}
            onChange={(e) => set({ kind: e.target.value || undefined, memory: undefined })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor={`${ids}-q`}>
            Search <Kbd className="ml-1">/</Kbd>
          </Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-2 left-2 size-4 text-fg-subtle"
              aria-hidden
            />
            <Input
              id={`${ids}-q`}
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Words in titles and text"
              className="pl-8"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {list.isPending ? (
        <ListSkeleton rows={5} />
      ) : list.isError ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Brain aria-hidden />}
          title={filtered ? 'Nothing here' : 'No memories yet'}
          action={
            bots.data?.length ? (
              <RoleGate route="createMemory">
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus aria-hidden /> Add memory
                </Button>
              </RoleGate>
            ) : undefined
          }
        >
          {filtered
            ? 'Nothing matches these filters. Try other words, another Bot or kind.'
            : 'Bots remember the result of each finished Run, notes they save, and your feedback (thumbs, edits, denials). You can add facts yourself.'}
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section aria-label="Memories">
            <p className="mb-2 text-xs text-fg-muted" role="status">
              {items.length} {items.length === 1 ? 'memory' : 'memories'}
              {items.length === 200 ? ' (newest 200)' : ''}
            </p>
            <ul
              ref={listRef}
              className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1"
              onKeyDown={(e) => {
                if (e.metaKey || e.ctrlKey || e.altKey) return;
                const at = items.findIndex((x) => x.id === selected?.id);
                const next = memoryListKey(e.key, at, items.length);
                const target = next === null ? undefined : items[next];
                if (!target) return;
                e.preventDefault();
                select(target.id, 'keys');
              }}
            >
              {items.map((m) => (
                <MemoryRow
                  key={m.id}
                  m={m}
                  botName={search.bot ? null : name(m.botId)}
                  selected={selected?.id === m.id}
                  onSelect={() => select(m.id, 'pointer')}
                />
              ))}
            </ul>
          </section>
          <div ref={detailRef} className="flex flex-col gap-2">
            {search.memory && selected?.id !== search.memory ? (
              <p role="status" className="text-sm text-fg-muted">
                That memory is gone (deleted) or outside these filters.
              </p>
            ) : null}
            {selected ? (
              <Detail
                key={selected.id}
                m={selected}
                botName={name(selected.botId)}
                headingRef={headingRef}
              />
            ) : null}
          </div>
        </div>
      )}
      <AddDialog
        bots={bots.data ?? []}
        initialBot={search.bot ?? ''}
        open={adding}
        onOpenChange={setAdding}
      />
      <ImportDialog
        bots={bots.data ?? []}
        initialBot={search.bot ?? ''}
        open={importing}
        onOpenChange={setImporting}
      />
    </div>
  );
}
