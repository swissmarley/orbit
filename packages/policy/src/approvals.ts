import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Redactor,
  type RunEventBody,
  type Tier,
  OrbitError,
  event,
  inputHash,
  newId,
} from '@orbit/core';
import { type OrbitDb, schema } from '@orbit/store';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import type { ApprovalCard } from './card';
import { RuleStore } from './rules';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface ApprovalDecision {
  decision: 'approved' | 'denied' | 'expired' | 'cancelled';
  by: string;
  reason: string | null;
  /** Input the human edited before approving ("edit then approve"). */
  editedInput: Record<string, unknown> | null;
  /** Standing rule created by "Always allow". */
  ruleId: string | null;
}

export interface Approval {
  id: string;
  runId: string;
  botId: string;
  toolUseId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  inputHash: string;
  tier: Tier;
  card: ApprovalCard;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

export interface DecideInput {
  approve: boolean;
  by: string;
  reason?: string | null;
  editedInput?: Record<string, unknown> | null;
  /** "Always allow": a standing rule for this tool, scoped and with optional expiry. */
  always?: { scope: 'bot' | 'global'; expiresAt: string | null } | null;
}

export interface Grant {
  id: string;
  approvalId: string;
  updatedInput: Record<string, unknown> | null;
}

/** Minimal sinks so the queue can audit and log without depending on their implementations. */
export interface AuditSink {
  append(input: {
    actor: string;
    action: string;
    subject?: string | null;
    data?: Record<string, unknown>;
  }): unknown;
}
export interface EventSink {
  append(runId: string, botId: string, bodies: readonly RunEventBody[]): unknown;
}

type Row = typeof schema.approvals.$inferSelect;

function toApproval(r: Row): Approval {
  return {
    id: r.id,
    runId: r.runId,
    botId: r.botId,
    toolUseId: r.toolUseId,
    toolName: r.toolName,
    input: r.input as Record<string, unknown>,
    inputHash: r.inputHash,
    tier: r.tier as Tier,
    // Cards stored before M6 have no delegation chain.
    card: {
      ...(r.card as ApprovalCard),
      delegatedBy: (r.card as ApprovalCard).delegatedBy ?? null,
    },
    status: r.status as ApprovalStatus,
    decision: (r.decision as ApprovalDecision | null) ?? null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    expiresAt: r.expiresAt,
  };
}

/**
 * The single approval queue both drivers feed (ADR-003). Persistent, so a
 * decision can come from any client or process; the waiting Run polls.
 */
export class ApprovalQueue {
  private readonly rules: RuleStore;

  constructor(
    private readonly db: OrbitDb,
    private readonly sinks: { audit?: AuditSink; events?: EventSink; redactor?: Redactor } = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rules = new RuleStore(db, now);
  }

  create(args: {
    runId: string;
    botId: string;
    toolUseId: string | null;
    toolName: string;
    input: Record<string, unknown>;
    tier: Tier;
    card: ApprovalCard;
    expiresAt?: string | null;
  }): Approval {
    if (args.tier === 'FINANCIAL') {
      throw new OrbitError(
        'invalid_input',
        'Financial actions are never queued for approval; they are handed back',
      );
    }
    const row: Row = {
      id: newId('apr'),
      runId: args.runId,
      botId: args.botId,
      toolUseId: args.toolUseId,
      toolName: args.toolName,
      // Stored and displayed redacted; the grant hash binds the exact raw input.
      input: this.sinks.redactor ? this.sinks.redactor.redact(args.input) : args.input,
      inputHash: inputHash(args.input),
      tier: args.tier,
      card: this.sinks.redactor ? this.sinks.redactor.redact(args.card) : args.card,
      status: 'pending',
      decision: null,
      createdAt: this.now().toISOString(),
      decidedAt: null,
      expiresAt: args.expiresAt ?? null,
    };
    this.db.orm.insert(schema.approvals).values(row).run();
    this.sinks.audit?.append({
      actor: `bot:${args.botId}`,
      action: 'approval.requested',
      subject: row.id,
      data: {
        runId: args.runId,
        toolName: args.toolName,
        tier: args.tier,
        what: args.card.what,
        inputHash: row.inputHash,
      },
    });
    this.sinks.events?.append(args.runId, args.botId, [
      event('approval.requested', {
        approvalId: row.id,
        toolUseId: args.toolUseId,
        toolName: args.toolName,
        tier: args.tier,
        summary: args.card.what,
      }),
    ]);
    return toApproval(row);
  }

