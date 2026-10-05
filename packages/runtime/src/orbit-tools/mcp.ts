import type { OrbitRunSession } from './session';
import type { OrbitToolset } from './tools';

/** What the minimal server serves: Orbit's own tools, or one plugin of a segment (ADR-014). */
export interface McpSurface {
  name: string;
  instructions: string;
  tools(): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** Orbit's own tools for one session, as an MCP surface. */
export function orbitSurface(toolset: OrbitToolset, session: OrbitRunSession): McpSurface {
  return {
    name: 'orbit',
    instructions:
      'Orbit tools: memory for this Bot and delegation to peer Bots. Every call is checked by Orbit policy.',
    tools: () =>
      toolset.definitions(session.bot).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    call: (name, args) => toolset.call(session, name, args),
  };
}

/**
 * A minimal MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless, JSON
 * responses only) for the Orbit tools. Small on purpose: it implements
 * initialize, ping, tools/list and tools/call and nothing else, so the
 * whole surface a Bot can reach is reviewable here.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function reply(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function one(surface: McpSurface, msg: unknown, version: string): Promise<Json | null> {
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(isObj(msg) ? msg.id : null, -32600, 'Invalid request');
  }
  const { id, method } = msg;
  const params = isObj(msg.params) ? msg.params : {};
  // Notifications (no id) never get a response.
  if (id === undefined) return null;
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: surface.name, version: '0.1.0' },
        instructions: surface.instructions,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: surface.tools() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isObj(params.arguments) ? params.arguments : {};
      const r = await surface.call(name, args);
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POSTed body (a message or a batch). Null = nothing to send (202). */
export async function handleMcpBody(
  toolset: OrbitToolset,
  session: OrbitRunSession,
  body: unknown,
): Promise<unknown> {
  return handleMcpRequest(orbitSurface(toolset, session), body);
}

/** Serve one POSTed body for any surface (Orbit's tools or a plugin). */
export async function handleMcpRequest(surface: McpSurface, body: unknown): Promise<unknown> {
  const version = MCP_PROTOCOL_VERSIONS[0] ?? '2025-06-18';
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return fail(null, -32600, 'Invalid batch');
    const out = (await Promise.all(body.map((m) => one(surface, m, version)))).filter(
      (r) => r !== null,
    );
    return out.length ? out : null;
  }
  return one(surface, body, version);
}
