import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type AuthMethod, type RunEventBody, event } from '@orbit/core';
import { findExecutable } from '../auth/probes';
import { type Env, assertChildEnvSafe, buildChildEnv } from '../env';
import { Channel } from './channel';
import { checkAuthSource } from './auth-source';
import { Normalizer } from './normalize';
import { decide, hookOutput, postHookOutput, postProcess } from './permission';
import { EventSequencer } from './sequencer';
import type { AgentDriver, DriverRunRequest, EngineMcpServer } from './types';

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface SdkDriverOptions {
  authMethod: AuthMethod;
  /** Source environment; filtered through the sdk-engine allowlist. */
  env: Env;
  /**
   * Start the engine with `--bare`: authentication is strictly
   * ANTHROPIC_API_KEY / apiKeyHelper / cloud credentials and the subscription
   * OAuth on disk or in the keychain is never consulted (ADR-005).
   */
  bare: boolean;
  apiKeyHelper: string | null;
  /** Injected in tests; defaults to the Agent SDK's `query`. */
  queryFn?: QueryFn;
  /** Tests: the host platform and where bubblewrap is (see `engineScrubBlocker`). */
  platform?: NodeJS.Platform;
  findBwrap?: (pathEnv: string | undefined) => string | null;
}

/** How to fix a host without bubblewrap (doctor and the failed Run say the same). */
export const BUBBLEWRAP_HOWTO =
  'Install bubblewrap (Debian/Ubuntu: sudo apt-get install -y bubblewrap; Fedora: sudo dnf install bubblewrap), then run orbit daemon restart — or give the Bot a Docker sandbox, whose engine never holds the key.';

/**
 * Why the host SDK engine cannot start, or null. Orbit starts it with
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the API key never reaches the
 * engine's own children (Bash, hooks, MCP servers; ADR-005). On Linux Claude
 * Code enforces that scrub with bubblewrap and refuses to start without it;
 * turning the scrub off instead would hand the key to every shell command.
 */
export function engineScrubBlocker(platform: NodeJS.Platform, bwrap: string | null): string | null {
  if (platform !== 'linux' || bwrap !== null) return null;
  return 'The SDK engine needs bubblewrap (bwrap) on Linux to keep the API key out of its shell commands and tools, and bwrap is not on PATH.';
}

async function defaultQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as QueryFn;
}

/**
 * Orbit's tools as an in-process MCP server: the engine talks to it over the
 * SDK's own stdio control channel, so no token or port is involved (and
 * nothing secret ends up in the engine's `--mcp-config` argument).
 */
export async function orbitSdkServer(
  binding: NonNullable<DriverRunRequest['orbitTools']>,
): Promise<McpServerConfig> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.createSdkMcpServer({
    name: 'orbit',
    version: '0.1.0',
    tools: binding.tools.map((t) =>
      sdk.tool(
        t.name,
        t.description,
        t.schema.shape as Parameters<typeof sdk.tool>[2],
        async (args) => {
          const r = await binding.call(t.name, args);
          return { content: [{ type: 'text', text: r.text }], isError: r.isError };
        },
        { alwaysLoad: true },
      ),
    ),
  });
}

/**
 * A plugin's tools as an in-process MCP server (ADR-014): the engine calls
 * Orbit over the SDK's control channel and Orbit calls the plugin process.
 * The plugin's own JSON schemas are served as-is (low-level handlers).
 */
export async function pluginSdkServer(binding: EngineMcpServer): Promise<McpServerConfig> {
  const [{ McpServer }, types] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new McpServer({ name: binding.name, version: '0.1.0' });
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(types.ListToolsRequestSchema, () => ({
    tools: binding.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object' as const, ...t.inputSchema },
    })),
  }));
  server.server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
    const r = await binding.call(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
  });
  return { type: 'sdk', name: binding.name, instance: server };
}

