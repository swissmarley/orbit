/** @jsxRuntime automatic @jsxImportSource react */
import { type Harness, TOKEN, harness } from '@orbit/api/testing';
import { OrbitClient } from '@orbit/sdk-client/browser';
import { render } from '@testing-library/react';
import { App, makeQueryClient } from '../app';
import { authStore } from '../lib/api';

export interface Mounted {
  h: Harness;
  client: OrbitClient;
  unmount: () => void;
}

/**
 * The App against the real API service (MockDriver, in-memory clock, no
 * network): requests go straight into the Hono app. Tests drive it with the
 * keyboard and check the daemon's state, not just the DOM.
 */
export function mountApp(path: string, opts: { h?: Harness; token?: string } = {}): Mounted {
  const h = opts.h ?? harness();
  const client = new OrbitClient({
    baseUrl: 'http://orbit.test',
    token: opts.token ?? TOKEN,
    fetch: (url, init) => Promise.resolve(h.app.request(url, init)),
  });
  authStore.set('unknown');
  window.history.replaceState(null, '', path);
  const r = render(<App client={client} queryClient={makeQueryClient()} />);
  return { h, client, unmount: r.unmount };
}

export { TOKEN };
