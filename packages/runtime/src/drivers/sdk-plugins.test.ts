import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { pluginSdkServer } from './sdk';

describe('SDK engine: a plugin as an in-process MCP server (ADR-014)', () => {
  it("serves the plugin's own JSON schemas and routes calls through the binding", async () => {
    const call = vi.fn((name: string, args: Record<string, unknown>) =>
      Promise.resolve({ text: `${name}:${JSON.stringify(args)}`, isError: false }),
    );
    const config = await pluginSdkServer({
      name: 'fake',
      http: null,
      tools: [
        {
          name: 'echo',
          description: 'Echo',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
      call,
    });
    expect(config).toMatchObject({ type: 'sdk', name: 'fake' });
    if (config.type !== 'sdk' || !('instance' in config)) throw new Error('not an sdk server');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      }),
    ]);
    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r).toMatchObject({
      content: [{ type: 'text', text: 'echo:{"text":"hi"}' }],
      isError: false,
    });
    expect(call).toHaveBeenCalledWith('echo', { text: 'hi' });
    await client.close();
  });
});
