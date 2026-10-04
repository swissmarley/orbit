import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type HookHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Loopback HTTP endpoint that CliDriver's PreToolUse command hook calls
 * (bin/orbit-hook.mjs). Each Run registers a random bearer token; a token can
 * only *ask* for a decision about a tool call — it cannot change policy or
 * approve anything, so a Bot that reads its own environment gains nothing.
 */
export class HookBridge {
  private readonly handlers = new Map<string, HookHandler>();

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(host = '127.0.0.1'): Promise<HookBridge> {
    const holder: { bridge?: HookBridge } = {};
    const server = createServer((req, res) => {
      void holder.bridge?.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    holder.bridge = new HookBridge(server, `http://${host}:${port}/hook`);
    return holder.bridge;
  }

  /** Register a handler; returns its token and an unregister function. */
  register(handler: HookHandler): { token: string; dispose: () => void } {
    const token = randomBytes(24).toString('hex');
    this.handlers.set(token, handler);
    return { token, dispose: () => this.handlers.delete(token) };
  }

  private lookup(header: string | undefined): HookHandler | undefined {
    const presented = /^Bearer ([0-9a-f]{48})$/.exec(header ?? '')?.[1];
    if (!presented) return undefined;
    for (const [token, handler] of this.handlers) {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(presented))) return handler;
    }
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/hook') {
      send(res, 404, { error: 'not found' });
      return;
    }
    const handler = this.lookup(req.headers.authorization);
    if (!handler) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        send(res, 400, { error: 'expected a JSON object' });
        return;
      }
      send(res, 200, await handler(body as Record<string, unknown>));
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : 'hook failed' });
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
