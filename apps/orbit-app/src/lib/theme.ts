import { createStore } from './store';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'orbit.theme';

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const themeStore = createStore<ThemeChoice>(
  typeof localStorage === 'undefined' ? 'system' : stored(),
);

/** Apply a theme choice to <html> (system = follow prefers-color-scheme). */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  themeStore.set(choice);
  applyTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // private mode: the choice lasts for this tab
  }
}

/** The theme actually showing. */
export function effectiveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
