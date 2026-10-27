/**
 * Files (spec 05 §16.6): how a file is named and checked, how it is sealed,
 * and how it travels between peers and is kept with the body that names it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK,
  chunkCount,
  chunkFits,
  chunkListOf,
  fileIdOf,
  fileRefsIn,
  filesOf,
  listFits,
} from '../src/files/file-id.js';
import { fileOpener, openFile, sealFile } from '../src/files/seal.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  utf8Decode,
  utf8Encode,
} from '../src/utils/encoding.js';
import { sha256 } from '../src/utils/hash.js';
import { createNode } from '../src/node/node.js';
import type { FileRef, P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { team } from '../src/space/presets.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { until } from './helpers/until.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import type { StorageAdapter } from '../src/types.js';
import type { SyncMessageBody } from '../src/sync/sync-messages.js';
import { createStorageProvider, type StorageProvider } from '../src/storage/storage-provider.js';
import { createMemoryBlobStore } from '../src/storage/blob/memory.js';
import { deleteMirrored } from '../src/storage/mirror.js';
import {
  createSpaceFiles,
  type SealedFile,
  type SpaceFiles,
  type SpaceFilesConfig,
} from '../src/files/space-files.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { nextVersion } from '../src/records/version.js';

const provider = createP256Provider();
const signer = createSigner(provider);

const bytesOf = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
};

describe('a file’s id and chunk list', () => {
  test('the example in the spec: 300000 bytes are two chunks', async () => {
    const bytes = bytesOf(300_000);
    const list = await chunkListOf(bytes);
    assert.equal(chunkCount(300_000), 2);
    assert.equal(list.length, 64);
    const id = await fileIdOf(300_000, list);
    const length = new Uint8Array([0, 0, 0, 0, 0, 0x04, 0x93, 0xe0]);
    assert.equal(id, Buffer.from(await sha256(concatBytes(length, list))).toString('hex'));
    const file = { hash: id, size: 300_000 };
    assert.equal(await listFits(file, list), true);
    assert.equal(await chunkFits(file, list, 0, bytes.subarray(0, CHUNK)), true);
    assert.equal(await chunkFits(file, list, 1, bytes.subarray(CHUNK)), true);
  });

  test('a list of the wrong length, or naming another size, is refused, and so is a chunk not its own', async () => {
    const bytes = bytesOf(3 * CHUNK);
    const list = await chunkListOf(bytes);
    const file = { hash: await fileIdOf(bytes.length, list), size: bytes.length };
    // One hash short, or a list that gives the id for another size.
    assert.equal(await listFits(file, list.subarray(0, 64)), false);
    assert.equal(await listFits({ hash: file.hash, size: 2 * CHUNK }, list), false);
    assert.equal(await chunkFits(file, list, 0, bytes.subarray(CHUNK, 2 * CHUNK)), false);
    assert.equal(await chunkFits(file, list, 0, bytes.subarray(0, CHUNK - 1)), false);
    assert.equal(await chunkFits(file, list, 3, bytes.subarray(0, CHUNK)), false);
  });

  test('a file of one chunk is checked by its id alone', async () => {
    const bytes = bytesOf(1000);
    const file = { hash: await fileIdOf(1000, await chunkListOf(bytes)), size: 1000 };
    assert.equal(await chunkFits(file, null, 0, bytes), true);
    assert.equal(await chunkFits(file, null, 0, bytesOf(999)), false);
  });

  test('peers take the first 16 well-formed, distinct files, none on a delete, and ignore the rest', () => {
    const h = (n: number) => n.toString(16).padStart(64, '0');
    const files = [
      { hash: h(1), size: 10 },
      { hash: h(1), size: 20 },
      { hash: 'NOT-HEX', size: 10 },
      { hash: h(2), size: 0 },
      { hash: h(3), size: 2 ** 31 + 1 },
      'nonsense',
      { hash: h(4), size: 5, extra: true },
      ...Array.from({ length: 20 }, (_, i) => ({ hash: h(100 + i), size: 1 })),
    ];
    const taken = filesOf({ files });
    assert.equal(taken.length, 16);
    assert.deepEqual(taken[0], { hash: h(1), size: 10 });
    assert.deepEqual(taken[1], { hash: h(4), size: 5 });
    assert.deepEqual(filesOf({ files, deleted: true }), []);
    assert.deepEqual(filesOf({ files: 'nope' }), []);
  });

  test('a body names the file references in it, however deep', () => {
    const ref = { hash: 'a'.repeat(64), size: 9, key: 'k', salt: 's', mime: 'image/webp' };
    assert.deepEqual(fileRefsIn({ avatar: { blob: ref }, list: [ref, { hash: 'b'.repeat(64), size: 1 }] }), [
      { hash: 'a'.repeat(64), size: 9 },
    ]);
  });
});

describe('sealing a file (RFC 8188 records)', () => {
  test('the record of RFC 8188’s own example, §3.1', async () => {
    // "I am the walrus", rs 4096: the example's output is its 21-byte header, then this one record.
    const key = { key: 'yqdlZ-tYemfogSmv7Ws5PQ', salt: 'I1BsxtFttlv3u_Oo94xnmw' };
    const { bytes } = await sealFile(utf8Encode('I am the walrus'), 4096, key);
    const example = base64UrlDecode(
      'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg',
    );
    assert.equal(base64UrlEncode(bytes), base64UrlEncode(example.subarray(21)));
    assert.equal(utf8Decode(await openFile(bytes, key, 4096)), 'I am the walrus');
  });

  test('records line up with chunks, open one at a time, and can’t be swapped or cut short', async () => {
    const plain = bytesOf(2 * (CHUNK - 17) + 5);
    const { bytes, key } = await sealFile(plain);
    assert.equal(chunkCount(bytes.length), 3);
    assert.equal(bytes.length, plain.length + 3 * 17);
    const open = fileOpener(key);
    assert.deepEqual(
      await open(bytes.subarray(CHUNK, 2 * CHUNK), 1, false),
      plain.subarray(CHUNK - 17, 2 * (CHUNK - 17)),
    );
    await assert.rejects(open(bytes.subarray(0, CHUNK), 1, false));
    // The second record passed off as the last: its delimiter says otherwise.
    await assert.rejects(open(bytes.subarray(CHUNK, 2 * CHUNK), 1, true));
    assert.deepEqual(await openFile(bytes, key), plain);
  });

  test('an empty file is one record of 17 bytes, and every file gets a key of its own', async () => {
    const empty = await sealFile(new Uint8Array(0));
    assert.equal(empty.bytes.length, 17);
    assert.deepEqual(await openFile(empty.bytes, empty.key), new Uint8Array(0));
    const again = await sealFile(new Uint8Array(0));
    assert.notEqual(again.key.key, empty.key.key);
  });
});

describe('files between nodes', () => {
  const open: P2PNode[] = [];
  after(async () => {
    await Promise.all(open.splice(0).map((node) => node.close()));
  });

  async function pair() {
    const hub = createFakeHub({ latencyMs: 1 });
    const start = async (extra: Partial<Parameters<typeof createNode>[0]> = {}) => {
      const manager = createIdentityManager();
      const seed = generateSeed();
      const identity = await manager.fromSeed(seed);
      const node = await createNode({
        signer: createLocalRootSigner(identity, manager.getProvider()),
        accountKey: await deriveAccountKey(seed),
        stores: memoryStores(),
        watchIntervalMs: 0,
        network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
        ...extra,
      });
      open.push(node);
      return node;
    };
    const alice = await start();
    const bob = await start();
    const space = await alice.spaces.create({ name: 'Photos', visibility: 'private', ...team });
    await bob.spaces.join(await alice.spaces.invite(space.id, { role: 'editor' }));
    await joined(bob, space.id);
    return { alice, bob, space };
  }

  test('one node adds a file of several chunks; another reads it, checked, from it', async () => {
    const { alice, bob, space } = await pair();
    const photo = bytesOf(3 * CHUNK + 1234);
    const ref = await alice.records.addFile(space.id, photo, { mime: 'image/jpeg', name: 'cat.jpg' });
    const record = await alice.records.put(space.id, 'app.photo', { photo: ref });

    await until(
      async () => (await bob.records.get(space.id, record.key)) !== null,
      5000,
      'the record to arrive',
    );
    const got = await bob.records.get<{ photo: FileRef }>(space.id, record.key);
    assert.deepEqual(await bob.records.readFile(space.id, got!.body!.photo), photo);
  });

  test('a node fetches a named file before anyone reads it, and serves it when the writer is gone', async () => {
    const { alice, bob, space } = await pair();
    const ref = await alice.records.addFile(space.id, bytesOf(CHUNK + 10), { mime: 'video/mp4' });
    const record = await alice.records.put(space.id, 'app.clip', { clip: ref });
    await until(
      async () => (await bob.records.get(space.id, record.key)) !== null,
      5000,
      'the record to arrive',
    );
    // Read from the other node alone once it has had time to fetch: the writer has left.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await alice.close();
    assert.deepEqual(await bob.records.readFile(space.id, ref), bytesOf(CHUNK + 10));
  });

  test('a picture set on the account reaches the profile others see in a space, and opens there', async () => {
    const { alice, bob, space } = await pair();
    await alice.account.setName('Alice');
    const picture = bytesOf(5000);
    await alice.account.setAvatar({ bytes: picture, mime: 'image/webp' });
    await until(
      async () => !!(await bob.spaces.profiles(space.id)).find((p) => p.did === alice.did)?.avatar,
      8000,
      'the picture to reach the space',
    );
    const seen = (await bob.spaces.profiles(space.id)).find((p) => p.did === alice.did)!;
    assert.equal(seen.name, 'Alice');
    assert.deepEqual(await bob.records.readFile(space.id, seen.avatar!), picture);
    // Opening the space again makes no second copy.
    const before = seen.avatar!.hash;
    await alice.account.setName('Alice B');
    await until(
      async () => (await bob.spaces.profiles(space.id)).find((p) => p.did === alice.did)?.name === 'Alice B',
      8000,
      'the rename',
    );
    assert.equal(
      (await bob.spaces.profiles(space.id)).find((p) => p.did === alice.did)?.avatar?.hash,
      before,
    );
  });

  test('a picture whose bytes are away never holds back the name and contact key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const start = async (seed = generateSeed()) => {
      const manager = createIdentityManager();
      const node = await createNode({
        signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
        accountKey: await deriveAccountKey(seed),
        stores: memoryStores(),
        watchIntervalMs: 0,
        network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
      });
      open.push(node);
      return node;
    };
    const seed = generateSeed();
    const first = await start(seed);
    await first.account.setName('Alice');
    await first.account.setAvatar({ bytes: bytesOf(5000), mime: 'image/webp' });
    const second = await start(seed);
    await until(async () => (await second.account.profile())?.avatar !== undefined, 10000, 'the registry');
    // The only device with the picture's bytes goes away; the other joins a space.
    await first.close();
    const bob = await start();
    const space = await bob.spaces.create({ name: 'B', visibility: 'private', ...team });
    await second.spaces.join(await bob.spaces.invite(space.id, { role: 'editor' }));
    await joined(second, space.id);
    await until(
      async () => (await bob.spaces.profiles(space.id)).find((p) => p.did === second.did)?.name === 'Alice',
      8000,
      'the name, without the picture',
    );
  });

  test('a file nobody names is asked for by nobody, and served to nobody', async () => {
    const { alice, bob, space } = await pair();
    const ref = await alice.records.addFile(space.id, bytesOf(100), { mime: 'text/plain' });
    await assert.rejects(bob.records.readFile(space.id, ref), /No record here names that file/);
  });
});

describe('what a peer refuses', () => {
  /** Two services over one space's stores, wired so a test can see and change what passes between them */
  async function wired(
    tamper: (message: Record<string, unknown>) => Record<string, unknown> | null = (m) => m,
    options: { peers?: boolean } = {},
  ) {
    const make = () => {
      const adapter = createMemoryAdapter();
      return { adapter, storage: createStorageProvider(adapter) };
    };
    const a = make();
    const b = make();
    const mirror = createMemoryBlobStore();
    let files: { a: SpaceFiles; b: SpaceFiles } | null = null;
    // In order, one at a time, as the sync engine hands a peer's messages on.
    let queue: Promise<void> = Promise.resolve();
    const deliver = (to: 'a' | 'b', from: string, message: Record<string, unknown>) => {
      const changed = tamper(message);
      if (changed) queue = queue.then(() => files![to].onMessage(from, structuredClone(changed)));
    };
    const service = (side: typeof a, me: 'a' | 'b', other: 'a' | 'b', mirrors: boolean) =>
      createSpaceFiles({
        space: 'demo',
        adapter: side.adapter,
        storage: side.storage,
        send: (_peer, message) => deliver(other, me, { ...message }),
        peers: () => (options.peers === false ? [] : [other]),
        mirrors: () => (mirrors ? [{ store: mirror, writer: `writer-${me}` }] : []),
      });
    files = { a: service(a, 'a', 'b', true), b: service(b, 'b', 'a', true) };
    return { a, b, files, mirror };
  }

  /** A version naming a file, kept whole in a store */
  async function name(
    storage: StorageProvider,
    ref: SealedFile,
    text = 'a photo',
    keys?: Awaited<ReturnType<typeof provider.generateKeyPair>>,
  ) {
    keys ??= await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const version = await signer.sign(
      createVersion({ author: did, collection: 'app.photo', body: { text, photo: ref }, files: [ref] }),
      keys.privateKey,
    );
    await storage.addVersion(version);
    return version;
  }

  test('a chunk that is not the one its list names is dropped, and the file asked of no one else is not kept', async () => {
    const { a, b, files } = await wired((message) =>
      message.type === 'file' && message.chunk === 1
        ? {
            ...message,
            bytes: base64UrlEncode(new Uint8Array(base64UrlDecode(String(message.bytes)).length)),
          }
        : message,
    );
    const ref = await files.a.add(bytesOf(2 * CHUNK));
    await name(a.storage, ref);
    await name(b.storage, ref);
    await assert.rejects(files.b.read(ref), /No peer or mirror holds that file/);
    // Chunk 0 checked and kept; the forged chunk 1 never was.
    assert.ok(await b.adapter.get(`f/${ref.hash}/0`));
    assert.equal(await b.adapter.get(`f/${ref.hash}/1`), null);
  });

  test('a list of inner hashes, or of the wrong length, is refused', async () => {
    const { a, b, files } = await wired((message) =>
      message.type === 'file' && message.chunk === 'list'
        ? { ...message, bytes: base64UrlEncode(base64UrlDecode(String(message.bytes)).subarray(0, 32)) }
        : message,
    );
    const ref = await files.a.add(bytesOf(3 * CHUNK));
    await name(a.storage, ref);
    await name(b.storage, ref);
    await assert.rejects(files.b.read(ref));
    assert.equal(await b.adapter.get(`f/${ref.hash}/list`), null);
  });

  test('a peer serves no file that no version it keeps whole names', async () => {
    const { b, files } = await wired();
    const ref = await files.a.add(bytesOf(100));
    // The asker names it; the holder doesn't, so it says it has none.
    await name(b.storage, ref);
    await assert.rejects(files.b.read(ref), /No peer or mirror holds that file/);
  });

  test('a want for chunks no file can have is dropped at once, unanswered', async () => {
    const sent: unknown[] = [];
    const adapter = createMemoryAdapter();
    const files = createSpaceFiles({
      space: 'demo',
      adapter,
      storage: createStorageProvider(adapter),
      send: (_peer, message) => sent.push(message),
      peers: () => [],
    });
    const started = Date.now();
    for (const chunks of [
      [2 ** 53, 2 ** 53],
      [0, 64],
      [5, 4],
      [-1, 0],
      [8192, 8192],
      [0.5, 1],
    ])
      await files.onMessage('p', { type: 'want-file', id: 1, hash: 'a'.repeat(64), chunks });
    assert.ok(Date.now() - started < 500);
    assert.deepEqual(sent, []);
    // A well-formed ask for a file it doesn't hold is answered, as missing.
    await files.onMessage('p', { type: 'want-file', id: 2, hash: 'a'.repeat(64), chunks: [8190, 8191] });
    assert.deepEqual(sent, [{ type: 'file-done', id: 2, hash: 'a'.repeat(64), missing: [8190, 8191] }]);
  });

  test('bytes nobody asked for, or out of order, are not taken', async () => {
    const { b, files } = await wired();
    const ref = await files.a.add(bytesOf(100));
    await files.b.onMessage('a', { type: 'file', id: 99, hash: ref.hash, chunk: 0, at: 0, bytes: 'AAAA' });
    assert.equal(await b.adapter.get(`f/${ref.hash}/0`), null);
  });

  test('a file goes with the body that names it: superseded, it is dropped; one only added waits a day', async () => {
    const { a, files } = await wired();
    const ref = await files.a.add(bytesOf(500));
    const unnamed = await files.a.add(bytesOf(600));
    const version = await name(a.storage, ref);
    files.a.changed();
    await files.a.tidy();
    assert.ok(await a.adapter.get(`f/${ref.hash}/0`));
    // The next version names no file: the first is now a stub, and frees its file.
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    await a.storage.addVersion(
      await signer.sign(
        createVersion({
          author: did,
          collection: 'app.photo',
          body: { text: 'gone' },
          version: nextVersion(version),
        }),
        keys.privateKey,
      ),
    );
    files.a.changed();
    await files.a.tidy();
    assert.equal(await a.adapter.get(`f/${ref.hash}/0`), null);
    assert.ok(await a.adapter.get(`f/${unnamed.hash}/0`), 'a file added here and not yet named stays');
  });

  test('a wrong size named for a live file takes nothing from it: it is served, kept and mirrored whole', async () => {
    const { a, b, files, mirror } = await wired();
    const ref = await files.a.add(bytesOf(3 * CHUNK));
    await name(a.storage, ref);
    await name(b.storage, ref);
    // Another member names the same id with a size of 1, in a version of its own.
    for (const storage of [a.storage, b.storage]) await name(storage, { ...ref, size: 1 }, 'grief');
    assert.deepEqual(await files.b.read(ref), await files.a.read(ref));
    files.a.changed();
    await files.a.tidy();
    assert.equal((await mirror.get(`files/demo/writer-a/${ref.hash}`))?.length, ref.size);
  });

  test('deleting a space from a blob store takes its files with it', async () => {
    const store = createMemoryBlobStore();
    await store.put('demo/w/000001-x.seg', new Uint8Array([1]));
    await store.put('files/demo/w/abc', new Uint8Array([1]));
    await store.put('files/demo/w/abc.list', new Uint8Array([1]));
    await store.put('files/other/w/abc', new Uint8Array([1]));
    await deleteMirrored(store, 'demo');
    assert.deepEqual(await store.list(''), ['files/other/w/abc']);
  });

  test('a file kept in a mirror is read from it with no peer at all, and checked', async () => {
    const { a, b, files, mirror } = await wired(undefined, { peers: false });
    const ref = await files.a.add(bytesOf(CHUNK + 5));
    await name(a.storage, ref);
    files.a.changed();
    await files.a.tidy();
    assert.deepEqual((await mirror.list('files/demo/writer-a/')).sort(), [
      `files/demo/writer-a/${ref.hash}`,
      `files/demo/writer-a/${ref.hash}.list`,
    ]);
    await name(b.storage, ref);
    assert.deepEqual(await files.b.open(ref), bytesOf(CHUNK + 5));
  });

  /** A writer and a reader of one space, apart until `meet`; `asked` counts the reader's wants */
  function apart(
    options: Partial<SpaceFilesConfig> = {},
    /** Told of each message once the other side took it */
    taken?: (to: 'a' | 'b', message: SyncMessageBody) => void,
  ) {
    const make = () => {
      const adapter = createMemoryAdapter();
      return { adapter, storage: createStorageProvider(adapter) };
    };
    const a = make();
    const b = make();
    let met = false;
    const counts = { asked: 0 };
    let queue: Promise<void> = Promise.resolve();
    const service = (side: typeof a, other: 'a' | 'b', more: Partial<SpaceFilesConfig>) =>
      createSpaceFiles({
        space: 'demo',
        adapter: side.adapter,
        storage: side.storage,
        send: (_peer, message) => {
          if (other === 'a' && message.type === 'want-file') counts.asked++;
          queue = queue.then(async () => {
            await files[other].onMessage(other === 'a' ? 'b' : 'a', structuredClone(message));
            taken?.(other, message);
          });
        },
        peers: () => (met ? [other] : []),
        ...more,
      });
    const files: { a: SpaceFiles; b: SpaceFiles } = {
      a: service(a, 'b', {}),
      b: service(b, 'a', options),
    };
    const meet = () => {
      met = true;
      files.b.joined('a');
    };
    return { a, b, files, counts, meet };
  }
  const pending = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(() => 'settled'),
      new Promise((resolve) => setTimeout(resolve, 50, 'pending')),
    ]);

  test('a read waits for a file nobody has, and opens once a peer that has it connects', async () => {
    const { a, b, files, meet } = apart();
    const ref = await files.a.add(bytesOf(CHUNK + 7));
    await name(a.storage, ref);
    await name(b.storage, ref);
    const reading = files.b.open(ref);
    assert.equal(await pending(reading), 'pending');
    meet();
    await files.b.fetchMissing();
    assert.deepEqual(await reading, bytesOf(CHUNK + 7));
  });

  test('a waiting read is asked again of a peer already connected, which has the file since', async () => {
    const { a, b, files, meet } = apart();
    meet();
    const ref = await files.a.add(bytesOf(300));
    await name(b.storage, ref);
    // The peer holds the bytes but no version it keeps names them yet: it serves nothing.
    const reading = files.b.open(ref);
    assert.equal(await pending(reading), 'pending');
    await name(a.storage, ref);
    files.a.changed();
    await files.b.fetchMissing();
    assert.deepEqual(await reading, bytesOf(300));
  });

  test('a read of a size the file is not ends, once the file itself is here', async () => {
    const { a, b, files, meet } = apart();
    meet();
    const ref = await files.a.add(bytesOf(300));
    const wrong = { ...ref, size: ref.size + CHUNK };
    await name(a.storage, ref);
    await name(b.storage, ref);
    await name(b.storage, wrong, 'the wrong size');
    assert.deepEqual(await files.b.open(ref), bytesOf(300));
    await assert.rejects(files.b.open(wrong));
  });

  test('a wrong size another member names, read first, keeps no read of the real file waiting', async () => {
    const { a, b, files, meet } = apart();
    const ref = await files.a.add(bytesOf(300));
    const wrong = { ...ref, size: ref.size + CHUNK };
    await name(a.storage, ref);
    await name(b.storage, ref);
    await name(b.storage, wrong, "someone else's post");
    const theirs = files.b.open(wrong).then(
      () => 'opened',
      () => 'refused',
    );
    const real = files.b.open(ref);
    assert.equal(await pending(real), 'pending');
    meet();
    await files.b.fetchMissing();
    assert.deepEqual(await real, bytesOf(300));
    assert.equal(await theirs, 'refused');
  });

  test('a node fetches what nobody had from a peer that connects later, and asks no one else again', async () => {
    const { a, b, files, counts, meet } = apart();
    const ref = await files.a.add(bytesOf(300));
    await name(a.storage, ref);
    await name(b.storage, ref);
    await files.b.fetchMissing();
    assert.equal(await b.adapter.get(`f/${ref.hash}/0`), null);
    // Nobody had it: a pass on the next change asks no one again.
    await files.b.fetchMissing();
    assert.equal(counts.asked, 0);
    meet();
    await files.b.fetchMissing();
    assert.ok(await b.adapter.get(`f/${ref.hash}/0`));
    assert.deepEqual(await files.b.open(ref), bytesOf(300));
  });

  test('a device fetches unread only the files its limit lets come ahead; a larger one when read', async () => {
    const { a, b, files, counts, meet } = apart({ limits: { ahead: CHUNK, keep: 10 * CHUNK } });
    const small = await files.a.add(bytesOf(300));
    const large = await files.a.add(bytesOf(2 * CHUNK));
    for (const ref of [small, large]) {
      await name(a.storage, ref);
      await name(b.storage, ref);
    }
    meet();
    await files.b.fetchMissing();
    assert.ok(await b.adapter.get(`f/${small.hash}/0`));
    assert.equal(counts.asked, 1);
    assert.deepEqual(await files.b.open(large), bytesOf(2 * CHUNK));
  });

  test('past its limit a device drops what others wrote and was used longest ago, never its own, and fetches it again only when read', async () => {
    const keys = await provider.generateKeyPair();
    const self = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const { a, b, files, counts, meet } = apart({
      limits: { ahead: CHUNK, keep: 2 * CHUNK },
      mine: async (version) => version.author === self,
    });
    meet();
    const theirs: SealedFile[] = [];
    for (const n of [1, 2, 3]) {
      const ref = await files.a.add(bytesOf(CHUNK - 100 - n));
      await name(a.storage, ref);
      await name(b.storage, ref);
      files.a.changed();
      files.b.changed();
      await files.b.fetchMissing();
      // Used one after another: the first longest ago.
      await new Promise((resolve) => setTimeout(resolve, 5));
      theirs.push(ref);
    }
    const mine = await files.b.add(bytesOf(CHUNK - 50));
    await name(b.storage, mine, 'my photo', keys);
    files.b.changed();
    await files.b.tidy();
    const held = async (ref: SealedFile) => !!(await b.adapter.get(`f/${ref.hash}/0`));
    assert.deepEqual(
      await Promise.all([...theirs, mine].map(held)),
      [false, true, true, true],
      'the oldest of theirs goes; mine stays, though it is past the limit with it',
    );
    const asked = counts.asked;
    await files.b.fetchMissing();
    assert.equal(counts.asked, asked, 'what was dropped is not fetched again unread');
    assert.deepEqual(await files.b.open(theirs[0]!), bytesOf(CHUNK - 101));
  });

  /** Bytes of chunks and lists a store holds */
  const heldBytes = async (adapter: StorageAdapter) => {
    let total = 0;
    for (const key of await adapter.list('f/'))
      if (!key.endsWith('/used') && !key.endsWith('/own')) total += (await adapter.get(key))?.length ?? 0;
    return total;
  };

  test('a flood of small files fetched in one pass leaves a device within its limit', async () => {
    const keep = 2 * CHUNK;
    const { a, b, files, meet } = apart({ limits: { ahead: CHUNK, keep } });
    meet();
    for (let n = 0; n < 12; n++) {
      const ref = await files.a.add(bytesOf(CHUNK - 200 - n));
      await name(a.storage, ref);
      await name(b.storage, ref);
    }
    // One pass, and no record change after it to tidy.
    await files.b.tidy();
    await files.b.fetchMissing();
    assert.ok((await heldBytes(b.adapter)) <= keep);
  });

  test('a file named at a smaller size, read, still counts at its own size', async () => {
    const keep = 2 * CHUNK;
    const { a, b, files, meet } = apart({ limits: { ahead: CHUNK, keep } });
    meet();
    for (let n = 0; n < 3; n++) {
      const ref = await files.a.add(bytesOf(3 * CHUNK + n));
      await name(a.storage, ref);
      await name(b.storage, ref);
      files.a.changed();
      files.b.changed();
      await files.b.open(ref);
      // Someone's post names the same id at 1 byte; showing it reads it.
      await name(b.storage, { ...ref, size: 1 }, "someone else's post");
      files.b.changed();
      await files.b.open({ ...ref, size: 1 }).catch(() => {});
    }
    await files.b.tidy();
    // Files of 4 chunks each: only the newest, past the limit alone, may stay till it is read no more.
    assert.ok((await heldBytes(b.adapter)) <= keep + 4 * CHUNK);
  });

  test('a file dropped and read again while a pass runs is not dropped from under the read', async () => {
    let armed = false;
    const { a, b, files, meet } = apart({ limits: { ahead: CHUNK, keep: 2 * CHUNK } }, (to, message) => {
      // Records arrive mid-fetch: the pass tidies while the read fetches.
      if (armed && to === 'b' && message.type === 'file' && message.chunk === 1 && message.at === 0) {
        armed = false;
        void files.b.tidy();
      }
    });
    meet();
    const ref = await files.a.add(bytesOf(3 * CHUNK));
    await name(a.storage, ref);
    await name(b.storage, ref);
    await files.b.open(ref);
    await files.b.tidy();
    assert.equal(await b.adapter.get(`f/${ref.hash}/0`), null, 'past the limit alone, dropped once read');
    armed = true;
    assert.deepEqual(await files.b.open(ref), bytesOf(3 * CHUNK));
    assert.ok(
      await b.adapter.get(`f/${ref.hash}/list`),
      'its list with its chunks, so it can be served and dropped',
    );
  });

  test('a read deciding whether to wait as the space closes ends too', async () => {
    const writer = apart().files.a;
    const ref = await writer.add(bytesOf(300));
    const adapter = createMemoryAdapter();
    const storage = createStorageProvider(adapter);
    await name(storage, ref);
    let files: SpaceFiles | null = null;
    let armed = false;
    files = createSpaceFiles({
      space: 'demo',
      // A record arrives as the read looks for the file, and the space closes while it works out what is named.
      adapter: {
        ...adapter,
        get: async (key) => {
          if (key === `f/${ref.hash}/list` && !armed) {
            armed = true;
            files?.changed();
          }
          return adapter.get(key);
        },
      },
      storage: {
        ...storage,
        versionIds: async () => {
          if (armed) files?.close();
          return storage.versionIds();
        },
      },
      send: () => {},
      peers: () => [],
    });
    const reading = files.open(ref).then(
      () => 'opened',
      () => 'refused',
    );
    assert.equal(await pending(reading), 'settled');
    assert.ok(armed);
    assert.equal(await reading, 'refused');
  });

  test('a waiting read ends when the space closes', async () => {
    const { a, b, files } = apart();
    const ref = await files.a.add(bytesOf(300));
    await name(a.storage, ref);
    await name(b.storage, ref);
    const reading = files.b.open(ref);
    assert.equal(await pending(reading), 'pending');
    files.b.close();
    await assert.rejects(reading, /closed/);
  });
});