/** Build Agent SDK options for a Run (exported for tests). */
export function buildSdkOptions(
  req: DriverRunRequest,
  o: Pick<SdkDriverOptions, 'env' | 'bare' | 'apiKeyHelper'>,
  hooks: {
    preToolUse: HookCallback;
    postToolUse?: HookCallback;
    postToolUseFailure?: HookCallback;
    canUseTool: CanUseTool;
  },
  abortController: AbortController,
  onStderr: (line: string) => void,
  orbitServer: McpServerConfig | null = null,
  pluginServers: Record<string, McpServerConfig> = {},
): Options {
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: the engine strips API credentials from
  // the environment of its own children (Bash, hooks, MCP servers) — ADR-005.
  // A proxied engine (docker, ADR-018) gets no API credential at all: the
  // key stays in orbitd and the container sees a placeholder.
  const env = buildChildEnv(req.apiKeyProxied === true ? 'tool' : 'sdk-engine', o.env, {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  });
  assertChildEnvSafe(req.apiKeyProxied === true ? 'tool' : 'sdk-engine', env);
  const options: Options = {
    cwd: req.cwd,
    env,
    abortController,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { ...pluginServers, ...(orbitServer ? { orbit: orbitServer } : {}) },
    hooks: {
      PreToolUse: [{ hooks: [hooks.preToolUse] }],
      ...(hooks.postToolUse ? { PostToolUse: [{ hooks: [hooks.postToolUse] }] } : {}),
      ...(hooks.postToolUseFailure
        ? { PostToolUseFailure: [{ hooks: [hooks.postToolUseFailure] }] }
        : {}),
    },
    canUseTool: hooks.canUseTool,
    systemPrompt: req.appendSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: req.appendSystemPrompt }
      : { type: 'preset', preset: 'claude_code' },
    stderr: onStderr,
  };
  if (o.bare) options.extraArgs = { bare: null };
  // The helper runs on the host for a proxied engine (the key proxy calls it).
  if (o.apiKeyHelper && req.apiKeyProxied !== true) {
    options.settings = { apiKeyHelper: o.apiKeyHelper };
  }
  if (req.model) options.model = req.model;
  if (req.maxTurns) options.maxTurns = req.maxTurns;
  if (req.tools) options.tools = req.tools;
  if (req.resumeSessionId) options.resume = req.resumeSessionId;
  else if (req.sessionId) options.sessionId = req.sessionId;
  if (req.maxBudgetUsd) options.maxBudgetUsd = req.maxBudgetUsd;
  if (req.engineSandbox) options.sandbox = req.engineSandbox;
  if (req.agents && Object.keys(req.agents).length > 0) options.agents = req.agents;
  if (typeof req.spawnEngine === 'function') {
    options.spawnClaudeCodeProcess = req.spawnEngine as NonNullable<
      Options['spawnClaudeCodeProcess']
    >;
    // The engine binary inside the sandbox image (docker/sandbox.Dockerfile).
    options.pathToClaudeCodeExecutable = 'claude';
  }
  return options;
}

/**
 * SdkDriver: the Agent SDK with an API key (or Bedrock / Vertex). The only
 * driver allowed for hosted, shared or networked deployments.
 */
export class SdkDriver implements AgentDriver {
  readonly kind = 'sdk' as const;
  readonly authMethod: AuthMethod;

  constructor(private readonly opts: SdkDriverOptions) {
    this.authMethod = opts.authMethod;
  }

