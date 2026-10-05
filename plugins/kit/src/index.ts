import { createInterface } from 'node:readline';
import { z } from 'zod';

/**
 * A minimal MCP server over stdio for Orbit's reference plugins (ADR-014).
 * It serves `initialize`, `ping`, `tools/list` and `tools/call`; tools are
 * defined with zod and their arguments validated before they run. Plugins
 * get no model access and make no requests of their host.
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** A failure the model should see as a tool error (not a crash). */
export class ToolError extends Error {
  override name = 'ToolError';
}

export interface ToolContext {
  /** The Bot's workspace (orbitd starts the server there), or the plugin's scratch dir in checks. */
  workspace: string;
  /** The server's own environment (built by Orbit from an allowlist). */
  env: Readonly<Record<string, string | undefined>>;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<string> | string;
}

export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool {
  return tool;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Server {
  name: string;
  version: string;
  tools: readonly Tool[];
  instructions?: string;
}

function schemaOf(tool: Tool): Record<string, unknown> {
  const json = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Longest text a tool result may carry. */
export const MAX_TEXT = 60_000;

/** Answer one JSON-RPC message (null for notifications). Exported for tests. */
export async function handle(server: Server, msg: unknown, ctx: ToolContext): Promise<Json | null> {
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: isObj(msg) ? (msg.id ?? null) : null,
      error: { code: -32600, message: 'Invalid request' },
    };
  }
  const { id, method } = msg;
  if (id === undefined) return null;
  const params = isObj(msg.params) ? msg.params : {};
  const reply = (result: unknown): Json => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: server.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: schemaOf(t),
        })),
      });
    case 'tools/call': {
      const tool = server.tools.find((t) => t.name === params.name);
      const text = (t: string, isError = false) =>
        reply({ content: [{ type: 'text', text: t.slice(0, MAX_TEXT) }], isError });
      if (!tool) return text(`Unknown tool ${String(params.name)}`, true);
      const args = tool.input.safeParse(isObj(params.arguments) ? params.arguments : {});
      if (!args.success) return text(`Invalid arguments: ${z.prettifyError(args.error)}`, true);
      try {
        return text(await tool.run(args.data, ctx));
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/** Serve on stdin/stdout until stdin closes. Logs go to stderr only. */
export function serve(server: Server): void {
  const ctx: ToolContext = {
    workspace: process.env.ORBIT_WORKSPACE ?? process.cwd(),
    env: process.env,
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      return;
    }
    void handle(server, msg, ctx).then((r) => {
      if (r) process.stdout.write(`${JSON.stringify(r)}\n`);
    });
  });
  lines.on('close', () => process.exit(0));
}

/** A required environment value (a secret or setting Orbit passes), or a clear tool error. */
export function requireEnv(ctx: ToolContext, name: string, what: string): string {
  const v = ctx.env[name];
  if (!v)
    throw new ToolError(`${what} is not set up (${name}); ask your owner to configure the plugin`);
  return v;
}

/**
 * JSON over HTTPS to a third-party API with a timeout, no redirects to other
 * hosts and a size cap. `base` comes from Orbit's env (tests point it at a
 * local fake).
 */
export async function api(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = (await res.text()).slice(0, 2_000_000);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      isObj(json) && typeof json.message === 'string'
        ? json.message
        : isObj(json) && isObj(json.error) && typeof json.error.message === 'string'
          ? json.error.message
          : `HTTP ${res.status}`;
    throw new ToolError(`The API answered ${res.status}: ${msg.slice(0, 300)}`);
  }
  return json;
}

/** Compact JSON for tool results. */
export function show(value: unknown): string {
  return JSON.stringify(value, null, 1);
}
