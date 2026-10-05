/** @jsxRuntime automatic @jsxImportSource react */
import { useEffect } from 'react';
import { INBOX_KEYS } from '../lib/inbox';
import { MOD } from '../lib/platform';
import { otherModalOpen } from '../lib/modal';
import { createStore, useStore } from '../lib/store';
import { Dialog, DialogContent } from './ui/dialog';
import { Kbd } from './ui/misc';

export const helpStore = createStore(false);

/** Every binding in one place (the Inbox's come from its key model). */
export const GLOBAL_KEYS: readonly { keys: string; does: string }[] = [
  { keys: `${MOD}K`, does: 'search Bots, runs and approvals; run any command' },
  { keys: 'Alt+T', does: 'jump to the latest notification (its Undo button)' },
  { keys: '?', does: 'this help' },
  { keys: 'y', does: 'confirm a question (any other key cancels)' },
  { keys: 'Esc', does: 'close a dialog or step back' },
];
export const MEMORY_KEYS: readonly { keys: string; does: string }[] = [
  { keys: 'j k / ↓ ↑', does: 'move through the memories' },
  { keys: '/', does: 'search the full text' },
];
export const RUN_KEYS: readonly { keys: string; does: string }[] = [
  { keys: '[ ]', does: 'step the replay one event back / forward' },
  { keys: 'L', does: 'back to live' },
];

function isField(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
  );
}

/** "j k / ↓ ↑" → separate keycaps; "a (in the card)" → keycap plus plain words. */
function KeyCaps({ keys }: { keys: string }) {
  const qualifier = /\s*\(([^)]*)\)$/.exec(keys);
  const main = qualifier ? keys.slice(0, qualifier.index) : keys;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {main.split(' / ').map((group, i) => (
        <span key={group} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-fg-subtle">or</span> : null}
          {group.split(' ').map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      ))}
      {qualifier ? <span className="text-xs text-fg-subtle">{qualifier[1]}</span> : null}
    </span>
  );
}

function Section({
  title,
  keys,
}: {
  title: string;
  keys: readonly { keys: string; does: string }[];
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {title}
      </h3>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        {keys.map((k) => (
          <div key={k.keys} className="contents">
            <dt>
              <KeyCaps keys={k.keys} />
            </dt>
            <dd className="text-fg">{k.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function KeyboardHelp() {
  const open = useStore(helpStore);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isField(e.target)) {
        // Never over another dialog (an approval card, a confirmation): close only.
        if (!helpStore.get() && otherModalOpen()) return;
        e.preventDefault();
        helpStore.set((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Dialog open={open} onOpenChange={(o) => helpStore.set(o)}>
      {open ? (
        <DialogContent
          title="Keyboard shortcuts"
          description="Everything in Orbit works from the keyboard."
        >
          <div className="flex flex-col gap-5">
            <Section title="Everywhere" keys={GLOBAL_KEYS} />
            <Section title="Inbox" keys={INBOX_KEYS} />
            <Section title="Run view" keys={RUN_KEYS} />
            <Section title="Memory" keys={MEMORY_KEYS} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
