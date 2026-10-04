import { Cron } from 'croner';
import {
  type Bot,
  OrbitError,
  type TriggerRef,
  type TriggerSpec,
  canonicalJson,
  errorMessage,
  sha256Hex,
} from '@orbit/core';
import type { TriggerFire } from '@orbit/store';

/** Stable identity of a trigger: its definition, minus on/off and its label. */
export function triggerKey(botId: string, trigger: TriggerSpec): string {
  const { enabled: _enabled, name: _name, ...definition } = trigger;
  return `${botId}:${sha256Hex(canonicalJson(definition)).slice(0, 16)}`;
}

export function describeTrigger(trigger: TriggerSpec): string {
  if (trigger.name) return trigger.name;
  return trigger.kind === 'cron'
    ? `cron ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ''}`
    : `every ${trigger.everyMinutes}m`;
}

function cronFor(trigger: Extract<TriggerSpec, { kind: 'cron' }>): Cron {
  return new Cron(trigger.cron, {
    paused: true,
    ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
  });
}

/** Throws `invalid_input` for a cron expression or time zone the scheduler cannot use. */
export function validateTriggers(triggers: readonly TriggerSpec[]): void {
  for (const t of triggers) {
    if (t.kind !== 'cron') continue;
    try {
      const next = cronFor(t).nextRun();
      if (!next) throw new Error('it never fires');
    } catch (err) {
      throw new OrbitError(
        'invalid_input',
        `Invalid cron trigger "${t.cron}": ${errorMessage(err)}`,
        {
          hint: 'Use 5 fields (minute hour day month weekday), e.g. "0 9 * * 1-5", and an IANA time zone such as "Europe/Zurich".',
        },
      );
    }
  }
}

/** When `trigger` fires next, given its last fire (or when it was first seen). */
export function nextFire(trigger: TriggerSpec, after: Date): Date | null {
  if (trigger.kind === 'interval') return new Date(after.getTime() + trigger.everyMinutes * 60_000);
  try {
    return cronFor(trigger).nextRun(after);
  } catch {
    return null;
  }
}

export interface ScheduleEntry {
  botId: string;
  key: string;
  kind: TriggerSpec['kind'];
  description: string;
  enabled: boolean;
  nextAt: string | null;
  lastFiredAt: string | null;
  lastRunId: string | null;
}

export type FireOutcome = { fired: true; runId: string } | { fired: false; reason: string };

export interface SchedulerDeps {
  bots: () => Bot[];
  state: {
    get(key: string): TriggerFire | undefined;
    record(fire: TriggerFire): void;
  };
  /** Start a Run for this trigger (enqueue it); a reason when it must not run now. */
  fire: (bot: Bot, trigger: TriggerSpec, ref: TriggerRef) => FireOutcome;
  /** Is the Run started by this trigger's previous fire still in flight? (no overlap) */
  inFlight: (runId: string) => boolean;
  now?: () => Date;
}

/**
 * Fires cron and interval triggers. Pure tick-driven (the daemon calls
 * `tick()` every second), so tests drive time explicitly. Missed fires while
 * the daemon was down are not replayed: the next fire is computed from the
 * later of the last fire and the scheduler's start. A trigger whose previous
 * Run is still queued or running is skipped (no pile-up of always-on Bots).
 */
export class Scheduler {
  private readonly now: () => Date;
  private readonly startedAt: Date;
  /** First time each interval trigger was seen without a recorded fire. */
  private readonly firstSeen = new Map<string, Date>();

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  private base(key: string, last: TriggerFire | undefined): Date {
    if (last) {
      const at = new Date(last.lastFiredAt);
      return at > this.startedAt ? at : this.startedAt;
    }
    let seen = this.firstSeen.get(key);
    if (!seen) {
      seen = this.now();
      this.firstSeen.set(key, seen);
    }
    return seen;
  }

  private nextFor(bot: Bot, trigger: TriggerSpec): { key: string; next: Date | null } {
    const key = triggerKey(bot.id, trigger);
    const last = this.deps.state.get(key);
    // Interval: from the last fire itself (a restart does not reset the cadence).
    const after =
      trigger.kind === 'interval' && last ? new Date(last.lastFiredAt) : this.base(key, last);
    return { key, next: nextFire(trigger, after) };
  }

  /** Fire every due trigger. Returns what happened, for logs and tests. */
  tick(): { botId: string; key: string; outcome: FireOutcome }[] {
    const now = this.now();
    const results: { botId: string; key: string; outcome: FireOutcome }[] = [];
    for (const bot of this.deps.bots()) {
      for (const trigger of bot.spec.triggers) {
        if (!trigger.enabled) continue;
        const { key, next } = this.nextFor(bot, trigger);
        if (!next || next > now) continue;
        const previous = this.deps.state.get(key);
        let outcome: FireOutcome;
        if (bot.pausedAt) {
          outcome = { fired: false, reason: 'Bot is paused' };
        } else if (previous?.lastRunId && this.deps.inFlight(previous.lastRunId)) {
          outcome = { fired: false, reason: `previous run ${previous.lastRunId} still in flight` };
        } else {
          try {
            outcome = this.deps.fire(bot, trigger, {
              kind: trigger.kind,
              source: describeTrigger(trigger),
            });
          } catch (err) {
            outcome = { fired: false, reason: errorMessage(err) };
          }
        }
        // A skipped fire is still consumed: it does not fire again the moment
        // the kill switch is released or the previous Run ends.
        this.deps.state.record({
          key,
          botId: bot.id,
          lastFiredAt: now.toISOString(),
          lastRunId: outcome.fired ? outcome.runId : (previous?.lastRunId ?? null),
        });
        results.push({ botId: bot.id, key, outcome });
      }
    }
    return results;
  }

  /** Upcoming fires, soonest first (for `GET /v1/schedules`). */
  upcoming(botId?: string): ScheduleEntry[] {
    const entries: ScheduleEntry[] = [];
    for (const bot of this.deps.bots()) {
      if (botId && bot.id !== botId) continue;
      for (const trigger of bot.spec.triggers) {
        const { key, next } = this.nextFor(bot, trigger);
        const last = this.deps.state.get(key);
        entries.push({
          botId: bot.id,
          key,
          kind: trigger.kind,
          description: describeTrigger(trigger),
          enabled: trigger.enabled && !bot.pausedAt,
          nextAt: trigger.enabled && !bot.pausedAt && next ? next.toISOString() : null,
          lastFiredAt: last?.lastFiredAt ?? null,
          lastRunId: last?.lastRunId ?? null,
        });
      }
    }
    return entries.sort((a, b) => (a.nextAt ?? '~').localeCompare(b.nextAt ?? '~'));
  }
}
