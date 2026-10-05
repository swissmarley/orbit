import type { RunStatus, Tier } from './enums';
import type { TriggerSpec } from './bot';

/**
 * One status vocabulary for every client (TUI, CLI, App): a symbol, a word
 * and a tone. Clients map the tone to their own palette (16 terminal colours,
 * design tokens), and always show the symbol or the word with it — never
 * colour alone.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'attention';

export interface StatusWord {
  mark: string;
  label: string;
  tone: Tone;
  /** One sentence for tooltips, help and screen readers. */
  meaning: string;
}

export const RUN_STATUS: Readonly<Record<RunStatus, StatusWord>> = {
  queued: { mark: '·', label: 'queued', tone: 'neutral', meaning: 'waiting for a free slot' },
  running: { mark: '●', label: 'running', tone: 'info', meaning: 'the engine is working' },
  waiting_approval: {
    mark: '◆',
    label: 'needs you',
    tone: 'attention',
    meaning: 'parked until you decide an approval',
  },
  delegating: {
    mark: '⇢',
    label: 'delegated',
    tone: 'info',
    meaning: 'waiting for the peer Bots it handed work to',
  },
  rate_limited: {
    mark: '⧗',
    label: 'usage limit',
    tone: 'warning',
    meaning: 'paused by a usage limit; resumes after the reset',
  },
  paused: { mark: '⏸', label: 'paused', tone: 'warning', meaning: 'paused' },
  completed: { mark: '✔', label: 'done', tone: 'success', meaning: 'finished successfully' },
  failed: { mark: '✘', label: 'failed', tone: 'danger', meaning: 'ended with an error' },
  cancelled: {
    mark: '■',
    label: 'cancelled',
    tone: 'warning',
    meaning: 'stopped before it finished',
  },
};

/** A Bot's own state, shown next to its latest Run. */
export const BOT_PAUSED: StatusWord = {
  mark: '⏸',
  label: 'paused',
  tone: 'warning',
  meaning: 'Bot paused: no Runs start until you resume it',
};

export const TIER_WORD: Readonly<Record<Tier, StatusWord>> = {
  READ: { mark: '◇', label: 'read', tone: 'neutral', meaning: 'reads only; allowed automatically' },
  WRITE_LOCAL: {
    mark: '✎',
    label: 'local write',
    tone: 'info',
    meaning: 'changes files inside the Bot workspace',
  },
  EXTERNAL: {
    mark: '⇗',
    label: 'external',
    tone: 'attention',
    meaning: 'reaches outside the machine (sends, posts, calls); needs your approval',
  },
  FINANCIAL: {
    mark: '$',
    label: 'financial',
    tone: 'danger',
    meaning: 'moves money; always handed back to you, never executed by a Bot',
  },
};

/**
 * Provenance of a memory: trusted (written or reviewed by you, or by a Bot
 * while nothing untrusted had entered its Run) or untrusted (influenced by
 * web, email, tool or delegated content). Untrusted memories are never
 * offered to Runs automatically, and reading one taints the Run.
 */
export const MEMORY_TRUST: Readonly<Record<'trusted' | 'untrusted', StatusWord>> = {
  trusted: {
    mark: '✓',
    label: 'trusted',
    tone: 'success',
    meaning: 'written by you, or by a Bot while nothing untrusted had entered its Run',
  },
  untrusted: {
    mark: '⚠',
    label: 'untrusted',
    tone: 'warning',
    meaning:
      'influenced by web, email, tool or delegated content: never offered to Runs automatically, and reading it taints the Run',
  },
};

export function memoryTrust(m: { taint: readonly string[] }): StatusWord {
  return m.taint.length > 0 ? MEMORY_TRUST.untrusted : MEMORY_TRUST.trusted;
}

/** Symbols and their meanings, for help overlays and legends. */
export const STATUS_LEGEND: readonly { mark: string; means: string }[] = [
  { mark: RUN_STATUS.running.mark, means: 'running' },
  { mark: RUN_STATUS.waiting_approval.mark, means: 'waiting for your approval' },
  { mark: RUN_STATUS.delegating.mark, means: 'waiting for a delegated Bot' },
  { mark: RUN_STATUS.rate_limited.mark, means: 'usage limit — resumes later' },
  { mark: BOT_PAUSED.mark, means: 'Bot paused' },
  { mark: RUN_STATUS.completed.mark, means: 'done' },
  { mark: RUN_STATUS.failed.mark, means: 'failed' },
  { mark: RUN_STATUS.cancelled.mark, means: 'cancelled' },
  { mark: RUN_STATUS.queued.mark, means: 'queued' },
];

// ── times: always local, with a relative hint ──────────────────────────────

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "3m ago", "in 2h", "just now" (past or future). */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((now - t) / 1000);
  const abs = Math.abs(sec);
  if (abs < 10) return 'just now';
  const n =
    abs < MINUTE
      ? `${abs}s`
      : abs < HOUR
        ? `${Math.round(abs / MINUTE)}m`
        : abs < DAY
          ? `${Math.round(abs / HOUR)}h`
          : `${Math.round(abs / DAY)}d`;
  return sec >= 0 ? `${n} ago` : `in ${n}`;
}

/** Local wall-clock time: "14:05" today, "Mon 14:05" within a week, else "12 Mar 14:05". */
export function formatClock(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  if (Math.abs(now - d.getTime()) < 6 * DAY * 1000) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** Local time of day with seconds ("14:05:09"), for event rows inside one Run. */
export function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** Local time with zone, for moments a person acts on ("resumes at Mon 14:05 CET"). */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** "14:05 · 3m ago": the standard way a timestamp is shown in lists. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  return `${formatClock(iso, now)} · ${formatRelative(iso, now)}`;
}

/** Full local date and time for tooltips and titles. */
export function formatFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** "850ms", "4.2s", "3m 10s", "1h 5m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Engine-estimated cost: "$0.004", "$0.0021", "$1.25" (enough digits to see a
 * small triage call, never more than four decimals); "~" marks an estimate.
 */
export function formatCost(usd: number, estimate = true): string {
  const digits = usd === 0 ? 2 : usd < 0.01 ? 4 : usd < 1 ? 3 : 2;
  return `${estimate ? '~' : ''}$${usd.toFixed(digits)}`;
}

/** "950", "12.3k", "1.2M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A trigger in words ("Weekday mornings", "every 15m", "Slack mentions in C0123…"). */
export function triggerLabel(trigger: TriggerSpec): string {
  return trigger.name ?? triggerDetail(trigger);
}

/** What a trigger does, whatever its name ("cron 0 8 * * 1-5", "signed webhook deploys"). */
export function triggerDetail(trigger: TriggerSpec): string {
  switch (trigger.kind) {
    case 'cron':
      return `cron ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
    case 'interval':
      return `every ${trigger.everyMinutes}m`;
    case 'slack':
      return `Slack ${trigger.on === 'mention' ? 'mentions' : 'messages'} in ${trigger.channels.join(', ')}`;
    case 'file':
      return `changes in ${trigger.paths.join(', ')}`;
    case 'git':
      return `commits on ${trigger.branch} in ${trigger.repo}`;
    case 'webhook':
      return `signed webhook ${trigger.name}`;
  }
}

/** The kind of trigger in a word, for badges. */
export const TRIGGER_KIND_WORD: Readonly<Record<TriggerSpec['kind'], string>> = {
  cron: 'schedule',
  interval: 'interval',
  webhook: 'webhook',
  slack: 'Slack',
  file: 'files',
  git: 'git',
};
