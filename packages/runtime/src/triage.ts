import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { BotProposal, OrbitError, type RunEventBody, errorMessage } from '@orbit/core';
import {
  PROPOSAL_SYSTEM,
  SUMMARY_SYSTEM,
  type TriageLedger,
  type TriagePurpose,
  type TriageUsage,
} from '@orbit/memory';
import { denyAll } from './drivers/permission';
import type { AgentDriver } from './drivers/types';

export interface TriageRequest {
  purpose: TriagePurpose;
  botId: string | null;
  runId: string | null;
  system: string;
  prompt: string;
}

export interface TriageResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** One model call with no tools, on the triage model. */
export type TriageEngine = (req: TriageRequest, signal: AbortSignal) => Promise<TriageResult>;

/**
 * The triage call through the active driver: the same engine, credentials
 * and child environment as a Run (so subscription mode stays the user's own
 * `claude`), but with every tool disabled, one turn, and a policy that
 * denies anything the engine might still try.
 */
export function driverTriage(
  driver: AgentDriver,
  opts: { model: string; cwd: string },
): TriageEngine {
  return async (req, signal) => {
    mkdirSync(opts.cwd, { recursive: true, mode: 0o700 });
    let text = '';
    let usage: Extract<RunEventBody, { type: 'usage' }>['data'] | null = null;
    let terminal: RunEventBody | null = null;
    for await (const body of driver.run({
      runId: `triage-${randomUUID()}`,
      prompt: req.prompt,
      cwd: opts.cwd,
      model: opts.model,
      appendSystemPrompt: req.system,
      tools: [],
      maxTurns: 1,
      resumeSessionId: null,
      sessionId: randomUUID(),
      permission: denyAll,
      signal,
      engineSandbox: null,
      maxBudgetUsd: null,
    })) {
      if (body.type === 'message.assistant' && !body.data.parentToolUseId) text = body.data.text;
      if (body.type === 'usage') usage = body.data;
      if (
        body.type === 'run.completed' ||
        body.type === 'run.failed' ||
        body.type === 'run.cancelled' ||
        body.type === 'run.rate_limited'
      ) {
        terminal = body;
        break;
      }
    }
    const tokens = {
      model: usage?.models[0] ?? opts.model,
      inputTokens:
        (usage?.inputTokens ?? 0) +
        (usage?.cacheReadTokens ?? 0) +
        (usage?.cacheCreationTokens ?? 0),
      outputTokens: usage?.outputTokens ?? 0,
      costUsd: usage?.costUsd ?? null,
    };
    if (terminal?.type !== 'run.completed') {
      const message =
        terminal?.type === 'run.failed' || terminal?.type === 'run.rate_limited'
          ? terminal.data.message
          : 'The triage call was stopped';
      throw Object.assign(new OrbitError('engine_error', message), { usage: tokens });
    }
    return { text: text || terminal.data.result, ...tokens };
  };
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim();
}

/**
 * Demo mode (MockDriver): deterministic, free, no model. Summaries list the
 * main agent's messages; proposals are derived from the goal's words.
 */
