import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { type AuthMethod, type RunEventBody, event } from '@orbit/core';
import { type Env, assertChildEnvSafe, buildChildEnv } from '../env';
import { Channel } from './channel';
import type { HookBridge } from './hook-bridge';
import { checkAuthSource } from './auth-source';
import { Normalizer } from './normalize';
import { decide, hookOutput, postHookOutput, postProcess } from './permission';
import { EventSequencer } from './sequencer';
import type { AgentDriver, DriverRunRequest } from './types';

export const HOOK_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../bin/orbit-hook.mjs',
);

/** Seconds Claude Code waits for Orbit's PreToolUse hook before giving up. */
export const HOOK_TIMEOUT_SECONDS = 600;

export interface CliDriverOptions {
  claudePath: string;
  authMethod: AuthMethod;
  /** Source environment (normally process.env); filtered through the cli-engine allowlist. */
  env: Env;
  /** Shared loopback bridge for PreToolUse hooks. */
  bridge: HookBridge;
  /** Grace period between SIGTERM and SIGKILL when a Run is stopped. */
  killGraceMs?: number;
  /** Node binary that runs the hook script. */
  nodePath?: string;
  hookScript?: string;
  /** Registers per-run secrets (the hook token) with the event redactor. */
  secrets?: { addSecret(value: string): void };
  /** How long a hook request may wait for its tool call to appear on stdout. */
  callWaitMs?: number;
}

const reject = (reason: string) => hookOutput({ behavior: 'deny', reason });

const quote = (s: string): string => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

/**
 * Settings passed with `--settings`: Orbit's PreToolUse hook decides every
 * tool call, its PostToolUse hook post-processes every result, and the Bot's
 * native engine sandbox (if any) confines shell commands.
 */
export function buildCliSettings(
  nodePath: string,
  hookScript: string,
  engineSandbox: Record<string, unknown> | null = null,
): string {
  const hook = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `${quote(nodePath)} ${quote(hookScript)}`,
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return JSON.stringify({
    hooks: { PreToolUse: hook, PostToolUse: hook },
    ...(engineSandbox ? { sandbox: engineSandbox } : {}),
  });
}

/**
 * Arguments for `claude -p`. The prompt is written to stdin (no argv length
 * limits, not visible in `ps`). User/project settings, plugins' MCP servers
 * and interactive permission prompts are all disabled: Orbit's hook is the
 * only thing that can allow a tool call.
 */
export function buildCliArgs(req: DriverRunRequest, settingsJson: string): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    settingsJson,
    '--permission-mode',
    'default',
    '--permission-prompts',
    'none',
  ];
  if (req.model) args.push('--model', req.model);
  if (req.maxTurns) args.push('--max-turns', String(req.maxTurns));
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  else if (req.sessionId) args.push('--session-id', req.sessionId);
  if (req.appendSystemPrompt) args.push('--append-system-prompt', req.appendSystemPrompt);
  // Subagent messages carry parent_tool_use_id so their tool calls can be verified.
  args.push('--forward-subagent-text');
  if (req.tools) args.push('--tools', req.tools.join(','));
  if (req.maxBudgetUsd) args.push('--max-budget-usd', String(req.maxBudgetUsd));
  return args;
}

/**
 * CliDriver: runs the user's own, already logged-in `claude` binary, so usage
 * counts against their Claude subscription. Only allowed for local,
 * single-user use (see auth/guard.ts). The child never receives an API key or
 * any OAuth credential from Orbit (ADR-005).
 */
export class CliDriver implements AgentDriver {
  readonly kind = 'cli' as const;
  readonly authMethod: AuthMethod;
  private readonly opts: Required<Omit<CliDriverOptions, 'authMethod' | 'secrets'>>;
  private readonly secrets: CliDriverOptions['secrets'];

  constructor(options: CliDriverOptions) {
    this.authMethod = options.authMethod;
    this.opts = {
      claudePath: options.claudePath,
      env: options.env,
      bridge: options.bridge,
      killGraceMs: options.killGraceMs ?? 5000,
      nodePath: options.nodePath ?? process.execPath,
      hookScript: options.hookScript ?? HOOK_SCRIPT,
      callWaitMs: options.callWaitMs ?? 10_000,
    };
    this.secrets = options.secrets;
  }

