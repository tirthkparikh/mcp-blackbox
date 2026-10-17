// Web viewer for live or recorded MCP sessions.
import http from 'node:http';

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mcp-blackbox</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1b1b18;--mute:#6b6b63;--line:#e4e3de;--ok:#15803d;--err:#c2410c;--warn:#a16207;--sel:#fff3e8;--key:#7c3aed;--str:#0f766e;--num:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--panel:#1a1a18;--ink:#ecebe6;--mute:#9a998f;--line:#2c2c29;--ok:#4ade80;--err:#fb923c;--warn:#facc15;--sel:#2a2119;--key:#c4b5fd;--str:#5eead4;--num:#fbbf24}}
*{box-sizing:border-box}body{margin:0;display:flex;flex-direction:column;height:100vh;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
h1{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em}h1 small{color:var(--mute);font-weight:400;margin-left:6px;display:inline-block;max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.stat{font-size:12px;color:var(--mute)}.stat b{display:block;font-size:17px;color:var(--ink);font-variant-numeric:tabular-nums}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mute)}.dot{width:8px;height:8px;border-radius:50%;background:var(--mute)}.on .dot{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
input{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:220px;margin-left:auto}
main{display:grid;grid-template-columns:minmax(300px,420px) 1fr;flex:1;min-height:0}
#list{overflow:auto;border-right:1px solid var(--line)}
.row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:9px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:color-mix(in srgb,var(--sel) 60%,transparent)}.row.sel{background:var(--sel)}
.m{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m .tool{font-weight:650}.sub{font-size:12px;color:var(--mute)}.ms{font-variant-numeric:tabular-nums;font-size:12px;color:var(--mute);text-align:right}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid currentColor;justify-self:end}.ok{color:var(--ok)}.err{color:var(--err)}.pend{color:var(--warn)}.note{color:var(--mute)}
#detail{overflow:auto;padding:18px 22px}#detail h2{font-size:16px;margin:0 0 4px}.meta{color:var(--mute);font-size:12px;margin-bottom:16px}
section{margin-bottom:18px}section h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 6px;display:flex;justify-content:space-between}
pre{margin:0;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.k{color:var(--key)}.s{color:var(--str)}.n{color:var(--num)}button.copy{font:inherit;font-size:11px;border:0;background:none;color:var(--mute);cursor:pointer}
.empty{color:var(--mute);padding:40px;text-align:center}
#tools{display:flex;gap:6px;flex-wrap:wrap}.chip{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:2px 9px;background:var(--bg)}
@media (max-width:760px){body{height:auto;display:block}h1 small{max-width:70vw}main{grid-template-columns:1fr}#list{max-height:45vh;border-right:0;border-bottom:1px solid var(--line)}input{min-width:0;width:100%;margin:0}}
</style></head><body>
<header>
  <h1>mcp-blackbox <small id="src"></small></h1>
  <span class="live" id="live"><span class="dot"></span><span id="livetxt">recorded</span></span>
  <div class="stat"><b id="s-calls">0</b>calls</div>
  <div class="stat"><b id="s-err">0</b>errors</div>
  <div class="stat"><b id="s-p50">–</b>p50</div>
  <div class="stat"><b id="s-p95">–</b>p95</div>
  <input id="q" placeholder="Filter: method, tool, text…" autocomplete="off">
</header>
<main><div id="list"></div><div id="detail"><div class="empty">Select a call to see the request and response.</div></div></main>
<script>
const events = [], calls = [], open = new Map();
let selected = null, stderr = [], session = null;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const pretty = v => v === undefined ? '<span class="note">none</span>' : esc(JSON.stringify(v, null, 2))
  .replace(/(&quot;|")((?:\\\\.|[^"\\\\])*)"(\\s*:)?/g, (m, q, s, colon) => colon ? '<span class="k">"' + s + '"</span>' + colon : '<span class="s">"' + s + '"</span>')
  .replace(/\\b(-?\\d+(?:\\.\\d+)?)\\b(?![^<]*<\\/span>)/g, '<span class="n">$1</span>');
function add(ev) {
  events.push(ev);
  if (ev.type === 'session') { session = ev; $('#src').textContent = ev.server ? [ev.server.command, ...(ev.server.args||[])].join(' ') : ''; return; }
  if (!ev.msg) { if (ev.dir === 'stderr') stderr.push(ev); return; }
  for (const x of [].concat(ev.msg)) {
    if (x.method && x.id != null) { const c = { key: ev.dir + ':' + x.id, id: x.id, dir: ev.dir, method: x.method, tool: x.method === 'tools/call' ? x.params?.name : '', params: x.params, t: ev.t, pending: true }; open.set(c.key, c); calls.push(c); }
    else if (x.method) calls.push({ dir: ev.dir, method: x.method, params: x.params, t: ev.t, notification: true });
    else if (x.id != null) { const c = open.get((ev.dir === 's2c' ? 'c2s' : 's2c') + ':' + x.id); if (c) { Object.assign(c, { result: x.result, error: x.error, ms: ev.t - c.t, pending: false }); open.delete(c.key); } }
  }
}
function status(c) {
  if (c.notification) return ['note', 'notify'];
  if (c.pending) return ['pend', 'waiting'];
  if (c.error) return ['err', 'error ' + c.error.code];
  if (c.result?.isError) return ['err', 'tool error'];
  return ['ok', 'ok'];
}
const pct = (arr, p) => { if (!arr.length) return '–'; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))] + 'ms'; };
let raf = 0;
function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const q = $('#q').value.toLowerCase();
    const reqs = calls.filter(c => !c.notification);
    $('#s-calls').textContent = reqs.length;
    $('#s-err').textContent = reqs.filter(c => c.error || c.result?.isError).length;
    const times = reqs.filter(c => c.ms != null).map(c => c.ms);
    $('#s-p50').textContent = pct(times, 50); $('#s-p95').textContent = pct(times, 95);
    const shown = calls.filter(c => !q || JSON.stringify([c.method, c.tool, c.params, c.result, c.error]).toLowerCase().includes(q));
    $('#list').innerHTML = shown.length ? shown.map((c, i) => {
      const [cls, label] = status(c);
      const idx = calls.indexOf(c);
      return '<div class="row' + (idx === selected ? ' sel' : '') + '" data-i="' + idx + '"><div class="m">' + (c.dir === 's2c' ? '← ' : '') + esc(c.method) + (c.tool ? ' <span class="tool">' + esc(c.tool) + '</span>' : '') + '</div><span class="badge ' + cls + '">' + label + '</span><div class="sub">' + (c.t/1000).toFixed(2) + 's' + (c.id != null ? ' · id ' + esc(c.id) : '') + '</div><div class="ms">' + (c.ms != null ? c.ms + 'ms' : '') + '</div></div>';
    }).join('') : '<div class="empty">' + (calls.length ? 'No matches.' : 'Waiting for traffic…') + '</div>';
    if (selected != null) detail(calls[selected]);
  });
}
function detail(c) {
  if (!c) return;
  const [cls, label] = status(c);
  $('#detail').innerHTML = '<h2>' + esc(c.method) + (c.tool ? ' · ' + esc(c.tool) : '') + '</h2><div class="meta"><span class="' + cls + '">' + label + '</span>' + (c.ms != null ? ' · ' + c.ms + 'ms' : '') + ' · at ' + (c.t/1000).toFixed(3) + 's · ' + (c.dir === 'c2s' ? 'client → server' : 'server → client') + '</div>' +
    '<section><h3>Request <button class="copy" data-copy="params">copy</button></h3><pre>' + pretty(c.params) + '</pre></section>' +
    (c.notification ? '' : '<section><h3>' + (c.error ? 'Error' : 'Response') + ' <button class="copy" data-copy="' + (c.error ? 'error' : 'result') + '">copy</button></h3><pre>' + (c.pending ? '<span class="pend">waiting…</span>' : pretty(c.error ?? c.result)) + '</pre></section>') +
    (c.method === 'initialize' && stderr.length ? '<section><h3>Server stderr</h3><pre>' + esc(stderr.map(e => e.text).join('\\n')) + '</pre></section>' : '');
  $('#detail').querySelectorAll('.copy').forEach(b => b.onclick = () => navigator.clipboard?.writeText(JSON.stringify(c[b.dataset.copy], null, 2)));
}
$('#list').addEventListener('click', e => { const r = e.target.closest('.row'); if (!r) return; selected = +r.dataset.i; render(); });
$('#q').addEventListener('input', render);
fetch('events.json').then(r => r.json()).then(d => {
  d.events.forEach(add); render();
  if (!d.live) return;
  let seen = d.events.length;
  const es = new EventSource('stream?from=' + seen);
  es.onopen = () => { $('#live').classList.add('on'); $('#livetxt').textContent = 'live'; };
  es.onerror = () => { $('#live').classList.remove('on'); $('#livetxt').textContent = 'disconnected'; };
  es.onmessage = m => { add(JSON.parse(m.data)); render(); };
});
</script></body></html>`;

/**
 * Serve the viewer. `events` is an array that may keep growing (live mode);
 * call push(ev) to stream new events to open pages.
 */
export function startViewer({ events, live = false, port = 4300, host = '127.0.0.1' }) {
  const clients = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (url.pathname === '/events.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ live, events })); }
    if (url.pathname === '/stream' && live) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const from = Number(url.searchParams.get('from') ?? events.length);
      for (const ev of events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    res.writeHead(404); res.end();
  });
  const ready = new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok(server.address())); });
  return {
    ready,
    push(ev) { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); },
    close: () => { for (const c of clients) c.end(); return new Promise(ok => server.close(ok)); },
  };
}
