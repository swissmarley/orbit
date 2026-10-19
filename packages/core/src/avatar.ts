import { z } from 'zod';

/**
 * Bot avatars (ADR-020): a character and a colour from a fixed vocabulary.
 * Clients draw them (the App as inline SVG); nothing is uploaded or fetched,
 * so an avatar can never carry content.
 */
export const AVATAR_CHARACTERS = [
  'orb',
  'planet',
  'star',
  'cloud',
  'comet',
  'robot',
  'ghost',
  'cat',
] as const;
export const AVATAR_COLORS = [
  'violet',
  'blue',
  'teal',
  'green',
  'amber',
  'coral',
  'rose',
  'slate',
] as const;

export const AvatarCharacter = z.enum(AVATAR_CHARACTERS);
export type AvatarCharacter = z.infer<typeof AvatarCharacter>;
export const AvatarColor = z.enum(AVATAR_COLORS);
export type AvatarColor = z.infer<typeof AvatarColor>;

export const BotAvatar = z.object({ character: AvatarCharacter, color: AvatarColor });
export type BotAvatar = z.infer<typeof BotAvatar>;

/** How each character is named to people (pickers, accessible labels). */
export const AVATAR_CHARACTER_LABEL: Record<AvatarCharacter, string> = {
  orb: 'Orb',
  planet: 'Planet',
  star: 'Star',
  cloud: 'Cloud',
  comet: 'Comet',
  robot: 'Robot',
  ghost: 'Ghost',
  cat: 'Cat',
};

/** FNV-1a: stable across clients and releases, so a default never changes. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The avatar a Bot without one shows, the same in every client (derived from its id). */
export function defaultAvatar(botId: string): BotAvatar {
  const h = fnv1a(botId);
  return {
    character: AVATAR_CHARACTERS[h % AVATAR_CHARACTERS.length] ?? 'orb',
    color:
      AVATAR_COLORS[Math.floor(h / AVATAR_CHARACTERS.length) % AVATAR_COLORS.length] ?? 'violet',
  };
}

/** The avatar a Bot shows: the one in its spec, else its default. */
export function avatarFor(bot: {
  id: string;
  spec: { avatar?: BotAvatar | undefined };
}): BotAvatar {
  return bot.spec.avatar ?? defaultAvatar(bot.id);
}

/**
 * An avatar no other Bot shows yet (for a new Bot), in vocabulary order after
 * `seed`'s default; when all 64 are taken, the default.
 */
export function freeAvatar(seed: string, taken: readonly BotAvatar[]): BotAvatar {
  const used = new Set(taken.map((a) => `${a.character}/${a.color}`));
  const first = defaultAvatar(seed);
  const total = AVATAR_CHARACTERS.length * AVATAR_COLORS.length;
  const start =
    AVATAR_COLORS.indexOf(first.color) * AVATAR_CHARACTERS.length +
    AVATAR_CHARACTERS.indexOf(first.character);
  for (let i = 0; i < total; i++) {
    const n = (start + i) % total;
    const candidate: BotAvatar = {
      character: AVATAR_CHARACTERS[n % AVATAR_CHARACTERS.length] ?? 'orb',
      color: AVATAR_COLORS[Math.floor(n / AVATAR_CHARACTERS.length)] ?? 'violet',
    };
    if (!used.has(`${candidate.character}/${candidate.color}`)) return candidate;
  }
  return first;
}
