/**
 * A node's stores in one SQLite database: the adapter contract, stores kept
 * apart, every write landing whole or not at all, and two nodes syncing over
 * it. Also the body cache several stores share, which never makes a read
 * come back short.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { after, sqliteStores } from '../src/storage/sqlite-adapter.js';
import { createBodyCache } from '../src/storage/body-cache.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import type { Version } from '../src/types.js';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner, type RootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import type { StoreFactory } from '../src/node/stores.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { hold } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { until } from './helpers/until.js';
import { team } from '../src/space/presets.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array | null) => (value ? new TextDecoder().decode(value) : null);

const memory = () => sqliteStores(new DatabaseSync(':memory:'));

/** `n` signed versions in one collection, as a peer would send them */
async function versions(n: number, collection = 'app.note'): Promise<Version[]> {
  const provider = createP256Provider();
  const pair = await provider.generateKeyPair();
  const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const signer = createSigner(provider);
  const made: Version[] = [];
  for (let i = 0; i < n; i++)
    made.push(await signer.sign(createVersion({ author, collection, body: { i } }), pair.privateKey));
  return made;
}

describe('SQLite stores — the adapter', () => {
  test('entries: put, get, delete, and listing by prefix', async () => {
    const store = await memory()('spaces/a');
    await store.put('r/one', bytes('1'));
    await store.put('r/two', bytes('2'));
    await store.put('i/x', bytes('x'));
    await store.put('r/two', bytes('2b'));
    assert.equal(text(await store.get('r/two')), '2b');
    assert.equal(await store.get('r/none'), null);
    assert.deepEqual(await store.list('r/'), ['r/one', 'r/two']);
    assert.deepEqual((await store.list()).sort(), ['i/x', 'r/one', 'r/two']);
    await store.delete('r/one');
    await store.delete('r/absent');
    assert.deepEqual(await store.list('r/'), ['r/two']);
    assert.deepEqual(
      (await store.entries!('r/')).map(([key, value]) => [key, text(value)]),
      [['r/two', '2b']],
    );
  });

  test('a prefix lists exactly the keys it starts, past ASCII too', async () => {
    const store = await memory()('s');
    const keys = [
      'a',
      'a/',
      'a/b',
      'a/ø',
      'a/😀',
      'a/\u{10ffff}x',
      'a0',
      'b',
      'ø',
      'ø/1',
      '\u{10ffff}',
      '\u{10ffff}a',
    ];
    for (const key of keys) await store.put(key, bytes(key));
    for (const prefix of ['', 'a', 'a/', 'ø', '\u{10ffff}', 'zz']) {
      const expected = keys.filter((key) => key.startsWith(prefix)).sort();
      assert.deepEqual((await store.list(prefix)).sort(), expected, `prefix ${JSON.stringify(prefix)}`);
    }
  });

  test('a key holding U+0000 is refused, since it would read back cut short', async () => {
    const store = await memory()('s');
    await assert.rejects(store.put('a\0b', bytes('x')), /U\+0000/);
    await assert.rejects(store.batch([{ type: 'put', key: 'a\0b', value: bytes('x') }]), /U\+0000/);
    assert.deepEqual(await store.list(), []);
  });

  test('after(prefix) bounds every string the prefix starts', () => {
    assert.equal(after(''), null);
    assert.equal(after('a'), 'b');
    assert.equal(after('a\u{10ffff}'), 'b');
    assert.equal(after('\u{10ffff}'), null);
    assert.equal(after('\u{d7ff}'), '\u{e000}');
  });

  test('versions: put, get one or many, delete', async () => {
    const store = await memory()('spaces/a');
    const [one, two] = await versions(2);
    await store.putVersion(one!);
    await store.putVersion(two!);
    assert.deepEqual(await store.getVersion(one!.id), one);
    assert.deepEqual(await store.getVersions!([two!.id, 'missing', one!.id]), [two, null, one]);
    await store.deleteVersion(one!.id);
    assert.equal(await store.getVersion(one!.id), null);
  });

  test('stores are kept apart, and sized apart', async () => {
    const stores = memory();
    const a = await stores('spaces/a');
    const b = await stores('spaces/b');
    await a.put('k', bytes('in a'));
    const [version] = await versions(1);
    await b.putVersion(version!);
    assert.equal(await b.get('k'), null);
    assert.equal(await a.getVersion(version!.id), null);
    assert.equal(stores.size('spaces/a'), 'k'.length + 'in a'.length);
    assert.equal(stores.size('spaces/b'), Buffer.byteLength(JSON.stringify(version)));
    assert.equal(stores.size('spaces/none'), 0);
    assert.deepEqual(stores.paths(), ['spaces/a', 'spaces/b']);
  });

  test('a commit lands whole or not at all', async () => {
    const store = await memory()('spaces/a');
    const [version] = await versions(1);
    await assert.rejects(
      store.commit!({
        store: [version!],
        ops: [
          { type: 'put', key: 'r/one', value: bytes('1') },
          // Not bytes: SQLite refuses it, after the version and the first entry were written.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- what a broken caller would pass
          { type: 'put', key: 'r/two', value: { nope: true } as unknown as Uint8Array },
        ],
        remove: [],
      }),
    );
    assert.equal(await store.get('r/one'), null);
    assert.equal(await store.getVersion(version!.id), null);
    await store.commit!({
      store: [version!],
      ops: [{ type: 'put', key: 'r/one', value: bytes('1') }],
      remove: [],
    });
    assert.equal(text(await store.get('r/one')), '1');
  });

  test('a store closed refuses more, and its data stays for the next open', async () => {
    const stores = memory();
    const store = await stores('registry');
    await store.put('k', bytes('v'));
    await store.close();
    await assert.rejects(store.get('k'));
    assert.equal(text(await (await stores('registry')).get('k')), 'v');
  });

  test('a database reopened from its file has everything', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'minca-sqlite-'));
    try {
      const file = path.join(dir, 'node.sqlite');
      const first = new DatabaseSync(file);
      const [version] = await versions(1);
      const store = await sqliteStores(first)('spaces/a');
      await store.commit!({
        store: [version!],
        ops: [{ type: 'put', key: 'r/k', value: bytes(version!.id) }],
        remove: [],
      });
      first.close();
      const again = await sqliteStores(new DatabaseSync(file))('spaces/a');
      assert.equal(text(await again.get('r/k')), version!.id);
      assert.deepEqual(await again.getVersion(version!.id), version);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a body cache several stores share', () => {
  test('reads never come back short, however small the cache', async () => {
    const cache = createBodyCache(10);
    const stores = memory();
    const storage = createStorageProvider(await stores('spaces/a'), cache);
    const other = createStorageProvider(await stores('spaces/b'), cache);
    const made = await versions(50);
    for (const version of made) await storage.addVersion(version);
    for (const version of (await versions(20, 'app.other')).slice(0, 20)) await other.addVersion(version);
    assert.equal((await storage.keptVersions('app.note')).length, 50);
    assert.equal((await storage.queryVersions('app.note')).length, 50);
    assert.equal((await storage.listCurrent()).length, 50);
    assert.equal((await other.listCurrent()).length, 20);
  });

  test('a store cleared forgets only its own', async () => {
    const cache = createBodyCache(100_000);
    const a = cache.part();
    const b = cache.part();
    const [one] = await versions(1);
    a.set(one!);
    b.set(one!);
    a.clear();
    assert.equal(a.get(one!.id), undefined);
    assert.deepEqual(b.get(one!.id), one);
  });

  test('it holds bytes, not bodies: large bodies take no more memory than small ones', async () => {
    const cache = createBodyCache(1_000_000);
    const part = cache.part();
    const [template] = await versions(1);
    const large = (n: number) => ({ ...template!, id: `large-${n}`, body: 'x'.repeat(100_000) });
    for (let n = 0; n < 50; n++) part.set(large(n));
    const kept = Array.from({ length: 50 }, (_, n) => part.has(`large-${n}`)).filter(Boolean).length;
    assert.ok(kept > 0 && kept <= 5, `kept ${kept} bodies of 200 KB in 1 MB`);
    assert.ok(part.has('large-49'), 'the one used last is kept');
    part.set({ ...template!, id: 'huge', body: 'x'.repeat(200_000) });
    assert.equal(part.has('huge'), false, 'a body over a quarter of the cache is not kept');
  });
});

