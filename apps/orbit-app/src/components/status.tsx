/** @jsxRuntime automatic @jsxImportSource react */
import {
  BOT_PAUSED,
  RUN_STATUS,
  type RunStatus,
  TIER_WORD,
  type Tier,
  formatFull,
  formatRelative,
  formatWhen,
} from '@orbit/core/browser';
import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';

/** A Run status: symbol + word + tone (never colour alone), meaning in the tooltip. */
export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const w = RUN_STATUS[status];
  return (
    <Badge tone={w.tone} title={w.meaning} className={className}>
      <span aria-hidden>{w.mark}</span>
      {w.label}
    </Badge>
  );
}

export function PausedBadge() {
  return (
    <Badge tone={BOT_PAUSED.tone} title={BOT_PAUSED.meaning}>
      <span aria-hidden>{BOT_PAUSED.mark}</span>
      {BOT_PAUSED.label}
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: Tier }) {
  const w = TIER_WORD[tier];
  return (
    <Badge tone={w.tone} title={w.meaning}>
      <span aria-hidden>{w.mark}</span>
      {w.label}
    </Badge>
  );
}

/** Re-render every 30 s so relative times stay true. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** A timestamp in local time with a relative hint; the full date on hover. */
export function Time({
  iso,
  mode = 'when',
  className,
}: {
  iso: string;
  mode?: 'when' | 'relative';
  className?: string;
}) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatFull(iso)} className={cn('tabular-nums', className)}>
      {mode === 'relative' ? formatRelative(iso, now) : formatWhen(iso, now)}
    </time>
  );
}
