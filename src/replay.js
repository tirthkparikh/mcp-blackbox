// Replay a recorded session against a server and compare responses: regression tests for MCP servers.
import { spawn } from 'node:child_process';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Remove ignored keys (at any depth) and normalise volatile bits before comparing. */
export function normalise(value, ignore = []) {
  const keys = new Set(['_meta', ...ignore.filter(k => !k.includes('.'))]);
  const paths = ignore.filter(k => k.includes('.'));
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (isObj(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        const p = path ? `${path}.${k}` : k;
        if (keys.has(k) || paths.some(ip => ip === p || ip === p.replace(/\[\d+\]/g, '[]'))) continue;
        out[k] = walk(v[k], p);
      }
      return out;
    }
    return v;
  };
  return walk(value, '');
}

/** List differences between two JSON values as "path: expected → actual". */
export function diff(a, b, path = '', ignore = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const show = v => { const s = JSON.stringify(v); return s === undefined ? 'missing' : s.length > 80 ? s.slice(0, 77) + '…' : s; };
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diff(a[k], b[k], path ? `${path}.${k}` : k, ignore));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${path}[${i}]`, ignore));
    return out;
  }
  // recordings shorten huge strings and hide secrets; treat those parts as matching
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.includes('[redacted]')) {
      const re = new RegExp('^' + a.split('[redacted]').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]+?') + '$');
      if (re.test(b)) return [];
    }
    const cut = a.match(/^([\s\S]*)…\[(\d+) more chars\]$/);
    if (cut && b.startsWith(cut[1]) && b.length === cut[1].length + Number(cut[2])) return [];
  }
  // JSON embedded in text content (very common for MCP tool results): compare structurally
  if (typeof a === 'string' && typeof b === 'string') {
    try {
      const ja = JSON.parse(a), jb = JSON.parse(b);
      if (typeof ja === 'object' && typeof jb === 'object') return diff(normalise(ja, ignore), normalise(jb, ignore), `${path}<json>`, ignore);
    } catch {}
  }
  return [`${path || '(root)'}: ${show(a)} → ${show(b)}`];
}

/**
 * Replay client->server traffic from recorded events.
 * opts: command, args, env, ignore[], timeout, only (method or tool filter), onProgress
 * Returns { checks: [{ method, tool, ok, diffs, ms, recordedMs }], passed, failed }.
 */
export async function replay(events, { command, args = [], env, ignore = [], timeout = 30000, onProgress } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const waiting = new Map();
  let buf = '';
  const recordedClientReplies = new Map();  // method -> recorded client response for server->client requests

  // map recorded responses
  const recorded = new Map();
  for (const ev of events) {
    if (!ev.msg || Array.isArray(ev.msg)) continue;
    if (ev.dir === 's2c' && ev.msg.id != null && !ev.msg.method) recorded.set(ev.msg.id, { msg: ev.msg, t: ev.t });
  }
  const reqTimes = new Map();
  for (const ev of events) if (ev.dir === 'c2s' && ev.msg?.method && ev.msg.id != null) reqTimes.set(ev.msg.id, ev.t);
  // client answers to server->client requests (roots/list, sampling…), keyed by the server's request method
  const s2cRequests = new Map();
  for (const ev of events) {
    if (ev.dir === 's2c' && ev.msg?.method && ev.msg.id != null) s2cRequests.set(ev.msg.id, ev.msg.method);
    if (ev.dir === 'c2s' && ev.msg && !ev.msg.method && ev.msg.id != null && s2cRequests.has(ev.msg.id)) recordedClientReplies.set(s2cRequests.get(ev.msg.id), ev.msg);
  }

  const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method && msg.id != null) {  // server asks the client something
        const rec = recordedClientReplies.get(msg.method);
        send(rec ? { ...rec, id: msg.id } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not available during replay' } });
      } else if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const exited = new Promise(ok => { child.on('exit', code => ok(code)); child.on('error', e => ok(e)); });

  const request = (msg) => Promise.race([
    new Promise(ok => { waiting.set(msg.id, ok); send(msg); }),
    new Promise((_, fail) => setTimeout(() => fail(new Error(`no response within ${timeout}ms`)), timeout)),
    exited.then(code => { throw new Error(`server exited (${code instanceof Error ? code.message : code})${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`); }),
  ]);

  const checks = [];
  try {
    for (const ev of events) {
      if (ev.dir !== 'c2s' || !ev.msg || Array.isArray(ev.msg)) continue;
      const msg = ev.msg;
      if (!msg.method) continue;               // replies to server requests are handled above
      if (msg.id == null) { send(msg); continue; }  // notification
      const t0 = Date.now();
      const check = { id: msg.id, method: msg.method, tool: msg.method === 'tools/call' ? msg.params?.name : undefined, recordedMs: recorded.has(msg.id) ? recorded.get(msg.id).t - reqTimes.get(msg.id) : null };
      try {
        const got = await request(msg);
        check.ms = Date.now() - t0;
        const want = recorded.get(msg.id)?.msg;
        if (!want) { check.ok = true; check.note = 'no recorded response'; }
        else {
          const ign = ignore;
          const a = normalise({ result: want.result, error: want.error }, ign);
          const b = normalise({ result: got.result, error: got.error }, ign);
          if (msg.method === 'initialize') { delete a.result?.serverInfo?.version; delete b.result?.serverInfo?.version; }
          check.diffs = diff(a, b, '', ign);
          check.ok = check.diffs.length === 0;
        }
      } catch (e) {
        check.ok = false; check.diffs = [e.message]; check.ms = Date.now() - t0;
      }
      checks.push(check);
      onProgress?.(check);
      if (check.diffs?.[0]?.startsWith('server exited')) break;
    }
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    await exited;
    clearTimeout(timer);
  }
  return { checks, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length };
}
