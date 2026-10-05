import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { OrbitError, type RunEvent, errorMessage } from '@orbit/core';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { ZodError, z } from 'zod';
import {
  API_VERSION,
  CSRF_HEADER,
  type ErrorBody,
  type RouteDef,
  type RouteName,
  STATUS_FOR_CODE,
  honoPath,
  routes,
} from './contract';
import { buildOpenApi } from './openapi';
import type { OrbitService } from './service';
import { SessionStore } from './session';

export interface AppOptions {
  service: OrbitService;
  /** Bearer token every request (but health and the OpenAPI document) must present. */
  token: string;
  /**
   * `host:port` values accepted in the request URL / Host header. Requests
   * naming any other host are refused (DNS-rebinding guard). Empty = any.
   */
  allowedHosts?: readonly string[] | (() => readonly string[]);
  /**
   * Browser origins allowed besides orbitd's own (ADR-011): loopback dev
   * servers and the desktop shell, from `api.allowedOrigins`.
   */
  allowedOrigins?: readonly string[] | (() => readonly string[]);
  /** App sessions (one-time tickets → cookies); created when omitted. */
  sessions?: SessionStore;
  /** Directory of the built App served at `/` (same origin as the API); null/omitted = not served. */
  appRoot?: string | null;
  /** SSE heartbeat comment interval. Default 15 s. */
  heartbeatMs?: number;
  /** Validate every JSON response against its contract schema (tests). */
  validateResponses?: boolean;
  /** Called after POST /v1/daemon/stop has been answered. */
  onStop?: () => void;
}

interface Input {
  params: Record<string, string>;
  query: unknown;
  body: unknown;
}

type Handler = (input: Input, c: Context) => unknown;

