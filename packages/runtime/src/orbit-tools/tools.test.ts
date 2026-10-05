import { BotSpec, MEMORY_LIMITS, type Bot } from '@orbit/core';
import { MemoryStore } from '@orbit/memory';
import { EventStore, openDatabase } from '@orbit/store';
import { describe, expect, it } from 'vitest';
import { handleMcpBody } from './mcp';
import { OrbitSessions } from './session';
import { OrbitToolset, canonicalArgs, orbitToolOf } from './tools';

function bot(id: string, spec: Record<string, unknown> = {}): Bot {
  return {
    id,
    version: 1,
    spec: BotSpec.parse({ name: id, goal: 'g', ...spec }),
    pausedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function setup(spec: Record<string, unknown> = {}, delegate = false) {
  const db = openDatabase(':memory:');
  const memory = new MemoryStore(db);
  const store = new EventStore(db);
  const delegated: string[] = [];
  const tools = new OrbitToolset({
    memory,
    store,
    ...(delegate
      ? {
          delegate: (_s, target) => {
            delegated.push(target);
            return { childRunId: 'run_child', botName: target };
          },
        }
      : {}),
  });
  const sessions = new OrbitSessions();
  const taint: string[] = [];
  const b = bot('bot_1', spec);
  const session = sessions.open({
    runId: 'run_1',
    bot: b,
    depth: 0,
    taint: () => taint,
    addTaint: (s) => {
      for (const x of s) if (!taint.includes(x)) taint.push(x);
    },
  });
  /** Allow then call, like the PreToolUse hook followed by the engine's MCP call. */
  const allowed = (name: string, args: Record<string, unknown>) => {
    const canon = canonicalArgs(orbitToolOf(`mcp__orbit__${name}`)!, args)!;
    session.authorize(`mcp__orbit__${name}`, canon);
    return tools.call(session, name, args);
  };
  return { db, memory, store, tools, sessions, session, taint, allowed, delegated, bot: b };
}

describe('Orbit tool sessions', () => {
  it('authorizations are exact (tool + canonical input) and used once', () => {
    const { session } = setup();
    session.authorize('mcp__orbit__memory_read', { id: 'mem_1' });
    expect(session.consume('mcp__orbit__memory_read', { id: 'mem_2' })).toBe(false);
    expect(session.consume('mcp__orbit__memory_write', { id: 'mem_1' })).toBe(false);
    expect(session.consume('mcp__orbit__memory_read', { id: 'mem_1' })).toBe(true);
    expect(session.consume('mcp__orbit__memory_read', { id: 'mem_1' })).toBe(false);
  });

  it('tokens are 256-bit, looked up by hash, and dead once the session closes', () => {
    const { sessions, session } = setup();
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions.byToken(session.token)).toBe(session);
    expect(sessions.byToken(session.token.toUpperCase())).toBeUndefined();
    expect(sessions.byToken('nope')).toBeUndefined();
    sessions.close(session);
    expect(sessions.byToken(session.token)).toBeUndefined();
    session.authorize('mcp__orbit__memory_read', { id: 'mem_1' });
    expect(session.consume('mcp__orbit__memory_read', { id: 'mem_1' })).toBe(false);
  });

  it('canonical arguments drop unknown keys so transports compare equal', () => {
    expect(canonicalArgs('memory_read', { id: 'mem_1', extra: true })).toEqual({ id: 'mem_1' });
    expect(canonicalArgs('memory_read', { id: '../etc' })).toBeNull();
    expect(orbitToolOf('mcp__orbit__memory_read')).toBe('memory_read');
    expect(orbitToolOf('mcp__orbitx__memory_read')).toBeNull();
    expect(orbitToolOf('mcp__orbit__shell')).toBeNull();
  });
});

describe('OrbitToolset', () => {
  it('refuses calls the policy did not allow', async () => {
    const { tools, session, memory } = setup();
    const r = await tools.call(session, 'memory_write', { title: 't', body: 'b' });
    expect(r.isError).toBe(true);
    expect(memory.count('bot_1')).toBe(0);
  });

  it('memory_write stores the Run taint with the note and enforces the per-Run limit', async () => {
    const { allowed, memory, taint, session } = setup();
    expect((await allowed('memory_write', { title: 'clean', body: 'b' })).isError).toBe(false);
    taint.push('WebFetch');
    await allowed('memory_write', { title: 'dirty', body: 'b' });
    const [dirty, clean] = memory.list({ botId: 'bot_1' });
    expect(clean).toMatchObject({ title: 'clean', taint: [], source: 'bot', runId: 'run_1' });
    expect(dirty).toMatchObject({ title: 'dirty', taint: ['WebFetch'] });
    session.memoryWrites = MEMORY_LIMITS.botWritesPerRun;
    const over = await allowed('memory_write', { title: 'x', body: 'y' });
    expect(over).toMatchObject({ isError: true });
  });

  it('searching or reading untrusted memory taints the Run; other Bots’ memory is invisible', async () => {
    const { allowed, memory, taint } = setup();
    const clean = memory.create({
      botId: 'bot_1',
      kind: 'note',
      source: 'bot',
      title: 'Launch plan',
      body: 'ok',
      createdBy: 'x',
    });
    const dirty = memory.create({
      botId: 'bot_1',
      kind: 'note',
      source: 'bot',
      title: 'Launch rumour',
      body: 'from the web',
      taint: ['WebFetch'],
      createdBy: 'x',
    });
    const other = memory.create({
      botId: 'bot_2',
      kind: 'note',
      source: 'bot',
      title: 'Launch secret',
      body: 's',
      createdBy: 'x',
    });
    expect((await allowed('memory_read', { id: clean.id })).isError).toBe(false);
    expect(taint).toEqual([]);
    const found = await allowed('memory_search', { query: 'launch' });
    expect(found.text).toContain(clean.id);
    expect(found.text).not.toContain(other.id);
    expect(taint).toEqual([`memory:${dirty.id}`, 'WebFetch']);
    expect((await allowed('memory_read', { id: other.id })).isError).toBe(true);
  });

  it('offers delegate_to_bot only with allowed peers and a delegation service', () => {
    expect(
      setup({}, true)
        .tools.definitions(bot('b'))
        .map((t) => t.name),
    ).not.toContain('delegate_to_bot');
    const withPeers = bot('b', { delegation: { allowedBots: ['Researcher'] } });
    expect(
      setup({}, false)
        .tools.definitions(withPeers)
        .map((t) => t.name),
    ).not.toContain('delegate_to_bot');
    expect(
      setup({}, true)
        .tools.definitions(withPeers)
        .map((t) => t.name),
    ).toContain('delegate_to_bot');
    expect(setup({}, true).tools.definitions(bot('b', { memory: { tools: false } }))).toEqual([]);
  });

  it('delegate_to_bot records the child on the session', async () => {
    const { allowed, session, delegated } = setup(
      { delegation: { allowedBots: ['Researcher'] } },
      true,
    );
    const r = await allowed('delegate_to_bot', { bot: 'Researcher', task: 'Find it' });
    expect(r.text).toContain('Delegated to Researcher as Run run_child');
    expect(session.delegations).toEqual(['run_child']);
    expect(delegated).toEqual(['Researcher']);
  });
});

describe('the MCP JSON-RPC surface', () => {
  it('implements initialize, ping, tools/list and tools/call only', async () => {
    const { tools, session } = setup();
    const init = (await handleMcpBody(tools, session, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect(
      await handleMcpBody(tools, session, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
    expect(await handleMcpBody(tools, session, { jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {},
    });
    const unknown = (await handleMcpBody(tools, session, {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
    })) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    const bad = (await handleMcpBody(tools, session, { id: 4 })) as { error: { code: number } };
    expect(bad.error.code).toBe(-32600);
    const batch = (await handleMcpBody(tools, session, [
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/x' },
    ])) as unknown[];
    expect(batch).toHaveLength(1);
    const call = (await handleMcpBody(tools, session, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x' } },
    })) as { result: { isError: boolean } };
    expect(call.result.isError).toBe(true);
  });
});
