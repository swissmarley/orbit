/** @jsxRuntime automatic @jsxImportSource react */
import {
  AVATAR_CHARACTERS,
  AVATAR_CHARACTER_LABEL,
  AVATAR_COLORS,
  type AvatarCharacter,
  type Bot,
  type BotAvatar as AvatarValue,
  avatarFor,
  scrubControls,
} from '@orbit/core/browser';
import { type ReactNode, useId } from 'react';
import {
  AVATAR_COLOR_LABEL,
  AVATAR_PALETTE,
  type AvatarState,
  describeAvatar,
} from '../lib/avatar';
import { cn } from '../lib/cn';

const INK = '#2a2433';

/** A 5-point star around (32, 35) with a point at the top. */
const STAR = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 23 : 11.5;
    pts.push(`${(32 + r * Math.cos(a)).toFixed(2)} ${(35 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
})();

/** Eyes, smile and cheeks centred on (x, y); closed eyes when the Bot sleeps (paused). */
function Face({
  x,
  y,
  s = 1,
  cheek,
  closed,
  ink = INK,
}: {
  x: number;
  y: number;
  s?: number;
  cheek?: string;
  closed: boolean;
  ink?: string;
}) {
  const dx = 7.2 * s;
  const line = { stroke: ink, strokeWidth: 1.9 * s, fill: 'none', strokeLinecap: 'round' } as const;
  return (
    <g>
      {cheek ? (
        <>
          <ellipse
            cx={x - dx - 3.6 * s}
            cy={y + 4.8 * s}
            rx={2.9 * s}
            ry={1.7 * s}
            fill={cheek}
            opacity={0.6}
          />
          <ellipse
            cx={x + dx + 3.6 * s}
            cy={y + 4.8 * s}
            rx={2.9 * s}
            ry={1.7 * s}
            fill={cheek}
            opacity={0.6}
          />
        </>
      ) : null}
      {closed ? (
        <>
          <path d={`M${x - dx - 2.9 * s} ${y} q ${2.9 * s} ${2.4 * s} ${5.8 * s} 0`} {...line} />
          <path d={`M${x + dx - 2.9 * s} ${y} q ${2.9 * s} ${2.4 * s} ${5.8 * s} 0`} {...line} />
        </>
      ) : (
        <>
          <ellipse cx={x - dx} cy={y} rx={3.1 * s} ry={3.9 * s} fill={ink} />
          <ellipse cx={x + dx} cy={y} rx={3.1 * s} ry={3.9 * s} fill={ink} />
          <circle cx={x - dx + 1.05 * s} cy={y - 1.45 * s} r={1.15 * s} fill="#fff" />
          <circle cx={x + dx + 1.05 * s} cy={y - 1.45 * s} r={1.15 * s} fill="#fff" />
        </>
      )}
      <path d={`M${x - 3.6 * s} ${y + 5.6 * s} q ${3.6 * s} ${3.6 * s} ${7.2 * s} 0`} {...line} />
    </g>
  );
}

function Shine({ x, y, rx = 6.5, ry = 4 }: { x: number; y: number; rx?: number; ry?: number }) {
  return (
    <ellipse
      cx={x}
      cy={y}
      rx={rx}
      ry={ry}
      fill="#fff"
      opacity={0.32}
      transform={`rotate(-32 ${x} ${y})`}
    />
  );
}

/** The character's body and face; `body` is the gradient fill, shared by every shape. */
function Character({
  character,
  body,
  ids,
  closed,
  palette,
}: {
  character: AvatarCharacter;
  body: string;
  ids: string;
  closed: boolean;
  palette: (typeof AVATAR_PALETTE)[keyof typeof AVATAR_PALETTE];
}) {
  const { dark, light, cheek } = palette;
  switch (character) {
    case 'orb':
      return (
        <g>
          <circle cx={32} cy={34} r={22} fill={body} />
          <Shine x={23} y={22} />
          <Face x={32} y={34} cheek={cheek} closed={closed} />
        </g>
      );
    case 'planet': {
      const ring = { cx: 32, cy: 34, rx: 30, ry: 8, transform: 'rotate(-15 32 34)' };
      return (
        <g>
          <defs>
            <clipPath id={`${ids}-front`}>
              <rect x={-10} y={34} width={84} height={40} transform="rotate(-15 32 34)" />
            </clipPath>
          </defs>
          <ellipse {...ring} fill="none" stroke={dark} strokeWidth={3.2} opacity={0.85} />
          <circle cx={32} cy={33} r={18.5} fill={body} />
          <Shine x={25} y={24} rx={5} ry={3.2} />
          <Face x={32} y={31} s={0.85} cheek={cheek} closed={closed} />
          <ellipse
            {...ring}
            fill="none"
            stroke={dark}
            strokeWidth={3.2}
            clipPath={`url(#${ids}-front)`}
          />
        </g>
      );
    }
    case 'star':
      return (
        <g>
          <path d={STAR} fill={body} stroke={body} strokeWidth={6} strokeLinejoin="round" />
          <Face x={32} y={36} s={0.82} cheek={cheek} closed={closed} />
        </g>
      );
    case 'cloud':
      return (
        <g fill={body}>
          <circle cx={22} cy={37} r={11} />
          <circle cx={35} cy={29} r={14.5} />
          <circle cx={46.5} cy={38} r={9.5} />
          <rect x={12} y={35} width={44} height={14} rx={7} />
          <Shine x={29} y={21} rx={5.5} ry={3.2} />
          <Face x={33} y={38} s={0.85} cheek={cheek} closed={closed} />
        </g>
      );
    case 'comet':
      return (
        <g>
          <g fill={light} opacity={0.9}>
            <path d="M27 27 C19 19 12 12 4 6 C14 10 21 14 30 20 Z" />
            <path d="M24 36 C16 33 9 31 2 30 C11 27 18 27 26 29 Z" />
            <path d="M31 21 C27 14 24 9 21 3 C27 8 31 12 35 18 Z" />
          </g>
          <circle cx={38} cy={37} r={17} fill={body} />
          <Shine x={32} y={28} rx={5} ry={3.2} />
          <Face x={38} y={37} s={0.8} cheek={cheek} closed={closed} />
        </g>
      );
    case 'robot':
      return (
        <g>
          <line
            x1={32}
            y1={8}
            x2={32}
            y2={15}
            stroke={dark}
            strokeWidth={2.6}
            strokeLinecap="round"
          />
          <circle cx={32} cy={7} r={3.6} fill={light} stroke={dark} strokeWidth={1.4} />
          <rect x={6.5} y={28} width={6.5} height={12} rx={3} fill={dark} />
          <rect x={51} y={28} width={6.5} height={12} rx={3} fill={dark} />
          <rect x={11} y={14} width={42} height={38} rx={12} fill={body} />
          <rect x={17} y={21.5} width={30} height={22} rx={7.5} fill={INK} opacity={0.92} />
          <Face x={32} y={31} s={0.78} closed={closed} ink={light} />
        </g>
      );
    case 'ghost':
      return (
        <g>
          <path
            d="M14 55 V31 C14 20.5 22 13 32 13 C42 13 50 20.5 50 31 V55 L44 50.5 L38 55 L32 50.5 L26 55 L20 50.5 Z"
            fill={body}
            stroke={body}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <Shine x={24} y={22} rx={5} ry={3.2} />
          <Face x={32} y={32} s={0.92} cheek={cheek} closed={closed} />
        </g>
      );
    case 'cat':
      return (
        <g>
          <g fill={body} stroke={body} strokeWidth={4} strokeLinejoin="round">
            <path d="M13 30 L15.5 9 L30 19 Z" />
            <path d="M51 30 L48.5 9 L34 19 Z" />
          </g>
          <g fill={cheek} opacity={0.55}>
            <path d="M17.5 22 L18.5 13.5 L25 18.5 Z" />
            <path d="M46.5 22 L45.5 13.5 L39 18.5 Z" />
          </g>
          <ellipse cx={32} cy={36} rx={21.5} ry={19} fill={body} />
          <Shine x={23} y={26} rx={5} ry={3.2} />
          <g stroke={INK} strokeWidth={1.3} strokeLinecap="round" opacity={0.45}>
            <line x1={12} y1={40} x2={3} y2={38.5} />
            <line x1={12} y1={43.5} x2={3.5} y2={44.5} />
            <line x1={52} y1={40} x2={61} y2={38.5} />
            <line x1={52} y1={43.5} x2={60.5} y2={44.5} />
          </g>
          <Face x={32} y={35} s={0.9} cheek={cheek} closed={closed} />
          <path d="M30.4 39.4 H33.6 L32 41.2 Z" fill={cheek} />
        </g>
      );
  }
}

