import { type RunEventBody, event, truncate } from '@orbit/core';

/**
 * The one place where engine output becomes Orbit events (ADR-002).
 *
 * Input: Agent SDK `SDKMessage` objects — identical to the CLI's
 * `--output-format stream-json --verbose` lines. Typed loosely on purpose:
 * engine versions add fields and message types, and an unknown shape must
 * degrade to a `raw` event, never crash a Run.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => {
  const n = num(v);
  return n === null ? 0 : Math.max(0, Math.round(n));
};

/** Tools whose calls spawn a subagent. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Known high-frequency engine messages that carry nothing Orbit models. */
const IGNORED_TYPES = new Set([
  'active_goal',
  'autocompact_state',
  'stream_event',
  'prompt_suggestion',
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'elicitation_complete',
]);
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_progress',
  'thinking_tokens',
  'task_summary',
  'task_progress',
  'task_updated',
  'status',
  'session_state_changed',
  'commands_changed',
  'background_tasks_changed',
  'files_persisted',
  'compact_boundary',
  'informational',
  'local_command_output',
]);

export const MAX_TOOL_RESULT_CHARS = 16_000;

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  limitType: string | null;
  resetsAt: string | null;
  utilization: number | null;
}

function epochToIso(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  // Engine reports seconds; tolerate milliseconds.
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isObj(part)) return '';
        if (part.type === 'text') return str(part.text) ?? '';
        if (part.type === 'image') return '[image]';
        return `[${str(part.type) ?? 'content'}]`;
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

export class Normalizer {
  sessionId: string | null = null;
  lastRateLimit: RateLimitSnapshot | null = null;
  /** Set when the engine reports an assistant-level error (e.g. rate_limit). */
  assistantError: string | null = null;
  lastAssistantText: string | null = null;
  terminal: RunEventBody | null = null;
  private readonly subagents = new Set<string>();

  constructor(private readonly maxToolResultChars = MAX_TOOL_RESULT_CHARS) {}

  push(message: unknown): RunEventBody[] {
    if (!isObj(message)) return [];
    const sid = str(message.session_id);
    if (sid) this.sessionId = sid;
    const type = str(message.type) ?? 'unknown';
    const subtype = str(message.subtype);

    switch (type) {
      case 'assistant':
        return this.assistant(message);
      case 'user':
        return this.user(message);
      case 'system':
        return this.system(message, subtype);
      case 'rate_limit_event':
        return this.rateLimit(message);
      case 'result':
        return this.result(message);
      default:
        if (IGNORED_TYPES.has(type)) return [];
        return [event('raw', { messageType: type, subtype })];
    }
  }

  private assistant(m: Json): RunEventBody[] {
    const parent = str(m.parent_tool_use_id);
    const err = str(m.error);
    if (err) this.assistantError = err;
    const msg = isObj(m.message) ? m.message : {};
    const messageId = str(msg.id);
    const content = Array.isArray(msg.content) ? msg.content : [];
    const out: RunEventBody[] = [];
    for (const block of content) {
      if (!isObj(block)) continue;
      const bt = str(block.type);
      if (bt === 'text') {
        const text = str(block.text) ?? '';
        if (text.trim().length === 0) continue;
        if (!parent) this.lastAssistantText = text;
        out.push(event('message.assistant', { messageId, text, parentToolUseId: parent }));
      } else if (bt === 'thinking') {
        const text = str(block.thinking) ?? '';
        if (text.trim().length > 0) {
          out.push(event('message.thinking', { messageId, text, parentToolUseId: parent }));
        }
      } else if (bt === 'tool_use' || bt === 'server_tool_use' || bt === 'mcp_tool_use') {
        const toolUseId = str(block.id) ?? '';
        const name = str(block.name) ?? 'unknown';
        const input = isObj(block.input) ? block.input : {};
        out.push(event('tool.call', { toolUseId, name, input, parentToolUseId: parent }));
        if (SUBAGENT_TOOLS.has(name) && !this.subagents.has(toolUseId)) {
          this.subagents.add(toolUseId);
          out.push(
            event('subagent.started', {
              toolUseId,
              agentType: str(input.subagent_type),
              description: str(input.description),
              parentToolUseId: parent,
            }),
          );
        }
      }
    }
    return out;
  }

