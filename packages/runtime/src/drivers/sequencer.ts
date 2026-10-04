import type { RunEventBody } from '@orbit/core';
import type { Channel } from './channel';

/**
 * Orders permission decisions after the tool call they belong to. Engine
 * output and permission callbacks travel on different paths (stdout vs. hook
 * bridge, iterator vs. callback), so a decision can arrive before its
 * `tool.call` has been read. Decisions are held until the call is emitted.
 */
export class EventSequencer {
  private readonly seenCalls = new Set<string>();
  private readonly pending = new Map<string, RunEventBody[]>();

  constructor(private readonly out: Channel<RunEventBody>) {}

  engine(bodies: readonly RunEventBody[]): void {
    for (const body of bodies) {
      this.out.push(body);
      if (body.type === 'tool.call') {
        this.seenCalls.add(body.data.toolUseId);
        const held = this.pending.get(body.data.toolUseId);
        if (held) {
          this.pending.delete(body.data.toolUseId);
          held.forEach((b) => this.out.push(b));
        }
      }
    }
  }

  decision(toolUseId: string | null, body: RunEventBody): void {
    if (!toolUseId || this.seenCalls.has(toolUseId)) {
      this.out.push(body);
      return;
    }
    const list = this.pending.get(toolUseId) ?? [];
    list.push(body);
    this.pending.set(toolUseId, list);
  }

  /** Emit anything still held (e.g. the engine died before printing the call). */
  flush(): void {
    for (const list of this.pending.values()) list.forEach((b) => this.out.push(b));
    this.pending.clear();
  }
}
