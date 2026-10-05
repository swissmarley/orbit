/** @jsxRuntime automatic @jsxImportSource react */
import { useEffect } from 'react';
import { INBOX_KEYS } from '../lib/inbox';
import { createStore, useStore } from '../lib/store';
import { Dialog, DialogContent } from './ui/dialog';
import { Kbd } from './ui/misc';

export const helpStore = createStore(false);

/** Every binding in one place (the Inbox's come from its key model). */
export const GLOBAL_KEYS: readonly { keys: string; does: string }[] = [
  { keys: '⌘K / Ctrl+K', does: 'search Bots, runs and approvals; run any command' },
  { keys: '?', does: 'this help' },
  { keys: 'y', does: 'confirm a question (any other key cancels)' },
  { keys: 'Esc', does: 'close a dialog or step back' },
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
              <Kbd>{k.keys}</Kbd>
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
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
