/** @jsxRuntime automatic @jsxImportSource react */
import { RUN_STATUS, RunStatus } from '@orbit/core/browser';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ListTree } from 'lucide-react';
import { RunsTable } from '../components/runs-table';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../components/states';
import { Label, Select } from '../components/ui/input';
import { useBots, useRuns } from '../lib/queries';

export function RunsScreen() {
  const search: { status?: string | undefined; bot?: string | undefined } = useSearch({
    strict: false,
  });
  const navigate = useNavigate();
  const status = RunStatus.safeParse(search.status).data;
  const bots = useBots();
  const runs = useRuns({
    limit: 200,
    ...(status ? { status } : {}),
    ...(search.bot ? { bot: search.bot } : {}),
  });
  const set = (patch: { status?: string | undefined; bot?: string | undefined }) =>
    void navigate({ to: '/runs', search: { ...search, ...patch }, replace: true });
  return (
    <div>
      <PageHeader title="Runs" description="Every Run of every Bot, newest first." />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-status">Status</Label>
          <Select
            id="f-status"
            value={status ?? ''}
            onChange={(e) => set({ status: e.target.value || undefined })}
          >
            <option value="">any</option>
            {RunStatus.options.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS[s].mark} {RUN_STATUS[s].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="f-bot">Bot</Label>
          <Select
            id="f-bot"
            value={search.bot ?? ''}
            onChange={(e) => set({ bot: e.target.value || undefined })}
          >
            <option value="">all</option>
            {(bots.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.spec.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {runs.isPending ? (
        <ListSkeleton rows={6} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} retry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <EmptyState icon={<ListTree aria-hidden />} title="No runs match">
          Runs appear here when a Bot starts — by hand, on a schedule or after you approve
          something.
        </EmptyState>
      ) : (
        <RunsTable runs={runs.data} {...(bots.data ? { bots: bots.data } : {})} />
      )}
    </div>
  );
}
