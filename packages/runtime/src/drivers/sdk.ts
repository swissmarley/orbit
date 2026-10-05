import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type AuthMethod, OrbitError, type RunEventBody, event } from '@orbit/core';
import { findExecutable } from '../auth/probes';
import { type Env, assertChildEnvSafe, buildChildEnv, proxiedEngineEnv } from '../env';
import { Channel } from './channel';
import { checkAuthSource } from './auth-source';
import { Normalizer } from './normalize';
import { decide, hookOutput, postHookOutput, postProcess } from './permission';
import { EventSequencer } from './sequencer';
import type { AgentDriver, DriverRunRequest, EngineMcpServer } from './types';

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/**
 * orbitd's loopback key proxy for host engines (`HostKeyProxy` in
 * @orbit/sandbox, ADR-018 amended): one lease per Run segment.
 */
export interface EngineKeyProxy {
  open(): Promise<{ baseUrl: string; token: string; close(): void }>;
}

/**
 * How an engine reaches the API for one segment:
 *  - `engine`: Bedrock / Vertex — the engine holds the cloud credentials and
 *    scrubs them from its own children (ADR-005);
 *  - `host_proxy`: an API key or apiKeyHelper — the engine on the host holds
 *    only the placeholder key and talks to orbitd's key proxy with the
 *    segment's token; `scrub` is CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
 *  - `container`: a docker sandbox — the container's own key proxy path (ADR-018).
 */
export type EngineKey =
  { via: 'engine' } | { via: 'host_proxy'; baseUrl: string; scrub: boolean } | { via: 'container' };

/** Where the engine's API credential lives: in orbitd (proxied) or in the engine's env. */
export type EngineKeyDelivery = 'proxied' | 'in_engine';

/**
 * API keys and apiKeyHelper output stay in orbitd behind the key proxy;
 * Bedrock and Vertex credentials cannot be proxied and go to the engine.
 */
export function engineKeyDelivery(authMethod: AuthMethod): EngineKeyDelivery | null {
  switch (authMethod) {
    case 'api_key':
    case 'api_key_helper':
      return 'proxied';
    case 'bedrock':
    case 'vertex':
      return 'in_engine';
    default:
      return null;
  }
}

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
  /**
   * orbitd's key proxy: required for `api_key` / `api_key_helper` (the key
   * never enters an engine on the host); unused for Bedrock / Vertex.
   */
  keyProxy?: EngineKeyProxy | null;
  /** Told each segment's key-proxy token, so the redactor hides it (like hook tokens). */
  secrets?: { addSecret(value: string): void };
  /** Injected in tests; defaults to the Agent SDK's `query`. */
  queryFn?: QueryFn;
  /** Tests: the host platform and where bubblewrap is (see `subprocessScrub`). */
  platform?: NodeJS.Platform;
  findBwrap?: (pathEnv: string | undefined) => string | null;
}

/** How to fix a host without bubblewrap (doctor and the failed Run say the same). */
export const BUBBLEWRAP_HOWTO =
  'Install bubblewrap (Debian/Ubuntu: sudo apt-get install -y bubblewrap; Fedora: sudo dnf install bubblewrap), then run orbit daemon restart — or use an Anthropic API key, which Orbit keeps out of the engine.';

/**
 * Whether Claude Code can scrub its children's environment here
 * (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`): on Linux it enforces the scrub with
 * bubblewrap and refuses to start without it (verified with 2.1.289).
 */
export function subprocessScrub(platform: NodeJS.Platform, bwrap: string | null): boolean {
  return platform !== 'linux' || bwrap !== null;
}

/**
 * Why a host engine that holds Bedrock / Vertex credentials cannot start, or
 * null. Orbit starts it with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so those
 * credentials never reach the engine's own children (Bash, hooks, MCP
 * servers; ADR-005); turning the scrub off instead would hand them to every
 * shell command. Engines behind a key proxy hold no secret and run either way.
 */