export const mockTriage: TriageEngine = (req) => {
  if (req.system === SUMMARY_SYSTEM) {
    const lines = req.prompt.split('\n');
    const task = (lines.find((l) => l.startsWith('TASK: ')) ?? 'TASK: a task').slice(6);
    const said = lines
      .filter((l) => l.startsWith('ASSISTANT: ') || l.startsWith('RESULT: '))
      .map((l) => `- ${l.replace(/^(ASSISTANT|RESULT): /, '').slice(0, 200)}`)
      .slice(-5);
    return Promise.resolve({
      text: [`Summary (demo): ${firstLine(task).slice(0, 70)}`, ...said].join('\n'),
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }
  if (req.system === PROPOSAL_SYSTEM) {
    const goal = (/<goal>\n([\s\S]*?)\n<\/goal>/.exec(req.prompt)?.[1] ?? '').trim();
    const g = goal.toLowerCase();
    const tools = ['Read', 'Glob', 'Grep'];
    if (/\b(web|site|news|search|online|research)\b/.test(g)) tools.push('WebSearch', 'WebFetch');
    if (/\b(write|draft|report|notes?|summar)/.test(g)) tools.push('Write');
    const daily = /\b(daily|every (day|morning)|each morning)\b/.test(g);
    const weekly = /\b(weekly|every week|mondays?)\b/.test(g);
    const proposal = BotProposal.parse({
      name: (goal.split(/\s+/).slice(0, 3).join(' ') || 'New Bot').slice(0, 40),
      goal: goal || 'Help the owner',
      instructions: 'Keep results short. Ask for approval before anything leaves the machine.',
      tools,
      schedule: daily ? { cron: '0 9 * * *' } : weekly ? { cron: '0 9 * * 1' } : null,
      subagents: {},
      rationale: [
        'Demo proposal (mock driver): derived from the words of your goal, no model was called.',
        `Tools: ${tools.join(', ')} — read-only unless the goal asks for written output.`,
      ],
    });
    return Promise.resolve({
      text: JSON.stringify(proposal),
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }
  return Promise.resolve({
    text: firstLine(req.prompt),
    model: 'mock',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
};

export interface TriagePathDeps {
  ledger: TriageLedger;
  /** The engine for the current driver (resolved lazily). */
  engine: () => Promise<TriageEngine>;
  maxCallsPerDay: () => number;
  /** Why no triage call may start now (kill switch, usage-limit hold), or null. */
  hold: () => string | null;
  timeoutMs?: number;
}

/**
 * The only way Orbit spends model usage outside a Run (ADR-012): every call
 * is counted against `triage.maxCallsPerDay`, recorded with its tokens and
 * cost, refused while a kill switch or usage limit holds, and run one at a
 * time.
 */
export class TriagePath {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** Includes queued calls, so an engine cannot be replaced beneath a triage call. */
  get busy(): boolean {
    return this.pending > 0;
  }

  constructor(private readonly deps: TriagePathDeps) {}

  usage(): TriageUsage {
    return this.deps.ledger.usage(this.deps.maxCallsPerDay());
  }

  /** Throws `blocked` (with the reason) when a call may not start. */
  check(): void {
    const held = this.deps.hold();
    if (held) throw new OrbitError('blocked', `Triage calls are paused: ${held}`);
    const u = this.usage();
    if (u.limit === 0) {
      throw new OrbitError('blocked', 'Triage calls are turned off', {
        hint: 'Set triage.maxCallsPerDay (or ORBIT_TRIAGE_MAX_CALLS_PER_DAY) above 0.',
      });
    }
    if (u.callsToday >= u.limit) {
      throw new OrbitError(
        'blocked',
        `Daily triage limit reached (${u.callsToday} of ${u.limit} calls today)`,
        { hint: 'It resets at midnight; raise triage.maxCallsPerDay to allow more.' },
      );
    }
  }

  call(req: TriageRequest): Promise<TriageResult> {
    this.pending += 1;
    const run = async (): Promise<TriageResult> => {
      this.check();
      const engine = await this.deps.engine();
      const signal = AbortSignal.timeout(this.deps.timeoutMs ?? 120_000);
      try {
        const r = await engine(req, signal);
        this.deps.ledger.record({ ...base(req), status: 'ok', ...pick(r), error: null });
        return r;
      } catch (err) {
        const u = (err as { usage?: Partial<TriageResult> }).usage;
        this.deps.ledger.record({
          ...base(req),
          status: 'failed',
          model: u?.model ?? 'unknown',
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          costUsd: u?.costUsd ?? null,
          error: errorMessage(err).slice(0, 500),
        });
        throw err;
      }
    };
    const next = this.chain.then(run, run).finally(() => {
      this.pending -= 1;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

const base = (req: TriageRequest) => ({ purpose: req.purpose, botId: req.botId, runId: req.runId });
const pick = (r: TriageResult) => ({
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  costUsd: r.costUsd,
});
