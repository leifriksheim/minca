/**
 * A process taking a lock, for tests that race several: says `ready`, reads
 * the time to take it at, takes it then, says `HELD` or `BUSY`, and keeps it
 * until stdin closes.
 */
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { holdLock } from '../../src/writer-keys.js';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
process.stdout.write('ready\n');
const at = Number((await lines.next()).value);
await delay(Math.max(0, at - Date.now()));
const release = await holdLock(process.argv[2] ?? '');
process.stdout.write(release ? 'HELD\n' : 'BUSY\n');
await lines.next();
