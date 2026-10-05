import { type Bot, errorMessage, pluginToolName } from '@orbit/core';
import type { OrbitRunSession } from '../orbit-tools/session';
import type { McpCallResult, McpClient, McpToolDef } from './client';
import type { PluginRegistry, ReadyPlugin } from './registry';

/** One plugin as one driver segment sees it (an MCP server named after the plugin). */
export interface PluginServerBinding {
  /** Server name the engine sees: tools arrive as `mcp__<name>__<tool>`. */
  name: string;
  tools: McpToolDef[];
  call(tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/**
 * The plugins of one driver segment (ADR-014). Servers start lazily on the
 * first allowed call, in the Bot's workspace, and stop when the segment ends.
 * A call runs only if Orbit's policy allowed exactly that tool and input in
 * this segment (the session's authorization, ADR-013).
 */
export class PluginSegment {
  readonly bindings: PluginServerBinding[] = [];
  /** Plugins the Bot lists that cannot be used now, with the reason. */
  readonly unavailable: { id: string; reason: string }[] = [];
  private readonly clients = new Map<string, McpClient>();
  private closed = false;

  constructor(
    private readonly registry: PluginRegistry,
    bot: Bot,
    private readonly workspace: string,
    private readonly session: OrbitRunSession,
    /** Worktree Bots: the owner's repository and the Bot's own branch. */
    private readonly git?: { repo: string; branch: string },
  ) {
    for (const id of bot.spec.plugins) {
      const r = registry.ready(id);
      if ('reason' in r) {
        this.unavailable.push({ id, reason: r.reason });
        continue;
      }
      this.bindings.push({
        name: id,
        tools: r.tools,
        call: (tool, args) => this.call(r, tool, args),
      });
    }
  }

  binding(name: string): PluginServerBinding | undefined {
    return this.bindings.find((b) => b.name === name);
  }

  private async call(
    plugin: ReadyPlugin,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const engineName = pluginToolName(plugin.manifest.id, tool);
    if (this.closed) return { text: 'This Run segment has ended.', isError: true };
    if (!plugin.tools.some((t) => t.name === tool)) {
      return { text: `No such tool: ${engineName}`, isError: true };
    }
    if (!this.session.consume(engineName, args)) {
      return {
        text: 'Orbit did not authorize this call (it must be announced by the engine and allowed by policy first).',
        isError: true,
      };
    }
    let client = this.clients.get(plugin.manifest.id);
    if (!client) {
      client = this.registry.client({
        manifest: plugin.manifest,
        dir: plugin.dir,
        cwd: this.workspace,
        workspace: this.workspace,
        git: this.git,
      });
      this.clients.set(plugin.manifest.id, client);
    }
    try {
      return await client.callTool(tool, args);
    } catch (err) {
      return {
        text: `The ${plugin.manifest.name} plugin failed: ${errorMessage(err)}`,
        isError: true,
      };
    }
  }

  /** Stop every server this segment started. */
  async close(): Promise<void> {
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }
}

/** Open plugin segments by Run (the `/mcp/plugins/<id>` endpoint finds them through the session). */
export class PluginSegments {
  private readonly byRun = new Map<string, PluginSegment>();

  open(
    registry: PluginRegistry,
    bot: Bot,
    workspace: string,
    session: OrbitRunSession,
    git?: { repo: string; branch: string },
  ) {
    const seg = new PluginSegment(registry, bot, workspace, session, git);
    this.byRun.set(session.runId, seg);
    return seg;
  }

  forSession(session: OrbitRunSession): PluginSegment | undefined {
    const seg = this.byRun.get(session.runId);
    return seg;
  }

  async close(seg: PluginSegment, runId: string): Promise<void> {
    if (this.byRun.get(runId) === seg) this.byRun.delete(runId);
    await seg.close();
  }
}
