/** @jsxRuntime automatic @jsxImportSource react */
import { useEffect } from 'react';
import { createStore, useStore } from '../lib/store';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter } from './ui/dialog';
import { Kbd } from './ui/misc';

interface Ask {
  title: string;
  body: string;
  confirm: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const askStore = createStore<Ask | null>(null);

/** A confirmation is on screen (page-level key handlers stand down). */
export function confirmOpen(): boolean {
  return askStore.get() !== null;
}

/**
 * Ask before something hard to undo. Resolves true only on the confirm
 * button or y (like the TUI: Enter does not confirm).
 */
export function confirmAction(opts: {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    askStore.get()?.resolve(false);
    askStore.set({ ...opts, danger: opts.danger ?? false, resolve });
  });
}

export function ConfirmHost() {
  const ask = useStore(askStore);
  const close = (ok: boolean) => {
    ask?.resolve(ok);
    askStore.set(null);
  };
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'y' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        ask.resolve(true);
        askStore.set(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask]);
  return (
    <Dialog open={ask !== null} onOpenChange={(open) => (open ? undefined : close(false))}>
      {ask ? (
        <DialogContent title={ask.title} description={ask.body}>
          <DialogFooter className="mt-0 border-t-0 pt-0">
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel <Kbd>Esc</Kbd>
            </Button>
            <Button variant={ask.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {ask.confirm} <Kbd className="border-transparent bg-black/15 text-inherit">y</Kbd>
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
