import { errorMessage } from '@orbit/core';

/**
 * Slack over Socket Mode (ADR-014): Orbit asks Slack for a WebSocket URL with
 * the app-level token and connects outward, so nothing listens publicly.
 * Every envelope is acknowledged; message and mention events are handed on.
 */

export interface SlackMessage {
  type: 'message' | 'app_mention';
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs: string | null;
}

export type SlackState =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'connected'; since: string }
  | { state: 'error'; message: string; retryAt: string | null };

/** The bits of a WebSocket Orbit uses (Node 22's global WebSocket, or a test double). */
export interface SocketLike {
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SlackSocketOptions {
  /** The app-level token (xapp-…); read from the vault when connecting. */
  appToken: () => string | undefined;
  /** Slack Web API base (SLACK_API_URL; tests point it at a fake). */
  apiUrl: string;
  onMessage: (m: SlackMessage) => void;
  onState?: (s: SlackState) => void;
  fetchFn?: typeof fetch;
  connect?: (url: string) => SocketLike;
  now?: () => Date;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

const SLACK_CHANNEL = /^[CGD][A-Z0-9]{2,20}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/;

/** Socket Mode URLs: wss only (ws only to a loopback test server). */
export function slackSocketUrlOk(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'wss:') return true;
  return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

/** A Slack event payload → a message Orbit starts Runs from, or null (bots, edits, joins…). */
export function slackMessageOf(payload: unknown): SlackMessage | null {
  if (!isObj(payload) || !isObj(payload.event)) return null;
  const e = payload.event;
  const type = str(e.type);
  if (type !== 'message' && type !== 'app_mention') return null;
  // Edits, deletions, joins and bot posts (including Orbit's own) never start Runs.
  if (e.subtype !== undefined || e.bot_id !== undefined) return null;
  // Ids and timestamps go into the Run's context line: only Slack's own shapes (review L3).
  const channel = str(e.channel);
  const user = str(e.user);
  const ts = str(e.ts);
  const threadTs = str(e.thread_ts);
  if (!channel || !SLACK_CHANNEL.test(channel)) return null;
  if (!user || !SLACK_USER.test(user)) return null;
  if (!ts || !SLACK_TS.test(ts)) return null;
  if (threadTs !== null && !SLACK_TS.test(threadTs)) return null;
  return {
    type,
    channel,
    user,
    text: (str(e.text) ?? '').slice(0, 8000),
    ts,
    threadTs,
  };
}

export class SlackSocket {
  private socket: SocketLike | null = null;
  private stopped = true;
  private retry: NodeJS.Timeout | undefined;
  private attempts = 0;
  private current: SlackState = { state: 'off' };
  private readonly now: () => Date;

  constructor(private readonly opts: SlackSocketOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  get state(): SlackState {
    return this.current;
  }

  private set(s: SlackState): void {
    this.current = s;
    this.opts.onState?.(s);
  }

  /** Read through a method: `stop()` may run while a connect awaits. */
  private isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    const s = this.socket;
    this.socket = null;
    try {
      s?.close();
    } catch {
      // Already closed.
    }
    this.set({ state: 'off' });
  }

  private schedule(message: string): void {
    if (this.stopped) return;
    this.attempts += 1;
    const delay = Math.min(300_000, 2000 * 2 ** Math.min(this.attempts, 8));
    this.set({
      state: 'error',
      message,
      retryAt: new Date(this.now().getTime() + delay).toISOString(),
    });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), delay);
    this.retry.unref();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = this.opts.appToken();
    if (!token) {
      this.set({
        state: 'error',
        message: 'The Slack app-level token (SLACK_APP_TOKEN) is not set',
        retryAt: null,
      });
      return;
    }
    this.set({ state: 'connecting' });
    let url: string;
    try {
      const res = await (this.opts.fetchFn ?? fetch)(
        `${this.opts.apiUrl.replace(/\/+$/, '')}/apps.connections.open`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      const body: unknown = await res.json();
      if (!isObj(body) || body.ok !== true || typeof body.url !== 'string') {
        const code =
          isObj(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        this.schedule(`Slack refused the connection: ${code.slice(0, 100)}`);
        return;
      }
      url = body.url;
      if (!slackSocketUrlOk(url)) {
        this.schedule('Slack returned an unexpected socket URL');
        return;
      }
    } catch (err) {
      this.schedule(`Could not reach Slack: ${errorMessage(err).slice(0, 200)}`);
      return;
    }
    if (this.isStopped()) return;
    let socket: SocketLike;
    try {
      socket = this.opts.connect ? this.opts.connect(url) : new WebSocket(url);
    } catch (err) {
      this.schedule(`Could not open the Slack socket: ${errorMessage(err).slice(0, 200)}`);
      return;
    }
    this.socket = socket;
    socket.addEventListener('message', (e) => this.onFrame(socket, e.data));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.schedule('The Slack socket closed');
    });
    socket.addEventListener('error', () => {
      // 'close' follows; nothing else to do.
    });
  }

  private onFrame(socket: SocketLike, data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    if (msg.type === 'hello') {
      this.attempts = 0;
      this.set({ state: 'connected', since: this.now().toISOString() });
      return;
    }
    if (msg.type === 'disconnect') {
      // Slack rotates connections: open a fresh one.
      this.socket = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      void this.connect();
      return;
    }
    // Acknowledge every envelope first, so Slack does not redeliver it.
    if (typeof msg.envelope_id === 'string') {
      socket.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    }
    if (msg.type !== 'events_api') return;
    const m = slackMessageOf(msg.payload);
    if (!m) return;
    try {
      this.opts.onMessage(m);
    } catch (err) {
      this.opts.log?.(`Slack trigger: ${errorMessage(err)}`);
    }
  }
}
