import { newId } from '@orbit/core';
import type { OrbitDb } from '@orbit/store';

export type TriagePurpose = 'summary' | 'bot_proposal';

export interface TriageCall {
  id: string;
  purpose: TriagePurpose;
  botId: string | null;
  runId: string | null;
  model: string;
  status: 'ok' | 'failed';
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
}

export interface TriageUsage {
  /** Calls since local midnight (all purposes, failed ones too: they may have spent). */
  callsToday: number;
  limit: number;
  inputTokensToday: number;
  outputTokensToday: number;
  /** Engine-estimated USD today; informational in subscription mode. */
  costUsdToday: number;
  recent: TriageCall[];
}

interface Row {
  id: string;
  purpose: string;
  bot_id: string | null;
  run_id: string | null;
  model: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number | null;
  error: string | null;
  created_at: string;
}

const toCall = (r: Row): TriageCall => ({
  id: r.id,
  purpose: r.purpose as TriagePurpose,
  botId: r.bot_id,
  runId: r.run_id,
  model: r.model,
  status: r.status as 'ok' | 'failed',
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsd: r.cost_micro_usd === null ? null : r.cost_micro_usd / 1e6,
  error: r.error,
  createdAt: r.created_at,
});

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Every call on the triage path, so the owner can see — and cap — what it spends. */
export class TriageLedger {
  constructor(
    private readonly db: OrbitDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(call: Omit<TriageCall, 'id' | 'createdAt'>): TriageCall {
    const full: TriageCall = { ...call, id: newId('tri'), createdAt: this.now().toISOString() };
    this.db.sqlite
      .prepare(
        `INSERT INTO triage_calls (id, purpose, bot_id, run_id, model, status, input_tokens,
           output_tokens, cost_micro_usd, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.purpose,
        full.botId,
        full.runId,
        full.model,
        full.status,
        full.inputTokens,
        full.outputTokens,
        full.costUsd === null ? null : Math.round(full.costUsd * 1e6),
        full.error,
        full.createdAt,
      );
    return full;
  }

  usage(limit: number): TriageUsage {
    const since = startOfLocalDay(this.now()).toISOString();
    const today = this.db.sqlite
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
                COALESCE(SUM(cost_micro_usd), 0) AS c FROM triage_calls WHERE created_at >= ?`,
      )
      .get(since) as { n: number; i: number; o: number; c: number };
    const recent = (
      this.db.sqlite
        .prepare('SELECT * FROM triage_calls ORDER BY created_at DESC, id DESC LIMIT 20')
        .all() as Row[]
    ).map(toCall);
    return {
      callsToday: today.n,
      limit,
      inputTokensToday: today.i,
      outputTokensToday: today.o,
      costUsdToday: today.c / 1e6,
      recent,
    };
  }
}
