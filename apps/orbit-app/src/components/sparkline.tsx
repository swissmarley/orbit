/** @jsxRuntime automatic @jsxImportSource react */
import { RUN_STATUS, type RunState, formatTokens } from '@orbit/core/browser';
import { cn } from '../lib/cn';
import { TONE_FILL, textMark } from '../lib/tone';

/**
 * Recent Runs, oldest → newest: bar height = tokens used, colour = outcome
 * tone, and a text summary for screen readers (never colour alone).
 */
export function RunSparkline({
  runs,
  max = 14,
  className,
}: {
  runs: RunState[];
  max?: number;
  className?: string;
}) {
  const recent = runs.slice(0, max).reverse();
  if (recent.length === 0)
    return <p className={cn('text-xs text-fg-subtle', className)}>No runs yet</p>;
  // One bar reads as a stray mark: say it in words until there is a trend.
  if (recent.length === 1 && recent[0]) {
    const w = RUN_STATUS[recent[0].status];
    return (
      <p className={cn('flex items-end text-xs text-fg-subtle', className)}>
        1 run ·{' '}
        <span aria-hidden className="mx-0.5">
          {textMark(w.mark)}
        </span>
        {w.label}
      </p>
    );
  }
  const peak = Math.max(1, ...recent.map((r) => r.totals.tokens));
  const counts = new Map<string, number>();
  for (const r of recent)
    counts.set(RUN_STATUS[r.status].label, (counts.get(RUN_STATUS[r.status].label) ?? 0) + 1);
  const summary = `Last ${recent.length} run${recent.length === 1 ? '' : 's'}: ${[...counts].map(([l, n]) => `${n} ${l}`).join(', ')}`;
  return (
    <div
      className={cn('flex items-end gap-0.5', className)}
      role="img"
      aria-label={summary}
      title={summary}
    >
      {recent.map((r) => (
        <span
          key={r.runId}
          className={cn('w-1.5 rounded-sm', TONE_FILL[RUN_STATUS[r.status].tone])}
          style={{ height: `${Math.round(30 + (70 * r.totals.tokens) / peak)}%` }}
          title={`${RUN_STATUS[r.status].label} · ${formatTokens(r.totals.tokens)} tokens`}
        />
      ))}
    </div>
  );
}

/** A labelled meter (used / limit) that reads as text too. */
export function Meter({
  label,
  value,
  max,
  format = String,
}: {
  label: string;
  value: number;
  max: number | null;
  format?: (n: number) => string;
}) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const tone = !max
    ? 'bg-accent'
    : pct >= 100
      ? 'bg-danger'
      : pct >= 80
        ? 'bg-warning'
        : 'bg-accent';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="font-medium text-fg tabular-nums">
          {format(value)}
          {max ? (
            <span className="text-fg-subtle"> / {format(max)}</span>
          ) : (
            <span className="text-fg-subtle"> (no limit)</span>
          )}
        </span>
      </div>
      {max ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-3"
          role="meter"
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
        >
          <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}