/**
 * A Bot's face (ADR-020): one of eight characters in one of eight colours,
 * drawn as inline SVG. `working` sends a little satellite around it,
 * `attention` adds a badge, `paused` closes its eyes. Decorative avatars sit
 * next to the Bot's name and are hidden from screen readers.
 */
export function Avatar({
  avatar,
  name,
  size = 40,
  state = 'idle',
  decorative = false,
  className,
}: {
  avatar: AvatarValue;
  /** The Bot's name: the accessible label unless `decorative`. */
  name?: string;
  size?: number;
  state?: AvatarState;
  decorative?: boolean;
  className?: string;
}) {
  const ids = useId().replace(/:/g, '');
  const palette = AVATAR_PALETTE[avatar.color];
  const label = `${name ? scrubControls(name) : 'Bot'}${
    state === 'working'
      ? ', working'
      : state === 'attention'
        ? ', needs you'
        : state === 'paused'
          ? ', paused'
          : ''
  }`;
  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{
        width: size,
        height: size,
        ...(state === 'idle' && size >= 56
          ? { animation: 'orbit-float 5s ease-in-out infinite' }
          : {}),
      }}
      data-avatar={`${avatar.character}/${avatar.color}`}
    >
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
        style={state === 'paused' ? { filter: 'saturate(0.35)', opacity: 0.85 } : undefined}
      >
        <defs>
          <radialGradient
            id={`${ids}-body`}
            gradientUnits="userSpaceOnUse"
            cx={24}
            cy={20}
            r={44}
            fx={22}
            fy={18}
          >
            <stop offset="0%" stopColor={palette.light} />
            <stop offset="48%" stopColor={palette.base} />
            <stop offset="100%" stopColor={palette.dark} />
          </radialGradient>
        </defs>
        <ellipse cx={32} cy={59} rx={15} ry={2.6} fill="#000" opacity={0.12} />
        <Character
          character={avatar.character}
          body={`url(#${ids}-body)`}
          ids={ids}
          closed={state === 'paused'}
          palette={palette}
        />
        {state === 'working' ? (
          <g style={{ transformOrigin: '32px 34px', animation: 'orbit-spin 2.4s linear infinite' }}>
            <circle
              cx={32}
              cy={4.5}
              r={3.6}
              fill={palette.dark}
              stroke="var(--surface)"
              strokeWidth={1.6}
            />
          </g>
        ) : null}
        {state === 'attention' ? (
          <g>
            <circle
              cx={53}
              cy={11}
              r={8.5}
              fill="var(--tone-attention)"
              stroke="var(--surface)"
              strokeWidth={2.5}
            />
            <rect x={51.8} y={5.6} width={2.4} height={6.6} rx={1.2} fill="var(--on-solid)" />
            <circle cx={53} cy={15.2} r={1.4} fill="var(--on-solid)" />
          </g>
        ) : null}
      </svg>
    </span>
  );
}

