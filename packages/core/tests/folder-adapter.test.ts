/**
 * Data folders: the directory adapter the registry is kept in, the directory
 * blob store a space's segments are kept in, and the property the design
 * rests on — apps and devices sharing one folder converge without
 * coordinating, through a few files per space rather than several per version.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import {
  createFolderAdapter,
  resolvePath,
  writeFolderFile,
  type FolderAdapter,
} from '../src/storage/folder-adapter.js';
import { reconcileFolder } from '../src/storage/folder-reconcile.js';
import { createDirectoryBlobStore } from '../src/storage/blob/directory.js';
import { createMirror, type Taken } from '../src/storage/mirror.js';
import { folderStores, type StoreFactory } from '../src/node/stores.js';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { team } from '../src/space/presets.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { memoryStores } from './helpers/memory-stores.js';
import { until } from './helpers/until.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import type { Version } from '../src/types.js';
import { packSegment } from '../src/storage/segment.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const COLLECTION = 'app.test.note';

/** A signed version, so the fixtures look like the real thing. */
async function makeVersion(text: string, space?: string, collection = COLLECTION): Promise<Version> {
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const unsigned = createVersion({ author: did, collection, body: { text }, ...(space ? { space } : {}) });
  return await signer.sign(unsigned, keys.privateKey);
}

describe('folder adapter — key/value storage', () => {
  test('round-trips values through files', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('hello', utf8Encode('world'));

    assert.equal(utf8Decode((await adapter.get('hello'))!), 'world');
    assert.equal(await adapter.get('missing'), null);
  });

  test('survives keys that are not filename-safe', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    // The shapes the space manager and the store actually use.
    const keys = ['space:bafy123', 'spacekey:bafy123', '__mst_root', 'a/b/c', 'w i t h  s p a c e'];
    for (const key of keys) await adapter.put(key, utf8Encode(key));

    for (const key of keys) {
      assert.equal(utf8Decode((await adapter.get(key))!), key, `key ${key} did not round-trip`);
    }
    assert.deepEqual((await adapter.list()).sort(), [...keys].sort());
  });

  test('keeps keys apart that a case-insensitive filesystem would merge', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('Key', utf8Encode('upper'));
    await adapter.put('key', utf8Encode('lower'));

    assert.equal(utf8Decode((await adapter.get('Key'))!), 'upper');
    assert.equal(utf8Decode((await adapter.get('key'))!), 'lower');
    // On macOS or Windows these must not be one file.
    assert.equal(folder.paths().filter((path) => path.includes('/kv/')).length, 2);
  });

  test('lists by prefix, and deletes', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('space:one', utf8Encode('1'));
    await adapter.put('space:two', utf8Encode('2'));
    await adapter.put('other', utf8Encode('3'));

    assert.deepEqual((await adapter.list('space:')).sort(), ['space:one', 'space:two']);

    await adapter.delete('space:one');
    assert.equal(await adapter.get('space:one'), null);
    assert.deepEqual(await adapter.list('space:'), ['space:two']);
  });

  test('applies a batch', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    await adapter.put('gone', utf8Encode('x'));
    await adapter.batch([
      { type: 'put', key: 'kept', value: utf8Encode('y') },
      { type: 'delete', key: 'gone' },
    ]);

    assert.equal(utf8Decode((await adapter.get('kept'))!), 'y');
    assert.equal(await adapter.get('gone'), null);
  });
});

