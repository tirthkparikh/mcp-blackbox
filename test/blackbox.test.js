import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { redact, readSession, pairCalls } from '../src/record.js';
import { diff, normalise } from '../src/replay.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../bin/cli.js');
const FIXTURE = join(here, 'fixtures/server.mjs');
const run = promisify(execFile);

test('redact hides secret keys and known token formats', () => {
  const out = redact({
    params: { arguments: { password: 'hunter2', apiKey: 'abc', query: 'hello', nested: { Authorization: 'Bearer abcdefghijklmnop' } }, _meta: { progressToken: 7 } },
    text: `use ${'sk-' + 'ant-api03-abcdefghijklmnopqrstuv'} and ${'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789'}, header Bearer abcdefghijklmnopqrst`,
  }, ['query']);
  assert.equal(out.params.arguments.password, '[redacted]');
  assert.equal(out.params.arguments.apiKey, '[redacted]');
  assert.equal(out.params.arguments.query, '[redacted]');
  assert.equal(out.params.arguments.nested.Authorization, '[redacted]');
  assert.equal(out.params._meta.progressToken, 7);
  assert.equal(out.text, 'use [redacted] and [redacted], header Bearer [redacted]');
});

test('diff compares JSON inside text content and honours ignores', () => {
  const a = { result: { content: [{ type: 'text', text: '{"sum":3,"at":1}' }] } };
  const b = { result: { content: [{ type: 'text', text: '{"sum":4,"at":2}' }] } };
  assert.deepEqual(diff(a, b), ['result.content[0].text<json>.at: 1 → 2', 'result.content[0].text<json>.sum: 3 → 4']);
  assert.deepEqual(diff(a, b, '', ['at']), ['result.content[0].text<json>.sum: 3 → 4']);
  assert.deepEqual(diff(normalise({ x: 1, ts: 5 }, ['ts']), normalise({ x: 1, ts: 9 }, ['ts'])), []);
  assert.deepEqual(diff({ s: 'abc…[3 more chars]' }, { s: 'abcdef' }), []);
});

// Drive the proxy like an MCP client would.
function client(args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = '', err = '';
  const waiting = new Map();
  child.stderr.on('data', d => { err += d; });
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  return {
    stderr: () => err,
    req: (method, params) => new Promise(ok => { const n = ++id; waiting.set(n, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }),
    note: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    end: () => new Promise(ok => { child.on('exit', ok); child.stdin.end(); }),
  };
}

async function recordSession(dir) {
  const file = join(dir, 'session.jsonl');
  const c = client(['--out', file, '--ui', '0', '--', process.execPath, FIXTURE]);
  const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'fixture');
  c.note('notifications/initialized');
  assert.equal((await c.req('tools/list', {})).result.tools.length, 2);
  const add = await c.req('tools/call', { name: 'add', arguments: { a: 1, b: 2 } });
  assert.equal(JSON.parse(add.result.content[0].text).sum, 3);
  const login = await c.req('tools/call', { name: 'login', arguments: { password: 'hunter2' } });
  assert.match(login.result.content[0].text, /ghp_/, 'the client still gets the real data');
  await c.req('tools/call', { name: 'missing', arguments: {} });
  const code = await c.end();
  assert.equal(code, 0);
  assert.match(c.stderr(), /fixture server ready/, 'server stderr is passed through');
  return file;
}

test('proxy passes traffic through unchanged and records a redacted session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-'));
  const file = await recordSession(dir);
  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /hunter2|ghp_abcdef/, 'secrets must not reach the recording');
  const events = await readSession(file);
  assert.equal(events[0].type, 'session');
  const calls = pairCalls(events).filter(c => !c.notification);
  assert.deepEqual(calls.map(c => c.tool ?? c.method), ['initialize', 'tools/list', 'add', 'login', 'missing']);
  assert.ok(calls.every(c => !c.pending && typeof c.ms === 'number'));
  assert.equal(calls.at(-1).toolError, true);
  assert.ok(events.some(e => e.dir === 'stderr' && /fixture server ready/.test(e.text)));
});

test('stats and replay (pass, then detect a regression)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-'));
  const file = await recordSession(dir);

  const stats = JSON.parse((await run(process.execPath, [CLI, 'stats', file, '--json'])).stdout);
  assert.deepEqual(stats.find(r => r.name === 'tool add'), { ...stats.find(r => r.name === 'tool add'), calls: 1, errors: 0 });
  assert.equal(stats.find(r => r.name === 'tool missing').errors, 1);

  const ok = await run(process.execPath, [CLI, 'replay', file, '--ignore', 'at', '--', process.execPath, FIXTURE]);
  assert.match(ok.stdout, /5 passed, 0 failed/);

  await assert.rejects(
    run(process.execPath, [CLI, 'replay', file, '--ignore', 'at', '--', process.execPath, FIXTURE], { env: { ...process.env, MODE: 'changed' } }),
    e => e.code === 1 && /sum: 3 → 4/.test(e.stdout) && /4 passed, 1 failed/.test(e.stdout),
  );
});

test('live viewer serves the page and events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-'));
  const c = client(['--no-save', '--ui', '4391', '--', process.execPath, FIXTURE]);
  await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await c.req('tools/call', { name: 'add', arguments: { a: 2, b: 2 } });
  const page = await (await fetch('http://127.0.0.1:4391/')).text();
  assert.match(page, /<title>mcp-blackbox<\/title>/);
  const data = await (await fetch('http://127.0.0.1:4391/events.json')).json();
  assert.equal(data.live, true);
  assert.ok(data.events.filter(e => e.msg).length >= 4);
  await c.end();
  void dir;
});
