import { isDeepStrictEqual } from 'node:util';
import { type RunEventBody, event } from '@orbit/core';
import type { Channel } from './channel';

export interface ObservedCall {
  name: string;
  input: unknown;
  parentToolUseId: string | null;
}

/**
 * Orders and verifies permission decisions.
 *
 * - Ordering: engine output and permission callbacks travel on different
 *   paths (stdout vs. hook bridge, iterator vs. callback), so a decision can
 *   arrive before its `tool.call` has been read. Decisions are held until the
 *   call is emitted.
 * - Verification: Orbit only decides tool calls the engine actually announced
 *   (`claimCall`), once per call, and any *successful* tool result without a
 *   prior Orbit decision means the permission path was bypassed (hook crash,
 *   hook timeout, managed settings disabling hooks) — the driver must stop.
 */
export class EventSequencer {
  private readonly calls = new Map<string, ObservedCall>();
  private readonly waiters = new Map<string, ((c: ObservedCall) => void)[]>();
  private readonly pending = new Map<string, RunEventBody[]>();
  private readonly claimed = new Set<string>();
  private readonly decided = new Set<string>();
  private readonly allowed = new Set<string>();

  constructor(private readonly out: Channel<RunEventBody>) {}

  /**
   * Emit engine events. Returns a terminal `run.failed` if a tool ran without
   * an Orbit decision; the caller must stop the engine and finish with it.
   */
  engine(bodies: readonly RunEventBody[]): RunEventBody | null {
    for (const body of bodies) {
      if (
        body.type === 'tool.result' &&
        !body.data.isError &&
        !this.decided.has(body.data.toolUseId)
      ) {
        return event('run.failed', {
          code: 'policy_bypassed',
          message: `Tool call ${body.data.toolUseId} completed without an Orbit permission decision; the run was stopped`,
          retryable: false,
          sessionId: null,
        });
      }
      this.out.push(body);
      if (body.type === 'tool.call') {
        const id = body.data.toolUseId;
        const call = {
          name: body.data.name,
          input: body.data.input,
          parentToolUseId: body.data.parentToolUseId,
        };
        this.calls.set(id, call);
        this.waiters.get(id)?.forEach((w) => w(call));
        this.waiters.delete(id);
        const held = this.pending.get(id);
        if (held) {
          this.pending.delete(id);
          held.forEach((b) => this.out.push(b));
        }
      }
    }
    return null;
  }

  /** Resolve once the engine has announced `toolUseId` (or null after `timeoutMs`). */
  awaitCall(toolUseId: string, timeoutMs: number): Promise<ObservedCall | null> {
    const known = this.calls.get(toolUseId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
      const list = this.waiters.get(toolUseId) ?? [];
      list.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
      this.waiters.set(toolUseId, list);
    });
  }

  /**
   * Claim the right to decide an announced call whose name and input match.
   * At most one claim per call; forged or replayed requests get false.
   */
  claimCall(toolUseId: string, name: string, input: unknown): ObservedCall | null {
    const call = this.calls.get(toolUseId);
    if (!call || this.claimed.has(toolUseId)) return null;
    if (call.name !== name || !isDeepStrictEqual(call.input, input)) return null;
    this.claimed.add(toolUseId);
    return call;
  }

  decision(toolUseId: string | null, body: RunEventBody, allowed = false): void {
    if (toolUseId) this.decided.add(toolUseId);
    if (toolUseId && allowed) this.allowed.add(toolUseId);
    if (!toolUseId || this.calls.has(toolUseId)) {
      this.out.push(body);
      return;
    }
    const list = this.pending.get(toolUseId) ?? [];
    list.push(body);
    this.pending.set(toolUseId, list);
  }

  wasAllowed(toolUseId: string): boolean {
    return this.allowed.has(toolUseId);
  }

  /** Emit anything still held (e.g. the engine died before printing the call). */
  flush(): void {
    for (const list of this.pending.values()) list.forEach((b) => this.out.push(b));
    this.pending.clear();
  }
}
