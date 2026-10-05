import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach } from 'vitest';

// jsdom lacks these browser APIs the UI uses; the stubs do nothing on purpose.
const noop = () => undefined;
class ResizeObserverStub {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
Object.assign(window, {
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  }),
});
Object.assign(Element.prototype, {
  scrollIntoView: noop,
  hasPointerCapture: () => false,
  releasePointerCapture: noop,
  setPointerCapture: noop,
  // No layout in jsdom: give elements a size so the virtualized timeline renders rows.
  getBoundingClientRect: () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 768,
    width: 1024,
    height: 768,
    toJSON: () => ({}),
  }),
});
for (const [prop, value] of [
  ['offsetWidth', 1024],
  ['offsetHeight', 768],
  ['clientHeight', 768],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
}

afterEach(() => {
  // Unmount first: a mounted Toaster answers dismiss() with exit timers that can
  // fire after jsdom is gone ("window is not defined").
  cleanup();
  // sonner keeps toasts in module state: start every test without old ones.
  toast.dismiss();
  localStorage.clear();
});