  get(id: string): Approval | undefined {
    const row = this.db.orm
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, id))
      .get();
    return row ? toApproval(row) : undefined;
  }

  require(id: string): Approval {
    const a = this.get(id);
    if (!a) throw new OrbitError('not_found', `Approval ${id} not found`);
    return a;
  }

  list(opts: { status?: ApprovalStatus; botId?: string; runId?: string } = {}): Approval[] {
    const conds = [
      opts.status ? eq(schema.approvals.status, opts.status) : undefined,
      opts.botId ? eq(schema.approvals.botId, opts.botId) : undefined,
      opts.runId ? eq(schema.approvals.runId, opts.runId) : undefined,
    ].filter((c) => c !== undefined);
    return this.db.orm
      .select()
      .from(schema.approvals)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.approvals.createdAt))
      .all()
      .map(toApproval);
  }

  /** Approve (optionally edited / always) or deny. Idempotency: only pending approvals can be decided. */
  decide(id: string, input: DecideInput): Approval {
    const ts = this.now().toISOString();
    const result = this.db.sqlite.transaction(() => {
      const current = this.require(id);
      if (
        current.status === 'pending' &&
        current.expiresAt &&
        Date.parse(current.expiresAt) <= Date.parse(ts)
      ) {
        this.db.orm
          .update(schema.approvals)
          .set({
            status: 'expired',
            decision: {
              decision: 'expired',
              by: 'system',
              reason: null,
              editedInput: null,
              ruleId: null,
            },
            decidedAt: ts,
          })
          .where(eq(schema.approvals.id, id))
          .run();
        throw new OrbitError('invalid_input', `Approval ${id} expired at ${current.expiresAt}`);
      }
      if (current.status !== 'pending') {
        throw new OrbitError('invalid_input', `Approval ${id} is already ${current.status}`);
      }
      const edited = input.approve && input.editedInput ? input.editedInput : null;
      let ruleId: string | null = null;
      if (input.approve && input.always) {
        ruleId = this.rules.create(
          {
            botId: input.always.scope === 'bot' ? current.botId : null,
            toolPattern: current.toolName,
            effect: 'allow',
            reason: `Always allow from approval ${id}`,
            createdBy: input.by,
            expiresAt: input.always.expiresAt,
          },
          current.tier,
        ).id;
      }
      const decision: ApprovalDecision = {
        decision: input.approve ? 'approved' : 'denied',
        by: input.by,
        reason: input.reason ?? null,
        editedInput: edited,
        ruleId,
      };
      this.db.orm
        .update(schema.approvals)
        .set({ status: decision.decision, decision, decidedAt: ts })
        .where(eq(schema.approvals.id, id))
        .run();
      if (input.approve) {
        // One-shot grants, bound to this Run and the exact input. A retry with
        // the original input runs the edited version; a retry with the edited
        // input is also accepted. Using either consumes both.
        const hashes = [{ hash: current.inputHash, updated: edited }];
        if (edited) hashes.push({ hash: inputHash(edited), updated: null });
        for (const h of hashes) {
          this.db.orm
            .insert(schema.grants)
            .values({
              id: newId('grt'),
              approvalId: id,
              botId: current.botId,
              runId: current.runId,
              toolName: current.toolName,
              inputHash: h.hash,
              updatedInput: h.updated,
              createdAt: ts,
              usedAt: null,
              revokedAt: null,
            })
            .run();
        }
      }
      return { ...current, status: decision.decision, decision, decidedAt: ts };
    })();

    this.sinks.audit?.append({
      actor: input.by,
      action: 'approval.decided',
      subject: id,
      data: {
        runId: result.runId,
        toolName: result.toolName,
        decision: result.status,
        edited: result.decision.editedInput !== null,
        inputHash: result.inputHash,
        editedInputHash: result.decision.editedInput
          ? inputHash(result.decision.editedInput)
          : null,
        reason: result.decision.reason,
        ruleId: result.decision.ruleId,
      },
    });
    this.sinks.events?.append(result.runId, result.botId, [this.decidedEvent(result)]);
    return result;
  }

  private decidedEvent(a: Approval): RunEventBody {
    return event('approval.decided', {
      approvalId: a.id,
      decision: a.decision?.decision ?? 'cancelled',
      by: a.decision?.by ?? 'system',
      edited: (a.decision?.editedInput ?? null) !== null,
      reason: a.decision?.reason ?? null,
      ruleId: a.decision?.ruleId ?? null,
    });
  }

  /** Close pending approvals of a Run that was stopped (they can no longer be used). */
  cancelForRun(
    runId: string,
    by: string,
    status: 'cancelled' | 'expired' = 'cancelled',
  ): Approval[] {
    const pending = this.list({ runId, status: 'pending' });
    if (pending.length === 0) return [];
    const ts = this.now().toISOString();
    const decision: ApprovalDecision = {
      decision: status,
      by,
      reason: null,
      editedInput: null,
      ruleId: null,
    };
    this.db.orm
      .update(schema.approvals)
      .set({ status, decision, decidedAt: ts })
      .where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.status, 'pending')))
      .run();
    const closed = pending.map((p) => ({ ...p, status, decision, decidedAt: ts }));
    for (const a of closed) {
      this.sinks.audit?.append({
        actor: by,
        action: `approval.${status}`,
        subject: a.id,
        data: { runId },
      });
    }
    const first = closed[0];
    if (first)
      this.sinks.events?.append(
        runId,
        first.botId,
        closed.map((a) => this.decidedEvent(a)),
      );
    return closed;
  }

  /**
   * Expire pending approvals whose `expiresAt` has passed (the orchestrator
   * sets it when it asks). Each becomes `expired` with an approval.decided
   * event, exactly like a denial without a reason. Returns what expired.
   */
  expireDue(): Approval[] {
    const ts = this.now().toISOString();
    const due = this.db.orm
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          isNotNull(schema.approvals.expiresAt),
          lte(schema.approvals.expiresAt, ts),
        ),
      )
      .all()
      .map(toApproval);
    const decision: ApprovalDecision = {
      decision: 'expired',
      by: 'system',
      reason: null,
      editedInput: null,
      ruleId: null,
    };
    const expired: Approval[] = [];
    for (const a of due) {
      // Only still-pending rows: a decision may land between the select and here.
      const changed = this.db.orm
        .update(schema.approvals)
        .set({ status: 'expired', decision, decidedAt: ts })
        .where(and(eq(schema.approvals.id, a.id), eq(schema.approvals.status, 'pending')))
        .run().changes;
      if (changed === 0) continue;
      const closed: Approval = { ...a, status: 'expired', decision, decidedAt: ts };
      expired.push(closed);
      this.sinks.audit?.append({
        actor: 'system',
        action: 'approval.expired',
        subject: a.id,
        data: { runId: a.runId, expiresAt: a.expiresAt },
      });
      this.sinks.events?.append(a.runId, a.botId, [this.decidedEvent(closed)]);
    }
    return expired;
  }

  /**
   * Grants are scoped to the driver segment right after their decision
   * (M2 review L4): when a segment ends, unused grants of the Run created
   * before it started are revoked, so an approval cannot be replayed by a
   * much later segment. Returns how many were revoked.
   */
  revokeGrants(runId: string, createdBefore: string): number {
    return this.db.orm
      .update(schema.grants)
      .set({ revokedAt: this.now().toISOString() })
      .where(
        and(
          eq(schema.grants.runId, runId),
          isNull(schema.grants.usedAt),
          isNull(schema.grants.revokedAt),
          lt(schema.grants.createdAt, createdBefore),
        ),
      )
      .run().changes;
  }

  /** Wait for a decision; null when still pending after `timeoutMs` (the Run then parks). */
  async waitForDecision(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    pollMs = 100,
  ): Promise<Approval | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const a = this.require(id);
      if (a.status !== 'pending') return a;
      if (Date.now() >= deadline || signal?.aborted) return null;
      try {
        await sleep(
          Math.min(pollMs, Math.max(1, deadline - Date.now())),
          undefined,
          signal ? { signal } : {},
        );
      } catch {
        return null;
      }
    }
  }

  /** Consume a one-shot grant for this exact call, if one exists. */
  consumeGrant(
    runId: string,
    botId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Grant | null {
    const hash = inputHash(input);
    return this.db.sqlite.transaction(() => {
      const g = this.db.orm
        .select()
        .from(schema.grants)
        .where(
          and(
            eq(schema.grants.runId, runId),
            eq(schema.grants.botId, botId),
            eq(schema.grants.toolName, toolName),
            eq(schema.grants.inputHash, hash),
            isNull(schema.grants.usedAt),
            isNull(schema.grants.revokedAt),
          ),
        )
        .get();
      if (!g) return null;
      const ts = this.now().toISOString();
      const siblings = this.db.orm
        .select({ id: schema.grants.id })
        .from(schema.grants)
        .where(eq(schema.grants.approvalId, g.approvalId))
        .all()
        .map((r) => r.id);
      this.db.orm
        .update(schema.grants)
        .set({ usedAt: ts })
        .where(inArray(schema.grants.id, siblings))
        .run();
      return {
        id: g.id,
        approvalId: g.approvalId,
        updatedInput: (g.updatedInput as Record<string, unknown> | null) ?? null,
      };
    })();
  }

  get ruleStore(): RuleStore {
    return this.rules;
  }
}
