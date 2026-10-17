import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSession } from '../src/record.js';

const cli = new URL('../bin/cli.js', import.meta.url).pathname;
const fixture = new URL('./fixtures/big-exit.mjs', import.meta.url).pathname;

test('no server output is lost when the server exits right after a big write', { skip: process.platform === 'win32' }, async () => {
  // A reader that starts late lets the pipe fill up, which used to cut the output at 64 KB.
  const cmd = `echo '{}' | "${process.execPath}" "${cli}" --no-save -- "${process.execPath}" "${fixture}" 2>/dev/null | (sleep 0.3; wc -c)`;
  const p = spawn('sh', ['-c', cmd]);
  let out = '';
  p.stdout.on('data', c => { out += c; });
  await new Promise(ok => p.on('close', ok));
  assert.equal(Number(out.trim()), 500046);  // exact size of the fixture's line
});

test('corrupt lines in a session file are skipped', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'bb-')), 's.jsonl');
  writeFileSync(f, '{"type":"session"}\n{bad\n{"t":1}\n');
  const bad = [];
  const ev = await readSession(f, { onBadLine: n => bad.push(n) });
  assert.equal(ev.length, 2);
  assert.deepEqual(bad, [2]);
});

test('viewer escapes error codes', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/viewer.js', import.meta.url), 'utf8');
  assert.match(src, /'error ' \+ esc\(c\.error\.code\)/);
});
