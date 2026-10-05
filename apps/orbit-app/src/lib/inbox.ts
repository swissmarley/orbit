import { scrubControls } from '@orbit/core/browser';
import type { Approval } from '@orbit/sdk-client/browser';

/**
 * The Inbox ("Needs you") key model, pure like the TUI's: j/k move, Enter or
 * a opens the full card, e opens it in edit mode, d asks for a deny reason.
 * Approving happens only from the open card (a there), never from the list,
 * and the selection follows the card's id: when the card under the cursor
 * is replaced (decided elsewhere, expired) the next decision key is a no-op.
 */
export type InboxMode =
  | { kind: 'list' }
  | { kind: 'card'; id: string }
  | { kind: 'edit'; id: string }
  | { kind: 'deny'; id: string }
  | { kind: 'always'; id: string };

export interface InboxState {
  selectedId: string | null;
  /** The selected card was replaced under the cursor. */
  moved: boolean;
  mode: InboxMode;
}

export const INITIAL_INBOX: InboxState = { selectedId: null, moved: false, mode: { kind: 'list' } };

export type InboxCommand =
  { kind: 'approve'; id: string; always: boolean } | { kind: 'notice'; text: string };

export interface InboxKey {
  /** KeyboardEvent.key: 'a' approves, 'A' (any way it is typed) asks to always allow. */
  key: string;
  /** Typing in a field: only Escape is ours. */
  inField?: boolean;
}

export function selected(state: InboxState, list: readonly Approval[]): Approval | undefined {
  return list.find((a) => a.id === state.selectedId) ?? list[0];
}

/** Keep the selection valid after the list changed (follows the id). */
export function reconcileInbox(state: InboxState, list: readonly Approval[]): InboxState {
  let { selectedId, moved, mode } = state;
  if (selectedId !== null && !list.some((a) => a.id === selectedId)) {
    const replacement = list[0]?.id ?? null;
    if (replacement !== null) moved = true;
    selectedId = replacement;
  }
  if (selectedId === null && list[0]) selectedId = list[0].id;
  if (mode.kind !== 'list') {
    const id = mode.id;
    if (!list.some((a) => a.id === id)) mode = { kind: 'list' };
  }
  if (selectedId === state.selectedId && moved === state.moved && mode === state.mode) return state;
  return { selectedId, moved, mode };
}

export function onInboxKey(
  state: InboxState,
  list: readonly Approval[],
  k: InboxKey,
): { state: InboxState; command?: InboxCommand } {
  // Caps Lock must not change what a key does: navigation keys fold case; a
  // and A stay distinct (A only ever asks, so the safe reading wins).
  const key = /^[JKED]$/.test(k.key) ? k.key.toLowerCase() : k.key;
  const { mode } = state;
  if (key === 'Escape') {
    return {
      state: {
        ...state,
        mode:
          mode.kind === 'list'
            ? mode
            : mode.kind === 'card'
              ? { kind: 'list' }
              : { kind: 'card', id: mode.id },
      },
    };
  }
  if (k.inField) return { state };

  if (mode.kind === 'always') {
    // Only an explicit y confirms "always allow"; n cancels (Esc is handled
    // above). Other keys (Tab, screen-reader navigation) are ignored so the
    // buttons stay reachable.
    if (key === 'y') {
      return {
        state: { ...state, mode: { kind: 'list' } },
        command: { kind: 'approve', id: mode.id, always: true },
      };
    }
    if (key === 'n') {
      return {
        state: { ...state, mode: { kind: 'card', id: mode.id } },
        command: { kind: 'notice', text: 'Cancelled' },
      };
    }
    return { state };
  }
  if (mode.kind === 'card') {
    // FINANCIAL is never approved (handed back); the server never queues it either.
    const tier = list.find((a) => a.id === mode.id)?.tier;
    if (tier === 'FINANCIAL' && (key === 'a' || key === 'A' || key === 'e')) {
      return {
        state,
        command: { kind: 'notice', text: 'Financial actions are never executed by a Bot' },
      };
    }
    if (key === 'a')
      return {
        state: { ...state, mode: { kind: 'list' } },
        command: { kind: 'approve', id: mode.id, always: false },
      };
    if (key === 'A') return { state: { ...state, mode: { kind: 'always', id: mode.id } } };
    if (key === 'e') return { state: { ...state, mode: { kind: 'edit', id: mode.id } } };
    if (key === 'd') return { state: { ...state, mode: { kind: 'deny', id: mode.id } } };
    return { state };
  }
  if (mode.kind !== 'list') return { state };

  const at = Math.max(
    0,
    list.findIndex((a) => a.id === state.selectedId),
  );
  if (key === 'j' || key === 'ArrowDown' || key === 'k' || key === 'ArrowUp') {
    const step = key === 'j' || key === 'ArrowDown' ? 1 : -1;
    const next = list[Math.min(list.length - 1, Math.max(0, at + step))];
    return { state: { ...state, selectedId: next?.id ?? null, moved: false } };
  }
  const current = selected(state, list);
  if (!current) return { state };
  const decision = key === 'a' || key === 'A' || key === 'e' || key === 'd' || key === 'Enter';
  if (decision && state.moved) {
    return {
      state: { ...state, selectedId: current.id, moved: false },
      command: { kind: 'notice', text: 'The selected card changed — review it, then press again' },
    };
  }
  // Approving always goes through the full card.
  if (key === 'Enter' || key === 'a' || key === 'A')
    return { state: { ...state, selectedId: current.id, mode: { kind: 'card', id: current.id } } };
  if (key === 'e')
    return { state: { ...state, selectedId: current.id, mode: { kind: 'edit', id: current.id } } };
  if (key === 'd')
    return { state: { ...state, selectedId: current.id, mode: { kind: 'deny', id: current.id } } };
  return { state };
}

/** Bindings for the help sheet and the footer (single source). */
export const INBOX_KEYS: readonly { keys: string; does: string }[] = [
  { keys: 'j k / ↓ ↑', does: 'move between cards' },
  { keys: 'Enter / a', does: 'open the whole card' },
  { keys: 'a (in the card)', does: 'approve' },
  {
    keys: 'A (in the card)',
    does: 'approve and always allow this tool for the Bot (7 days, asks first)',
  },
  { keys: 'e', does: 'edit the arguments, then approve' },
  { keys: 'd', does: 'deny, with a reason the Bot will see' },
  { keys: 'Esc', does: 'back' },
];

/** What "always allow" means, said before it happens. */
export function alwaysAllowText(a: Approval): string {
  return `Always allow ${scrubControls(a.toolName)} for ${scrubControls(a.card.botName)}, with any arguments, for 7 days? Runs that read untrusted content still ask.`;
}