describe('folder adapter — versions', () => {
  test('stores each version as its own file', async () => {
    const folder = createMemoryDirectory();
    const adapter = await createFolderAdapter(folder.handle, 'notes');

    const first = await makeVersion('one');
    const second = await makeVersion('two');
    await adapter.putVersion(first);
    await adapter.putVersion(second);

    assert.deepEqual([...(await adapter.listVersionIds())].sort(), [first.id, second.id].sort());
    assert.deepEqual(await adapter.getVersion(first.id), first);
    assert.equal(await adapter.getVersion('nope'), null);

    // One file per record, named after its own hash — that is what lets two
    // copies of the folder merge by union.
    const files = folder.paths().filter((path) => path.includes('/versions/'));
    assert.equal(files.length, 2);
    assert.ok(files.some((path) => path.endsWith(`${first.id}.json`)));
  });

  test('reopening a folder finds what was written before', async () => {
    const folder = createMemoryDirectory();
    const first = await createFolderAdapter(folder.handle, 'notes');
    const version = await makeVersion('durable');
    await first.putVersion(version);
    await first.close();

    const reopened = await createFolderAdapter(folder.handle, 'notes');
    assert.deepEqual(await reopened.getVersion(version.id), version);
  });
});

describe('two origins, one folder', () => {
  /** Opens an independent view of a folder — a second deployment of the app. */
  async function openOrigin(
    handle: ReturnType<typeof createMemoryDirectory>['handle'],
  ): Promise<{ adapter: FolderAdapter; storage: StorageProvider }> {
    const adapter = await createFolderAdapter(handle, 'spaces/demo');
    return { adapter, storage: createStorageProvider(adapter) };
  }

  test('a key another writer creates after a miss is found by listing', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    // B asks first and finds nothing — and remembers that.
    assert.equal(await b.adapter.get('space:new'), null);
    await a.adapter.put('space:new', new Uint8Array([1, 2, 3]));

    // Listing is how a writer's additions are discovered; the stale miss must not hide them.
    assert.deepEqual(await b.adapter.list('space:'), ['space:new']);
    assert.deepEqual(await b.adapter.get('space:new'), new Uint8Array([1, 2, 3]));
  });

  test('what one origin writes, the other sees — and reconciling reports it', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    const version = await makeVersion('written on A');
    await a.storage.addVersion(version);

    // Reconciling notices the file A added. (Both read the same root pointer
    // from disk, so B's lists already include it; reconciling is what repairs
    // a tree whose pointer write was lost.)
    const result = await reconcileFolder(b.storage, b.adapter);
    assert.deepEqual(result.added, [version.id]);
    assert.equal(result.changed, true);

    const seen = await b.storage.queryVersions(COLLECTION);
    assert.deepEqual(
      seen.map((item) => item.id),
      [version.id],
    );
  });

  test('a delete on one origin propagates to the other', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    const version = await makeVersion('short-lived');
    await a.storage.addVersion(version);
    await reconcileFolder(b.storage, b.adapter);
    assert.equal((await b.storage.queryVersions(COLLECTION)).length, 1);

    await a.storage.removeVersion(version.id);
    await reconcileFolder(b.storage, b.adapter);

    assert.equal((await b.storage.queryVersions(COLLECTION)).length, 0);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  test('a tree that still indexes a vanished file is repaired from the files', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());

    const version = await makeVersion('deleted behind our back');
    await a.storage.addVersion(version);

    // Delete the file without going through the provider — another device did
    // it while this one was closed, so the root pointer still indexes it. This
    // is the case the shared root pointer cannot cover, and the reason
    // reconciling reads the directory rather than trusting the pointer.
    const store = await (await folder.open().getDirectoryHandle('spaces')).getDirectoryHandle('demo');
    const versions = await store.getDirectoryHandle('versions');
    await versions.removeEntry(`${version.id}.json`);

    const result = await reconcileFolder(a.storage, a.adapter);

    assert.deepEqual(result.removed, [version.id]);
    assert.deepEqual(result.repaired, [version.id], 'the entries should have been fixed');
    assert.equal((await a.storage.queryVersions(COLLECTION)).length, 0);
  });

  test('concurrent writes converge on the union, with the same fingerprint', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    const b = await openOrigin(folder.open());

    // Neither knows about the other: interleaved writes, no coordination, and
    // both write the same folder's entries on the way.
    const fromA = await makeVersion('from A');
    const fromB = await makeVersion('from B');
    await a.storage.addVersion(fromA);
    await b.storage.addVersion(fromB);

    await reconcileFolder(a.storage, a.adapter);
    await reconcileFolder(b.storage, b.adapter);
    // A second pass on A: B's reconcile may have written entries after A had
    // already finished looking.
    await reconcileFolder(a.storage, a.adapter);

    const idsFrom = async (origin: { storage: StorageProvider }) =>
      (await origin.storage.queryVersions(COLLECTION)).map((item) => item.id).sort();

    assert.deepEqual(await idsFrom(a), [fromA.id, fromB.id].sort());
    assert.deepEqual(await idsFrom(b), [fromA.id, fromB.id].sort());

    // Same files means the same versions kept, which is the whole point of
    // deriving the entries from the files rather than trying to merge them.
    assert.equal(await a.storage.fingerprint(), await b.storage.fingerprint());
  });

  test('reconciling with nothing new reports no change', async () => {
    const folder = createMemoryDirectory();
    const a = await openOrigin(folder.open());
    await a.storage.addVersion(await makeVersion('settled'));

    const result = await reconcileFolder(a.storage, a.adapter);
    assert.equal(result.changed, false);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.repaired, []);
  });
});

