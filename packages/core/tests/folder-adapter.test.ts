/**
 * Data folders: the directory adapter the registry is kept in, the directory
 * blob store a space's segments are kept in, and the property the design
 * rests on — apps and devices sharing one folder converge without
 * coordinating, through a few files per space rather than several per version.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import { createFolderAdapter } from '../src/storage/folder-adapter.js';
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
  test('stores each version as its own file, and reads it back after reopening', async () => {
    const folder = createMemoryDirectory();
    const first = await createFolderAdapter(folder.handle, 'notes');
    const version = await makeVersion('durable');
    await first.putVersion(version);
    await first.close();

    assert.ok(folder.paths().includes(`notes/versions/${version.id}.json`));
    const reopened = await createFolderAdapter(folder.handle, 'notes');
    assert.deepEqual(await reopened.getVersion(version.id), version);
    assert.equal(await reopened.getVersion('nope'), null);
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

  test('a writer’s directory goes with its last segment', async () => {
    const folder = createMemoryDirectory();
    const store = createDirectoryBlobStore(folder.handle, 'base');
    await store.put('s/w/a.seg', utf8Encode('a'));
    await store.delete('s/w/a.seg');
    assert.deepEqual(await store.list(''), []);
    const left: string[] = [];
    for await (const name of (await folder.handle.getDirectoryHandle('base')).keys()) left.push(name);
    assert.deepEqual(left, [], 'the empty space and writer directories are gone');
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

  test('a version left in the folder is judged before it is taken', async () => {
    const folder = createMemoryDirectory();
    const planted = await makeVersion('planted');
    const a = await origin(folder.open());
    await a.storage.addVersion(planted);
    await a.mirror.flush();

    const b = await origin(folder.open(), (version) => version.id === planted.id);
    await b.mirror.pull();
    assert.deepEqual(await ids(b.storage), []);
  });

  test('a space in the former layout becomes a segment, judged like any other, and its files go', async () => {
    const folder = createMemoryDirectory();
    const kept = await makeVersion('from before');
    const planted = await makeVersion('planted before');
    // The former layout: a file per version, and entries another app wrote and nobody checked.
    const former = await createFolderAdapter(folder.open(), `${BASE}/spaces/${SPACE}`);
    const formerStorage = createStorageProvider(former);
    await formerStorage.addVersion(kept);
    await formerStorage.addVersion(planted);

    const b = await origin(folder.open(), (version) => version.id === planted.id);
    const paths = folder.paths().filter((path) => path.startsWith(`${BASE}/spaces/${SPACE}/`));
    assert.ok(paths.every((path) => !path.includes('/kv/') && !path.includes('/versions/')));
    assert.equal(paths.filter((path) => path.endsWith('.seg')).length, 1);
    // Nothing is taken on the former entries' word.
    assert.deepEqual(await ids(b.storage), []);

    await b.mirror.pull();
    assert.deepEqual(await ids(b.storage), [kept.id]);
  });

  test('another store in the former layout is copied to an empty local store, and left for others', async () => {
    const folder = createMemoryDirectory();
    const former = await createFolderAdapter(folder.open(), `${BASE}/writers`);
    await former.put('lines/did:key:z/space', utf8Encode('{"collections":{}}'));

    const stores = folderStores(folder.open(), { basePath: BASE, local: memoryStores() });
    const writers = await stores('writers');
    assert.equal(utf8Decode((await writers.get('lines/did:key:z/space'))!), '{"collections":{}}');
    assert.ok(folder.paths().includes(`${BASE}/writers/kv/lines%2Fdid%3Akey%3Az%2Fspace`));
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
