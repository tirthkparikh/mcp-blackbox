#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder, readSession, pairCalls, sessionsDir } from '../src/record.js';
import { startProxy } from '../src/proxy.js';
import { startViewer } from '../src/viewer.js';
import { replay } from '../src/replay.js';

const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
const HELP = `mcp-blackbox ${pkg.version}
Flight recorder for MCP servers: see every call, keep a log, replay real sessions as tests.

Record (put this in front of any stdio MCP server command)
  mcp-blackbox [options] -- <command> [args…]
    --ui [port]            Live web viewer (default port 4300)
    --out <file.jsonl>     Where to save the session (default: ~/.mcp-blackbox/sessions/)
    --no-save              Don't write a file (viewer only)
    --redact <k1,k2>       Extra JSON keys to hide (tokens, passwords and common API keys are hidden already)
    --keep-large           Keep big payloads (base64 images etc.) in full

Inspect
  mcp-blackbox ls                          Recent sessions
  mcp-blackbox view <file|latest> [--port n]
  mcp-blackbox stats <file|latest>         Calls, errors and latency per tool

Test
  mcp-blackbox replay <file|latest> [--ignore k1,a.b] [--timeout ms] -- <command> [args…]
    Re-sends the recorded client requests to a fresh server and compares every response.
    Exit code 1 on any difference, so it fits CI.

Example (Claude Desktop config):
  "command": "npx", "args": ["-y", "@tirthlabs/mcp-blackbox", "--ui", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

Docs: ${pkg.homepage}`;

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const before = sep >= 0 ? argv.slice(0, sep) : argv;
const target = sep >= 0 ? argv.slice(sep + 1) : [];
const say = m => process.stderr.write(`[mcp-blackbox] ${m}\n`);
const fail = m => { process.stderr.write(`\x1b[31m✖\x1b[0m ${m}\n`); process.exit(1); };

// tiny flag parser: --flag value | --flag=value | --bool
const flags = {}, pos = [];
const BOOL = new Set(['no-save', 'keep-large', 'help', 'version', 'json']);
for (let i = 0; i < before.length; i++) {
  const a = before[i];
  if (a === '-h') { flags.help = true; continue; }
  if (a === '-v') { flags.version = true; continue; }
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const [k, inline] = a.slice(2).split(/=(.*)/s);
  if (BOOL.has(k)) flags[k] = true;
  else if (inline !== undefined) flags[k] = inline;
  else if (k === 'ui' && (before[i + 1] === undefined || !/^\d+$/.test(before[i + 1]))) flags.ui = '4300';
  else flags[k] = before[++i];
}
if (flags.version) { console.log(pkg.version); process.exit(0); }

