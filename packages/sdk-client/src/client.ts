import {
  type BotSpecInput,
  OrbitError,
  type OrbitErrorCode,
  RunEvent,
  errorMessage,
} from '@orbit/core/browser';
import {
  type RouteBody,
  type RouteDef,
  type RouteName,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  buildPath,
  routes,
} from '@orbit/api/contract';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** e.g. http://127.0.0.1:7420; '' = the page's own origin (the App served by orbitd). */
  baseUrl: string;
  /**
   * Contents of $ORBIT_HOME/daemon.token (CLI, TUI). Omitted in the browser,
   * where the App authenticates with its HttpOnly session cookie (ADR-011).
   */
  token?: string;
  /** fetch credentials mode; the App uses 'same-origin' so the session cookie is sent. */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** Extra headers on every request, or a function read per request (the App's CSRF secret). */
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: FetchLike;
  /** Per-request timeout for JSON calls (not streams). Default 30 s. */
  timeoutMs?: number;
}

export interface CallArgs<N extends RouteName> {
  params?: RouteParams<N>;
  query?: RouteQuery<N>;
  body?: RouteBody<N>;
  signal?: AbortSignal;
}

export interface EventStreamOptions {
  run?: string;
  bot?: string;
  /** Start after this event id (default: the whole Run when `run` is set, else only new events). */
  after?: number;
  signal?: AbortSignal;
  /** Consecutive failed (re)connects before giving up. Default 8. */
  maxReconnects?: number;
  /** First reconnect delay; doubles up to 5 s. Default 250 ms. */
  reconnectDelayMs?: number;
  /** Called each time the stream is (re)connected, before any event (UIs show "live"). */
  onOpen?: () => void;
}

const KNOWN_CODES = new Set<OrbitErrorCode>([
  'auth_required',
  'compliance_refused',
  'driver_unavailable',
  'invalid_config',
  'invalid_input',
  'not_found',
  'engine_error',
  'blocked',
  'conflict',
  'daemon_unavailable',
  'unauthorized',
  'forbidden',
  'internal',
]);

function toCode(code: unknown): OrbitErrorCode {
  if (code === 'payload_too_large') return 'invalid_input';
  return KNOWN_CODES.has(code as OrbitErrorCode) ? (code as OrbitErrorCode) : 'internal';
}

