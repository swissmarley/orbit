import type { ComputerTab } from './conversation';
import { type Store, createStore } from './store';

/** A store kept in this origin's storage (a preference, never anything secret). */
function persisted<T extends string | boolean>(key: string, initial: T): Store<T> {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const v = JSON.parse(raw) as unknown;
      if (typeof v === typeof initial) start = v as T;
    }
  } catch {
    // storage unavailable: defaults
  }
  const store = createStore<T>(start);
  store.subscribe(() => {
    try {
      localStorage.setItem(key, JSON.stringify(store.get()));
    } catch {
      // ignore
    }
  });
  return store;
}

/** The computer panel beside the chat (ADR-020): open or not, and which tab. */
export const computerOpenStore = persisted<boolean>('orbit.computer.open', false);
export const computerTabStore = createStore<ComputerTab>('activity');
/** A workspace path the Files tab should show (a tool card's "open on the computer"). */
export const computerPathStore = createStore<string | null>(null);

/** The sidebar: collapsed on wide screens; open as a drawer on narrow ones. */
export const sidebarCollapsedStore = persisted<boolean>('orbit.sidebar.collapsed', false);
export const drawerStore = createStore(false);

/** The Bot the owner last talked to: where "home" goes. */
export const lastBotStore = persisted<string>('orbit.lastBot', '');

/** Open the computer panel on a tab (from an inline tool card). */
export function showComputer(tab: ComputerTab, path: string | null = null): void {
  computerTabStore.set(tab);
  if (path !== null) computerPathStore.set(path);
  computerOpenStore.set(true);
}