/** A path parameter the route declares (Hono only matches when it is present). */
function param(params: Record<string, string>, name: string): string {
  const v = params[name];
  if (v === undefined) throw new OrbitError('invalid_input', `Missing path parameter ${name}`);
  return v;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Per-port cookie name: cookies ignore ports, and two daemons may share 127.0.0.1. */
export function sessionCookieName(url: string): string {
  const u = new URL(url);
  return `orbit_session_${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

/** One cookie from a Cookie header (no decoding: session ids are base64url). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The App's page policy: nothing but its own files and its own API. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Radix positions popovers with inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const APP_NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Orbit</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>The Orbit App is not built</h1>
<p>Build it once with <code>pnpm --filter @orbit/app build</code>, then run <code>orbit app</code> again.
The CLI (<code>orbit</code>) and the TUI work without it.</p></body>`;

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every event of `filter`, in id order: the replay after `after`, then live ones. */
function matches(e: RunEvent, filter: { runId?: string; botId?: string }): boolean {
  return (!filter.runId || e.runId === filter.runId) && (!filter.botId || e.botId === filter.botId);
}

/**
 * The orbitd HTTP API (Hono): REST routes from the contract table plus the
 * SSE event feed. Loopback-only by default; every route but health and the
 * OpenAPI document needs the local bearer token.
 */
export function createApp(opts: AppOptions): Hono {
  const { service } = opts;
  // Error text can quote tool, git or engine output: redact with the vault-aware redactor (L1).
  const errorBody = (code: string, message: string, hint: string | null = null): ErrorBody => ({
    error: {
      code,
      message: service.redactor.redactString(message),
      hint: hint === null ? null : service.redactor.redactString(hint),
    },
  });
  const app = new Hono();
  // Lazy: orbitd knows its port only after it listens.
  const allowedHosts = () => {
    const list = typeof opts.allowedHosts === 'function' ? opts.allowedHosts() : opts.allowedHosts;
    return new Set((list ?? []).map((h) => h.toLowerCase()));
  };
  const publicPaths = new Set(['/openapi.json', routes.health.path]);
  const sessions = opts.sessions ?? new SessionStore();
  /** How each request authenticated (set by the auth middleware). */
  const via = new WeakMap<Request, 'token' | 'session'>();
  const extraOrigins = () => {
    const list =
      typeof opts.allowedOrigins === 'function' ? opts.allowedOrigins() : opts.allowedOrigins;
    return new Set((list ?? []).map((o) => o.toLowerCase().replace(/\/+$/, '')));
  };
  /** orbitd's own origin (the Host header is already checked against allowedHosts). */
  const ownOrigin = (host: string | undefined) => `http://${(host ?? '').toLowerCase()}`;
  const originAllowed = (host: string | undefined, origin: string) => {
    const o = origin.toLowerCase();
    return o === ownOrigin(host) || extraOrigins().has(o);
  };
  const appRoot = opts.appRoot ? resolve(opts.appRoot) : null;
  const isAppPath = (method: string, path: string) =>
    appRoot !== null &&
    (method === 'GET' || method === 'HEAD') &&
    !path.startsWith('/v1/') &&
    path !== '/v1' &&
    path !== '/openapi.json';

  app.onError((err, c) => {
    if (err instanceof OrbitError) {
      return c.json(
        errorBody(err.code, err.message, err.hint ?? null),
        (STATUS_FOR_CODE[err.code] ?? 500) as 400,
      );
    }
    if (err instanceof ZodError) {
      return c.json(errorBody('invalid_input', z.prettifyError(err)), 400);
    }
    if (err instanceof SyntaxError) {
      // Never echo the body: JSON.parse quotes it, and it may be a secret (review L1).
      return c.json(errorBody('invalid_input', 'Malformed JSON body'), 400);
    }
    return c.json(errorBody('internal', errorMessage(err)), 500);
  });
  app.notFound((c) =>
    c.json(errorBody('not_found', `No route ${c.req.method} ${c.req.path}`), 404),
  );

  // DNS rebinding and browser guards: only our own host names, and only
  // allowlisted origins (orbitd's own, which serves the App, plus api.allowedOrigins).
  app.use('*', async (c, next) => {
    const allowed = allowedHosts();
    // Both the request URL (absolute-form targets) and the Host header (review L4).
    for (const host of [new URL(c.req.url).host, c.req.header('host') ?? '']) {
      const h = host.toLowerCase();
      if (allowed.size > 0 && h !== '' && !allowed.has(h)) {
        return c.json(errorBody('forbidden', `Host ${h} is not served here`), 403);
      }
    }
    // Browsers always send Host; without one the origin checks have nothing to compare (review L5).
    if (allowed.size > 0 && !c.req.header('host')) {
      return c.json(errorBody('invalid_input', 'Missing Host header'), 400);
    }
    const origin = c.req.header('origin');
    const okOrigin = origin !== undefined && originAllowed(c.req.header('host'), origin);
    if (origin !== undefined && !okOrigin) {
      return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed'), 403);
    }
    // A cross-site request without an Origin we know (old browsers, odd fetch modes).
    if (c.req.header('sec-fetch-site') === 'cross-site' && !okOrigin) {
      return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed'), 403);
    }
    const cors = okOrigin && origin.toLowerCase() !== ownOrigin(c.req.header('host'));
    if (c.req.method === 'OPTIONS') {
      if (!cors)
        return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed'), 403);
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE',
        'access-control-allow-headers': `authorization, content-type, last-event-id, ${CSRF_HEADER}`,
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    await next();
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    if (cors) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('access-control-allow-credentials', 'true');
      c.res.headers.append('vary', 'Origin');
    }
    return undefined;
  });

  app.use('*', async (c, next) => {
    if (publicPaths.has(c.req.path) || isAppPath(c.req.method, c.req.path)) return next();
    if (c.req.method === 'POST' && c.req.path === routes.createSession.path) return next();
    if (tokenMatches(c.req.header('authorization'), opts.token)) {
      via.set(c.req.raw, 'token');
      return next();
    }
    const cookie = cookieValue(c.req.header('cookie'), sessionCookieName(c.req.url));
    const session =
      cookie === undefined ? 'none' : sessions.check(cookie, c.req.header(CSRF_HEADER));
    if (session === 'bad_csrf') {
      // A valid cookie without this session's CSRF secret: another listener
      // on a loopback port may have harvested the cookie (cookies ignore ports).
      return c.json(
        errorBody('unauthorized', 'This App session needs signing in again', 'Run `orbit app`.'),
        401,
      );
    }
    if (session === 'ok') {
      // Cookie + this session's secret (held only by the App's origin).
      via.set(c.req.raw, 'session');
      return next();
    }
    return c.json(
      errorBody(
        'unauthorized',
        'Missing or wrong API token',
        'The CLI reads it from $ORBIT_HOME/daemon.token; the App signs in with `orbit app`.',
      ),
      401,
    );
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('payload_too_large', 'Request body too large'), 413),
    }),
  );

  app.get('/openapi.json', (c) => c.json(buildOpenApi()));

  const requireVia = (c: Context) => {
    const v = via.get(c.req.raw);
    if (!v) throw new OrbitError('unauthorized', 'Not signed in');
    return v;
  };

  const handlers: Partial<Record<RouteName, Handler>> = {
    health: () => ({
      ok: true,
      version: service.version,
      api: API_VERSION,
      pid: process.pid,
      startedAt: service.startedAt,
    }),
    doctor: () => service.doctor(),
    stopDaemon: () => {
      // Answer first, then stop.
      setTimeout(() => opts.onStop?.(), 10).unref();
      return { ok: true };
    },
    getSession: (_i, c) => ({ via: requireVia(c) }),
    createLoginTicket: (_i, c) => {
      if (requireVia(c) !== 'token') {
        throw new OrbitError('forbidden', 'Only the bearer token (the CLI) can mint login tickets');
      }
      return sessions.mintTicket();
    },
    createSession: ({ body }, c) => {
      // Before sign-in the App has no secret yet; any value proves a script
      // (not a form or an image) sent it, and the Origin check already ran.
      if (!c.req.header(CSRF_HEADER)) {
        throw new OrbitError('forbidden', `Missing the ${CSRF_HEADER} header`);
      }
      const redeemed = sessions.redeem((body as z.output<typeof routes.createSession.body>).ticket);
      if (!redeemed) {
        throw new OrbitError('unauthorized', 'This sign-in link was already used or has expired', {
          hint: 'Run `orbit app` again for a fresh link.',
        });
      }
      setCookie(c, sessionCookieName(c.req.url), redeemed.session, {
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: redeemed.maxAgeSeconds,
      });
      return { ok: true, csrf: redeemed.csrf };
    },
    deleteSession: (_i, c) => {
      const name = sessionCookieName(c.req.url);
      const cookie = getCookie(c, name);
      if (cookie !== undefined) sessions.revoke(cookie);
      deleteCookie(c, name, { path: '/' });
      return { ok: true };
    },
    listBots: () => service.bots.list(),
    createBot: ({ body }) => service.createBot(body as never),
    getBot: ({ params }) => service.bots.get(param(params, 'bot')),
    updateBot: ({ params, body }) => service.updateBot(param(params, 'bot'), body as never),
    botVersions: ({ params }) => service.bots.versions(param(params, 'bot')),
    pauseBot: ({ params }) => service.pauseBot(param(params, 'bot')),
    resumeBot: ({ params }) => service.resumeBot(param(params, 'bot')),
    startRun: ({ params, body }) =>
      service.startRun(param(params, 'bot'), body as z.output<typeof routes.startRun.body>),
    listRuns: ({ query }) => {
      const q = query as z.output<typeof routes.listRuns.query>;
      return service.store.listRuns({
        ...(q.bot ? { botId: service.bots.get(q.bot).id } : {}),
        ...(q.status ? { status: q.status } : {}),
        limit: q.limit ?? 20,
      });
    },
    getRun: ({ params }) => service.requireRun(param(params, 'run')),
    runEvents: ({ params, query }) => {
      service.requireRun(param(params, 'run'));
      const q = query as z.output<typeof routes.runEvents.query>;
      return service.store.listRunEvents(param(params, 'run'), { afterSeq: q.afterSeq ?? 0 });
    },
    stopRun: ({ params }) => service.stopRun(param(params, 'run')),
    resumeRun: ({ params, body }) =>
      service.resumeRun(param(params, 'run'), body as z.output<typeof routes.resumeRun.body>),
    listApprovals: ({ query }) => {
      const q = query as z.output<typeof routes.listApprovals.query>;
      return service.approvals.list({
        ...(q.status ? { status: q.status } : q.all ? {} : { status: 'pending' }),
        ...(q.run ? { runId: q.run } : {}),
      });
    },
    getApproval: ({ params }) => service.approvals.require(param(params, 'approval')),
    approve: ({ params, body }) =>
      service.approve(param(params, 'approval'), body as z.output<typeof routes.approve.body>),
    deny: ({ params, body }) =>
      service.deny(param(params, 'approval'), body as z.output<typeof routes.deny.body>),
    listRules: ({ query }) =>
      service.rules.list({
        includeInactive: (query as z.output<typeof routes.listRules.query>).all === true,
      }),
    createRule: ({ body }) => service.createRule(body as z.output<typeof routes.createRule.body>),
    revokeRule: ({ params }) => service.revokeRule(param(params, 'rule')),
    listAudit: ({ query }) => {
      const q = query as z.output<typeof routes.listAudit.query>;
      return service.auditTail(q.action, q.limit ?? 50);
    },
    verifyAudit: () => service.audit.verify(),
    exportAudit: (_i, c) => {
      const lines: string[] = [];
      service.audit.exportJsonl((line) => lines.push(line));
      return c.body(lines.length ? `${lines.join('\n')}\n` : '', 200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
    },
    listSecrets: () => service.vault.list(),
    setSecret: ({ params, body }) =>
      service.setSecret(
        param(params, 'name'),
        (body as z.output<typeof routes.setSecret.body>).value,
      ),
    removeSecret: ({ params }) => {
      service.removeSecret(param(params, 'name'));
      return { ok: true };
    },
    killStatus: () => service.killStatus(),
    setKill: ({ body }) => service.setKill((body as z.output<typeof routes.setKill.body>).on),
    queue: () => service.queueSnapshot(),
    schedules: ({ query }) =>
      service.schedules((query as z.output<typeof routes.schedules.query>).bot),
    events: ({ query }, c) => sse(c, query as z.output<typeof routes.events.query>),
  };

  const sse = (c: Context, q: z.output<typeof routes.events.query>) => {
    const filter = {
      ...(q.run ? { runId: service.requireRun(q.run).runId } : {}),
      ...(q.bot ? { botId: service.bots.get(q.bot).id } : {}),
    };
    const header = c.req.header('last-event-id');
    const fromHeader = header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
    // Default start: the whole Run when one is named, otherwise only new events.
    const start = fromHeader ?? q.after ?? (q.run ? 0 : service.store.lastEventId());
    return streamSSE(c, async (stream) => {
      let last = start;
      const pending: RunEvent[] = [];
      let wake: (() => void) | null = null;
      const off = service.store.subscribe((e) => {
        if (!matches(e, filter)) return;
        pending.push(e);
        wake?.();
      });
      // Comment lines keep proxies and idle timeouts from closing the stream.
      const heartbeat = setInterval(() => {
        stream.write(': ping\n\n').catch(() => undefined);
      }, opts.heartbeatMs ?? 15_000);
      stream.onAbort(() => {
        off();
        clearInterval(heartbeat);
        wake?.();
      });
      const send = async (e: RunEvent) => {
        if (e.id <= last) return; // replay and live overlap: each id once, in order
        last = e.id;
        await stream.writeSSE({ id: String(e.id), event: 'run-event', data: JSON.stringify(e) });
      };
      try {
        // Replay what the client missed, page by page (live events buffer meanwhile).
        for (;;) {
          const page = service.store.listEventsAfter(last, 500, filter);
          for (const e of page) await send(e);
          if (page.length < 500 || stream.aborted) break;
        }
        // A function, not the property: the abort can land during any await below.
        const aborted = () => stream.aborted;
        while (!aborted()) {
          const batch = pending.splice(0).sort((a, b) => a.id - b.id);
          for (const e of batch) await send(e);
          if (pending.length === 0 && !aborted()) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        }
      } finally {
        off();
        clearInterval(heartbeat);
      }
    });
  };

  for (const [name, def] of Object.entries(routes) as [RouteName, RouteDef][]) {
    const handler = handlers[name];
    if (!handler) throw new Error(`No handler for route ${name}`);
    const method = def.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    app[method](honoPath(def.path), async (c) => {
      const query = def.query ? def.query.parse(c.req.query()) : {};
      let body: unknown = undefined;
      if (def.body) {
        const text = await c.req.text();
        body = def.body.parse(text.trim() === '' ? {} : (JSON.parse(text) as unknown));
      }
      const result = await handler({ params: c.req.param(), query, body }, c);
      if (result instanceof Response) return result;
      if (opts.validateResponses && def.response) def.response.parse(result);
      return c.json(result as object, (def.status ?? 200) as 200);
    });
  }
  if (appRoot !== null) {
    const serveFile = (c: Context, file: string) => {
      const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
      const html = type.startsWith('text/html');
      return c.body(readFileSync(file), 200, {
        'content-type': type,
        // Hashed asset names never change; the page itself always revalidates.
        'cache-control': file.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...(html ? { 'content-security-policy': APP_CSP, 'x-frame-options': 'DENY' } : {}),
      });
    };
    app.get('*', (c) => {
      if (!isAppPath(c.req.method, c.req.path)) {
        return c.json(errorBody('not_found', `No route ${c.req.method} ${c.req.path}`), 404);
      }
      let path: string;
      try {
        path = decodeURIComponent(c.req.path);
      } catch {
        return c.json(errorBody('not_found', 'Bad path'), 404);
      }
      const file = resolve(appRoot, `.${path}`);
      if (path.includes('\0') || (file !== appRoot && !file.startsWith(appRoot + sep))) {
        return c.json(errorBody('not_found', 'Bad path'), 404);
      }
      if (file !== appRoot && existsSync(file) && statSync(file).isFile())
        return serveFile(c, file);
      if (extname(path) !== '') {
        return c.json(errorBody('not_found', `No file ${path}`), 404);
      }
      // Client-side routes (/bots/x, /runs/y) all load the App's page.
      const index = resolve(appRoot, 'index.html');
      if (!existsSync(index)) {
        return c.html(APP_NOT_BUILT, 503, { 'content-security-policy': APP_CSP });
      }
      return serveFile(c, index);
    });
  }
  return app;
}
