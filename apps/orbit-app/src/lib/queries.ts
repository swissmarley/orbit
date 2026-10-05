import type { RunEvent } from '@orbit/core/browser';
import type { RouteQuery } from '@orbit/sdk-client/browser';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useClient } from './api';

/** Query keys: one place, so live events can invalidate precisely. */
export const keys = {
  all: ['orbit'] as const,
  session: ['orbit', 'session'] as const,
  doctor: ['orbit', 'doctor'] as const,
  bots: ['orbit', 'bots'] as const,
  bot: (id: string) => ['orbit', 'bots', id] as const,
  botVersions: (id: string) => ['orbit', 'bots', id, 'versions'] as const,
  runs: ['orbit', 'runs'] as const,
  runList: (q: RouteQuery<'listRuns'>) => ['orbit', 'runs', 'list', q] as const,
  run: (id: string) => ['orbit', 'runs', 'one', id] as const,
  runEvents: (id: string) => ['orbit', 'run-events', id] as const,
  approvals: ['orbit', 'approvals'] as const,
  approvalList: (q: RouteQuery<'listApprovals'>) => ['orbit', 'approvals', 'list', q] as const,
  queue: ['orbit', 'queue'] as const,
  kill: ['orbit', 'kill'] as const,
  schedules: ['orbit', 'schedules'] as const,
  rules: ['orbit', 'rules'] as const,
  audit: ['orbit', 'audit'] as const,
  secrets: ['orbit', 'secrets'] as const,
  memory: ['orbit', 'memory'] as const,
  memoryList: (q: RouteQuery<'listMemory'>) => ['orbit', 'memory', 'list', q] as const,
  memoryOne: (id: string) => ['orbit', 'memory', 'one', id] as const,
  runMemory: (id: string) => ['orbit', 'memory', 'run', id] as const,
  /** Under `runs`, so every run invalidation refreshes delegation trees too. */
  runTree: (id: string) => ['orbit', 'runs', 'tree', id] as const,
  botTaint: (id: string) => ['orbit', 'memory', 'taint', id] as const,
  triage: ['orbit', 'triage'] as const,
};

export function useSession() {
  const c = useClient();
  return useQuery({ queryKey: keys.session, queryFn: () => c.call('getSession'), retry: false });
}

export function useDoctor() {
  const c = useClient();
  return useQuery({ queryKey: keys.doctor, queryFn: () => c.doctor(), staleTime: 60_000 });
}

export function useBots() {
  const c = useClient();
  return useQuery({ queryKey: keys.bots, queryFn: () => c.bots.list() });
}

export function useBot(id: string) {
  const c = useClient();
  return useQuery({ queryKey: keys.bot(id), queryFn: () => c.bots.get(id), enabled: id !== '' });
}

export function useBotVersions(id: string) {
  const c = useClient();
  return useQuery({
    queryKey: keys.botVersions(id),
    queryFn: () => c.bots.versions(id),
    enabled: id !== '',
  });
}

export function useRuns(q: RouteQuery<'listRuns'> = { limit: 200 }) {
  const c = useClient();
  return useQuery({ queryKey: keys.runList(q), queryFn: () => c.runs.list(q) });
}

export function useRun(id: string) {
  const c = useClient();
  return useQuery({ queryKey: keys.run(id), queryFn: () => c.runs.get(id), enabled: id !== '' });
}

/** A Run's whole event log; live events are appended by the live feed (lib/live.ts). */
export function useRunEvents(id: string) {
  const c = useClient();
  return useQuery<RunEvent[]>({
    queryKey: keys.runEvents(id),
    queryFn: () => c.runs.events(id),
    enabled: id !== '',
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePendingApprovals() {
  const c = useClient();
  return useQuery({
    queryKey: keys.approvalList({}),
    queryFn: () => c.approvals.list(),
    select: (list) => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });
}

export function useApprovalHistory() {
  const c = useClient();
  return useQuery({
    queryKey: keys.approvalList({ all: 'true' }),
    queryFn: () => c.approvals.list({ all: 'true' }),
  });
}

export function useQueue() {
  const c = useClient();
  return useQuery({ queryKey: keys.queue, queryFn: () => c.queue(), refetchInterval: 30_000 });
}

export function useKill() {
  const c = useClient();
  return useQuery({ queryKey: keys.kill, queryFn: () => c.kill.status() });
}

export function useSchedules() {
  const c = useClient();
  return useQuery({
    queryKey: keys.schedules,
    queryFn: () => c.schedules(),
    refetchInterval: 60_000,
  });
}

export function useRules(all = false) {
  const c = useClient();
  return useQuery({ queryKey: [...keys.rules, all], queryFn: () => c.rules.list(all) });
}

export function useAudit(limit = 200) {
  const c = useClient();
  return useQuery({ queryKey: [...keys.audit, limit], queryFn: () => c.audit.list({ limit }) });
}

export function useSecrets() {
  const c = useClient();
  return useQuery({ queryKey: keys.secrets, queryFn: () => c.secrets.list() });
}

export function useMemoryList(q: RouteQuery<'listMemory'>) {
  const c = useClient();
  // Keep the list on screen while a new search loads (no skeleton flash per keystroke).
  return useQuery({
    queryKey: keys.memoryList(q),
    queryFn: () => c.memory.list(q),
    placeholderData: keepPreviousData,
  });
}

export function useRunMemory(runId: string) {
  const c = useClient();
  return useQuery({
    queryKey: keys.runMemory(runId),
    queryFn: () => c.runs.memory(runId),
    enabled: runId !== '',
  });
}

/** The delegation tree a Run belongs to (live: run events invalidate `runs`). */
export function useRunTree(runId: string) {
  const c = useClient();
  return useQuery({
    queryKey: keys.runTree(runId),
    queryFn: () => c.runs.tree(runId),
    enabled: runId !== '',
  });
}

export function useBotTaint(botId: string) {
  const c = useClient();
  return useQuery({
    queryKey: keys.botTaint(botId),
    queryFn: () => c.memory.taint(botId),
    enabled: botId !== '',
  });
}

export function useTriage() {
  const c = useClient();
  return useQuery({ queryKey: keys.triage, queryFn: () => c.triage.usage() });
}
