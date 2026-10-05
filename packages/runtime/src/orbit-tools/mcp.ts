import type { OrbitRunSession } from './session';
import type { OrbitToolset } from './tools';

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

async function one(
  toolset: OrbitToolset,
  session: OrbitRunSession,
  msg: unknown,
  version: string,
): Promise<Json | null> {
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
        serverInfo: { name: 'orbit', version: '0.1.0' },
        instructions:
          'Orbit tools: memory for this Bot and delegation to peer Bots. Every call is checked by Orbit policy.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: toolset.definitions(session.bot).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isObj(params.arguments) ? params.arguments : {};
      const r = await toolset.call(session, name, args);
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
  const version = MCP_PROTOCOL_VERSIONS[0] ?? '2025-06-18';
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return fail(null, -32600, 'Invalid batch');
    const out = (await Promise.all(body.map((m) => one(toolset, session, m, version)))).filter(
      (r) => r !== null,
    );
    return out.length ? out : null;
  }
  return one(toolset, session, body, version);
}
