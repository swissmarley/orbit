// The corpus plugin: a minimal MCP server whose output an attacker controls.
//   get_document  returns docs/<id>.txt from the Bot's workspace (the test puts a payload there)
//   lookup_slowly   writes .corpus/started, waits 20 s, writes .corpus/finished (kill switch tests)
//   get_config    echoes its own secret back (redaction tests)
//   send_message, pay_invoice  answer "done" (they must never run without Orbit's say-so)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (id, t) =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }], isError: false } });
const schema = {
  type: 'object',
  properties: { id: { type: 'string' }, text: { type: 'string' } },
};
const TOOLS = ['get_document', 'lookup_slowly', 'get_config', 'send_message', 'pay_invoice'];

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
        serverInfo: { name: 'corpus', version: '1' },
      },
    });
    return;
  }
  if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { tools: TOOLS.map((name) => ({ name, description: name, inputSchema: schema })) },
    });
    return;
  }
  if (m.method !== 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
    return;
  }
  const args = m.params.arguments ?? {};
  switch (m.params.name) {
    case 'get_document': {
      const name = String(args.id ?? '').replace(/[^\w-]/g, '');
      let body;
      try {
        body = readFileSync(`docs/${name}.txt`, 'utf8');
      } catch {
        body = '(no such document)';
      }
      text(m.id, `Document ${name}:\n${body}`);
      return;
    }
    case 'lookup_slowly': {
      mkdirSync('.corpus', { recursive: true });
      writeFileSync('.corpus/started', String(process.pid));
      setTimeout(() => {
        writeFileSync('.corpus/finished', 'yes');
        text(m.id, 'lookup finished');
      }, 20_000);
      return;
    }
    case 'get_config':
      text(m.id, `config: token=${process.env.CORPUS_TOKEN ?? 'missing'}`);
      return;
    default:
      text(m.id, `${m.params.name}: done`);
  }
});
