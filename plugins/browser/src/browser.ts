import {
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
  chromium,
} from 'playwright-core';
import { type Allowlist, requestVerdict } from './allowlist';
import { type FilterProxy, startFilterProxy } from './filter-proxy';

type Env = Readonly<Record<string, string | undefined>>;

/** The first value that is set and not empty. */
const firstSet = (...values: (string | undefined)[]) =>
  values.find((v) => v !== undefined && v !== '');

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 10_000;

/** The Chromium binary to use: BROWSER_EXECUTABLE, else Playwright's own (honours PLAYWRIGHT_BROWSERS_PATH). */
export function resolveExecutable(env: Env): string {
  return firstSet(env.BROWSER_EXECUTABLE) ?? chromium.executablePath();
}

/** The owner's HTTP proxy, if the environment Orbit built names one (chained behind the filter). */
export function proxyFromEnv(env: Env): { server: string; bypass?: string } | undefined {
  const server = firstSet(env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy);
  if (!server) return undefined;
  const bypass = firstSet(env.NO_PROXY, env.no_proxy);
  return bypass ? { server, bypass } : { server };
}

/**
 * How Chromium is launched: headless, with the plugin's own environment
 * (Orbit built it from an allowlist) passed explicitly, all traffic (loopback
 * included) sent through the filter proxy on `proxyPort`, WebRTC kept off
 * non-proxied UDP, and Chromium's sandbox on unless running as root.
 */
export function launchOptions(env: Env, proxyPort: number): LaunchOptions {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') childEnv[k] = v;
  return {
    headless: true,
    args: [
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--dns-prefetch-disable',
    ],
    env: childEnv,
    // Playwright adds --no-sandbox unless this is true; Chromium refuses its sandbox as root.
    chromiumSandbox: process.getuid?.() !== 0,
    // server.ts closes the browser on signals; Playwright still kills it on process exit.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: NAVIGATION_TIMEOUT_MS,
    ...(env.BROWSER_EXECUTABLE ? { executablePath: env.BROWSER_EXECUTABLE } : {}),
  };
}

/**
 * One headless Chromium per plugin process (= per Run segment), launched on
 * first use, with one fresh incognito context: no downloads, no permissions,
 * no service workers, no WebSockets. The allowlist is enforced twice: every
 * request Playwright routes is checked (and aborted if its host is not
 * allowed), and the browser's only network path is the filter proxy, which
 * checks each request again, including redirect targets and worker requests
 * that Playwright's routing does not see.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private proxy: FilterProxy | undefined;
  private current: Page | undefined;
  private starting: Promise<BrowserContext> | undefined;
  private allow: Allowlist | undefined;
  private readonly blockedHosts = new Set<string>();

  /** The current page, opening a blank one if there is none. */
  async page(env: Env, allow: Allowlist): Promise<Page> {
    this.allow = allow;
    const context = await (this.starting ??= this.start(env));
    if (!this.current || this.current.isClosed()) this.current = await context.newPage();
    return this.current;
  }

  /** The current page, if one was opened. */
  openPage(): Page | undefined {
    return this.current && !this.current.isClosed() ? this.current : undefined;
  }

  /** Is this URL one the browser may reach? */
  allows(url: string): boolean {
    return this.allow ? requestVerdict(this.allow, url).allowed : false;
  }

  /** Hosts whose requests were refused since the last call (then forgotten). */
  takeBlocked(): string[] {
    const hosts = [...this.blockedHosts];
    this.blockedHosts.clear();
    return hosts;
  }

  async close(): Promise<void> {
    const starting = this.starting;
    this.starting = undefined;
    this.current = undefined;
    await starting?.catch(() => undefined);
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
    const proxy = this.proxy;
    this.proxy = undefined;
    await proxy?.close();
  }

  private block(host: string): void {
    if (this.blockedHosts.size < 100) this.blockedHosts.add(host || '(no host)');
  }

  private async start(env: Env): Promise<BrowserContext> {
    try {
      this.proxy = await startFilterProxy({
        allowed: (url) => this.allows(url),
        onBlocked: (host) => this.block(host),
        upstream: proxyFromEnv(env),
      });
      const browser = await chromium.launch(launchOptions(env, this.proxy.port));
      this.browser = browser;
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        ignoreHTTPSErrors: false,
        bypassCSP: false,
      });
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        const verdict = this.allow
          ? requestVerdict(this.allow, url)
          : { allowed: false as const, host: '' };
        if (verdict.allowed) await route.continue().catch(() => undefined);
        else {
          this.block(verdict.host);
          await route.abort('blockedbyclient').catch(() => undefined);
        }
      });
      await context.routeWebSocket(
        () => true,
        async (ws) => {
          let host = '(invalid URL)';
          try {
            host = new URL(ws.url()).hostname;
          } catch {
            // keep the placeholder
          }
          this.block(host);
          await ws.close({ code: 1008, reason: 'WebSockets are blocked by Orbit' });
        },
      );
      context.on('page', (p) => {
        this.current = p;
      });
      return context;
    } catch (err) {
      this.starting = undefined;
      await this.close();
      throw err;
    }
  }
}
