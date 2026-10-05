/** One refused request or tunnel. `target` never carries a path's query string or any header. */
export interface ProxyRefusal {
  at: string;
  /** `host:port` for a tunnel, `METHOD /path` for an API request. */
  target: string;
  reason: string;
}

/** What a host-side proxy did for one Bot since orbitd started (shown by doctor). */
export interface ProxyCounters {
  /** Requests forwarded / tunnels opened. */
  forwarded: number;
  /** Refused by Orbit's rules (path, allowlist, address, no active Run, …). */
  refused: number;
  /** Allowed, but the upstream could not be reached (DNS, connect, TLS). */
  failed: number;
  /** The latest refusals, newest last. */
  recent: ProxyRefusal[];
}

const RECENT = 20;

/** Mutable counters behind a ProxyCounters snapshot. */
export class Counters {
  private forwarded = 0;
  private refused = 0;
  private failed = 0;
  private readonly recent: ProxyRefusal[] = [];

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onRefusal?: (r: ProxyRefusal) => void,
  ) {}

  ok(): void {
    this.forwarded += 1;
  }

  fail(): void {
    this.failed += 1;
  }

  refuse(target: string, reason: string): void {
    this.refused += 1;
    const r = { at: this.now().toISOString(), target, reason };
    this.recent.push(r);
    this.recent.splice(0, Math.max(0, this.recent.length - RECENT));
    this.onRefusal?.(r);
  }

  snapshot(): ProxyCounters {
    return {
      forwarded: this.forwarded,
      refused: this.refused,
      failed: this.failed,
      recent: this.recent.map((r) => ({ ...r })),
    };
  }
}
