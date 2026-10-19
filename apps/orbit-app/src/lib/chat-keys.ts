/**
 * The chat's keys (ADR-020), pure like the Inbox's and the TUI's. In the
 * message box Enter sends, Shift+Enter breaks the line and Esc leaves the
 * box; elsewhere in the chat / goes to the message box, r to a request
 * waiting in the chat, n starts a new conversation and [ ] move between the
 * Bot's conversations. With focus in a request, the Inbox's keys decide it
 * (`onInboxKey`, src/lib/inbox.ts).
 */

export type ComposerCommand = 'send' | 'leave';

export function composerKey(k: {
  key: string;
  shift: boolean;
  /** An input method is composing: Enter picks a candidate, it never sends. */
  composing: boolean;
}): ComposerCommand | null {
  if (k.composing) return null;
  if (k.key === 'Enter' && !k.shift) return 'send';
  if (k.key === 'Escape') return 'leave';
  return null;
}

export type ChatCommand = 'composer' | 'request' | 'new' | 'previous' | 'next';

export function chatKey(k: {
  key: string;
  /** Typing in a field: none of these are ours. */
  inField: boolean;
  /** Ctrl, ⌘ or Alt held: a browser or Orbit-wide shortcut. */
  modified: boolean;
}): ChatCommand | null {
  if (k.inField || k.modified) return null;
  switch (k.key) {
    case '/':
      return 'composer';
    case 'r':
    case 'R':
      return 'request';
    case 'n':
    case 'N':
      return 'new';
    case '[':
      return 'previous';
    case ']':
      return 'next';
    default:
      return null;
  }
}

/** The conversation `[` or `]` goes to, in the sidebar's order (latest first). */
export function stepConversation(
  ids: readonly string[],
  current: string,
  command: 'previous' | 'next',
): string | null {
  if (ids.length === 0) return null;
  const at = ids.indexOf(current);
  if (at < 0) return command === 'next' ? (ids[0] ?? null) : null;
  return ids[at + (command === 'next' ? 1 : -1)] ?? null;
}

/** Bindings for the help sheet (single source). */
export const CHAT_KEYS: readonly { keys: string; does: string }[] = [
  { keys: 'Enter', does: 'send the message (in the message box)' },
  { keys: 'Shift+Enter', does: 'a new line in the message' },
  { keys: 'Esc', does: 'leave the message box; close the menu or the computer' },
  { keys: '/', does: 'write a message' },
  { keys: 'r', does: 'go to the request waiting in the chat' },
  { keys: 'a e d A (in a request)', does: 'approve, edit, deny, always allow (as in Needs you)' },
  { keys: 'n', does: 'new conversation' },
  { keys: '[ ]', does: 'previous / next conversation' },
];
