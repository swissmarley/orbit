/** @jsxRuntime automatic @jsxImportSource react */
import { scrubControls } from '@orbit/core/browser';
import type { Approval } from '@orbit/sdk-client/browser';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, Pencil, ShieldAlert, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { lineDiff, parseUnified, prettyJson } from '../lib/diff';
import { alwaysAllowText } from '../lib/inbox';
import { MOD } from '../lib/platform';
import { DiffView } from './diff-view';
import { TierBadge, Time } from './status';
import { ALWAYS_ALLOW_ROLE } from '../lib/role';
import { RoleGate } from './role-gate';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Kbd } from './ui/misc';

export type CardMode = 'card' | 'edit' | 'deny' | 'always';

/** Parse edited arguments: a JSON object, or an error to show. */
export function parseEdited(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: 'The arguments must be a JSON object.' };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The whole approval card, unclipped: what the Bot wants to do, why, the
 * exact arguments (or the diff), where untrusted content came in, and the
 * risk. Every decision is made here: a approves, e edits then approves,
 * A always-allows after an explicit confirmation, d denies with a reason.
 */
export function ApprovalCard({
  approval,
  mode,
  onMode,
  onApprove,
  onDeny,
  busy = false,
  titled = false,
  inline = false,
}: {
  approval: Approval;
  mode: CardMode;
  onMode: (m: CardMode) => void;
  onApprove: (opts: { editedInput?: Record<string, unknown>; always?: boolean }) => void;
  onDeny: (reason: string | null) => void;
  busy?: boolean;
  /** The surrounding dialog's title already says what the Bot wants: don't repeat it. */
  titled?: boolean;
  /** In a chat (ADR-020): no sticky footer; the keys work with focus in the card. */
  inline?: boolean;
}) {
  const c = approval.card;
  const ids = useId();
  const original = useMemo(() => prettyJson(approval.input), [approval.input]);
  const [edited, setEdited] = useState(original);
  const [reason, setReason] = useState('');
  const parsed = parseEdited(edited);
  const editDiff = useMemo(() => lineDiff(original, edited), [original, edited]);
  const financial = approval.tier === 'FINANCIAL';
  const redacted = original.includes('[REDACTED:');

  return (
    <div className="flex flex-col gap-4" data-testid="approval-card">
      <div role="group" aria-label="Summary" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={approval.tier} />
          <span className="font-mono text-xs text-fg-muted">
            {scrubControls(approval.toolName)}
          </span>
          <span className="text-xs text-fg-subtle">
            asked <Time iso={approval.createdAt} />
            {approval.expiresAt ? (
              <>
                {' '}
                · expires <Time iso={approval.expiresAt} mode="relative" />
              </>
            ) : null}
          </span>
        </div>
        {titled ? null : <p className="text-base font-medium text-fg">{scrubControls(c.what)}</p>}
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-fg-muted">Why</dt>
          <dd className="whitespace-pre-wrap text-fg">{scrubControls(c.why)}</dd>
          <dt className="text-fg-muted">Bot</dt>
          <dd>
            <Link
              to="/bots/$botId"
              params={{ botId: approval.botId }}
              className="text-accent hover:underline"
            >
              {scrubControls(c.botName)}
            </Link>{' '}
            ·{' '}
            <Link
              to="/runs/$runId"
              params={{ runId: approval.runId }}
              className="font-mono text-xs text-accent hover:underline"
            >
              {approval.runId}
            </Link>
          </dd>
          <dt className="text-fg-muted">Risk</dt>
          <dd className="text-fg">{scrubControls(c.risk)}</dd>
        </dl>
      </div>

      {c.untrusted.length > 0 ? (
        <div
          role="note"
          className="flex gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Untrusted content influenced this run</p>
            <p>
              Check the arguments carefully — they may have been written by:{' '}
              {c.untrusted.map(scrubControls).join(', ')}
            </p>
          </div>
        </div>
      ) : null}

      {c.delegatedBy ? (
        <div
          role="note"
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
        >
          <span aria-hidden>⇢</span> Delegated by another Bot:{' '}
          <span className="font-medium">{scrubControls(c.delegatedBy)}</span>. Its task text was
          written by a Bot, not by you.
        </div>
      ) : null}

      {financial ? (
        <div
          role="note"
          className="flex gap-2 rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>Financial actions are never executed by a Bot. Do it yourself if you want it done.</p>
        </div>
      ) : null}

      {mode === 'edit' ? (
        <div role="group" aria-label="Edit arguments" className="flex flex-col gap-2">
          <label htmlFor={`${ids}-edit`} className="text-xs font-medium text-fg-muted">
            Arguments (JSON) — the tool runs with exactly these
          </label>
          {redacted ? (
            <p id={`${ids}-edit-redacted`} className="text-xs text-warning">
              ⚠ Values shown as [REDACTED:…] are hidden from you: replace them with the real value,
              or approve without editing.
            </p>
          ) : null}
          <Textarea
            id={`${ids}-edit`}
            className="min-h-48 font-mono text-xs"
            value={edited}
            spellCheck={false}
            aria-invalid={!parsed.ok}
            aria-describedby={
              [parsed.ok ? null : `${ids}-edit-error`, redacted ? `${ids}-edit-redacted` : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(e) => setEdited(e.target.value)}
            onKeyDown={(e) => {
              // Esc leaves edit mode (back to the card), even with focus in the field.
              if (e.key === 'Escape') {
                e.preventDefault();
                onMode('card');
                // The field is gone: keep focus on the step it came from.
                requestAnimationFrame(() => document.getElementById(`${ids}-edit-button`)?.focus());
                return;
              }
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                parsed.ok &&
                !busy &&
                !financial
              ) {
                e.preventDefault();
                onApprove({ editedInput: parsed.value });
              }
            }}
            autoFocus
          />
          {parsed.ok ? null : (
            <p id={`${ids}-edit-error`} role="alert" className="text-xs text-danger">
              {parsed.error}
            </p>
          )}
          <DiffView
            lines={editDiff.filter((l) => l.kind !== 'ctx')}
            label="Your changes"
            maxHeight="max-h-40"
          />
        </div>
      ) : (
        <div role="group" aria-label="Arguments" className="flex flex-col gap-2">
          {c.diff ? <DiffView lines={parseUnified(c.diff)} label="What it changes" /> : null}
          <figure className="overflow-hidden rounded-md border border-border">
            <figcaption className="border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
              Exact arguments
            </figcaption>
            <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-fg">
              {scrubControls(prettyJson(c.payload))}
            </pre>
          </figure>
        </div>
      )}

      {mode === 'deny' ? (
        <div role="group" aria-label="Deny" className="flex flex-col gap-2">
          <label htmlFor={`${ids}-reason`} className="text-xs font-medium text-fg-muted">
            Reason (the Bot sees it; optional)
          </label>
          <Textarea
            id={`${ids}-reason`}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onMode('card');
                requestAnimationFrame(() => document.getElementById(`${ids}-deny-button`)?.focus());
              }
            }}
            placeholder="e.g. Don't email customers directly — draft it for me instead."
            autoFocus
          />
        </div>
      ) : null}

      {mode === 'always' ? (
        <div
          role="alertdialog"
          aria-labelledby={`${ids}-always`}
          tabIndex={-1}
          className="rounded-md border border-attention/40 bg-attention-bg px-3 py-2 text-sm text-attention focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p id={`${ids}-always`} className="font-medium">
            {alwaysAllowText(approval)}
          </p>
          <p className="mt-1 text-xs">
            Press <Kbd>y</Kbd> to confirm, <Kbd>n</Kbd> or <Kbd>Esc</Kbd> to cancel.
          </p>
        </div>
      ) : null}

      <div
        className={
          inline
            ? 'flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3'
            : 'sticky bottom-0 -mx-5 -mb-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3'
        }
      >
        {mode === 'card' ? (
          <>
            <RoleGate route="deny">
              <Button
                id={`${ids}-deny-button`}
                variant="ghost"
                onClick={() => onMode('deny')}
                disabled={busy}
              >
                <X aria-hidden /> Deny <Kbd>d</Kbd>
              </Button>
            </RoleGate>
            <RoleGate route="approve">
              <Button
                id={`${ids}-edit-button`}
                onClick={() => onMode('edit')}
                disabled={busy || financial}
              >
                <Pencil aria-hidden /> Edit <Kbd>e</Kbd>
              </Button>
            </RoleGate>
            <RoleGate role={ALWAYS_ALLOW_ROLE}>
              <Button onClick={() => onMode('always')} disabled={busy || financial}>
                Always allow <Kbd>⇧A</Kbd>
              </Button>
            </RoleGate>
            <RoleGate route="approve">
              <Button variant="success" onClick={() => onApprove({})} disabled={busy || financial}>
                <Check aria-hidden /> Approve{' '}
                <Kbd className="border-transparent bg-black/15 text-inherit">a</Kbd>
              </Button>
            </RoleGate>
          </>
        ) : null}
        {mode === 'edit' ? (
          <>
            <Button variant="ghost" onClick={() => onMode('card')}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button
              variant="success"
              disabled={busy || !parsed.ok || financial}
              onClick={() => {
                if (parsed.ok) onApprove({ editedInput: parsed.value });
              }}
            >
              <Check aria-hidden /> Approve edited{' '}
              <Kbd className="border-transparent bg-black/15 text-inherit">{MOD}↵</Kbd>
            </Button>
          </>
        ) : null}
        {mode === 'deny' ? (
          <>
            <Button variant="ghost" onClick={() => onMode('card')}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => onDeny(reason.trim() || null)}>
              <X aria-hidden /> Deny
            </Button>
          </>
        ) : null}
        {mode === 'always' ? (
          <>
            <Button variant="ghost" onClick={() => onMode('card')}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button
              variant="success"
              disabled={busy || financial}
              onClick={() => onApprove({ always: true })}
            >
              Yes, always allow <Kbd className="border-transparent bg-black/15 text-inherit">y</Kbd>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
