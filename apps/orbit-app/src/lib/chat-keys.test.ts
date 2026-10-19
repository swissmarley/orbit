import { describe, expect, it } from 'vitest';
import { chatKey, composerKey, stepConversation } from './chat-keys';

describe('chat keys', () => {
  it('in the message box, Enter sends and Shift+Enter or an input method do not', () => {
    expect(composerKey({ key: 'Enter', shift: false, composing: false })).toBe('send');
    expect(composerKey({ key: 'Enter', shift: true, composing: false })).toBeNull();
    expect(composerKey({ key: 'Enter', shift: false, composing: true })).toBeNull();
    expect(composerKey({ key: 'Escape', shift: false, composing: false })).toBe('leave');
    expect(composerKey({ key: 'a', shift: false, composing: false })).toBeNull();
  });

  it('elsewhere, single keys move around; never while typing or with a modifier', () => {
    const at = (key: string) => chatKey({ key, inField: false, modified: false });
    expect(['/', 'r', 'n', '[', ']'].map(at)).toEqual([
      'composer',
      'request',
      'new',
      'previous',
      'next',
    ]);
    expect(at('R')).toBe('request');
    expect(at('x')).toBeNull();
    expect(chatKey({ key: 'n', inField: true, modified: false })).toBeNull();
    expect(chatKey({ key: 'n', inField: false, modified: true })).toBeNull();
  });

  it('[ and ] step through the conversations as the sidebar lists them', () => {
    const ids = ['c3', 'c2', 'c1'];
    expect(stepConversation(ids, 'c2', 'next')).toBe('c1');
    expect(stepConversation(ids, 'c2', 'previous')).toBe('c3');
    expect(stepConversation(ids, 'c1', 'next')).toBeNull();
    expect(stepConversation(ids, 'c3', 'previous')).toBeNull();
    // From a new conversation, ] opens the latest one.
    expect(stepConversation(ids, '', 'next')).toBe('c3');
    expect(stepConversation(ids, '', 'previous')).toBeNull();
    expect(stepConversation([], 'c1', 'next')).toBeNull();
  });
});