describe('directory blob store', () => {
  test('round-trips, says null for what is absent, and deletes twice without complaint', async () => {
    const store = createDirectoryBlobStore(createMemoryDirectory().handle, 'a/b');
    await store.put('space/writer/000001-x.seg', utf8Encode('one'));

    assert.equal(utf8Decode((await store.get('space/writer/000001-x.seg'))!), 'one');
    assert.equal(await store.get('space/writer/missing.seg'), null);
    assert.equal(await store.get('nowhere/at/all'), null);
    await store.delete('space/writer/000001-x.seg');
    await store.delete('space/writer/000001-x.seg');
    assert.equal(await store.get('space/writer/000001-x.seg'), null);
  });

  test('lists every key under a prefix, however deep, and keeps names a disk would merge apart', async () => {
    const folder = createMemoryDirectory();
    const store = createDirectoryBlobStore(folder.handle, 'base');
    const keys = ['s1/w1/a.seg', 's1/w1/b.seg', 's1/w2/a.seg', 's2/w1/a.seg', 's1/W1/a.seg', 's1/ü/x y'];
    for (const key of keys) await store.put(key, utf8Encode(key));

    assert.deepEqual((await store.list('s1/')).sort(), keys.filter((key) => key.startsWith('s1/')).sort());
    assert.deepEqual(await store.list('s1/w2/'), ['s1/w2/a.seg']);
    assert.deepEqual(await store.list('s3/'), []);
    // Encoded as a data folder names files: every key stays inside `base`.
    assert.ok(folder.paths().every((path) => path.startsWith('base/')));
    assert.ok(folder.paths().includes('base/s1/%571/a.seg'));
  });
});

