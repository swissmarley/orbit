/** @jsxRuntime automatic @jsxImportSource react */
import {
  type Bot,
  type RunState,
  formatDuration,
  formatTokens,
  scrubControls,
} from '@orbit/core/browser';
import { Link } from '@tanstack/react-router';
import { StatusBadge, Time } from './status';

function duration(r: RunState): string {
  if (r.totals.activeMs > 0) return formatDuration(r.totals.activeMs);
  if (r.startedAt && r.endedAt)
    return formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt));
  return '—';
}

/** Runs, newest first; the prompt links to the Run view. */
export function RunsTable({
  runs,
  bots,
  showBot = true,
}: {
  runs: RunState[];
  bots?: Bot[];
  showBot?: boolean;
}) {
  const name = (id: string) => scrubControls(bots?.find((b) => b.id === id)?.spec.name ?? id);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm">
        <caption className="sr-only">Runs</caption>
        <thead className="border-b border-border text-left text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            {showBot ? (
              <th scope="col" className="px-3 py-2 font-medium">
                Bot
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 font-medium">
              Task
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Trigger
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Started
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Time · tokens
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.runId}
              className="border-b border-border last:border-0 hover:bg-surface-2"
              data-testid="run-row"
            >
              <td className="px-3 py-2">
                <StatusBadge status={r.status} />
              </td>
              {showBot ? (
                <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{name(r.botId)}</td>
              ) : null}
              <td className="max-w-md px-3 py-2">
                <Link
                  to="/runs/$runId"
                  params={{ runId: r.runId }}
                  className="line-clamp-1 text-fg hover:text-accent"
                >
                  {scrubControls(r.prompt) || r.runId}
                </Link>
                {r.pendingApprovals.length > 0 ? (
                  <span className="text-xs text-attention">
                    ⚑ {r.pendingApprovals.length} waiting for you
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-xs text-fg-muted">{r.trigger?.kind ?? '—'}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">
                <Time iso={r.createdAt} />
              </td>
              <td className="px-3 py-2 text-right text-xs whitespace-nowrap text-fg-muted tabular-nums">
                {duration(r)} · {formatTokens(r.totals.tokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
