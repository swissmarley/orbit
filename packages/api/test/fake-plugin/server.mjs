// A minimal MCP server for API tests: echo and send_message both echo their text.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      },
    });
  } else if (m.method === 'tools/list') {
    const schema = { type: 'object', properties: { text: { type: 'string' } } };
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echo', inputSchema: schema },
          { name: 'send_message', description: 'Send', inputSchema: schema },
        ],
      },
    });
  } else if (m.method === 'tools/call') {
    const text = `${m.params.name}: ${m.params.arguments.text ?? ''} (token ${process.env.FAKE_TOKEN ? 'present' : 'missing'})`;
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { content: [{ type: 'text', text }], isError: false },
    });
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
