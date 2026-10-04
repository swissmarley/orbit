import { z } from 'zod';
import { API_VERSION, ErrorBody, type RouteDef, routes } from './contract';

type JsonSchema = Record<string, unknown>;

function schema(type: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(type, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
}

function queryParameters(query: z.ZodType): JsonSchema[] {
  const s = schema(query, 'input');
  const props = (s.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((s.required ?? []) as string[]);
  return Object.entries(props).map(([name, p]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: p,
  }));
}

/**
 * OpenAPI 3.1 document generated from the contract's zod schemas (JSON
 * Schema 2020-12 via zod's own converter — no extra tooling, ADR-010).
 */
export function buildOpenApi(): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const errorResponse = {
    description: 'Error',
    content: { 'application/json': { schema: schema(ErrorBody, 'output') } },
  };
  for (const [name, def] of Object.entries(routes) as [string, RouteDef][]) {
    const pathParams = [...def.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const op: JsonSchema = {
      operationId: name,
      summary: def.summary,
      tags: [def.tag],
      parameters: [...pathParams, ...(def.query ? queryParameters(def.query) : [])],
      responses: {
        [String(def.status ?? 200)]: def.response
          ? {
              description: 'OK',
              content: { 'application/json': { schema: schema(def.response, 'output') } },
            }
          : def.stream === 'sse'
            ? { description: 'Event stream', content: { 'text/event-stream': {} } }
            : { description: 'JSON Lines', content: { 'application/x-ndjson': {} } },
        default: errorResponse,
      },
      ...(def.auth === false ? { security: [] } : {}),
    };
    if (def.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: schema(def.body, 'input') } },
      };
    }
    paths[def.path] = { ...paths[def.path], [def.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'orbitd API',
      version: API_VERSION,
      description:
        'Local API of the Orbit daemon. Loopback only; authenticate with the bearer token in $ORBIT_HOME/daemon.token.',
    },
    servers: [{ url: 'http://127.0.0.1:7420' }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
