/**
 * A host's stores in SQLite: a host that kept them as folders has every one
 * moved in, as it was, the first time it starts; stopped halfway, it moves
 * them again and ends the same; and a carried space is measured in SQL.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { directoryStores } from '../../core/src/node/stores.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../core/src/identity/did.js';
import { createSigner } from '../../core/src/schema/signer.js';
import { createVersion } from '../../core/src/schema/version.js';
import type { StorageAdapter, Version } from '../../core/src/types.js';
import { openFsDirectory } from '../src/fs-directory.js';
import { hostStores, spaceSize } from '../src/host-setup.js';

const bytes = (text: string) => new TextEncoder().encode(text);

async function versions(n: number): Promise<Version[]> {
  const provider = createP256Provider();
  const pair = await provider.generateKeyPair();
  const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const signer = createSigner(provider);
  const made: Version[] = [];
  for (let i = 0; i < n; i++)
    made.push(await signer.sign(createVersion({ author, collection: 'note', body: { i } }), pair.privateKey));
  return made;
}

/** Every entry and version of a store, to compare two copies by */
async function contents(store: StorageAdapter, ids: ReadonlyArray<string>) {
  const entries = new Map<string, string>();
  for (const key of await store.list(''))
    entries.set(key, Buffer.from((await store.get(key))!).toString('hex'));
  return { entries, versions: await Promise.all(ids.map((id) => store.getVersion(id))) };
}

/** A host's data folder as it was kept before SQLite, with a few stores in it */
async function oldHost(data: string) {
  const folder = directoryStores(await openFsDirectory(path.join(data, 'store')));
  const made = await versions(3);
  const space = await folder('spaces/bspace1');
  for (const version of made) await space.putVersion(version);
  await space.put('r/key', bytes(made[0]!.id));
  await space.put('f/abc/0', new Uint8Array(300_000).fill(7));
  // Writer keys' places must come along as they were: one gone back would sign twice at a place.
  const writers = await folder('writers');
  await writers.put('place:key1', bytes('41'));
  const mirror = await folder('mirrors/bspace1/0');
  await mirror.put('writer', bytes('0123456789abcdef0123456789abcdef'));
  const odd = await folder('host/Ünïcode:path');
  await odd.put('subscription:1', bytes('{}'));
  const stores = {
    'spaces/bspace1': await contents(
      space,
      made.map((version) => version.id),
    ),
    writers: await contents(writers, []),
    'mirrors/bspace1/0': await contents(mirror, []),
    'host/Ünïcode:path': await contents(odd, []),
  };
  for (const store of [space, writers, mirror, odd]) await store.close();
  return { made, stores };
}

describe('a host on SQLite', () => {
  test('moves a host kept in folders into its database, as it was, and puts the folder aside', async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), 'minca-host-store-'));
    try {
      const { made, stores: before } = await oldHost(data);
      const stores = await hostStores(data);
      for (const [storePath, held] of Object.entries(before)) {
        const ids = storePath === 'spaces/bspace1' ? made.map((version) => version.id) : [];
        assert.deepEqual(await contents(await stores(storePath), ids), held, storePath);
      }
      assert.equal(existsSync(path.join(data, 'store')), false);
      assert.equal(existsSync(path.join(data, 'store.imported')), true);
      assert.ok((await spaceSize(stores)('bspace1')) > 300_000);
      assert.equal(await spaceSize(stores)('../etc'), 0);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  test('stopped halfway, it moves them again and ends the same', async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), 'minca-host-store-'));
    try {
      const { made, stores: before } = await oldHost(data);
      // As if a first start had copied part of a store into the database it builds, then stopped.
      const { DatabaseSync } = await import('node:sqlite');
      const { sqliteStores } = await import('../../core/src/storage/sqlite-adapter.js');
      const db = new DatabaseSync(path.join(data, 'host.sqlite.importing'));
      const partial = await sqliteStores(db)('spaces/bspace1');
      await partial.putVersion(made[1]!);
      await partial.put('r/stale', bytes('from a start that stopped'));
      db.close();

      const stores = await hostStores(data);
      const ids = made.map((version) => version.id);
      assert.deepEqual(await contents(await stores('spaces/bspace1'), ids), before['spaces/bspace1']);
      assert.deepEqual(await contents(await stores('writers'), []), before.writers);
      assert.equal(existsSync(path.join(data, 'host.sqlite.importing')), false);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  test('a folder written beside the database is never moved in over it', async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), 'minca-host-store-'));
    try {
      await oldHost(data);
      const stores = await hostStores(data);
      await (await stores('host')).put('subscription:1', bytes('{"v":2}'));
      // An older release run again finds no folder, makes one and writes what it knows.
      const older = directoryStores(await openFsDirectory(path.join(data, 'store')));
      await (await older('host')).put('subscription:1', bytes('{"v":1}'));

      await assert.rejects(hostStores(data), /are both here/);
      const { DatabaseSync } = await import('node:sqlite');
      const { sqliteStores } = await import('../../core/src/storage/sqlite-adapter.js');
      const db = new DatabaseSync(path.join(data, 'host.sqlite'));
      const kept = await (await sqliteStores(db)('host')).get('subscription:1');
      db.close();
      assert.equal(new TextDecoder().decode(kept!), '{"v":2}');
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  test('a new host starts with an empty database and nothing to move', async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), 'minca-host-store-'));
    try {
      const stores = await hostStores(data);
      assert.deepEqual(stores.paths(), []);
      assert.equal(existsSync(path.join(data, 'store.imported')), false);
      assert.equal(await spaceSize(stores)('bnone'), 0);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
