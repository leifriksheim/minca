/**
 * A new device restoring an account from a host, over a phone's link: where
 * the time goes as an account and its spaces grow.
 *
 *   node --conditions=@minca/source --import tsx tests/bench/restore.ts [messages] [edits] [members] [spaces]
 *
 * Defaults, roughly a year of use: one community of 5,000 messages, 200
 * records edited 20 times each, 300 members added and 100 of them removed
 * again, and 30 more small spaces in the account's registry. `minca host
 * --free` runs in a child process; the new device reaches it through a
 * proxy that delays every chunk by BENCH_LATENCY_MS (default 60) each way and
 * carries BENCH_MBPS (default 16 Mbit/s), as LTE does. BENCH_LATENCY_MS=0
 * BENCH_MBPS=0 takes the link away, to see what is CPU alone.
 *
 * Reports when the new device first lists the spaces, when it holds each
 * collection of the community whole, and the CPU it spent, by function.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Session } from 'node:inspector/promises';

import { createNode } from '../../../core/src/node/node.js';
import type { P2PNode } from '../../../core/src/node/types.js';
import { createIdentityManager } from '../../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../../core/src/identity/root-signer.js';
import { generateSeed } from '../../../core/src/identity/recovery-code.js';
import { deriveAccountKey } from '../../../core/src/identity/account-vault.js';
import { community } from '../../../core/src/space/presets.js';
import { memoryStores } from '../../../core/tests/helpers/memory-stores.js';

const [messages = 5000, edits = 200, members = 300, spaces = 30] = process.argv.slice(2).map(Number);
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 60);
const MBPS = Number(process.env.BENCH_MBPS ?? 16);
const PORT = 19_100 + Math.floor(Math.random() * 400);
const cli = path.resolve(import.meta.dirname, '../../src/main.ts');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

function startHost(data: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--conditions=@minca/source', '--import', 'tsx', cli, 'host', '--free', '--port', String(PORT)],
    { env: { ...process.env, MINCA_HOST_DATA: data }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

/**
 * A TCP proxy in front of the host: each chunk waits `LATENCY_MS`, and each
 * direction carries at most `MBPS`, first in first out, as a phone's link.
 */
let slow = false;
function slowLink(target: number): Promise<{ port: number; close: () => void }> {
  const bytesPerMs = MBPS > 0 ? (MBPS * 1_000_000) / 8 / 1000 : Infinity;
  const pipe = (from: net.Socket, to: net.Socket) => {
    let free = 0;
    from.on('data', (chunk: Buffer) => {
      if (!slow) return void to.write(chunk);
      const now = performance.now();
      const start = Math.max(now, free);
      free = start + chunk.length / bytesPerMs;
      const at = free + LATENCY_MS - now;
      if (at <= 0) to.write(chunk);
      else setTimeout(() => to.writable && to.write(chunk), at);
    });
    from.on('close', () => setTimeout(() => to.destroy(), LATENCY_MS));
    from.on('error', () => to.destroy());
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(target, '127.0.0.1');
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => server.close(),
      });
    }),
  );
}

const manager = createIdentityManager();
const seed = generateSeed();
const identity = await manager.fromSeed(seed);
const accountKey = await deriveAccountKey(seed);
const device = (url: string): Promise<P2PNode> =>
  createNode({
    signer: createLocalRootSigner(identity, manager.getProvider()),
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: { hosts: [url] },
  });
const someone = async () => (await manager.fromSeed(generateSeed())).did;

