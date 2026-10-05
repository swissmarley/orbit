/** @jsxRuntime automatic @jsxImportSource react */
import { TIER_WORD, formatFull, formatTimeOfDay } from '@orbit/core/browser';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { prettyJson } from '../lib/diff';
import type { TimelineItem } from '../lib/timeline';
import { TONE_TEXT } from '../lib/tone';
import { DiffView } from './diff-view';

function Decision({ d }: { d: NonNullable<Extract<TimelineItem, { kind: 'tool' }>['decision']> }) {
  const tier = d.tier ? <span className="text-fg-subtle"> · {TIER_WORD[d.tier].label}</span> : null;
  if (d.behavior === 'allow') return <span className="text-xs text-success">✓ allowed{tier}</span>;
  if (d.held) return <span className="text-xs text-attention">⏸ held for your approval{tier}</span>;
  return (
    <span className="text-xs text-danger" title={d.reason}>
      ✗ denied{tier}
    </span>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const added = item.diff?.filter((l) => l.kind === 'add').length ?? 0;
  const removed = item.diff?.filter((l) => l.kind === 'del').length ?? 0;
  const id = `tool-${item.key}`;
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-fg-subtle transition-transform',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span aria-hidden className="text-warning">
            ⚙
          </span>
          <span className="font-medium text-fg">{item.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
            {item.summary}
          </span>
          {item.diff ? (
            <span className="text-xs tabular-nums">
              <span className="text-success">+{added}</span>{' '}
              <span className="text-danger">−{removed}</span>
            </span>
          ) : null}
          {item.decision ? (
            <Decision d={item.decision} />
          ) : (
            <span className="text-xs text-fg-subtle">deciding…</span>
          )}
          {item.result && !item.decision?.held && item.decision?.behavior !== 'deny' ? (
            <span className={cn('text-xs', item.result.isError ? 'text-danger' : 'text-fg-subtle')}>
              {item.result.isError
                ? '↳ error'
                : `↳ ${item.result.content.split('\n').filter((l) => l.trim()).length} lines`}
            </span>
          ) : null}
        </button>
        {item.decision?.held && item.decision.approvalId ? (
          <Link
            to="/inbox"
            search={{ approval: item.decision.approvalId }}
            className="shrink-0 px-3 text-xs text-attention underline"
          >
            Review
          </Link>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {item.decision?.behavior === 'deny' && !item.decision.held ? (
            <p className="text-xs text-danger">Denied: {item.decision.reason}</p>
          ) : null}
          {item.diff ? (
            <DiffView lines={item.diff} label={item.summary || item.name} maxHeight="max-h-72" />
          ) : (
            <pre className="max-h-60 overflow-auto rounded bg-surface-2 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all text-fg">
              {prettyJson(item.input)}
            </pre>
          )}
          {item.result ? (
            <div>
              <p className="text-xs font-medium text-fg-muted">
                Result{item.result.truncated ? ' (truncated)' : ''}
              </p>
              <pre
                className={cn(
                  'mt-1 max-h-60 overflow-auto rounded px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all',
                  item.result.isError ? 'bg-danger-bg text-danger' : 'bg-surface-2 text-fg',
                )}
              >
                {item.result.content || '(empty)'}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'prompt':
      return (
        <div className="rounded-md border border-accent/30 bg-accent-subtle px-3 py-2 text-sm">
          <span className="text-xs font-medium text-fg-muted">Task</span>
          <p className="whitespace-pre-wrap text-fg">{item.text}</p>
        </div>
      );
    case 'message':
      return item.thinking ? (
        <details className="text-sm text-fg-subtle">
          <summary className="cursor-pointer italic">… thinking</summary>
          <p className="mt-1 whitespace-pre-wrap">{item.text}</p>
        </details>
      ) : (
        <div className="flex gap-2 text-sm">
          <span aria-hidden className="mt-0.5 text-info">
            ✦
          </span>
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-fg">{item.text}</p>
        </div>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'subagent':
      return (
        <p className="text-sm text-attention">
          <span aria-hidden>⇢</span> subagent <span className="font-medium">{item.text}</span>
          <span className="text-fg-subtle"> · {item.done ? 'finished' : 'working'}</span>
        </p>
      );
    case 'note':
      return (
        <div className={cn('text-sm', TONE_TEXT[item.tone])}>
          <span aria-hidden className="mr-1.5">
            {item.mark}
          </span>
          {item.text}
          {item.approvalId ? (
            <>
              {' '}
              <Link to="/inbox" search={{ approval: item.approvalId }} className="underline">
                Review
              </Link>
            </>
          ) : null}
          {item.detail ? (
            <p className="mt-0.5 whitespace-pre-wrap text-fg-muted">{item.detail}</p>
          ) : null}
        </div>
      );
  }
}

/**
 * The Run timeline, virtualized (thousands of events stay smooth). It
 * follows new events while scrolled to the bottom and stays put otherwise.
 */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  const parent = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 44,
    overscan: 8,
    // First paint (and jsdom) before the container is measured.
    initialRect: { width: 800, height: 600 },
    getItemKey: (i) => items[i]?.key ?? i,
  });
  useLayoutEffect(() => {
    if (follow && items.length > 0) v.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items.length, follow, v]);
  useEffect(() => {
    const el = parent.current;
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className={cn('relative', className)}>
      <div
        ref={parent}
        className="h-full overflow-y-auto rounded-lg border border-border bg-bg px-3"
        role="log"
        aria-label="Run timeline"
        aria-live="off"
        tabIndex={0}
      >
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const depth = 'depth' in item ? item.depth : 0;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={v.measureElement}
                className="absolute top-0 left-0 w-full py-1"
                style={{ transform: `translateY(${vi.start}px)`, paddingLeft: depth * 20 }}
              >
                <div className="flex gap-2">
                  <time
                    dateTime={item.ts}
                    title={formatFull(item.ts)}
                    className="hidden w-20 shrink-0 pt-0.5 text-right font-mono text-[11px] text-fg-subtle sm:block"
                  >
                    {formatTimeOfDay(item.ts)}
                  </time>
                  <div
                    className={cn(
                      'min-w-0 flex-1',
                      depth > 0 && 'border-l-2 border-attention/30 pl-2',
                    )}
                  >
                    <Row item={item} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {!follow ? (
        <button
          type="button"
          className="absolute right-4 bottom-3 rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg shadow-card hover:bg-surface-2"
          onClick={() => setFollow(true)}
        >
          ↓ Follow live
        </button>
      ) : null}
    </div>
  );
}
