// Session recording: JSONL files with every JSON-RPC message, secrets redacted.
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const sessionsDir = () => process.env.MCP_BLACKBOX_DIR || join(homedir(), '.mcp-blackbox', 'sessions');

const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|auth|cookie|session[-_]?id|private[-_]?key|client[-_]?secret|access[-_]?key|credentials?)$/i;
const SECRET_VALUES = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,          // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                      // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                    // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                              // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g,                          // Google API key
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bfigd_[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,  // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Deep-copy a value with secrets replaced by "[redacted]". */
export function redact(value, extraKeys = []) {
  const extra = extraKeys.length ? new RegExp(`^(${extraKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i') : null;
  const walk = (v, key) => {
    if (typeof key === 'string' && key !== 'progressToken' && (SECRET_KEY.test(key) || extra?.test(key)) && v != null && typeof v !== 'object' && v !== '') return '[redacted]';
    if (typeof v === 'string') return SECRET_VALUES.reduce((s, re) => s.replace(re, m => (/^(Bearer|Basic)\s/.test(m) ? m.split(/\s+/)[0] + ' [redacted]' : '[redacted]')), v);
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

/** Shorten huge payloads (e.g. base64 images) so recordings stay readable. */
export function trimLarge(value, max = 4000) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, 200)}…[${value.length - 200} more chars]` : value;
  if (Array.isArray(value)) return value.map(v => trimLarge(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimLarge(v, max)]));
  return value;
}

export function createRecorder({ file, server, redactKeys = [], keepLarge = false, onEvent } = {}) {
  const start = Date.now();
  let out = null;
  if (file !== false) {
    mkdirSync(file ? join(file, '..') : sessionsDir(), { recursive: true });
    const name = file ?? join(sessionsDir(), `${new Date(start).toISOString().replace(/[:.]/g, '-')}_${basename(server?.command ?? 'server').replace(/[^\w.-]/g, '_')}.jsonl`);
    out = createWriteStream(name, { flags: 'a' });
    out.path_ = name;
  }
  const events = [];
  const write = ev => {
    events.push(ev);
    out?.write(JSON.stringify(ev) + '\n');
    onEvent?.(ev);
  };
  write({ type: 'session', started: new Date(start).toISOString(), server: server ? { command: server.command, args: redact(server.args ?? []) } : null });
  return {
    file: out?.path_ ?? null,
    events,
    message(dir, msg) {
      let clean = redact(msg, redactKeys);
      if (!keepLarge) clean = trimLarge(clean);
      write({ t: Date.now() - start, dir, msg: clean });
    },
    raw(dir, text) { write({ t: Date.now() - start, dir, text: redact(String(text)).slice(0, 4000) }); },
    close: () => new Promise(ok => (out ? out.end(ok) : ok())),
  };
}

export async function readSession(file) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const events = [];
  for (const [i, line] of lines.entries()) {
    try { events.push(JSON.parse(line)); } catch { throw new Error(`${file}:${i + 1}: not valid JSON`); }
  }
  return events;
}

/**
 * Pair requests with responses. Returns calls:
 * { id, dir, method, tool, params, result, error, t, ms, pending }
 */
export function pairCalls(events) {
  const calls = [], open = new Map();
  for (const ev of events) {
    if (!ev.msg) continue;
    const m = ev.msg;
    const msgs = Array.isArray(m) ? m : [m];
    for (const x of msgs) {
      if (x.method && x.id != null) {
        const call = { key: `${ev.dir}:${x.id}`, id: x.id, dir: ev.dir, method: x.method, tool: x.method === 'tools/call' ? x.params?.name : undefined, params: x.params, t: ev.t, pending: true };
        open.set(call.key, call); calls.push(call);
      } else if (x.method) {
        calls.push({ id: null, dir: ev.dir, method: x.method, params: x.params, t: ev.t, notification: true });
      } else if (x.id != null) {
        const reqDir = ev.dir === 's2c' ? 'c2s' : 's2c';
        const call = open.get(`${reqDir}:${x.id}`);
        if (call) {
          Object.assign(call, { result: x.result, error: x.error, ms: ev.t - call.t, pending: false });
          if (x.result?.isError) call.toolError = true;
          open.delete(call.key);
        }
      }
    }
  }
  return calls;
}