export function engineScrubBlocker(platform: NodeJS.Platform, bwrap: string | null): string | null {
  if (subprocessScrub(platform, bwrap)) return null;
  return 'The SDK engine needs bubblewrap (bwrap) on Linux to keep cloud credentials out of its shell commands and tools, and bwrap is not on PATH.';
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
  o: Pick<SdkDriverOptions, 'env' | 'bare' | 'apiKeyHelper'> & { key: EngineKey },
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
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: the engine strips credentials from the
  // environment of its own children (Bash, hooks, MCP servers) — ADR-005.
  // A proxied engine gets no API credential at all (ADR-018): the key stays
  // in orbitd; the host engine sees a placeholder and the key proxy's URL
  // with its segment's token, and scrubs as defence in depth where it can;
  // a container engine gets its placeholder from the container env.
  let env: Record<string, string>;
  switch (o.key.via) {
    case 'engine':
      env = buildChildEnv('sdk-engine', o.env, { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
      assertChildEnvSafe('sdk-engine', env);
      break;
    case 'host_proxy':
      env = proxiedEngineEnv(o.env, o.key.baseUrl, {
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: o.key.scrub ? '1' : '0',
      });
      break;
    case 'container':
      env = buildChildEnv('tool', o.env, { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
      assertChildEnvSafe('tool', env);
      break;
  }
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
  // The helper runs inside orbitd for a proxied engine (the key proxy calls it).
  if (o.apiKeyHelper && o.key.via === 'engine') {
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
    if (engineKeyDelivery(opts.authMethod) === 'proxied' && !opts.keyProxy) {
      throw new OrbitError(
        'internal',
        "The SDK driver with an API key needs orbitd's key proxy: the key never enters the engine",
      );
    }
  }

  /** Where bubblewrap is on orbitd's PATH (tests inject it). */
  private bwrap(): string | null {
    return this.opts.findBwrap
      ? this.opts.findBwrap(this.opts.env.PATH)
      : findExecutable('bwrap', this.opts.env.PATH);
  }

  run(req: DriverRunRequest): AsyncIterable<RunEventBody> {
    const out = new Channel<RunEventBody>();
    const seq = new EventSequencer(out);
    const normalizer = new Normalizer();
    const abortController = new AbortController();
    const stderrTail: string[] = [];
    /** Ends this segment's key-proxy lease: forwarding stops at once (stop, kill, budget, end). */
    let closeKeyLease: () => void = () => undefined;
    let finished = false;
    const finish = (body?: RunEventBody) => {
      if (finished) return;
      closeKeyLease();
      seq.flush();
      if (body) out.push(body);
      finished = true;
      out.close();
    };
    const onAbort = () => {
      closeKeyLease();
      abortController.abort();
    };
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
        const platform = this.opts.platform ?? process.platform;
        let key: EngineKey;
        if (req.apiKeyProxied === true) {
          // A container engine holds no key and scrubs nothing (ADR-018).
          key = { via: 'container' };
        } else if (this.opts.keyProxy && engineKeyDelivery(this.authMethod) === 'proxied') {
          const lease = await this.opts.keyProxy.open();
          closeKeyLease = () => {
            closeKeyLease = () => undefined;
            lease.close();
          };
          this.opts.secrets?.addSecret(lease.token);
          if (req.signal.aborted) {
            finish(
              event('run.cancelled', {
                reason: 'Run was stopped',
                sessionId: req.resumeSessionId ?? req.sessionId ?? null,
              }),
            );
            return;
          }
          // No secret in the engine's env: scrub where Claude Code can, else run without it.
          key = {
            via: 'host_proxy',
            baseUrl: lease.baseUrl,
            scrub: subprocessScrub(platform, this.bwrap()),
          };
        } else {
          const blocker = engineScrubBlocker(platform, this.bwrap());
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
          key = { via: 'engine' };
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
          { ...this.opts, key },
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
                        // Behind a key proxy the engine only ever sees the placeholder key.
                        key.via === 'engine' ? this.authMethod : 'api_key',
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
        closeKeyLease();
        req.signal.removeEventListener('abort', onAbort);
      }
    };
    void consume();
    return out;
  }
}