  run(req: DriverRunRequest): AsyncIterable<RunEventBody> {
    const out = new Channel<RunEventBody>();
    const seq = new EventSequencer(out);
    const normalizer = new Normalizer();
    let finished = false;
    const finish = (body?: RunEventBody) => {
      if (finished) return;
      seq.flush();
      if (body) out.push(body);
      finished = true;
      out.close();
    };

    // The bridge only decides tool calls the engine announced on stdout, once
    // each, with the same name and input. Anything else (a Bot that read its
    // hook token and forges requests) is denied without touching the log.
    const registration = this.opts.bridge.register(async (input) => {
      if (input.hook_event_name === 'PostToolUse') {
        // Only post-process calls Orbit allowed; anything else gets no rewrite.
        const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;
        if (!id || !seq.wasAllowed(id)) return {};
        return postHookOutput(
          await postProcess(req.toolResult, {
            toolName: typeof input.tool_name === 'string' ? input.tool_name : 'unknown',
            toolUseId: id,
            input:
              typeof input.tool_input === 'object' && input.tool_input !== null
                ? (input.tool_input as Record<string, unknown>)
                : {},
            response: input.tool_response,
          }),
        );
      }
      if (input.hook_event_name !== 'PreToolUse') return reject('Unsupported hook event');
      const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;
      const toolName = typeof input.tool_name === 'string' ? input.tool_name : null;
      const toolInput =
        typeof input.tool_input === 'object' && input.tool_input !== null
          ? (input.tool_input as Record<string, unknown>)
          : null;
      if (!toolUseId || !toolName || !toolInput) return reject('Malformed hook request');
      if (!(await seq.awaitCall(toolUseId, this.opts.callWaitMs))) {
        return reject('Unknown tool call');
      }
      const call = seq.claimCall(toolUseId, toolName, toolInput);
      if (!call) return reject('Tool call does not match the engine output or was already decided');
      const { decision, event: decisionEvent } = await decide(
        req.permission,
        { toolName, input: toolInput, toolUseId, parentToolUseId: call.parentToolUseId },
        req.signal,
      );
      seq.decision(toolUseId, decisionEvent, decision.behavior === 'allow');
      return hookOutput(decision);
    });
    this.secrets?.addSecret(registration.token);

    const env = buildChildEnv('cli-engine', this.opts.env, {
      ORBIT_HOOK_URL: this.opts.bridge.url,
      ORBIT_HOOK_TOKEN: registration.token,
    });
    assertChildEnvSafe('cli-engine', env);

    const args = buildCliArgs(
      req,
      buildCliSettings(this.opts.nodePath, this.opts.hookScript, req.engineSandbox ?? null),
    );
    // Own process group, so stopping a Run also stops tool grandchildren.
    const child = spawn(this.opts.claudePath, args, {
      cwd: req.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    const stderrTail: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail.push(...chunk.split('\n').filter((l) => l.trim()));
      stderrTail.splice(0, Math.max(0, stderrTail.length - 20));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(req.prompt);

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (finished || line.trim().length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        out.push(
          event('diagnostic', {
            level: 'warn',
            message: `Unparseable engine output: ${line.slice(0, 200)}`,
          }),
        );
        return;
      }
      const bodies = normalizer.push(message);
      for (const b of bodies) {
        if (b.type !== 'session.init') continue;
        const check = checkAuthSource('cli', this.authMethod, b.data.apiKeySource);
        if (check.failure) return stop(check.failure);
      }
      const violation = seq.engine(bodies);
      if (violation) return stop(violation);
      if (normalizer.terminal) finish();
    });

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), this.opts.killGraceMs);
      killTimer.unref();
    };
    /** Stop the engine immediately with a terminal event (policy/auth violation). */
    const stop = (terminal: RunEventBody) => {
      const sessionId = normalizer.sessionId ?? req.resumeSessionId ?? req.sessionId;
      finish(
        terminal.type === 'run.failed'
          ? { ...terminal, data: { ...terminal.data, sessionId } }
          : terminal,
      );
      onAbort();
    };
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    let exited = false;
    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      lines.close();
      req.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      registration.dispose();
      if (normalizer.terminal) {
        finish();
        return;
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
            `claude exited ${sig ? `on ${sig}` : `with code ${code ?? 'unknown'}`} before finishing` +
            (stderrTail.length ? `: ${stderrTail.slice(-5).join(' | ')}` : ''),
          retryable: false,
          sessionId,
        }),
      );
    };
    // 'close' fires after stdout is drained, so every line has been parsed.
    child.on('close', onExit);
    child.on('error', (err) => {
      registration.dispose();
      finish(
        event('run.failed', {
          code: 'engine_spawn_failed',
          message: `Could not start claude at ${this.opts.claudePath}: ${err.message}`,
          retryable: false,
          sessionId: req.resumeSessionId ?? req.sessionId,
        }),
      );
    });

    return out;
  }
}
