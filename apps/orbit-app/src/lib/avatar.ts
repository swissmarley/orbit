import {
  AVATAR_CHARACTER_LABEL,
  type AvatarColor,
  type Bot,
  type BotAvatar,
  avatarFor,
} from '@orbit/core/browser';

/** Shading of each avatar colour: highlight, body and shadow, plus the cheeks. */
export const AVATAR_PALETTE: Record<
  AvatarColor,
  { light: string; base: string; dark: string; cheek: string }
> = {
  violet: { light: '#d6ceff', base: '#9384ff', dark: '#5a47d4', cheek: '#ff9ec4' },
  blue: { light: '#c3ddff', base: '#5f9fff', dark: '#2c63d4', cheek: '#ff9ec4' },
  teal: { light: '#b8eee3', base: '#4cb8a4', dark: '#22806d', cheek: '#ff9e9e' },
  green: { light: '#d5f1bb', base: '#7cc561', dark: '#448e37', cheek: '#ff9e9e' },
  amber: { light: '#ffeab0', base: '#f6b93a', dark: '#c78406', cheek: '#ff8f70' },
  coral: { light: '#ffd2c2', base: '#ff8b65', dark: '#d65733', cheek: '#ff6f8f' },
  rose: { light: '#ffcfe2', base: '#f173a9', dark: '#c1417c', cheek: '#ff6f8f' },
  slate: { light: '#dee4ec', base: '#95a2b4', dark: '#5b687b', cheek: '#ff9ec4' },
};

export const AVATAR_COLOR_LABEL: Record<AvatarColor, string> = {
  violet: 'violet',
  blue: 'blue',
  teal: 'teal',
  green: 'green',
  amber: 'amber',
  coral: 'coral',
  rose: 'rose',
  slate: 'slate',
};

/** "violet orb": how an avatar is described to screen readers and in pickers. */
export function describeAvatar(a: BotAvatar): string {
  return `${AVATAR_COLOR_LABEL[a.color]} ${AVATAR_CHARACTER_LABEL[a.character].toLowerCase()}`;
}

/** What an avatar shows besides the Bot itself. */
export type AvatarState = 'idle' | 'working' | 'attention' | 'paused';

export { avatarFor };
export type { Bot, BotAvatar };