/** A Bot's avatar (its own, or its default) with its name as the label. */
export function BotAvatar({
  bot,
  ...props
}: { bot: Pick<Bot, 'id'> & { spec: { name: string; avatar?: AvatarValue | undefined } } } & Omit<
  Parameters<typeof Avatar>[0],
  'avatar' | 'name'
>) {
  return <Avatar avatar={avatarFor(bot)} name={bot.spec.name} {...props} />;
}

function Choice({
  name,
  checked,
  onSelect,
  label,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="relative cursor-pointer" title={label}>
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="peer sr-only"
        aria-label={label}
      />
      <span
        className={cn(
          'flex size-12 items-center justify-center rounded-xl border bg-surface transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
          checked ? 'border-accent bg-accent-subtle' : 'border-border hover:bg-surface-2',
        )}
      >
        {children}
      </span>
    </label>
  );
}

/** Pick a character and a colour (two radio groups: arrow keys move, the avatar previews). */
export function AvatarPicker({
  value,
  onChange,
  name,
  className,
}: {
  value: AvatarValue;
  onChange: (next: AvatarValue) => void;
  name: string;
  className?: string;
}) {
  const group = useId();
  return (
    <div className={cn('flex flex-wrap items-start gap-5', className)}>
      <Avatar avatar={value} name={name || 'Your Bot'} size={88} className="mt-1" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">Character</legend>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_CHARACTERS.map((c) => (
              <Choice
                key={c}
                name={`${group}-character`}
                checked={value.character === c}
                onSelect={() => onChange({ ...value, character: c })}
                label={AVATAR_CHARACTER_LABEL[c]}
              >
                <Avatar avatar={{ ...value, character: c }} size={36} decorative />
              </Choice>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-fg-muted">Colour</legend>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_COLORS.map((c) => (
              <Choice
                key={c}
                name={`${group}-color`}
                checked={value.color === c}
                onSelect={() => onChange({ ...value, color: c })}
                label={AVATAR_COLOR_LABEL[c]}
              >
                <Avatar avatar={{ ...value, color: c }} size={36} decorative />
              </Choice>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-fg-subtle" aria-live="polite">
          {describeAvatar(value)}
        </p>
      </div>
    </div>
  );
}
