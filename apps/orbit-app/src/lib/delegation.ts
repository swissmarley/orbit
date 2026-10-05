import type { RunState } from '@orbit/core/browser';

/** One Run in a delegation tree (Bots handing work to Bots). */
export interface DelegationNode {
  run: RunState;
  botName: string;
  /** The Run the page is about. */
  current: boolean;
  children: DelegationNode[];
}

/**
 * The tree from orbitd's `GET /v1/runs/{run}/tree` (parents before
 * children). Children come in delegation order; unknown Runs are skipped.
 */
export function delegationTree(
  runs: readonly RunState[],
  root: string,
  botName: (botId: string) => string,
  currentRunId: string,
): DelegationNode | null {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const seen = new Set<string>();
  const build = (id: string): DelegationNode | null => {
    const run = byId.get(id);
    if (!run || seen.has(id)) return null;
    seen.add(id);
    return {
      run,
      botName: botName(run.botId),
      current: id === currentRunId,
      children: run.children.flatMap((c) => build(c.runId) ?? []),
    };
  };
  return build(root);
}

/** Number of Runs in a tree. */
export function treeSize(node: DelegationNode | null): number {
  return node ? 1 + node.children.reduce((n, c) => n + treeSize(c), 0) : 0;
}
