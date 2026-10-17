// A small MCP server for tests. MODE=changed makes `add` return a different answer.
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
process.stderr.write('fixture server ready\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: String(Date.now()) } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'add', inputSchema: { type: 'object' } }, { name: 'login', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call' && m.params.name === 'add') {
    const sum = m.params.arguments.a + m.params.arguments.b + (process.env.MODE === 'changed' ? 1 : 0);
    return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ sum, at: Date.now() }) }] } }), 20);
  }
  if (m.method === 'tools/call' && m.params.name === 'login') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'session token: ' + 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789' }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });
  if (m.id != null) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
});