describe('a data folder', () => {
  const BASE = 'accounts/a/stores';
  const SPACE = 'demo';

  /** One app or device on the folder: its own local stores, the folder's segments shared */
  async function origin(
    handle: ReturnType<typeof createMemoryDirectory>['handle'],
    refuse = (_: Version) => false,
  ) {
    const stores: StoreFactory = folderStores(handle, { basePath: BASE, local: memoryStores() });
    const storage: StorageProvider = createStorageProvider(await stores(`spaces/${SPACE}`));
    const accept = async (version: Version): Promise<Taken> => {
      if (refuse(version)) return 'refused';
      await storage.addVersion(version);
      return 'stored';
    };
    const mirror = await createMirror({
      store: stores.folder!,
      space: SPACE,
      storage,
      accept,
      state: await stores(`folder/${SPACE}`),
      flushMs: 5,
    });
    return { stores, storage, mirror };
  }

  const ids = async (storage: StorageProvider) =>
    (await storage.queryVersions(COLLECTION)).map((item) => item.id).sort();

  test('keeps a space as a few segments, not a file per version and per entry', async () => {
    const folder = createMemoryDirectory();
    const a = await origin(folder.open());
    for (let i = 0; i < 200; i++) await a.storage.addVersion(await makeVersion(`note ${i}`));
    await a.mirror.flush();

    const inFolder = folder.paths();
    const segments = inFolder.filter((path) => path.startsWith(`${BASE}/spaces/${SPACE}/`));
    assert.ok(segments.length >= 1 && segments.length <= 2, `${segments.length} files for 200 versions`);
    assert.ok(segments.every((path) => path.endsWith('.seg')));
    // The entries saying which version is current are this device's own.
    assert.ok(inFolder.every((path) => !path.includes('/kv/r%2F') && !path.includes('/kv/i%2F')));
  });

  test('two apps on one folder converge on the union, with the same fingerprint', async () => {
    const folder = createMemoryDirectory();
    const a = await origin(folder.open());
    const b = await origin(folder.open());

    const fromA = await makeVersion('from A');
    const fromB = await makeVersion('from B');
    await a.storage.addVersion(fromA);
    await b.storage.addVersion(fromB);
    await a.mirror.flush();
    await b.mirror.flush();
    await a.mirror.pull();
    await b.mirror.pull();

    assert.deepEqual(await ids(a.storage), [fromA.id, fromB.id].sort());
    assert.deepEqual(await ids(b.storage), [fromA.id, fromB.id].sort());
    assert.equal(await a.storage.fingerprint(), await b.storage.fingerprint());
    // Each wrote under its own store writer, so nothing was written twice or over.
    const writers = new Set(
      folder
        .paths()
        .filter((path) => path.startsWith(`${BASE}/spaces/${SPACE}/`))
        .map((path) => path.split('/')[5]),
    );
    assert.equal(writers.size, 2);
  });

  test('deleting segments from the folder takes nothing from an app that read them', async () => {
    const folder = createMemoryDirectory();
    const a = await origin(folder.open());
    const b = await origin(folder.open());
    const version = await makeVersion('kept');
    await a.storage.addVersion(version);
    await a.mirror.flush();
    await b.mirror.pull();

    const spaces = createDirectoryBlobStore(folder.open(), `${BASE}/spaces`);
    for (const key of await spaces.list(`${SPACE}/`)) await spaces.delete(key);
    await b.mirror.pull();

    assert.deepEqual(await ids(b.storage), [version.id]);
  });

  test('a version the gates refuse is not taken from the folder', async () => {
    const folder = createMemoryDirectory();
    const planted = await makeVersion('planted');
    const a = await origin(folder.open());
    await a.storage.addVersion(planted);
    await a.mirror.flush();

    const b = await origin(folder.open(), (version) => version.id === planted.id);
    await b.mirror.pull();
    assert.deepEqual(await ids(b.storage), []);
  });

  test('no store but a space is ever read from the folder: a planted writer id or line place is not taken', async () => {
    const folder = createMemoryDirectory();
    // An honest app's store writer id, as anyone reading the folder sees it.
    const a = await origin(folder.open());
    await a.storage.addVersion(await makeVersion('from A'));
    await a.mirror.flush();
    const honest = folder
      .paths()
      .find((path) => path.endsWith('.seg'))!
      .split('/')[5]!;
    // Planted in the former layout, for the next app to open the space to take as its own.
    const planted = await createFolderAdapter(folder.open(), `${BASE}/folder/${SPACE}`);
    await planted.put('mirror:writer', utf8Encode(honest));
    const lines = await createFolderAdapter(folder.open(), `${BASE}/writers`);
    await lines.put('lines/did:key:z/space', utf8Encode('{"collections":{"x":{"n":0,"id":"old"}}}'));

    const b = await origin(folder.open());
    assert.deepEqual(await (await b.stores('writers')).list(''), []);
    await b.mirror.pull();
    assert.equal(
      (await ids(b.storage)).length,
      1,
      'it reads the honest app’s segments, not skipping them as its own',
    );
    await b.storage.addVersion(await makeVersion('from B'));
    await b.mirror.flush();
    await a.mirror.pull();
    assert.equal((await ids(a.storage)).length, 2);
  });

  test('a name no key could make, planted in the folder, stops no pull', async () => {
    const folder = createMemoryDirectory();
    const a = await origin(folder.open());
    const b = await origin(folder.open());
    // A directory that sorts first, holding a file whose name decodes to a key with an empty part.
    const planted = await resolvePath(folder.open(), [...BASE.split('/'), 'spaces', SPACE, '0']);
    await writeFolderFile(planted, '%2Fx.seg', new Uint8Array([1]));

    const honest = await makeVersion('written after');
    await a.storage.addVersion(honest);
    await a.mirror.flush();
    await b.mirror.pull();
    assert.deepEqual(await ids(b.storage), [honest.id]);
  });

  test('outside a browser, a data folder needs a place for this device’s own stores', () => {
    assert.throws(() => folderStores(createMemoryDirectory().handle, { basePath: BASE }), /needs `local`/);
  });

  test('the registry stays in the folder, sealed, where every app and device reads it', async () => {
    const folder = createMemoryDirectory();
    const localKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const stores = folderStores(folder.open(), { basePath: BASE, local: memoryStores(), localKey });
    await (await stores('registry', { seal: true })).put('space:abc', utf8Encode('{"secret":true}'));

    const file = folder.paths().find((path) => path.startsWith(`${BASE}/registry/kv/`));
    assert.ok(file);
    const raw = await createFolderAdapter(folder.open(), `${BASE}/registry`);
    assert.ok(!utf8Decode((await raw.get('space:abc'))!).includes('secret'));
  });
});