const data = await mkdtemp(path.join(os.tmpdir(), 'minca-restore-'));
const host = startHost(data);
// Everyone reaches the host through the link, so the address the account keeps for it is the link's.
const link = await slowLink(PORT);
const url = `http://127.0.0.1:${link.port}`;
const nodes: P2PNode[] = [];
try {
  for (
    let i = 0;
    !(await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 120) throw new Error('The host did not start');
    await sleep(500);
  }

  // ─── A year of use, on the laptop ─────────────────────────────────
  const made = performance.now();
  const laptop = await device(url);
  nodes.push(laptop);
  const { id: big } = await laptop.spaces.create({ name: 'Community', ...community, visibility: 'private' });
  for (let n = 0; n < messages; n++)
    await laptop.records.put(big, 'note', {
      text: `Message ${n}: about a sentence of chat, as people write.`,
    });
  for (let r = 0; r < edits; r++) {
    const { key } = await laptop.records.put(big, 'doc', { text: 'draft 0' });
    for (let e = 1; e < 20; e++) await laptop.records.update(big, key, { text: `draft ${e}` });
  }
  const joined: string[] = [];
  for (let m = 0; m < members; m++) {
    const did = await someone();
    joined.push(did);
    await laptop.spaces.assign(big, did, 'member');
  }
  if (process.env.BENCH_REMOVE !== '0')
    for (const did of joined.slice(0, Math.floor(members / 3)))
      await laptop.spaces.unassign(big, did, 'member');
  for (let s = 0; s < spaces; s++) {
    const { id } = await laptop.spaces.create({ name: `Small ${s}`, visibility: 'private' });
    for (let n = 0; n < 20; n++) await laptop.records.put(id, 'note', { text: `Note ${n}` });
  }
  console.log(
    `made: ${messages} messages, ${edits} records edited 20 times, ${members} members (a third removed), ` +
      `${spaces} more spaces, in ${seconds(made)}`,
  );
  await laptop.hosting.use(url);
  const wanted = await laptop.records.list(big, { limit: 1_000_000 });
  const total = wanted.length;
  // Until the host holds everything the laptop wrote, in every space.
  for (const one of await laptop.spaces.list()) {
    const by = await laptop.spaces.kept(one.id, 600_000, 0);
    if (by !== 'keepers') throw new Error(`The host never took ${one.name}: ${by}`);
  }
  console.log(`the host holds it all, ${seconds(made)} after starting`);
  await sleep(Number(process.env.BENCH_SETTLE_MS ?? 15000));
  await laptop.close();
  nodes.length = 0;

  // ─── The new device ───────────────────────────────────────────────
  slow = true;
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const phone = await createNode({
    signer: createLocalRootSigner(identity, manager.getProvider()),
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: { hosts: [url] },
  });
  nodes.push(phone);
  let listed = false;
  let shown = 0;
  for (;;) {
    const list = await phone.spaces.list().catch(() => []);
    if (!listed && list.length >= spaces + 1) {
      listed = true;
      console.log(`  ${seconds(started)}: lists all ${list.length} spaces`);
    }
    const held = list.some((one) => one.id === big)
      ? (await phone.records.list(big, { limit: 1_000_000 }).catch(() => [])).length
      : 0;
    if (performance.now() - shown > 5000) {
      shown = performance.now();
      const status = list.some((one) => one.id === big)
        ? await phone.spaces.status(big).catch(String)
        : 'not listed';
      console.log(
        `  ${seconds(started)}: holds ${held} of ${total} records of the community; ${list.length} spaces;`,
        JSON.stringify(status).slice(0, 240),
      );
    }
    if (
      process.env.BENCH_DEBUG &&
      listed &&
      performance.now() - started > 8000 &&
      performance.now() - started < 8300
    )
      for (const one of list) {
        const status = await phone.spaces.status(one.id).catch(String);
        const count = (await phone.records.list(one.id, { limit: 100000 }).catch(() => [])).length;
        console.log('   ', one.name, count, JSON.stringify(status).slice(0, 160));
      }
    if (held >= total) break;
    if (performance.now() - started > 900_000) throw new Error(`Gave up at ${held} of ${total}`);
    await sleep(250);
  }
  const wall = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuBefore);
  const { profile } = await session.post('Profiler.stop');
  console.log(
    `restored in ${wall.toFixed(1)} s, latency ${LATENCY_MS} ms each way, ${MBPS || '∞'} Mbit/s; ` +
      `CPU ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s`,
  );

  // Where the CPU went, by function, itself
  const self = new Map<string, number>();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples?.length ?? 1) / 1000;
  for (const sample of profile.samples ?? []) {
    const frame = byId.get(sample)?.callFrame;
    if (!frame || frame.functionName === '(idle)' || frame.functionName === '(program)') continue;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').slice(-2).join('/')}:${frame.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + interval);
  }
  for (const [name, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.log(`${(ms / 1000).toFixed(2).padStart(8)} s  ${name}`);
  link.close();
} finally {
  await Promise.all(nodes.map((node) => node.close().catch(() => {})));
  host.kill('SIGTERM');
  await rm(data, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(0);
