import type { Approval } from '@orbit/sdk-client/browser';
import { describe, expect, it } from 'vitest';
import { INITIAL_INBOX, type InboxState, onInboxKey, reconcileInbox } from './inbox';

const card = (id: string): Approval =>
  ({ id, toolName: 'mcp__gmail__send_email', card: { botName: 'Mailer' } }) as unknown as Approval;
const LIST = [card('a1'), card('a2'), card('a3')];
const press = (s: InboxState, key: string, extra: { inField?: boolean } = {}, list = LIST) =>
  onInboxKey(s, list, { key, ...extra });
const start = reconcileInbox(INITIAL_INBOX, LIST);

describe('Inbox key model', () => {
  it('j/k (and arrows) move within bounds', () => {
    expect(start.selectedId).toBe('a1');
    let s = press(start, 'j').state;
    s = press(s, 'ArrowDown').state;
    s = press(s, 'j').state;
    expect(s.selectedId).toBe('a3');
    expect(press(press(start, 'k').state, 'ArrowUp').state.selectedId).toBe('a1');
  });

  it('a, A and Enter in the list only open the full card — never approve', () => {
    for (const key of ['a', 'A', 'Enter']) {
      const r = press(start, key);
      expect(r.command).toBeUndefined();
      expect(r.state.mode).toEqual({ kind: 'card', id: 'a1' });
    }
  });

  it('in the card: a approves, e edits, d asks for a reason, Esc steps back', () => {
    const open = press(start, 'Enter').state;
    expect(press(open, 'a').command).toEqual({ kind: 'approve', id: 'a1', always: false });
    expect(press(open, 'e').state.mode).toEqual({ kind: 'edit', id: 'a1' });
    const deny = press(open, 'd').state;
    expect(deny.mode).toEqual({ kind: 'deny', id: 'a1' });
    // Typing a reason never triggers bindings; Esc returns to the card, then the list.
    expect(press(deny, 'a', { inField: true }).command).toBeUndefined();
    const back = press(deny, 'Escape').state;
    expect(back.mode).toEqual({ kind: 'card', id: 'a1' });
    expect(press(back, 'Escape').state.mode).toEqual({ kind: 'list' });
  });

  it('e and d work from the list too (both still show the whole card)', () => {
    expect(press(start, 'e').state.mode).toEqual({ kind: 'edit', id: 'a1' });
    expect(press(start, 'd').state.mode).toEqual({ kind: 'deny', id: 'a1' });
  });

  it('always-allow needs an explicit y; n cancels; Tab and other keys leave it open', () => {
    const open = press(start, 'Enter').state;
    const ask = press(open, 'A').state;
    expect(ask.mode).toEqual({ kind: 'always', id: 'a1' });
    expect(press(ask, 'y').command).toEqual({ kind: 'approve', id: 'a1', always: true });
    expect(press(ask, 'Tab').state).toBe(ask);
    expect(press(ask, 'Enter').command).toBeUndefined();
    const no = press(ask, 'n');
    expect(no.command).toEqual({ kind: 'notice', text: 'Cancelled' });
    expect(no.state.mode).toEqual({ kind: 'card', id: 'a1' });
  });

  it('the selection follows its card; a replaced card makes the next decision key a no-op', () => {
    const onSecond = press(start, 'j').state;
    // A card arrives before it: still on a2.
    const grown = [card('a0'), ...LIST];
    expect(reconcileInbox(onSecond, grown).selectedId).toBe('a2');
    // a2 is decided elsewhere: the cursor lands on another card, flagged as moved.
    const shrunk = LIST.filter((a) => a.id !== 'a2');
    const moved = reconcileInbox(onSecond, shrunk);
    expect(moved.moved).toBe(true);
    const r = press(moved, 'Enter', {}, shrunk);
    expect(r.state.mode).toEqual({ kind: 'list' });
    expect(r.command).toMatchObject({ kind: 'notice' });
    // Once seen, the next press opens it.
    expect(press(r.state, 'Enter', {}, shrunk).state.mode.kind).toBe('card');
  });

  it('Caps Lock: J/K/E/D still navigate; A still only asks', () => {
    expect(press(start, 'J').state.selectedId).toBe('a2');
    const open = press(start, 'Enter').state;
    expect(press(open, 'A').command).toBeUndefined();
    expect(press(open, 'E').state.mode.kind).toBe('edit');
  });

  it('a FINANCIAL card cannot be approved, always-allowed or edited from the keyboard', () => {
    const money = [{ ...card('f1'), tier: 'FINANCIAL' } as Approval];
    const open = reconcileInbox({ ...INITIAL_INBOX, mode: { kind: 'card', id: 'f1' } }, money);
    for (const key of ['a', 'A', 'e']) {
      const r = press(open, key, {}, money);
      expect(r.command).toEqual({
        kind: 'notice',
        text: 'Financial actions are never executed by a Bot',
      });
      expect(r.state.mode).toEqual({ kind: 'card', id: 'f1' });
    }
  });

  it('an open card that disappears closes', () => {
    const open = press(start, 'Enter').state;
    expect(reconcileInbox(open, LIST.slice(1)).mode).toEqual({ kind: 'list' });
    expect(reconcileInbox(start, LIST)).toBe(start);
  });
});
