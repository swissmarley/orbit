/** @jsxRuntime automatic @jsxImportSource react */
import type { Meta, StoryObj } from '@storybook/react-vite';

const SURFACES = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'border',
  'border-strong',
  'accent',
  'accent-subtle',
];
const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'accent'];
const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'attention'];

function Tokens() {
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-2 text-sm font-semibold">Surfaces</h2>
        <div className="grid grid-cols-4 gap-3">
          {SURFACES.map((t) => (
            <div key={t} className="flex flex-col gap-1 text-xs">
              <div
                className="h-12 rounded-md border border-border"
                style={{ background: `var(--${t})` }}
              />
              <code>--{t}</code>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Text</h2>
        {TEXT.map((t) => (
          <p key={t} style={{ color: `var(--${t})` }}>
            The quick brown fox — <code>--{t}</code>
          </p>
        ))}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">
          Status tones (always with a symbol or a word)
        </h2>
        <div className="flex flex-wrap gap-2">
          {TONES.map((t) => (
            <span
              key={t}
              className="rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ color: `var(--tone-${t})`, background: `var(--tone-${t}-bg)` }}
            >
              ● {t}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Type scale</h2>
        <p className="text-2xl font-semibold tracking-tight">Page title 24</p>
        <p className="text-xl font-semibold tracking-tight">Screen title 20</p>
        <p className="text-base font-medium">Card heading 16</p>
        <p className="text-sm">Body 14</p>
        <p className="text-xs text-fg-muted">Meta 12</p>
        <p className="font-mono text-xs">mono 12 — run_01m45pw58qzzyh674ax23j</p>
      </section>
    </div>
  );
}

const meta: Meta<typeof Tokens> = { title: 'Foundations/Design tokens', component: Tokens };
export default meta;
export const Light: StoryObj<typeof Tokens> = { globals: { theme: 'light' } };
export const Dark: StoryObj<typeof Tokens> = { globals: { theme: 'dark' } };
