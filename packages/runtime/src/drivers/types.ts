import type {
  AuthMethod,
  DriverKind,
  PermissionHandler,
  RunEventBody,
  ToolResultHandler,
} from '@orbit/core';

export type {
  PermissionHandler,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolResultDecision,
  ToolResultHandler,
  ToolResultRequest,
} from '@orbit/core';

/** A subagent as the engine takes it (`agents` / `--agents`). */
export interface EngineAgent {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

/** Orbit's own tools (memory, delegation) for one driver segment (ADR-012). */
export interface OrbitToolBinding {
  /** CliDriver: the loopback endpoint and this segment's bearer token (`--mcp-config`). */
  http: { url: string; token: string } | null;
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** zod object (the SDK's in-process server takes its shape). */
    schema: { shape: Record<string, unknown> };
  }[];
  /** Execute a tool (SDK in-process server, MockDriver); checked against policy inside. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface DriverRunRequest {
  runId: string;
  prompt: string;
  /** Working directory = the Bot's workspace. */
  cwd: string;
  /** Model alias or ID (already resolved from bot → config defaults). */
  model: string | null;
  /** Bot goal + standing instructions appended to the engine's system prompt. */
  appendSystemPrompt: string | null;
  /** Built-in tools to expose; null = engine default. */
  tools: string[] | null;
  maxTurns: number | null;
  /** Engine session to resume (`--resume`). */
  resumeSessionId: string | null;
  /** Session id to assign to a new session (`--session-id`); ignored on resume. */
  sessionId: string | null;
  permission: PermissionHandler;
  /** Post-processing of tool output (secret redaction, untrusted-content tagging). */
  toolResult?: ToolResultHandler | undefined;
  signal: AbortSignal;
  /** Claude Code native `sandbox` settings for this Run (engine-enforced shell isolation). */
  engineSandbox?: Record<string, unknown> | null | undefined;
  /** Engine-side spend cap in USD (`--max-budget-usd` / `maxBudgetUsd`). */
  maxBudgetUsd?: number | null | undefined;
  /** SDK only: run the engine elsewhere (e.g. `docker exec` into the Bot's container). */
  spawnEngine?: unknown;
  /** MockDriver scenario. */
  mockFixture?: string | undefined;
  /** Orbit's MCP tools for this segment; null/omitted = none. */
  orbitTools?: OrbitToolBinding | null | undefined;
  /** Subagents by name; null/omitted = none. */
  agents?: Record<string, EngineAgent> | null | undefined;
}

/**
 * An AgentDriver executes one Run and streams normalized RunEvent bodies.
 * Contract (enforced by test/driver-contract.ts):
 *  - the stream ends with exactly one terminal event
 *    (run.completed | run.failed | run.cancelled | run.rate_limited)
 *  - a permission.decision follows its tool.call and precedes its tool.result
 *  - aborting `signal` yields run.cancelled promptly
 *  - the driver never throws from the iterator; failures become run.failed
 */
export interface AgentDriver {
  readonly kind: DriverKind;
  readonly authMethod: AuthMethod;
  run(request: DriverRunRequest): AsyncIterable<RunEventBody>;
}