  run(req: DriverRunRequest): AsyncIterable<RunEventBody> {
    const out = new Channel<RunEventBody>();
    const seq = new EventSequencer(out);
    const normalizer = new Normalizer();
    const abortController = new AbortController();
    const stderrTail: string[] = [];
    let finished = false;
    const finish = (body?: RunEventBody) => {
      if (finished) return;
      seq.flush();
      if (body) out.push(body);
      finished = true;
      out.close();
    };
    const onAbort = () => abortController.abort();
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    const preToolUse: HookCallback = async (input, toolUseID, { signal }) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolUseId = input.tool_use_id.length > 0 ? input.tool_use_id : (toolUseID ?? null);
      const { decision, event: decisionEvent } = await decide(
        req.permission,
        {
          toolName: input.tool_name,
          input:
            typeof input.tool_input === 'object' && input.tool_input !== null
              ? (input.tool_input as Record<string, unknown>)
              : {},
          toolUseId,
          parentToolUseId: null,
        },
        signal,
      );
      seq.decision(toolUseId, decisionEvent, decision.behavior === 'allow');
      return hookOutput(decision);
    };

    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PostToolUse' || !seq.wasAllowed(input.tool_use_id)) return {};
      return postHookOutput(
        await postProcess(req.toolResult, {
          toolName: input.tool_name,
          toolUseId: input.tool_use_id,
          input:
            typeof input.tool_input === 'object' && input.tool_input !== null
              ? (input.tool_input as Record<string, unknown>)
              : {},
          response: input.tool_response,
        }),
      );
    };

    const postToolUseFailure: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PostToolUseFailure' || !seq.wasAllowed(input.tool_use_id))
        return {};
      return postHookOutput(
        await postProcess(req.toolResult, {
          toolName: input.tool_name,
          toolUseId: input.tool_use_id,
          input:
            typeof input.tool_input === 'object' && input.tool_input !== null
              ? (input.tool_input as Record<string, unknown>)
              : {},
          response: input.error,
          isError: true,
        }),
        'PostToolUseFailure',
      );
    };

    // Backstop: the PreToolUse hook answers allow/deny for every call, so the
    // engine should never need to prompt. If it does, decide the same way.
    const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
      const { decision, event: decisionEvent } = await decide(
        req.permission,
        { toolName, input, toolUseId: toolUseID, parentToolUseId: null },
        signal,
      );
      seq.decision(toolUseID, decisionEvent, decision.behavior === 'allow');
      const result: PermissionResult =
        decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.reason, interrupt: decision.interrupt ?? false };
      return result;
    };

    const consume = async () => {
      try {
        // A proxied (Docker) engine holds no key and scrubs nothing (ADR-018).
        const blocker =
          req.apiKeyProxied === true
            ? null
            : engineScrubBlocker(
                this.opts.platform ?? process.platform,
                this.opts.findBwrap
                  ? this.opts.findBwrap(this.opts.env.PATH)
                  : findExecutable('bwrap', this.opts.env.PATH),
              );
        if (blocker) {
          finish(
            event('run.failed', {
              code: 'engine_sandbox_missing',
              message: `${blocker} ${BUBBLEWRAP_HOWTO}`,
              retryable: true,
              sessionId: req.resumeSessionId ?? req.sessionId ?? null,
            }),
          );
          return;
        }
        const orbitServer =
          req.orbitTools && req.orbitTools.tools.length > 0
            ? await orbitSdkServer(req.orbitTools)
            : null;
        const pluginServers: Record<string, McpServerConfig> = {};
        for (const p of req.pluginServers ?? []) {
          if (p.tools.length > 0) pluginServers[p.name] = await pluginSdkServer(p);
        }
        const options = buildSdkOptions(
          req,
          this.opts,
          { preToolUse, postToolUse, postToolUseFailure, canUseTool },
          abortController,
          (d) => {
            stderrTail.push(...d.split('\n').filter((l) => l.trim()));
            stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
          },
          orbitServer,
          pluginServers,
        );
        const queryFn = this.opts.queryFn ?? (await defaultQuery());
        for await (const message of queryFn({ prompt: req.prompt, options })) {
          if (finished) break;
          const bodies = normalizer.push(message);
          const violation =
            bodies
              .flatMap((b) =>
                b.type === 'session.init'
                  ? [
                      checkAuthSource(
                        'sdk',
                        // Behind the key proxy the engine only ever sees the placeholder key.
                        req.apiKeyProxied === true ? 'api_key' : this.authMethod,
                        b.data.apiKeySource,
                      ).failure,
                    ]
                  : [],
              )
              .find((f) => f !== null) ?? seq.engine(bodies);
          if (violation) {
            const sessionId = normalizer.sessionId ?? req.resumeSessionId ?? req.sessionId;
            finish(
              violation.type === 'run.failed'
                ? { ...violation, data: { ...violation.data, sessionId } }
                : violation,
            );
            abortController.abort();
            return;
          }
          if (normalizer.terminal) {
            finish();
            return;
          }
        }
        const sessionId = normalizer.sessionId ?? req.resumeSessionId ?? req.sessionId;
        if (req.signal.aborted) {
          finish(event('run.cancelled', { reason: 'Run was stopped', sessionId }));
          return;
        }
        finish(
          event('run.failed', {
            code: 'engine_exit',
            message:
              'Agent SDK ended without a result' +
              (stderrTail.length ? `: ${stderrTail.slice(-5).join(' | ')}` : ''),
            retryable: false,
            sessionId,
          }),
        );
      } catch (err) {
        const sessionId = normalizer.sessionId ?? req.resumeSessionId ?? req.sessionId;
        if (req.signal.aborted) {
          finish(event('run.cancelled', { reason: 'Run was stopped', sessionId }));
          return;
        }
        finish(
          event('run.failed', {
            code: 'engine_error',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
            sessionId,
          }),
        );
      } finally {
        req.signal.removeEventListener('abort', onAbort);
      }
    };
    void consume();
    return out;
  }
}
