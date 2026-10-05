/** @jsxRuntime automatic @jsxImportSource react */
import { scrubControls } from '@orbit/core/browser';
import type { Approval } from '@orbit/sdk-client/browser';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApprovalCard, type CardMode } from '../components/approval-card';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { TierBadge, Time } from '../components/status';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { Kbd } from '../components/ui/misc';
import { useActions } from '../lib/actions';
import { cn } from '../lib/cn';
import {
  INBOX_KEYS,
  INITIAL_INBOX,
  type InboxState,
  onInboxKey,
  reconcileInbox,
  selected,
} from '../lib/inbox';
import { usePendingApprovals } from '../lib/queries';

function isField(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
  );
}

/** "Needs you": pending approvals, oldest first. j/k move, Enter/a open the card, e edit, d deny. */
export function InboxScreen() {
  const approvals = usePendingApprovals();
  const actions = useActions();
  const navigate = useNavigate();
  const search: { approval?: string | undefined } = useSearch({ strict: false });
  const list = approvals.data ?? [];
  const [state, setState] = useState<InboxState>(INITIAL_INBOX);
  const [busy, setBusy] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());

  // Selection follows the card's id as the list changes.
  useEffect(() => setState((s) => reconcileInbox(s, list)), [list]);

  // /inbox?approval=apr_x (palette, notifications) opens that card.
  useEffect(() => {
    if (search.approval && list.some((a) => a.id === search.approval)) {
      const id = search.approval;
      setState((s) => ({ ...s, selectedId: id, moved: false, mode: { kind: 'card', id } }));
      void navigate({ to: '/inbox', search: {}, replace: true });
    }
  }, [search.approval, list, navigate]);

  const decide = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setState((s) => ({ ...s, mode: { kind: 'list' } }));
    try {
      await fn();
    } catch {
      // toast already shown
    } finally {
      setBusy(false);
    }
  }, []);

  const approve = useCallback(
    (a: Approval, opts: { editedInput?: Record<string, unknown>; always?: boolean }) =>
      void decide(() => actions.approve(a, opts)),
    [actions, decide],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const r = onInboxKey(state, list, { key: e.key, inField: isField(e.target) });
      if (r.state === state && !r.command) return;
      if (e.key !== 'Escape' || state.mode.kind !== 'list') e.preventDefault();
      setState(r.state);
      if (r.command?.kind === 'notice') toast(r.command.text);
      const cmd = r.command;
      if (cmd?.kind === 'approve') {
        const a = list.find((x) => x.id === cmd.id);
        if (a) approve(a, { always: cmd.always });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, list, approve]);

  const current = selected(state, list);
  useEffect(() => {
    if (current) rows.current.get(current.id)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const mode = state.mode;
  const open = mode.kind === 'list' ? null : (list.find((a) => a.id === mode.id) ?? null);
  const cardMode: CardMode = state.mode.kind === 'list' ? 'card' : state.mode.kind;
  const setMode = (m: CardMode) =>
    setState((s) => (s.mode.kind === 'list' ? s : { ...s, mode: { kind: m, id: s.mode.id } }));

  return (
    <div>
      <PageHeader
        title="Needs you"
        description="Actions your Bots want to take outside their sandbox. Nothing happens until you decide."
      >
        <p
          className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle"
          aria-label="Keyboard shortcuts"
        >
          {INBOX_KEYS.slice(0, 2)
            .concat(INBOX_KEYS.slice(4, 6))
            .map((k) => (
              <span key={k.keys}>
                <Kbd>{k.keys}</Kbd> {k.does}
              </span>
            ))}
        </p>
      </PageHeader>
      {approvals.isPending ? (
        <ListSkeleton rows={3} />
      ) : approvals.isError ? (
        <ErrorState error={approvals.error} retry={() => void approvals.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={<CheckCircle2 aria-hidden />} title="Nothing needs you">
          When a Bot wants to send, post or change something outside its workspace, the request
          waits here.
        </EmptyState>
      ) : (
        <ul aria-label="Pending approvals" className="flex flex-col gap-2">
          {list.map((a) => {
            const isSel = current?.id === a.id;
            return (
              <li
                key={a.id}
                ref={(el) => {
                  if (el) rows.current.set(a.id, el);
                  else rows.current.delete(a.id);
                }}
              >
                <button
                  type="button"
                  aria-current={isSel ? 'true' : undefined}
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      selectedId: a.id,
                      moved: false,
                      mode: { kind: 'card', id: a.id },
                    }))
                  }
                  className={cn(
                    'flex w-full cursor-pointer items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-left shadow-card transition-colors hover:border-border-strong',
                    isSel ? 'border-accent ring-1 ring-accent' : 'border-border',
                  )}
                  data-testid="inbox-row"
                >
                  <span
                    aria-hidden
                    className={cn('mt-0.5 w-3 text-accent', isSel ? 'visible' : 'invisible')}
                  >
                    ▸
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{scrubControls(a.card.what)}</span>
                      <TierBadge tier={a.tier} />
                      {a.card.untrusted.length > 0 ? (
                        <span className="text-xs text-warning">⚠ untrusted input</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">
                      {scrubControls(a.card.why)}
                    </p>
                    <p className="mt-1 text-xs text-fg-subtle">
                      {scrubControls(a.card.botName)} · <Time iso={a.createdAt} />
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(o) => (o ? undefined : setState((s) => ({ ...s, mode: { kind: 'list' } })))}
      >
        {open ? (
          <DialogContent
            wide
            title={`${scrubControls(open.card.botName)} wants to: ${scrubControls(open.card.what)}`}
            description="Review the whole card. Nothing happens until you decide."
            // Esc in edit/deny/confirm steps back to the card (the key model), not out of it.
            onEscapeKeyDown={(e) => {
              if (cardMode !== 'card') e.preventDefault();
            }}
          >
            <ApprovalCard
              key={open.id}
              approval={open}
              mode={cardMode}
              onMode={setMode}
              busy={busy}
              onApprove={(opts) => approve(open, opts)}
              onDeny={(reason) => void decide(() => actions.deny(open, reason))}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
