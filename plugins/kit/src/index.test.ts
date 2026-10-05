import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolError, defineTool, handle } from './index';

const server = {
  name: 'demo',
  version: '1.0.0',
  tools: [
    defineTool({
      name: 'echo',
      description: 'Echo',
      input: z.object({ text: z.string().max(10) }),
      run: ({ text }) => `echo: ${text}`,
    }),
    defineTool({
      name: 'fail',
      description: 'Fails',
      input: z.object({}),
      run: () => {
        throw new ToolError('nope');
      },
    }),
  ],
};
const ctx = { workspace: '/tmp', env: {} };
const call = (method: string, params: unknown = {}) =>
  handle(server, { jsonrpc: '2.0', id: 1, method, params }, ctx);

describe('plugin kit', () => {
  it('initializes, lists tools with JSON schemas and calls them', async () => {
    expect(await call('initialize', { protocolVersion: '2025-06-18' })).toMatchObject({
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } },
    });
    const list = await call('tools/list');
    expect(list?.result).toMatchObject({
      tools: [
        { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'fail' },
      ],
    });
    expect(await call('tools/call', { name: 'echo', arguments: { text: 'hi' } })).toMatchObject({
      result: { content: [{ type: 'text', text: 'echo: hi' }], isError: false },
    });
  });

  it('turns invalid arguments, unknown tools and failures into tool errors', async () => {
    expect(
      await call('tools/call', { name: 'echo', arguments: { text: 'x'.repeat(20) } }),
    ).toMatchObject({
      result: { isError: true },
    });
    expect(await call('tools/call', { name: 'nope' })).toMatchObject({ result: { isError: true } });
    expect(await call('tools/call', { name: 'fail' })).toMatchObject({
      result: { content: [{ text: 'nope' }], isError: true },
    });
  });

  it('ignores notifications and refuses unknown methods', async () => {
    expect(
      await handle(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, ctx),
    ).toBeNull();
    expect(await call('sampling/createMessage')).toMatchObject({ error: { code: -32601 } });
    expect(await handle(server, { nope: true }, ctx)).toMatchObject({ error: { code: -32600 } });
  });
});
