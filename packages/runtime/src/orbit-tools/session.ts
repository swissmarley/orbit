import { createHash, randomBytes } from 'node:crypto';
import { type Bot, inputHash } from '@orbit/core';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface OrbitSessionOptions {
  runId: string;
  bot: Bot;
  /** Delegation depth of the Run (0 = top level). */
  depth: number;
  /** Untrusted sources currently in the Run. */
  taint: () => readonly string[];
  /** Taint the Run (appends run.tainted for new sources). */
  addTaint: (sources: readonly string[]) => void;
}

/**
 * One driver segment's access to the Orbit tools (ADR-012). It carries the
 * per-segment bearer token for the loopback `/mcp/orbit` endpoint and the
 * list of tool calls Orbit's policy has allowed and not yet executed: a tool
 * call only runs if the engine announced it, the PreToolUse hook allowed it
 * and nobody executed it yet. A Bot that read its token and called the
 * endpoint itself gains nothing its own policy would not allow.
 */
export class OrbitRunSession {
  readonly token = randomBytes(32).toString('hex');
  readonly runId: string;
  readonly bot: Bot;
  readonly depth: number;
  /** Child Runs started in this segment (delegate_to_bot). */
  readonly delegations: string[] = [];
  memoryWrites = 0;
  private readonly allowed = new Map<string, number>();
  private closed = false;

  constructor(private readonly opts: OrbitSessionOptions) {
    this.runId = opts.runId;
    this.bot = opts.bot;
    this.depth = opts.depth;
  }

  get botId(): string {
    return this.bot.id;
  }

  taint(): readonly string[] {
    return this.opts.taint();
  }

  addTaint(sources: readonly string[]): void {
    if (sources.length > 0) this.opts.addTaint(sources);
  }

  /** Policy allowed this call (called from the permission handler). */
  authorize(tool: string, input: Record<string, unknown>): void {
    if (this.closed) return;
    const key = `${tool}\u0000${inputHash(input)}`;
    this.allowed.set(key, (this.allowed.get(key) ?? 0) + 1);
  }

  /** Claim one allowed, unexecuted call with exactly this tool and input. */
  consume(tool: string, input: Record<string, unknown>): boolean {
    if (this.closed) return false;
    const key = `${tool}\u0000${inputHash(input)}`;
    const n = this.allowed.get(key) ?? 0;
    if (n <= 0) return false;
    if (n === 1) this.allowed.delete(key);
    else this.allowed.set(key, n - 1);
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.allowed.clear();
  }
}

/** Live sessions by token (hashed) and by Run. */
export class OrbitSessions {
  private readonly byTokenHash = new Map<string, OrbitRunSession>();
  private readonly byRunId = new Map<string, OrbitRunSession>();

  open(opts: OrbitSessionOptions): OrbitRunSession {
    const s = new OrbitRunSession(opts);
    this.byTokenHash.set(sha(s.token), s);
    this.byRunId.set(s.runId, s);
    return s;
  }

  /** The session a bearer token belongs to (lookup by hash: no timing on the secret). */
  byToken(token: string): OrbitRunSession | undefined {
    if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
    const s = this.byTokenHash.get(sha(token));
    return s && !s.isClosed ? s : undefined;
  }

  forRun(runId: string): OrbitRunSession | undefined {
    return this.byRunId.get(runId);
  }

  close(session: OrbitRunSession): void {
    session.close();
    this.byTokenHash.delete(sha(session.token));
    if (this.byRunId.get(session.runId) === session) this.byRunId.delete(session.runId);
  }

  get size(): number {
    return this.byTokenHash.size;
  }
}
