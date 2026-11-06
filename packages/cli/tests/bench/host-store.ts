/**
 * What a host's stores cost: directory stores (a file per entry and version)
 * against SQLite, for many spaces at once.
 *
 *   node --expose-gc --conditions=@minca/source --import tsx tests/bench/host-store.ts [spaces] [versions] [bytes]
 *
 * Defaults: 30 spaces of 500 versions, bodies of about 1,500 bytes: the
 * production host's 15,000 versions. For each kind of store: the time to open
 * every space as a host does (its store, and what sync compares), the heap it
 * keeps after; then every version read once, as a peer catching up from
 * nothing would make it, and the heap kept after that.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createStorageProvider, type StorageProvider } from '../../../core/src/storage/storage-provider.js';
import { directoryStores, type StoreFactory } from '../../../core/src/node/stores.js';
import { sqliteStores } from '../../../core/src/storage/sqlite-adapter.js';
import { createP256Provider } from '../../../core/src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../../core/src/identity/did.js';
import { createSigner } from '../../../core/src/schema/signer.js';
import { createVersion } from '../../../core/src/schema/version.js';
import type { Version } from '../../../core/src/types.js';
import { openFsDirectory } from '../../src/fs-directory.js';

const [spaces = 30, perSpace = 500, size = 1500] = process.argv.slice(2).map(Number);
const gc = globalThis.gc;
if (!gc) throw new Error('Run with --expose-gc');
const heap = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const provider = createP256Provider();
const pair = await provider.generateKeyPair();
const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
const signer = createSigner(provider);
const filler = 'x'.repeat(size);
const made: Version[][] = [];
for (let s = 0; s < spaces; s++) {
  const versions: Version[] = [];
  for (let i = 0; i < perSpace; i++)
    versions.push(
      await signer.sign(
        createVersion({
          author,
          collection: i % 5 === 0 ? 'app.file' : 'app.note',
          body: { i, text: filler },
        }),
        pair.privateKey,
      ),
    );
  made.push(versions);
}
const ids = made.map((versions) => versions.map((version) => version.id));
console.log(`${spaces} spaces × ${perSpace} versions of ~${size} bytes`);

async function run(name: string, stores: () => Promise<StoreFactory>): Promise<void> {
  // Written by one node, then opened afresh by another: a host restarting.
  {
    const writing = await stores();
    for (let s = 0; s < spaces; s++) {
      const storage = createStorageProvider(await writing(`spaces/b${s}`), writing.cache);
      for (const version of made[s]!) await storage.addVersion(version);
      await storage.close();
    }
  }
  const factory = await stores();
  const before = heap();
  const t = performance.now();
  const open: StorageProvider[] = [];
  for (let s = 0; s < spaces; s++) {
    const storage = createStorageProvider(await factory(`spaces/b${s}`), factory.cache);
    for (const collection of (await storage.sums()).keys()) await storage.items(collection);
    open.push(storage);
  }
  const opened = performance.now() - t;
  const afterOpen = heap();
  const t2 = performance.now();
  for (let s = 0; s < spaces; s++) for (const id of ids[s]!) await open[s]!.getVersion(id);
  const served = performance.now() - t2;
  const afterServe = heap();
  console.log(
    `${name.padEnd(9)} open ${opened.toFixed(0).padStart(5)} ms, keeps ${mb(afterOpen - before).padStart(8)}; ` +
      `every version read in ${served.toFixed(0).padStart(5)} ms, keeps ${mb(afterServe - before).padStart(8)}`,
  );
  await Promise.all(open.map((storage) => storage.close()));
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'minca-host-store-'));
try {
  await run('directory', async () => directoryStores(await openFsDirectory(path.join(dir, 'store'))));
  const db = new DatabaseSync(path.join(dir, 'host.sqlite'));
  await run('sqlite', async () => sqliteStores(db));
  db.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
