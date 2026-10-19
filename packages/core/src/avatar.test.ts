import { describe, expect, it } from 'vitest';
import {
  AVATAR_CHARACTERS,
  AVATAR_COLORS,
  BotAvatar,
  avatarFor,
  defaultAvatar,
  freeAvatar,
} from './avatar';
import { BotSpec } from './bot';

describe('Bot avatars (ADR-020)', () => {
  it('the default is stable for an id and always valid', () => {
    expect(defaultAvatar('bot_01abc')).toEqual(defaultAvatar('bot_01abc'));
    for (let i = 0; i < 200; i++) {
      expect(BotAvatar.safeParse(defaultAvatar(`bot_${i}`)).success).toBe(true);
    }
  });

  it('defaults spread over characters and colours', () => {
    const seen = new Set(
      Array.from({ length: 400 }, (_, i) => {
        const a = defaultAvatar(`bot_${i}`);
        return `${a.character}/${a.color}`;
      }),
    );
    expect(seen.size).toBeGreaterThan(48);
  });

  it("a Bot shows its own avatar, else its id's default", () => {
    const own = { character: 'cat', color: 'teal' } as const;
    expect(avatarFor({ id: 'bot_1', spec: { avatar: own } })).toEqual(own);
    expect(avatarFor({ id: 'bot_1', spec: {} })).toEqual(defaultAvatar('bot_1'));
  });

  it('a new Bot gets an avatar nobody shows yet, and the default once all are taken', () => {
    const first = freeAvatar('seed', []);
    expect(first).toEqual(defaultAvatar('seed'));
    expect(freeAvatar('seed', [first])).not.toEqual(first);
    const all = AVATAR_COLORS.flatMap((color) =>
      AVATAR_CHARACTERS.map((character) => ({ character, color })),
    );
    expect(freeAvatar('seed', all)).toEqual(first);
  });

  it('the spec accepts an avatar from the vocabulary only, and none at all', () => {
    const base = { name: 'Scout', goal: 'Find things' };
    expect(BotSpec.parse(base).avatar).toBeUndefined();
    expect(
      BotSpec.parse({ ...base, avatar: { character: 'robot', color: 'amber' } }).avatar,
    ).toEqual({ character: 'robot', color: 'amber' });
    expect(
      BotSpec.safeParse({ ...base, avatar: { character: 'dragon', color: 'amber' } }).success,
    ).toBe(false);
    expect(
      BotSpec.safeParse({ ...base, avatar: { character: 'robot', color: 'url(x)' } }).success,
    ).toBe(false);
  });
});
