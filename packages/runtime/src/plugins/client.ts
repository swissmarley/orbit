import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { OrbitError } from '@orbit/core';

/**
 * A minimal MCP client for plugin servers (ADR-014): `initialize`,
 * `tools/list` and `tools/call` over stdio (newline-delimited JSON-RPC) or
 * Streamable HTTP. Requests a server makes of Orbit (sampling, roots,
 * elicitation) are refused: a plugin can never spend model usage or read
 * anything Orbit did not hand it.
 */

export const CLIENT_PROTOCOL_VERSION = '2025-06-18';
/** Longest tool result kept (the normalizer truncates further for events). */
export const MAX_RESULT_CHARS = 100_000;
const MAX_LINE_CHARS = 8 * 1024 * 1024;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text of an MCP `CallToolResult` content array (images and resources as placeholders). */
export function resultText(result: unknown): McpCallResult {
  if (!isObj(result)) return { text: '', isError: true };
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((c) => {
    if (!isObj(c)) return '';
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
    if (c.type === 'resource' && isObj(c.resource) && typeof c.resource.text === 'string') {
      return c.resource.text;
    }
    if (c.type === 'image') return '[image]';
    return `[${typeof c.type === 'string' ? c.type : 'content'}]`;
  });
  let text = parts.filter((p) => p.length > 0).join('\n');
  if (text === '' && isObj(result.structuredContent))
    text = JSON.stringify(result.structuredContent);
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
  return { text, isError: result.isError === true };
}

function toolDefs(result: unknown): McpToolDef[] {
  const tools = isObj(result) && Array.isArray(result.tools) ? result.tools : [];
  return tools.filter(isObj).flatMap((t) =>
    typeof t.name === 'string'
      ? [
          {
            name: t.name,
            description: typeof t.description === 'string' ? t.description.slice(0, 2000) : '',
            inputSchema: isObj(t.inputSchema) ? t.inputSchema : { type: 'object' },
          },
        ]
      : [],
  );
}

const INIT_PARAMS = {
  protocolVersion: CLIENT_PROTOCOL_VERSION,
  // No sampling, roots or elicitation: Orbit answers none of them.
  capabilities: {},
  clientInfo: { name: 'orbit', version: '0.1.0' },
};

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StdioClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Already built from the allowlist (buildPluginEnv). */
  env: Record<string, string>;
  /** Per request; tool calls may take a while (a browser, a git push). */
  timeoutMs?: number;
  /** Redacts stderr before it is quoted in an error. */
  redact?: (s: string) => string;
  /** Called once when the process has exited (removes a sandbox's private folder). */
  onExit?: () => void;
}

/** A plugin server as a child process speaking MCP on stdin/stdout. */
export class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | null = null;
  private exited: Error | null = null;
  private readonly stderrTail: string[] = [];

  constructor(private readonly opts: StdioClientOptions) {}

  private start(): Promise<void> {
    this.ready ??= (async () => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.opts.command, this.opts.args, {
          cwd: this.opts.cwd,
          env: this.opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group: closing stops what the server started (a browser, git).
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        this.runOnExit();
        throw new OrbitError(
          'driver_unavailable',
          `Could not start the plugin server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.child = child;
      child.stdin.on('error', () => undefined);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail.push(...chunk.split('\n').filter((l) => l.trim()));
        this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - 10));
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => this.onLine(line));
      const fail = (message: string) => {
        this.exited = new OrbitError('engine_error', this.withStderr(message));
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(this.exited);
          this.pending.delete(id);
        }
      };
      child.on('error', (err) => fail(`The plugin server failed to start: ${err.message}`));
      child.on('close', (code, sig) => {
        fail(`The plugin server exited (${sig ?? `code ${code ?? 'unknown'}`})`);
        this.runOnExit();
      });
      await this.request('initialize', INIT_PARAMS, 20_000);
      this.notify('notifications/initialized');
    })();
    return this.ready;
  }

  private exitHandled = false;

  private runOnExit(): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    try {
      this.opts.onExit?.();
    } catch {
      // Best effort: a leftover private folder is not worth failing a Run.
    }
  }

  private withStderr(message: string): string {
    const tail = this.stderrTail.slice(-3).join(' | ');
    const text = tail ? `${message}: ${tail}` : message;
    return (this.opts.redact ?? ((s) => s))(text).slice(0, 1000);
  }

  private onLine(line: string): void {
    if (line.length > MAX_LINE_CHARS) {
      void this.close();
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Servers may log to stdout by mistake; ignore non-JSON.
    }
    if (!isObj(msg)) return;
    // A request from the server: refuse it (no sampling, roots or elicitation).
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Orbit does not serve requests from plugins' },
      });
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (isObj(msg.error)) {
      const m = typeof msg.error.message === 'string' ? msg.error.message : 'error';
      p.reject(new OrbitError('engine_error', `Plugin error: ${m.slice(0, 500)}`));
    } else {
      p.resolve(msg.result);
    }
  }

  private write(msg: Json): void {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private notify(method: string): void {
    this.write({ jsonrpc: '2.0', method });
  }

  private request(method: string, params: Json, timeoutMs = this.opts.timeoutMs ?? 120_000) {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OrbitError(
            'engine_error',
            this.withStderr(`The plugin did not answer ${method} in time`),
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.start();
    return toolDefs(await this.request('tools/list', {}, 30_000));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.start();
    return resultText(await this.request('tools/call', { name, arguments: args }));
  }

  close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) this.runOnExit(); // never started
    if (child?.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        kill('SIGKILL');
        resolve();
      }, 2000);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
      kill('SIGTERM');
    });
  }
}

export interface HttpClientOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** A plugin server reached over Streamable HTTP (JSON or SSE responses). */
export class HttpMcpClient implements McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;

  constructor(private readonly opts: HttpClientOptions) {}

  private async post(body: Json, expectReply: boolean): Promise<unknown> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const res = await fetchFn(this.opts.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': CLIENT_PROTOCOL_VERSION,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      throw new OrbitError('engine_error', `The plugin server answered HTTP ${res.status}`);
    }
    if (!expectReply) return null;
    const text = (await res.text()).slice(0, MAX_LINE_CHARS);
    const messages: unknown[] = [];
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          messages.push(JSON.parse(line.slice(5)));
        } catch {
          // Not JSON: skip.
        }
      }
    } else {
      messages.push(JSON.parse(text));
    }
    const reply = messages.flat().find((m) => isObj(m) && m.id === body.id);
    if (!isObj(reply)) throw new OrbitError('engine_error', 'The plugin server sent no answer');
    if (isObj(reply.error)) {
      const m = typeof reply.error.message === 'string' ? reply.error.message : 'error';
      throw new OrbitError('engine_error', `Plugin error: ${m.slice(0, 500)}`);
    }
    return reply.result;
  }

  private request(method: string, params: Json): Promise<unknown> {
    return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, true);
  }

  private start(): Promise<void> {
    this.ready ??= (async () => {
      await this.request('initialize', INIT_PARAMS);
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    })();
    return this.ready;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.start();
    return toolDefs(await this.request('tools/list', {}));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.start();
    return resultText(await this.request('tools/call', { name, arguments: args }));
  }

  close(): Promise<void> {
    this.sessionId = null;
    return Promise.resolve();
  }
}