describe('two nodes of one account on one folder', () => {
  async function rootSigner(seed: Uint8Array) {
    const manager = createIdentityManager();
    const identity = await manager.fromSeed(seed);
    return createLocalRootSigner(identity, manager.getProvider());
  }

  test('meet with no network at all, and take nothing from it a member did not write', async () => {
    const folder = createMemoryDirectory();
    const seed = generateSeed();
    const stores = () =>
      folderStores(folder.open(), { basePath: 'accounts/a/stores', local: memoryStores() });

    const first = await createNode({ signer: await rootSigner(seed), stores: stores(), watchIntervalMs: 20 });
    const space = await first.spaces.create({ name: 'Notes', ...team, visibility: 'public' });
    await first.records.put(space.id, COLLECTION, { text: 'from the laptop' });
    const second = await createNode({
      signer: await rootSigner(seed),
      stores: stores(),
      watchIntervalMs: 20,
    });
    try {
      await until(
        async () => (await second.records.list(space.id).catch(() => [])).length === 1,
        5000,
        'the second to read the first one’s note from the folder',
      );

      // A stranger's version, left in the folder as a segment of its own.
      const stranger = await makeVersion('let me in', space.id);
      const spaces = createDirectoryBlobStore(folder.open(), 'accounts/a/stores/spaces');
      await spaces.put(`${space.id}/${'f'.repeat(32)}/000001-0000000000000000.seg`, packSegment([stranger]));
      await second.records.put(space.id, COLLECTION, { text: 'from the phone' });
      await until(
        async () => (await first.records.list(space.id)).length === 2,
        5000,
        'the first to read the second one’s note',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const texts = (await first.records.list(space.id)).map((record) => record.body);
      assert.deepEqual(texts.map((body) => JSON.stringify(body)).sort(), [
        '{"text":"from the laptop"}',
        '{"text":"from the phone"}',
      ]);
    } finally {
      await second.close();
      await first.close();
    }
  });
});
