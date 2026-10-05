/** ⌘ on Apple platforms, Ctrl+ elsewhere (for key hints). */
export const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