  private user(m: Json): RunEventBody[] {
    const parent = str(m.parent_tool_use_id);
    const msg = isObj(m.message) ? m.message : {};
    const content = msg.content;
    if (typeof content === 'string') {
      return content.trim()
        ? [event('message.user', { text: content, parentToolUseId: parent })]
        : [];
    }
    if (!Array.isArray(content)) return [];
    const out: RunEventBody[] = [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'tool_result') {
        const toolUseId = str(block.tool_use_id) ?? '';
        const isError = block.is_error === true;
        const { text, truncated } = truncate(
          toolResultText(block.content),
          this.maxToolResultChars,
        );
        out.push(
          event('tool.result', {
            toolUseId,
            isError,
            content: text,
            truncated,
            parentToolUseId: parent,
          }),
        );
        if (this.subagents.has(toolUseId)) {
          out.push(event('subagent.stopped', { toolUseId, isError }));
        }
      } else if (block.type === 'text') {
        const text = str(block.text) ?? '';
        if (text.trim()) out.push(event('message.user', { text, parentToolUseId: parent }));
      }
    }
    return out;
  }

  private system(m: Json, subtype: string | null): RunEventBody[] {
    switch (subtype) {
      case 'init':
        return [
          event('session.init', {
            sessionId: str(m.session_id) ?? '',
            model: str(m.model),
            tools: Array.isArray(m.tools)
              ? m.tools.filter((t): t is string => typeof t === 'string')
              : [],
            engineVersion: str(m.claude_code_version),
            permissionMode: str(m.permissionMode),
            apiKeySource: str(m.apiKeySource),
          }),
        ];
      case 'hook_response':
        return [
          event('hook', {
            hookEvent: str(m.hook_event) ?? 'unknown',
            hookName: str(m.hook_name) ?? 'unknown',
            outcome: str(m.outcome),
          }),
        ];
      case 'post_turn_summary':
        return [
          event('status.summary', {
            category: str(m.status_category) ?? 'unknown',
            detail: str(m.status_detail),
            needsAction: str(m.needs_action),
          }),
        ];
      case 'api_retry':
        return [
          event('api.retry', {
            attempt: num(m.attempt),
            delayMs: num(m.retry_delay_ms),
            error: str(m.error),
          }),
        ];
      case 'task_started': {
        const toolUseId = str(m.tool_use_id);
        if (!toolUseId || this.subagents.has(toolUseId)) return [];
        this.subagents.add(toolUseId);
        return [
          event('subagent.started', {
            toolUseId,
            agentType: str(m.subagent_type),
            description: str(m.description),
            parentToolUseId: null,
          }),
        ];
      }
      default:
        if (subtype && IGNORED_SYSTEM_SUBTYPES.has(subtype)) return [];
        return [event('raw', { messageType: 'system', subtype })];
    }
  }

  private rateLimit(m: Json): RunEventBody[] {
    const info = isObj(m.rate_limit_info) ? m.rate_limit_info : {};
    const status = str(info.status);
    if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return [];
    const snap: RateLimitSnapshot = {
      status,
      limitType: str(info.rateLimitType),
      resetsAt: epochToIso(info.resetsAt),
      utilization: num(info.utilization),
    };
    this.lastRateLimit = snap;
    return [event('usage_limit', snap)];
  }

  private result(m: Json): RunEventBody[] {
    const usage = isObj(m.usage) ? m.usage : {};
    const models = isObj(m.modelUsage) ? Object.keys(m.modelUsage) : [];
    const out: RunEventBody[] = [
      event('usage', {
        inputTokens: int(usage.input_tokens),
        outputTokens: int(usage.output_tokens),
        cacheReadTokens: int(usage.cache_read_input_tokens),
        cacheCreationTokens: int(usage.cache_creation_input_tokens),
        costUsd: num(m.total_cost_usd),
        numTurns: int(m.num_turns),
        durationMs: int(m.duration_ms),
        models,
      }),
    ];
    const subtype = str(m.subtype);
    const isError = m.is_error === true || (subtype !== null && subtype !== 'success');
    const resultText = str(m.result) ?? this.lastAssistantText ?? '';
    const sessionId = str(m.session_id) ?? this.sessionId;

    let terminal: RunEventBody;
    if (!isError) {
      const denials = Array.isArray(m.permission_denials) ? m.permission_denials : [];
      terminal = event('run.completed', {
        result: resultText,
        stopReason: str(m.stop_reason),
        sessionId,
        permissionDenials: denials.filter(isObj).map((d) => ({
          toolName: str(d.tool_name) ?? 'unknown',
          toolUseId: str(d.tool_use_id),
        })),
      });
    } else if (this.isRateLimited(m)) {
      terminal = event('run.rate_limited', {
        resetsAt: this.lastRateLimit?.resetsAt ?? null,
        limitType: this.lastRateLimit?.limitType ?? null,
        message: resultText || 'Usage limit reached',
        sessionId,
      });
    } else {
      const errors = Array.isArray(m.errors)
        ? m.errors.filter((e): e is string => typeof e === 'string')
        : [];
      const code = this.errorCode(subtype);
      terminal = event('run.failed', {
        code,
        message: errors.join('; ') || resultText || `Engine ended with ${subtype ?? 'an error'}`,
        retryable: code === 'overloaded' || code === 'server_error' || code === 'api_error',
        sessionId,
      });
    }
    this.terminal = terminal;
    out.push(terminal);
    return out;
  }

  private isRateLimited(m: Json): boolean {
    if (this.lastRateLimit?.status === 'rejected') return true;
    if (this.assistantError === 'rate_limit') return true;
    return num(m.api_error_status) === 429;
  }

  private errorCode(subtype: string | null): string {
    switch (subtype) {
      case 'error_max_turns':
        return 'max_turns';
      case 'error_max_budget_usd':
        return 'budget_exceeded';
      case 'error_max_structured_output_retries':
        return 'structured_output_failed';
      case 'error_during_execution':
        return this.assistantError ?? 'engine_error';
      default:
        return this.assistantError ?? 'api_error';
    }
  }
}

/** Convenience: normalize a whole recorded transcript. */
export function normalizeAll(messages: readonly unknown[]): RunEventBody[] {
  const n = new Normalizer();
  return messages.flatMap((m) => n.push(m));
}
