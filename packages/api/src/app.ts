import { timingSafeEqual } from 'node:crypto';
import { OrbitError, type RunEvent, errorMessage } from '@orbit/core';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { ZodError, z } from 'zod';
import {
  API_VERSION,
  type ErrorBody,
  type RouteDef,
  type RouteName,
  STATUS_FOR_CODE,
  honoPath,
  routes,
} from './contract';
import { buildOpenApi } from './openapi';
import type { OrbitService } from './service';

export interface AppOptions {
  service: OrbitService;
  /** Bearer token every request (but health and the OpenAPI document) must present. */
  token: string;
  /**
   * `host:port` values accepted in the request URL / Host header. Requests
   * naming any other host are refused (DNS-rebinding guard). Empty = any.
   */
  allowedHosts?: readonly string[] | (() => readonly string[]);
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
    error: { code, message: service.redactor.redactString(message), hint },
  });
  const app = new Hono();
  // Lazy: orbitd knows its port only after it listens.
  const allowedHosts = () => {
    const list = typeof opts.allowedHosts === 'function' ? opts.allowedHosts() : opts.allowedHosts;
    return new Set((list ?? []).map((h) => h.toLowerCase()));
  };
  const publicPaths = new Set(['/openapi.json', routes.health.path]);

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

  // DNS rebinding and browser guards: only our own host names, no cross-origin callers.
  app.use('*', async (c, next) => {
    const allowed = allowedHosts();
    // Both the request URL (absolute-form targets) and the Host header (review L4).
    for (const host of [new URL(c.req.url).host, c.req.header('host') ?? '']) {
      const h = host.toLowerCase();
      if (allowed.size > 0 && h !== '' && !allowed.has(h)) {
        return c.json(errorBody('forbidden', `Host ${h} is not served here`), 403);
      }
    }
    // Browsers always send Origin on cross-site requests; Orbit's clients never do.
    // (The M5 app gets an explicit origin allowlist.)
    if (c.req.header('origin') !== undefined || c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed'), 403);
    }
    return next();
  });

  app.use('*', async (c, next) => {
    if (publicPaths.has(c.req.path)) return next();
    if (!tokenMatches(c.req.header('authorization'), opts.token)) {
      return c.json(
        errorBody(
          'unauthorized',
          'Missing or wrong API token',
          'The CLI reads it from $ORBIT_HOME/daemon.token.',
        ),
        401,
      );
    }
    return next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('payload_too_large', 'Request body too large'), 413),
    }),
  );

  app.get('/openapi.json', (c) => c.json(buildOpenApi()));

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
  return app;
}
