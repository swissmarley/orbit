import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Bot,
  type OrbitConfig,
  type PermissionHandler,
  type RunEvent,
  type RunEventBody,
  type RunState,
  type TriggerRef,
  event,
  isTerminalEvent,
  newId,
  slugify,
} from '@orbit/core';
import type { EventStore } from '@orbit/store';
import type { AgentDriver } from './drivers/types';
import { composeBotSystemPrompt } from './prompt';

export interface OrchestratorDeps {
  config: OrbitConfig;
  store: EventStore;
  driver: AgentDriver;
  /** Policy for a Bot's Runs; receives the Bot's workspace path. */
  permissionFor: (bot: Bot, workspace: string) => PermissionHandler;
}

export interface StartRunOptions {
  prompt?: string;
  trigger?: TriggerRef;
  signal?: AbortSignal;
  /** Resume the engine session of a previous Run of the same Bot. */
  resumeSessionId?: string | null;
  mockFixture?: string;
  onEvent?: (event: RunEvent) => void;
}

export function workspaceFor(config: OrbitConfig, bot: Bot): string {
  return join(config.home, 'workspaces', slugify(bot.spec.name));
}

/**
 * Runs a Bot: allocates a Run, streams driver events into the append-only
 * log and returns the final projection. Queueing, scheduling and
 * park-and-resume build on this in M2/M3.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(bot: Bot, options: StartRunOptions = {}): Promise<RunState> {
    const { config, store, driver } = this.deps;
    const runId = newId('run');
    const cwd = workspaceFor(config, bot);
    mkdirSync(cwd, { recursive: true });
    const model = bot.spec.model ?? config.models.default;
    const requested = options.prompt?.trim() ?? '';
    const prompt = requested.length > 0 ? requested : bot.spec.goal;
    const resumeSessionId = options.resumeSessionId ?? null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const append = (bodies: RunEventBody[]) => {
      for (const e of store.append(runId, bot.id, bodies)) options.onEvent?.(e);
    };

    append([
      event('run.queued', { trigger: options.trigger ?? { kind: 'manual', source: null }, prompt }),
      event('run.started', {
        driver: driver.kind,
        authMethod: driver.authMethod,
        model,
        cwd,
        resumeSessionId,
      }),
    ]);

    let terminal = false;
    try {
      for await (const body of driver.run({
        runId,
        prompt,
        cwd,
        model,
        appendSystemPrompt: composeBotSystemPrompt(bot),
        tools: bot.spec.tools ?? null,
        maxTurns: bot.spec.maxTurns ?? null,
        resumeSessionId,
        sessionId: resumeSessionId ? null : randomUUID(),
        permission: this.deps.permissionFor(bot, cwd),
        signal: controller.signal,
        mockFixture: options.mockFixture ?? bot.spec.mock?.fixture,
      })) {
        if (terminal) break;
        append([body]);
        if (isTerminalEvent(body)) terminal = true;
      }
    } catch (err) {
      if (!terminal) {
        append([
          event('run.failed', {
            code: 'internal',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
            sessionId: null,
          }),
        ]);
        terminal = true;
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (!terminal) {
      append([
        event('run.failed', {
          code: 'driver_contract',
          message: `${driver.kind} driver ended without a terminal event`,
          retryable: false,
          sessionId: null,
        }),
      ]);
    }
    const state = store.getRun(runId);
    if (!state) throw new Error(`run ${runId} has no projection`);
    return state;
  }
}
