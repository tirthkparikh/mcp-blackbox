// Transparent stdio proxy: client <-> mcp-blackbox <-> real MCP server.
// Bytes pass through unchanged; each complete JSON line is also recorded.
import { spawn } from 'node:child_process';

function lineSplitter(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Start the wrapped server and wire it to the given streams.
 * Returns { child, exited: Promise<code> }.
 */
export function startProxy({ command, args = [], env, recorder, input = process.stdin, output = process.stdout, errOutput = process.stderr }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell: process.platform === 'win32' });

  const record = dir => line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return recorder.raw(dir === 'c2s' ? 'c2s-raw' : 's2c-raw', line); }
    recorder.message(dir, msg);
  };
  const fromClient = lineSplitter(record('c2s'));
  const fromServer = lineSplitter(record('s2c'));
  const fromStderr = lineSplitter(line => recorder.raw('stderr', line));

  input.setEncoding?.('utf8');
  input.on('data', chunk => { child.stdin.write(chunk); fromClient(chunk.toString()); });
  input.on('end', () => child.stdin.end());
  child.stdin.on('error', () => {});  // server exited early; the exit handler reports it

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output.write(chunk); fromServer(chunk); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errOutput.write(chunk); fromStderr(chunk); });

  const exited = new Promise(ok => {
    child.on('error', e => {
      recorder.raw('stderr', `[mcp-blackbox] failed to start "${command}": ${e.message}`);
      errOutput.write(`[mcp-blackbox] failed to start "${command}": ${e.message}\n`);
      ok(127);
    });
    child.on('exit', (code, signal) => {
      recorder.raw('stderr', `[mcp-blackbox] server exited (${signal ?? code})`);
      ok(code ?? (signal ? 1 : 0));
    });
  });
  return { child, exited };
}
