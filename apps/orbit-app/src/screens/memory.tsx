/** @jsxRuntime automatic @jsxImportSource react */
import {
  type Bot,
  MEMORY_SOURCE_WORD,
  MEMORY_TRUST,
  type Memory,
  type MemoryKind,
  memoryTrust,
  scrubControls,
} from '@orbit/core/browser';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Brain, Pencil, Pin, PinOff, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { confirmAction } from '../components/confirm';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { Time } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogFooter } from '../components/ui/dialog';
import { Field, Input, Label, Select, Textarea } from '../components/ui/input';
import { Kbd } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { cn } from '../lib/cn';
import { useBots, useMemoryList } from '../lib/queries';

const KINDS: { value: MemoryKind | ''; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'note', label: 'Bot notes' },
  { value: 'summary', label: 'Run summaries' },
  { value: 'feedback', label: 'Your feedback' },
  { value: 'fact', label: 'Your facts' },
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
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left hover:bg-surface-2',
          selected ? 'border-ring bg-accent-subtle' : 'border-border bg-surface',
        )}
      >
        <span className="flex flex-wrap items-center gap-2">
          <TrustBadge memory={m} />
          <span className="text-xs text-fg-muted">{m.kind}</span>
          {m.pinned ? (
            <span className="text-xs text-fg-muted">
              <Pin className="inline size-3" aria-hidden /> pinned
            </span>
          ) : null}
          <span className="ml-auto text-xs text-fg-subtle">
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

function Detail({ m, botName }: { m: Memory; botName: string | null }) {
  const actions = useActions();
  const [editing, setEditing] = useState(false);
  const untrusted = m.taint.length > 0;
  return (
    <Card role="region" aria-label="Selected memory">
      <CardHeader className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TrustBadge memory={m} />
          <Badge>{m.kind}</Badge>
          {m.pinned ? (
            <Badge tone="info">
              <Pin className="size-3" aria-hidden /> pinned
            </Badge>
          ) : null}
        </div>
        <CardTitle className="break-words">{scrubControls(m.title)}</CardTitle>
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
              <dd>{m.signal.replace('_', ' ')}</dd>
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
          <Button onClick={() => setEditing(true)}>
            <Pencil aria-hidden /> Edit
          </Button>
          {untrusted ? (
            <Button
              onClick={() =>
                void (async () => {
                  const ok = await confirmAction({
                    title: 'Mark this memory as trusted?',
                    body: 'Do this only after reading it: trusted memories can be offered to Runs automatically. The audit log records it.',
                    confirm: 'Mark trusted',
                  });
                  if (ok) await actions.updateMemory(m, { trusted: true });
                })().catch(() => undefined)
              }
            >
              <ShieldCheck aria-hidden /> I reviewed it
            </Button>
          ) : (
            <Button
              onClick={() =>
                void actions.updateMemory(m, { pinned: !m.pinned }).catch(() => undefined)
              }
            >
              {m.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />} {m.pinned ? 'Unpin' : 'Pin'}
            </Button>
          )}
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
                if (ok) await actions.deleteMemory(m);
              })().catch(() => undefined)
            }
          >
            <Trash2 aria-hidden /> Delete
          </Button>
        </div>
      </CardContent>
      <EditDialog memory={m} open={editing} onOpenChange={setEditing} />
    </Card>
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Memory"
        description="What your Bots remember — their notes, run summaries and your feedback — and who wrote each one."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)} disabled={!bots.data?.length}>
            <Plus aria-hidden /> Add memory
          </Button>
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
          title={search.q ? 'Nothing matches' : 'No memories yet'}
        >
          {search.q
            ? 'Try other words, or clear the filters.'
            : 'Bots remember the result of each finished Run, notes they save, and your feedback (thumbs, edits, denials). You can add facts yourself.'}
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section aria-label="Memories">
            <p className="mb-2 text-xs text-fg-muted" role="status">
              {items.length} {items.length === 1 ? 'memory' : 'memories'}
              {items.length === 200 ? ' (newest 200)' : ''}
            </p>
            <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
              {items.map((m) => (
                <MemoryRow
                  key={m.id}
                  m={m}
                  botName={search.bot ? null : name(m.botId)}
                  selected={selected?.id === m.id}
                  onSelect={() => set({ memory: m.id })}
                />
              ))}
            </ul>
          </section>
          <div className="flex flex-col gap-2">
            {search.memory && selected?.id !== search.memory ? (
              <p role="status" className="text-sm text-fg-muted">
                That memory is gone (deleted) or outside these filters.
              </p>
            ) : null}
            {selected ? (
              <Detail key={selected.id} m={selected} botName={name(selected.botId)} />
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
    </div>
  );
}
