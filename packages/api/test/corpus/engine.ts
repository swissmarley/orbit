import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEventBody, ToolResultDecision, ToolResultRequest } from '@orbit/core';
import { type AgentDriver, type DriverRunRequest, MockDriver } from '@orbit/runtime';

/**
 * Synthetic engine transcripts for the corpus. They are generated per test
 * (into a temporary fixtures directory) rather than committed, because most
 * of them carry a payload or an id that only exists at test time. Shapes are
 * the stream-json messages of Claude Code 2.1.289 (see
 * packages/runtime/fixtures/README.md).
 */
export const ENGINE_VERSION_DIR = 'claude-2.1.289';

export type Step =
  /** A tool call; `result` is what the recording says the tool returned. */
  | {
      tool: string;
      input: Record<string, unknown>;
      result?: string;
      /** The recording shows Orbit denying it, so the replay continues after the denial. */
      denied?: boolean;
    }
  /** The model says something (becomes the approval card's "why" for the next call). */
  | { say: string };

export type ToolStep = Extract<Step, { tool: string }>;

export interface TranscriptOptions {
  /** The final answer (the Run's result). */
  result?: string;
  /** Engine-estimated cost of the whole segment. */
  costUsd?: number;
  /** Input and output tokens of every assistant message. */
  tokensPerTurn?: { input: number; output: number };
  /** Make the final message an `error_max_turns` result instead of success. */
  maxTurns?: boolean;
}

const SESSION = '00000000-0000-4000-8000-0000000c0de5';

/** Engine messages for `steps`, ending with a result. */
export function transcript(steps: readonly Step[], opts: TranscriptOptions = {}): unknown[] {
  const tokens = opts.tokensPerTurn ?? { input: 10, output: 5 };
  const usage = { input_tokens: tokens.input, output_tokens: tokens.output };
  const out: unknown[] = [
    {
      type: 'system',
      subtype: 'init',
      cwd: '/workspace',
      session_id: SESSION,
      tools: [],
      mcp_servers: [],
      model: 'haiku',
      permissionMode: 'default',
      apiKeySource: 'none',
      claude_code_version: '2.1.289',
    },
  ];
  const denied: { tool_name: string; tool_use_id: string }[] = [];
  let turns = 0;
  const assistant = (content: unknown[]) => {
    turns += 1;
    out.push({
      type: 'assistant',
      message: {
        id: `msg_c${turns}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: null,
        usage,
      },
      parent_tool_use_id: null,
      session_id: SESSION,
    });
  };
  steps.forEach((step, i) => {
    if ('say' in step) {
      assistant([{ type: 'text', text: step.say }]);
      return;
    }
    const id = `toolu_c${i + 1}`;
    assistant([{ type: 'tool_use', id, name: step.tool, input: step.input }]);
    if (step.denied) denied.push({ tool_name: step.tool, tool_use_id: id });
    out.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: step.result ?? 'ok' }],
      },
      parent_tool_use_id: null,
      session_id: SESSION,
    });
  });
  const result = opts.result ?? 'Done.';
  assistant([{ type: 'text', text: result }]);
  out.push({
    type: 'result',
    subtype: opts.maxTurns ? 'error_max_turns' : 'success',
    is_error: Boolean(opts.maxTurns),
    duration_ms: 100,
    duration_api_ms: 90,
    num_turns: turns,
    result,
    stop_reason: 'end_turn',
    session_id: SESSION,
    total_cost_usd: opts.costUsd ?? 0,
    usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: denied,
  });
  return out;
}

/** Write `<root>/claude-2.1.289/<name>.jsonl`. */
export function writeFixture(root: string, name: string, messages: readonly unknown[]): void {
  const dir = join(root, ENGINE_VERSION_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.jsonl`),
    `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`,
  );
}

export interface EngineRequest {
  runId: string;
  /** What the engine was asked (task, memory, untrusted blocks, resume notes). */
  prompt: string;
  system: string | null;
  resumed: boolean;
  maxTurns: number | null;
}

export interface EngineToolResult {
  runId: string;
  toolName: string;
  response: unknown;
  decision: ToolResultDecision;
}

/**
 * The MockDriver with a tap: records every request the engine got and
 * every tool result Orbit post-processed for it, which is exactly what a real
 * engine would have seen (prompt on stdin, PostToolUse output and context).
 */
export class RecordingDriver implements AgentDriver {
  readonly kind = 'mock' as const;
  readonly authMethod = 'mock' as const;
  readonly requests: EngineRequest[] = [];
  readonly toolResults: EngineToolResult[] = [];
  private readonly inner: MockDriver;

  constructor(opts: { fixturesDir: string; delayMs?: number }) {
    this.inner = new MockDriver({ fixturesDir: opts.fixturesDir, delayMs: opts.delayMs ?? 0 });
  }

  run(req: DriverRunRequest): AsyncIterable<RunEventBody> {
    this.requests.push({
      runId: req.runId,
      prompt: req.prompt,
      system: req.appendSystemPrompt,
      resumed: req.resumeSessionId !== null,
      maxTurns: req.maxTurns,
    });
    const handler = req.toolResult;
    const toolResult = handler
      ? async (r: ToolResultRequest) => {
          const decision = await handler(r);
          this.toolResults.push({
            runId: req.runId,
            toolName: r.toolName,
            response: r.response,
            decision,
          });
          return decision;
        }
      : undefined;
    return this.inner.run({ ...req, toolResult });
  }

  /** Every prompt the engine got for a Run, oldest first. */
  prompts(runId: string): string[] {
    return this.requests.filter((r) => r.runId === runId).map((r) => r.prompt);
  }

  /** What the engine saw of each tool result of a Run: the (rewritten) output and the context note. */
  seen(runId: string, toolName?: string): { output: string; context: string | null }[] {
    return this.toolResults
      .filter((t) => t.runId === runId && (toolName === undefined || t.toolName === toolName))
      .map((t) => {
        const raw = t.decision.updatedOutput ?? t.response;
        return {
          output: typeof raw === 'string' ? raw : JSON.stringify(raw),
          context: t.decision.additionalContext ?? null,
        };
      });
  }
}