function query(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : JSON.stringify(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The OrbitError an API error response describes. */
async function errorFrom(res: Response): Promise<OrbitError> {
  let body: { error?: { code?: unknown; message?: unknown; hint?: unknown } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON
  }
  const hint = typeof body.error?.hint === 'string' ? body.error.hint : undefined;
  return new OrbitError(
    toCode(body.error?.code),
    typeof body.error?.message === 'string' ? body.error.message : `HTTP ${res.status}`,
    hint ? { hint } : undefined,
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Typed client for the orbitd API. Every method is derived from the shared
 * contract (`@orbit/api/contract`), and every response is validated against
 * its zod schema, so a client/daemon mismatch fails loudly instead of
 * silently. Clients (CLI, TUI, App) talk to orbitd only through this.
 */
export class OrbitClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly credentials: 'omit' | 'same-origin' | 'include' | undefined;
  private readonly extraHeaders: () => Record<string, string>;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.credentials = options.credentials;
    const extra = options.headers ?? {};
    this.extraHeaders = typeof extra === 'function' ? extra : () => extra;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.extraHeaders(),
      ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      ...extra,
    };
  }

  private async send(
    def: RouteDef,
    args: {
      params?: Record<string, string>;
      query?: unknown;
      body?: unknown;
      signal?: AbortSignal;
    },
    stream: boolean,
  ): Promise<Response> {
    const url =
      this.baseUrl +
      buildPath(def.path, args.params) +
      query(args.query as Record<string, unknown> | undefined);
    const signals = [args.signal, stream ? undefined : AbortSignal.timeout(this.timeoutMs)].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: def.method,
        headers: this.headers(def.body ? { 'content-type': 'application/json' } : {}),
        ...(this.credentials ? { credentials: this.credentials } : {}),
        ...(def.body ? { body: JSON.stringify(args.body ?? {}) } : {}),
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
    } catch (err) {
      if (args.signal?.aborted) throw err;
      throw new OrbitError(
        'daemon_unavailable',
        `Cannot reach orbitd at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          hint: 'Start it with `orbit daemon start` (the CLI starts it automatically).',
        },
      );
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  /** Call any route by name; the response is parsed with the route's schema. */
  async call<N extends RouteName>(name: N, args: CallArgs<N> = {}): Promise<RouteResponse<N>> {
    const def: RouteDef = routes[name];
    const res = await this.send(def, args, false);
    if (!def.response) throw new Error(`${name} is a stream; use the dedicated method`);
    const parsed = def.response.safeParse(await res.json());
    if (!parsed.success) {
      throw new OrbitError('internal', `orbitd answered ${name} with an unexpected shape`, {
        hint: 'The CLI and the daemon are different versions: restart the daemon (`orbit daemon stop`).',
      });
    }
    return parsed.data as RouteResponse<N>;
  }

  // ── convenience methods ───────────────────────────────────────────────────

  health() {
    return this.call('health');
  }
  doctor() {
    return this.call('doctor');
  }
  stopDaemon() {
    return this.call('stopDaemon');
  }

  readonly bots = {
    list: () => this.call('listBots'),
    create: (spec: BotSpecInput) => this.call('createBot', { body: spec }),
    get: (bot: string) => this.call('getBot', { params: { bot } }),
    update: (bot: string, spec: BotSpecInput) =>
      this.call('updateBot', { params: { bot }, body: spec }),
    versions: (bot: string) => this.call('botVersions', { params: { bot } }),
    pause: (bot: string) => this.call('pauseBot', { params: { bot } }),
    resume: (bot: string) => this.call('resumeBot', { params: { bot } }),
    /** Hold the Bot and get its workspace for the owner's shell (`orbit shell`; token only). */
    takeover: (bot: string, pid: number) =>
      this.call('startTakeover', { params: { bot }, body: { pid } }),
    endTakeover: (bot: string) => this.call('endTakeover', { params: { bot } }),
  };

  readonly runs = {
    start: (bot: string, body: RouteBody<'startRun'> = {}) =>
      this.call('startRun', { params: { bot }, body }),
    list: (q: RouteQuery<'listRuns'> = {}) => this.call('listRuns', { query: q }),
    get: (run: string) => this.call('getRun', { params: { run } }),
    events: (run: string, afterSeq?: number) =>
      this.call('runEvents', {
        params: { run },
        query: afterSeq === undefined ? {} : { afterSeq },
      }),
    stop: (run: string) => this.call('stopRun', { params: { run } }),
    /** Pause at the Run's next tool call, or `now` (stops the engine mid-turn). */
    pause: (run: string, body: RouteBody<'pauseRun'> = {}) =>
      this.call('pauseRun', { params: { run }, body }),
    resume: (run: string, body: RouteBody<'resumeRun'> = {}) =>
      this.call('resumeRun', { params: { run }, body }),
    /** The delegation tree the Run belongs to (top-level Run first). */
    tree: (run: string) => this.call('runTree', { params: { run } }),
    /** Thumbs up or down on a finished Run. */
    feedback: (run: string, body: RouteBody<'runFeedback'>) =>
      this.call('runFeedback', { params: { run }, body }),
    /** Memories the Run wrote. */
    memory: (run: string) => this.call('runMemory', { params: { run } }),
  };

  readonly memory = {
    list: (q: RouteQuery<'listMemory'> = {}) => this.call('listMemory', { query: q }),
    get: (memory: string) => this.call('getMemory', { params: { memory } }),
    create: (bot: string, body: RouteBody<'createMemory'>) =>
      this.call('createMemory', { params: { bot }, body }),
    update: (memory: string, body: RouteBody<'updateMemory'>) =>
      this.call('updateMemory', { params: { memory }, body }),
    remove: (memory: string) => this.call('deleteMemory', { params: { memory } }),
    /** One Bot's memories (or every Bot's) as JSON Lines with provenance. */
    export: async (bot?: string): Promise<string> =>
      (await this.send(routes.exportMemory, { query: bot ? { bot } : {} }, false)).text(),
    /** Import an export into a Bot; `dryRun` previews counts and trust without writing. */
    import: (bot: string, body: RouteBody<'importMemory'>) =>
      this.call('importMemory', { params: { bot }, body }),
    /** Apply retention now (orbitd also sweeps daily). */
    sweep: () => this.call('sweepMemory'),
    /** Workspace files written while untrusted content was in a Run. */
    taint: (bot: string) => this.call('botTaint', { params: { bot } }),
    clearTaint: (bot: string) => this.call('clearBotTaint', { params: { bot } }),
  };

  readonly triage = {
    usage: () => this.call('triageUsage'),
    /** One metered triage-model call: a Bot config proposal for the owner to review. */
    proposeBot: (goal: string) => this.call('proposeBot', { body: { goal } }),
  };

  /** Plugins (ADR-014): reference plugins and ones you added. */
  readonly plugins = {
    list: () => this.call('listPlugins'),
    get: (plugin: string) => this.call('getPlugin', { params: { plugin } }),
    add: (dir: string) => this.call('addPlugin', { body: { dir } }),
    remove: (plugin: string) => this.call('removePlugin', { params: { plugin } }),
    /** Starts the server once to list its tools, then offers it to the Bots that list it. */
    enable: (plugin: string) => this.call('enablePlugin', { params: { plugin } }),
    disable: (plugin: string) => this.call('disablePlugin', { params: { plugin } }),
    check: (plugin: string) => this.call('checkPlugin', { params: { plugin } }),
    setSecret: (plugin: string, name: string, value: string) =>
      this.call('setPluginSecret', { params: { plugin, name }, body: { value } }),
    removeSecret: (plugin: string, name: string) =>
      this.call('removePluginSecret', { params: { plugin, name } }),
    setSetting: (plugin: string, name: string, value: string | null) =>
      this.call('setPluginSetting', { params: { plugin, name }, body: { value } }),
    /** The configured catalog (ADR-019), with what is already installed. */
    catalog: () => this.call('pluginCatalog'),
    /** Install from the catalog or npm (SRI-verified, off until enabled); `dryRun` previews. */
    install: (body: RouteBody<'installPlugin'>) => this.call('installPlugin', { body }),
  };

  /** Inbound triggers (webhooks, Slack, files, git). */
  readonly triggers = {
    list: () => this.call('listTriggers'),
    /** Mint or rotate a webhook trigger's signing secret (shown once). */
    webhookSecret: (bot: string, trigger: string) =>
      this.call('webhookSecret', { params: { bot, trigger } }),
  };

  readonly approvals = {
    list: (q: RouteQuery<'listApprovals'> = {}) => this.call('listApprovals', { query: q }),
    get: (approval: string) => this.call('getApproval', { params: { approval } }),
    approve: (approval: string, body: RouteBody<'approve'> = {}) =>
      this.call('approve', { params: { approval }, body }),
    deny: (approval: string, body: RouteBody<'deny'> = {}) =>
      this.call('deny', { params: { approval }, body }),
  };

  readonly rules = {
    list: (all = false) => this.call('listRules', { query: all ? { all: 'true' } : {} }),
    create: (body: RouteBody<'createRule'>) => this.call('createRule', { body }),
    revoke: (rule: string) => this.call('revokeRule', { params: { rule } }),
  };

  readonly audit = {
    list: (q: RouteQuery<'listAudit'> = {}) => this.call('listAudit', { query: q }),
    verify: () => this.call('verifyAudit'),
    /** Keyed since when, unkeyed records from before the upgrade, the head (cheap). */
    status: () => this.call('auditStatus'),
    /** Append a checkpoint record; keep the signed JSON outside ORBIT_HOME. */
    checkpoint: () => this.call('auditCheckpoint'),
    verifyCheckpoint: (checkpoint: RouteBody<'verifyAuditCheckpoint'>) =>
      this.call('verifyAuditCheckpoint', { body: checkpoint }),
    /** The whole log as JSON Lines. */
    export: async (): Promise<string> => (await this.send(routes.exportAudit, {}, false)).text(),
  };

  readonly secrets = {
    list: () => this.call('listSecrets'),
    set: (name: string, value: string) =>
      this.call('setSecret', { params: { name }, body: { value } }),
    remove: (name: string) => this.call('removeSecret', { params: { name } }),
  };

  readonly kill = {
    status: () => this.call('killStatus'),
    set: (on: boolean) => this.call('setKill', { body: { on } }),
  };

  queue() {
    return this.call('queue');
  }

  schedules(bot?: string) {
    return this.call('schedules', { query: bot ? { bot } : {} });
  }

  /**
   * The SSE event feed as an async iterator. Reconnects on network errors and
   * resumes exactly after the last event received (Last-Event-ID), so a
   * consumer sees every event once, in order. Ends when `signal` aborts.
   */
  async *events(opts: EventStreamOptions = {}): AsyncGenerator<RunEvent> {
    let last: number | undefined = opts.after;
    let failures = 0;
    const max = opts.maxReconnects ?? 8;
    let delay = opts.reconnectDelayMs ?? 250;
    while (!opts.signal?.aborted) {
      let res: Response;
      try {
        const def = routes.events;
        const q = { run: opts.run, bot: opts.bot, ...(last === undefined ? {} : { after: last }) };
        res = await this.fetchFn(this.baseUrl + def.path + query(q), {
          headers: this.headers({
            accept: 'text/event-stream',
            ...(last === undefined ? {} : { 'last-event-id': String(last) }),
          }),
          ...(this.credentials ? { credentials: this.credentials } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        if (opts.signal?.aborted) return;
        if (++failures > max) {
          throw new OrbitError('daemon_unavailable', `Event stream lost: ${errorMessage(err)}`);
        }
        await sleep(delay, opts.signal);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      // Auth and validation errors do not get better by retrying.
      if (!res.ok || !res.body) throw await errorFrom(res);
      opts.onOpen?.();
      failures = 0;
      delay = opts.reconnectDelayMs ?? 250;
      try {
        for await (const e of parseSse(res.body, opts.signal)) {
          last = e.id;
          yield e;
        }
      } catch (err) {
        if (opts.signal?.aborted) return;
        if (err instanceof OrbitError) throw err;
        // Connection dropped mid-stream: reconnect after `last`.
      }
      if (opts.signal?.aborted) return;
      if (++failures > max)
        throw new OrbitError('daemon_unavailable', 'Event stream keeps closing');
      await sleep(delay, opts.signal);
    }
  }
}

/** Parse an SSE body into RunEvents (validated); comments (heartbeats) are skipped. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        const parsed = RunEvent.safeParse(JSON.parse(data));
        if (!parsed.success) {
          throw new OrbitError('internal', 'orbitd sent an event this client does not understand', {
            hint: 'The CLI and the daemon are different versions: restart the daemon.',
          });
        }
        yield parsed.data;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Close the HTTP stream too: a consumer that stops early (break) must not
    // leave the connection (and the process) open.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