describe('nodes on SQLite stores', () => {
  const open: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((node) => node.close().catch(() => {})));
  });

  async function person(hub: FakeHub, stores: StoreFactory, signer?: RootSigner): Promise<P2PNode> {
    const manager = createIdentityManager();
    const node = await createNode({
      signer: signer ?? createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider()),
      stores,
      watchIntervalMs: 0,
      network: { transports: (space: string, session: string) => [hub.transport(session, space)] },
    });
    open.push(node);
    return node;
  }

  test('two nodes sync, and a node restarted on its database has everything', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'minca-sqlite-node-'));
    try {
      const hub = createFakeHub();
      const file = path.join(dir, 'bob.sqlite');
      const manager = createIdentityManager();
      const bobSigner = createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider());
      const alice = await person(hub, memory());
      const { id: space } = await alice.spaces.create({ name: 'Notes', ...team, visibility: 'private' });
      await hold(alice, space);
      for (let i = 0; i < 30; i++) await alice.records.put(space, 'note', { i });

      let db = new DatabaseSync(file);
      let bob = await person(hub, sqliteStores(db), bobSigner);
      await bob.spaces.join(await alice.spaces.invite(space));
      await hold(bob, space);
      await joined(bob, space);
      await until(async () => (await bob.records.list(space, { collection: 'note' })).length === 30);

      await bob.close();
      open.splice(open.indexOf(bob), 1);
      db.close();
      db = new DatabaseSync(file);
      bob = await person(createFakeHub(), sqliteStores(db), bobSigner);
      assert.equal((await bob.records.list(space, { collection: 'note' })).length, 30);
      await bob.close();
      open.splice(open.indexOf(bob), 1);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