async function resolveSession(name) {
  if (name && name !== 'latest') return name;
  const dir = sessionsDir();
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch { files = []; }
  if (!files.length) fail(`No sessions in ${dir} yet.`);
  const withTime = await Promise.all(files.map(async f => ({ f, m: (await stat(join(dir, f))).mtimeMs })));
  return join(dir, withTime.sort((a, b) => b.m - a.m)[0].f);
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const command = pos[0];
try {
  if (flags.help || (!command && !target.length)) {
    console.log(HELP); process.exit(flags.help ? 0 : 1);
  } else if (!command) {
    // record mode
    const [cmd, ...args] = target;
    let viewer = null;
    const recorder = createRecorder({
      file: flags['no-save'] ? false : flags.out, server: { command: cmd, args },
      redactKeys: flags.redact ? flags.redact.split(',').map(s => s.trim()) : [], keepLarge: !!flags['keep-large'],
      onEvent: ev => viewer?.push(ev),
    });
    if (flags.ui) {
      viewer = startViewer({ events: recorder.events, live: true, port: Number(flags.ui) });
      viewer.ready.then(a => say(`viewer: http://${a.address}:${a.port}`)).catch(e => say(`viewer not started: ${e.message}`));
    }
    if (recorder.file) say(`recording to ${recorder.file}`);
    const { exited, child } = startProxy({ command: cmd, args, recorder });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    const code = await exited;
    await recorder.close();
    await viewer?.close();
    // Let queued writes to a pipe finish before exiting.
    process.stdout.write('', () => process.exit(typeof code === 'number' ? code : 1));
  } else if (command === 'ls') {
    const dir = sessionsDir();
    let files = [];
    try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch {}
    if (!files.length) { console.log(`No sessions yet in ${dir}`); process.exit(0); }
    const rows = await Promise.all(files.map(async f => {
      const s = await stat(join(dir, f));
      const calls = pairCalls(await readSession(join(dir, f), { onBadLine: n => say(`skipped bad line ${n} in ${f}`) })).filter(c => !c.notification);
      return { f, m: s.mtimeMs, calls: calls.length, errors: calls.filter(c => c.error || c.toolError).length };
    }));
    for (const r of rows.sort((a, b) => b.m - a.m).slice(0, 30)) console.log(`${new Date(r.m).toLocaleString().padEnd(24)} ${String(r.calls).padStart(4)} calls ${String(r.errors).padStart(3)} errors  ${join(dir, r.f)}`);
  } else if (command === 'view') {
    const file = await resolveSession(pos[1]);
    const events = await readSession(file, { onBadLine: n => say(`skipped line ${n}: not valid JSON`) });
    const viewer = startViewer({ events, port: Number(flags.port ?? 4300) });
    const a = await viewer.ready;
    console.log(`Viewing ${file}\nOpen http://${a.address}:${a.port}  (Ctrl+C to stop)`);
  } else if (command === 'stats') {
    const file = await resolveSession(pos[1]);
    const calls = pairCalls(await readSession(file, { onBadLine: n => say(`skipped line ${n}: not valid JSON`) })).filter(c => !c.notification && c.dir === 'c2s');
    const groups = new Map();
    for (const c of calls) {
      const k = c.tool ? `tool ${c.tool}` : c.method;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const rows = [...groups].map(([k, cs]) => {
      const ms = cs.filter(c => c.ms != null).map(c => c.ms);
      return { name: k, calls: cs.length, errors: cs.filter(c => c.error || c.toolError).length, pending: cs.filter(c => c.pending).length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null };
    }).sort((a, b) => b.calls - a.calls);
    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
    console.log(`${file}\n`);
    console.log(`${'call'.padEnd(36)} ${'count'.padStart(6)} ${'errors'.padStart(7)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}`);
    const f = v => (v == null ? '–' : `${v}ms`).padStart(8);
    for (const r of rows) console.log(`${r.name.slice(0, 36).padEnd(36)} ${String(r.calls).padStart(6)} ${String(r.errors).padStart(7)} ${f(r.p50)} ${f(r.p95)} ${f(r.max)}${r.pending ? `  (${r.pending} unanswered)` : ''}`);
  } else if (command === 'replay') {
    if (!target.length) fail('Usage: mcp-blackbox replay <file|latest> -- <server command> [args…]');
    const file = await resolveSession(pos[1]);
    const events = await readSession(file, { onBadLine: n => say(`skipped line ${n}: not valid JSON`) });
    console.log(`Replaying ${file}\nagainst  ${target.join(' ')}\n`);
    const res = await replay(events, {
      command: target[0], args: target.slice(1), timeout: Number(flags.timeout ?? 30000),
      ignore: flags.ignore ? flags.ignore.split(',').map(s => s.trim()) : [],
      onProgress: c => {
        const name = c.tool ? `tools/call ${c.tool}` : c.method;
        console.log(`${c.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${name.padEnd(40)} ${String(c.ms ?? '').padStart(5)}ms${c.recordedMs != null ? ` (was ${c.recordedMs}ms)` : ''}`);
        for (const d of (c.diffs ?? []).slice(0, 8)) console.log(`    ${d}`);
        if ((c.diffs?.length ?? 0) > 8) console.log(`    …and ${c.diffs.length - 8} more`);
      },
    });
    console.log(`\n${res.passed} passed, ${res.failed} failed`);
    process.exit(res.failed ? 1 : 0);
  } else {
    fail(`Unknown command "${command}". To wrap a server use: mcp-blackbox -- <command> [args…]`);
  }
} catch (e) { fail(e.message); }
