// Writes one large line and exits right away (used to check no output is lost).
import { writeSync } from 'node:fs';
writeSync(1, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'x'.repeat(500000) } }) + '\n');
process.exit(0);
