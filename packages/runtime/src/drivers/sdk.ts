import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type AuthMethod, type RunEventBody, event } from '@orbit/core';
import { type Env, assertChildEnvSafe, buildChildEnv } from '../env';
import { Channel } from './channel';
import { checkAuthSource } from './auth-source';
import { Normalizer } from './normalize';
import { decide, hookOutput, postHookOutput, postProcess } from './permission';
import { EventSequencer } from './sequencer';
import type { AgentDriver, DriverRunRequest } from './types';

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
}

async function defaultQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as QueryFn;
}

/** Build Agent SDK options for a Run (exported for tests). */
export function buildSdkOptions(
  req: DriverRunRequest,
  o: Pick<SdkDriverOptions, 'env' | 'bare' | 'apiKeyHelper'>,
  hooks: { preToolUse: HookCallback; postToolUse?: HookCallback; canUseTool: CanUseTool },
  abortController: AbortController,
  onStderr: (line: string) => void,
): Options {
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: the engine strips API credentials from
  // the environment of its own children (Bash, hooks, MCP servers) — ADR-005.
  const env = buildChildEnv('sdk-engine', o.env, { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
  assertChildEnvSafe('sdk-engine', env);
  const options: Options = {
    cwd: req.cwd,
    env,
    abortController,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    hooks: {
      PreToolUse: [{ hooks: [hooks.preToolUse] }],
      ...(hooks.postToolUse ? { PostToolUse: [{ hooks: [hooks.postToolUse] }] } : {}),
    },
    canUseTool: hooks.canUseTool,
    systemPrompt: req.appendSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: req.appendSystemPrompt }
      : { type: 'preset', preset: 'claude_code' },
    stderr: onStderr,
  };
  if (o.bare) options.extraArgs = { bare: null };
  if (o.apiKeyHelper) options.settings = { apiKeyHelper: o.apiKeyHelper };
  if (req.model) options.model = req.model;
  if (req.maxTurns) options.maxTurns = req.maxTurns;
  if (req.tools) options.tools = req.tools;
  if (req.resumeSessionId) options.resume = req.resumeSessionId;
  else if (req.sessionId) options.sessionId = req.sessionId;
  if (req.maxBudgetUsd) options.maxBudgetUsd = req.maxBudgetUsd;
  if (req.engineSandbox) options.sandbox = req.engineSandbox;
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
        const options = buildSdkOptions(
          req,
          this.opts,
          { preToolUse, postToolUse, canUseTool },
          abortController,
          (d) => {
            stderrTail.push(...d.split('\n').filter((l) => l.trim()));
            stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
          },
        );
        const queryFn = this.opts.queryFn ?? (await defaultQuery());
        for await (const message of queryFn({ prompt: req.prompt, options })) {
          if (finished) break;
          const bodies = normalizer.push(message);
          const violation =
            bodies
              .flatMap((b) =>
                b.type === 'session.init'
                  ? [checkAuthSource('sdk', this.authMethod, b.data.apiKeySource).failure]
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
