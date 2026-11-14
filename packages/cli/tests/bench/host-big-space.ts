/**
 * A host carrying one large space: what its memory does as the space arrives,
 * and as a new device of the account takes all of it back.
 *
 *   node --conditions=@minca/source --import tsx tests/bench/host-big-space.ts [records] [bytes] [files] [fileBytes]
 *
 * Defaults: 3,000 records of 50 KB each (150 MB) and no files. `minca host
 * --free` runs in a child process, so its memory is measured apart from the
 * devices, which run here. Memory should follow how many peers are connected,
 * never how much a space holds: the peak is what a machine must have.
 *
 * - BENCH_HEAP_MB caps the host's heap, as a small machine would: the test
 *   that counts, since V8 grows its heap lazily and RSS alone overstates it.
 * - BENCH_PROBE=<file.mjs> is loaded into the host first (`--import`), to log
 *   `process.memoryUsage()` from inside it.
 * - BENCH_SNAPSHOT=<ms> writes a heap snapshot once the space is in, to
 *   BENCH_SNAPSHOT_DIR, and waits that long for it.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import { createNode } from '../../../core/src/node/node.js';
import type { P2PNode } from '../../../core/src/node/types.js';
import { createIdentityManager } from '../../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../core/src/identity/root-signer.js';
import { generateSeed } from '../../../core/src/identity/recovery-code.js';
import { deriveAccountKey } from '../../../core/src/identity/account-vault.js';
import { memoryStores } from '../../../core/tests/helpers/memory-stores.js';

const [records = 3000, bytes = 50_000, files = 0, fileBytes = 5_000_000] = process.argv.slice(2).map(Number);
const PORT = 18_900 + Math.floor(Math.random() * 90);
const url = `http://127.0.0.1:${PORT}`;
const cli = path.resolve(import.meta.dirname, '../../src/main.ts');
const heap = process.env.BENCH_HEAP_MB;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

function startHost(data: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      ...(heap ? [`--max-old-space-size=${heap}`] : []),
      ...(process.env.BENCH_PROBE ? ['--import', process.env.BENCH_PROBE] : []),
      ...(process.env.BENCH_SNAPSHOT
        ? [
            '--heapsnapshot-signal=SIGUSR2',
            `--diagnostic-dir=${process.env.BENCH_SNAPSHOT_DIR ?? os.tmpdir()}`,
          ]
        : []),
      '--conditions=@minca/source',
      '--import',
      'tsx',
      cli,
      'host',
      '--free',
      '--port',
      String(PORT),
    ],
    { env: { ...process.env, MINCA_HOST_DATA: data }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

/** The host's memory now, in MB; 0 once it is gone */
function rssMb(pid: number): number {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString()) / 1024;
  } catch {
    return 0;
  }
}

/** Watches the host's memory; `peak()` gives the most since it was last asked */
function watch(host: ChildProcess) {
  let most = 0;
  const timer = setInterval(() => (most = Math.max(most, rssMb(host.pid!))), 100);
  return {
    peak() {
      const was = most;
      most = 0;
      return was;
    },
    stop: () => clearInterval(timer),
  };
}

async function waitFor(what: string, host: ChildProcess, ok: () => Promise<boolean>, ms = 900_000) {
  const started = Date.now();
  while (!(await ok())) {
    if (host.exitCode !== null || host.signalCode !== null)
      throw new Error(`The host died waiting for ${what}: exit ${host.exitCode ?? host.signalCode}`);
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
  return (Date.now() - started) / 1000;
}

/** Bytes of the spaces the host's database holds: read beside the running host, which WAL allows */
function carried(data: string): number {
  const file = path.join(data, 'host.sqlite');
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const spaces = "SELECT id FROM stores WHERE path LIKE 'spaces/%'";
    const sum = (table: string, column: string) =>
      Number(
        db
          .prepare(`SELECT coalesce(sum(length(${column})), 0) AS n FROM ${table} WHERE store IN (${spaces})`)
          .get()?.n ?? 0,
      );
    return sum('entries', 'value') + sum('versions', 'body');
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

const manager = createIdentityManager();
const seed = generateSeed();
const identity = await manager.fromSeed(seed);
const accountKey = await deriveAccountKey(seed);
const device = (): Promise<P2PNode> =>
  createNode({
    signer: createLocalRootSigner(identity, manager.getProvider()),
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: { hosts: [url] },
  });

/** Text of about `length` bytes that doesn't repeat, so nothing along the way can fold it small */
function filler(length: number, salt: number): string {
  let text = '';
  for (let i = 0; text.length < length; i++) text += `${(salt * 2654435761 + i * 40503).toString(36)} `;
  return text.slice(0, length);
}

const data = await mkdtemp(path.join(os.tmpdir(), 'minca-host-big-'));
const host = startHost(data);
const memory = watch(host);
const nodes: P2PNode[] = [];
try {
  await waitFor('the host to start', host, () =>
    fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    ),
  );
  await sleep(1000);
  console.log(`host started: ${memory.peak().toFixed(0)} MB${heap ? `, heap capped at ${heap} MB` : ''}`);

  const laptop = await device();
  nodes.push(laptop);
  const { id: space } = await laptop.spaces.create({ name: 'Big', visibility: 'private' });
  for (let r = 0; r < records; r++) await laptop.records.put(space, 'note', { text: filler(bytes, r) });
  for (let f = 0; f < files; f++) {
    const file = await laptop.records.addFile(space, fileOf(fileBytes), { mime: 'application/octet-stream' });
    await laptop.records.put(space, 'note', { text: `file ${f}`, file });
  }
  const size = records * bytes + files * fileBytes;
  console.log(`a space of ${records} records and ${files} files, ${mb(size)}`);

  await laptop.hosting.use(url);
  const took = await waitFor('the host to hold the space', host, async () => carried(data) >= size);
  console.log(`the host took it in ${took.toFixed(0)} s: peak ${memory.peak().toFixed(0)} MB`);
  await sleep(8000);
  console.log(`settled, with the device still on: peak ${memory.peak().toFixed(0)} MB`);
  if (process.env.BENCH_SNAPSHOT) {
    host.kill('SIGUSR2');
    await sleep(Number(process.env.BENCH_SNAPSHOT));
  }

  await laptop.close();
  nodes.length = 0;
  const phone = await device();
  nodes.push(phone);
  let shown = 0;
  const back = await waitFor('a new device to hold the space', host, async () => {
    const held = await phone.records.list(space, { collection: 'note' }).catch(() => []);
    if (Date.now() - shown > 10_000) {
      shown = Date.now();
      const listed = await phone.spaces.list().catch(() => []);
      const status = await phone.spaces.status(space).catch((error: unknown) => String(error));
      console.log(
        `  the new device holds ${held.length} records, host at ${rssMb(host.pid!).toFixed(0)} MB;`,
        `spaces ${listed.map((one) => one.name).join(', ')};`,
        JSON.stringify(status).slice(0, 300),
      );
    }
    return held.length >= records + files;
  });
  console.log(`a new device took it all in ${back.toFixed(0)} s: peak ${memory.peak().toFixed(0)} MB`);
} finally {
  memory.stop();
  await Promise.all(nodes.map((node) => node.close().catch(() => {})));
  host.kill('SIGTERM');
  await rm(data, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);

function fileOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536)
    globalThis.crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + 65_536)));
  return bytes;
}
