/**
 * Writers' logs (spec 02 §4.10): a key's writes in each collection of a space
 * form one line, two versions at one place in it are a fork, and a proven
 * fork stops what the key signed in that collection from there on counting,
 * at every peer.
 */
import { test, describe } from 'node:test';
import { newRecordKey } from '../src/records/key.js';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion, stubOf } from '../src/schema/version.js';
import { checkVersionShape } from '../src/records/version.js';
import { checkFork, forkProof } from '../src/records/fork.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { team } from '../src/space/presets.js';
import type { Version, WriterLog } from '../src/types.js';
import type { ClaimedWriter, HeadStore, WriterKeySource } from '../src/node/writer-keys.js';
import { browserWriterKeys } from '../src/node/writer-keys.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { person, open, type Person } from './helpers/person.js';

const provider = createP256Provider();

/** The version a record's current entry was written as, from the writer's own store */
async function versionOf(who: Person, space: string, id: string): Promise<Version> {
  const version = await createStorageProvider(await who.stores(`spaces/${space}`)).getVersion(id);
  assert.ok(version, `version ${id} is stored`);
  return version;
}

async function sharedWithBob() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  return { hub, alice, bob, space };
}

/** A key of Bob's that signs by hand, under a note Bob gave it: one log, whose places the test chooses */
async function handKey(bob: Person, space: string) {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const note = await createLocalRootSigner(bob.me, bob.manager.getProvider()).delegate({
    audience: did,
    command: '/record/write',
    subject: `space:${space}`,
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const { heads: seen } = await bob.node.spaces.access(space);
  return {
    did,
    sign: async (text: string, log: WriterLog, collection = 'app.note') =>
      createSigner(provider).sign(
        // Its log as given, which may be one a writer would never sign.
        {
          ...createVersion({
            author: did,
            collection,
            space,
            version: { key: await newRecordKey(bob.node.did), seq: 0 },
            body: { text },
            proof: [note],
            seen,
          }),
          log,
        },
        pair.privateKey,
      ),
  };
}

describe('a writer’s log', () => {
  test('each write takes the next place, naming the one before; each space has its own line', async () => {
    const { alice, space } = await sharedWithBob();
    const ids: string[] = [];
    for (const text of ['one', 'two', 'three'])
      ids.push((await alice.node.records.put(space, 'app.note', { text })).version);
    const logs = await Promise.all(ids.map(async (id) => (await versionOf(alice, space, id)).log));
    // Whatever else the node wrote first (its profile, its member key), these are the first three in their collection.
    assert.deepEqual(logs, [{ n: 0 }, { n: 1, prev: ids[0] }, { n: 2, prev: ids[1] }]);

    const other = await alice.node.spaces.create({ name: 'Other', visibility: 'public' });
    const there = await alice.node.records.put(other.id, 'app.note', { text: 'elsewhere' });
    assert.deepEqual((await versionOf(alice, other.id, there.version)).log, { n: 0 });
  });

  test('each collection has its own line', async () => {
    const { alice, space } = await sharedWithBob();
    const a = await alice.node.records.put(space, 'app.note', { text: 'a' });
    const b = await alice.node.records.put(space, 'app.photo', { text: 'b' });
    const d = await alice.node.records.put(space, 'app.note', { text: 'd' });
    const logs = await Promise.all(
      [a, b, d].map(async (r) => (await versionOf(alice, space, r.version)).log),
    );
    assert.deepEqual(logs, [{ n: 0 }, { n: 0 }, { n: 1, prev: a.version }]);
  });

  test('writes made at once still take one place each', async () => {
    const { alice, space } = await sharedWithBob();
    const written = await Promise.all(
      Array.from({ length: 6 }, (_, i) => alice.node.records.put(space, 'app.note', { text: `${i}` })),
    );
    const places = await Promise.all(
      written.map(async (record) => (await versionOf(alice, space, record.version)).log!.n),
    );
    assert.equal(new Set(places).size, 6);
  });

  test('a key handed to the node keeps its places across a restart', async () => {
    const { me, manager } = await person();
    const keys = await provider.generateKeyPair();
    const stores = memoryStores();
    const start = async () => {
      const node = await createNode({
        signer: createLocalRootSigner(me, manager.getProvider()),
        sessionKey: keys,
        stores,
        watchIntervalMs: 0,
      });
      open.push(node);
      return node;
    };
    const before = await start();
    const { id: space } = await before.spaces.create({ name: 'Mine', visibility: 'public' });
    const a = await before.records.put(space, 'app.note', { text: 'a' });
    await before.close();

    const after = await start();
    const b = await after.records.put(space, 'app.note', { text: 'b' });
    const read = async (id: string) =>
      (await createStorageProvider(await stores(`spaces/${space}`)).getVersion(id))!.log;
    const [was, now] = [(await read(a.version))!, (await read(b.version))!];
    assert.deepEqual(now, { n: was.n + 1, prev: a.version });
  });

  test('places a node kept before a line per collection are not carried on', async () => {
    const { me, manager } = await person();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      sessionKey: keys,
      stores,
      watchIntervalMs: 0,
    });
    open.push(node);
    const { id: space } = await node.spaces.create({ name: 'Mine', visibility: 'public' });
    // What the node kept when a key had one line across the space, naming versions no peer holds now.
    const old = { head: { n: 9, id: 'old9' }, collections: { 'app.note': { n: 4, id: 'old4' } } };
    await (
      await stores('writers')
    ).put(`head/${did}/${space}`, new TextEncoder().encode(JSON.stringify(old)));
    const written = await node.records.put(space, 'app.note', { text: 'a' });
    const version = await createStorageProvider(await stores(`spaces/${space}`)).getVersion(written.version);
    assert.deepEqual(version?.log, { n: 0 });
  });

  test('two nodes sharing a handed-in key and its storage, as two tabs of an app do, never take one place', async () => {
    const { me, manager } = await person();
    const keys = await provider.generateKeyPair();
    // One origin's storage, as every tab of an app sees it.
    const stores = memoryStores();
    const tab = async () => {
      const node = await createNode({
        signer: createLocalRootSigner(me, manager.getProvider()),
        sessionKey: keys,
        stores,
        watchIntervalMs: 0,
      });
      open.push(node);
      return node;
    };
    const first = await tab();
    const { id: space } = await first.spaces.create({ name: 'Mine', visibility: 'public' });
    const second = await tab();
    const written = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? first : second).records.put(space, 'app.note', { text: `${i}` }),
      ),
    );
    const store = createStorageProvider(await stores(`spaces/${space}`));
    const places = await Promise.all(
      written.map(async (record) => (await store.getVersion(record.version))!.log!.n),
    );
    assert.equal(new Set(places).size, places.length, 'no place taken twice');
  });

  test('a version in a space without its place is malformed', () => {
    const version = { key: 'abc', seq: 0, space: 's', bodyHash: 'bx' };
    assert.match(checkVersionShape(version) ?? '', /place in its writer/);
    assert.equal(checkVersionShape({ ...version, log: { n: 0 } }), null);
    assert.match(checkVersionShape({ ...version, log: { n: 1 } }) ?? '', /previous version/);
    assert.match(checkVersionShape({ ...version, log: { n: 0, prev: 'x' } }) ?? '', /names no previous/);
    assert.match(checkVersionShape({ ...version, log: { n: -1 } }) ?? '', /whole number/);
    assert.match(
      checkVersionShape({ ...version, log: Object.assign({ n: 0 }, { at: 1 }) }) ?? '',
      /only n and prev/,
    );
  });

  test('a version that still carries a line across collections is refused', async () => {
    const shape = { key: 'abc', seq: 0, space: 's', bodyHash: 'bx' };
    assert.match(
      checkVersionShape({ ...shape, log: Object.assign({ n: 0 }, { c: { n: 0 } }) }) ?? '',
      /only n and prev/,
    );

    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const old = await key.sign('old', Object.assign({ n: 0 }, { c: { n: 0 } }));
    const fine = await key.sign('fine', { n: 0 }, 'app.other');
    await letGo(bob.node, space);
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    for (const version of [old, fine]) await store.addVersion(version);
    await hold(bob.node, space);
    await until(async () => (await alice.node.records.get(space, fine.key)) !== null, 8000, 'the good one');
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    assert.equal(await aliceStore.getVersion(old.id), null, 'Alice refuses the old shape');
  });
});

/** Writer keys kept in memory, as a browser keeps them in IndexedDB: slots, each claimed by one node at a time */
function memoryWriterKeys(): WriterKeySource & { readonly claimed: () => number } {
  const slots: Array<{ keys: CryptoKeyPair; heads: Map<string, Uint8Array>; held: boolean }> = [];
  return {
    claimed: () => slots.filter((slot) => slot.held).length,
    async claim(): Promise<ClaimedWriter | null> {
      let slot = slots.find((candidate) => !candidate.held);
      if (!slot) {
        slot = { keys: await provider.generateKeyPair(), heads: new Map(), held: false };
        slots.push(slot);
      }
      const taken = slot;
      taken.held = true;
      const heads: HeadStore = {
        get: async (key) => taken.heads.get(key) ?? null,
        put: async (key, value) => void taken.heads.set(key, value),
      };
      return {
        keys: taken.keys,
        heads,
        release: async () => void (taken.held = false),
        forget: async () => void taken.heads.clear(),
      };
    },
  };
}

describe('a writer key that outlives the node', () => {
  async function nodeWith(writerKey: WriterKeySource, who: Person, stores = memoryStores()) {
    const node = await createNode({
      signer: createLocalRootSigner(who.me, who.manager.getProvider()),
      stores,
      writerKey,
      watchIntervalMs: 0,
    });
    open.push(node);
    return node;
  }

  test('a restart signs with the same key, and carries its log on', async () => {
    const who = await person();
    const keys = memoryWriterKeys();
    const stores = memoryStores();
    const before = await nodeWith(keys, who, stores);
    const { id: space } = await before.spaces.create({ name: 'Mine', visibility: 'public' });
    const a = await before.records.put(space, 'app.note', { text: 'a' });
    await before.close();
    assert.equal(keys.claimed(), 0, 'closing lets go of the key');

    const after = await nodeWith(keys, who, stores);
    assert.equal(after.sessionDid, before.sessionDid);
    const b = await after.records.put(space, 'app.note', { text: 'b' });
    const read = async (id: string) =>
      (await createStorageProvider(await stores(`spaces/${space}`)).getVersion(id))!.log;
    const [was, now] = [(await read(a.version))!, (await read(b.version))!];
    assert.deepEqual(now, { n: was.n + 1, prev: a.version });
  });

  test('two nodes running at once never share a key', async () => {
    const who = await person();
    const keys = memoryWriterKeys();
    const one = await nodeWith(keys, who);
    const two = await nodeWith(keys, who);
    assert.notEqual(one.sessionDid, two.sessionDid);
    assert.equal(keys.claimed(), 2);
  });

  test('where nothing can lock a key, there is no lasting one: the node makes its own', async () => {
    // No IndexedDB here, as in Node.
    assert.equal(await browserWriterKeys('weave:test').claim(), null);
    const who = await person();
    const node = await nodeWith(browserWriterKeys('weave:test'), who);
    assert.match(node.sessionDid, /^did:key:/);
  });
});

describe('a fork', () => {
  test('two versions at one place: found, proven to everyone, and what the key signed from there stops counting', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const first = await key.sign('first', { n: 0 });
    const second = await key.sign('second', { n: 1, prev: first.id });
    const rival = await key.sign('rival', { n: 1, prev: first.id });

    // Slipped into Bob's copy, from where they sync to Alice, as a copied key would write them.
    await letGo(bob.node, space);
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    for (const version of [first, second, rival]) await store.addVersion(version);
    await hold(bob.node, space);

    for (const who of [alice, bob])
      await until(
        async () =>
          (await who.node.spaces.access(space)).forks.some(
            (fork) => fork.writer === key.did && fork.collection === 'app.note' && fork.from === 1,
          ),
        8000,
        'the fork to be proven everywhere',
      );
    for (const who of [alice, bob]) {
      assert.notEqual(await who.node.records.get(space, first.key), null, 'before the fork still counts');
      assert.equal(await who.node.records.get(space, second.key), null);
      assert.equal(await who.node.records.get(space, rival.key), null);
    }
  });

  test('places a node kept before a line per collection don’t hide a fork', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    // Each node kept, from before, that this key's place 1 in app.note was a version no peer holds now.
    for (const who of [alice, bob])
      await (
        await who.stores(`spaces/${space}`)
      ).put(`clog/${key.did}/app.note/1`, new TextEncoder().encode('old'));
    const first = await key.sign('first', { n: 0 });
    const second = await key.sign('second', { n: 1, prev: first.id });
    const rival = await key.sign('rival', { n: 1, prev: first.id });
    await letGo(bob.node, space);
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    for (const version of [first, second, rival]) await store.addVersion(version);
    await hold(bob.node, space);
    await until(
      async () => (await alice.node.spaces.access(space)).forks.some((fork) => fork.writer === key.did),
      8000,
      'the fork to be proven',
    );
  });

  test('a fork reaches only the line it is in: the key’s versions in other collections stand', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const first = await key.sign('first', { n: 0 });
    const second = await key.sign('second', { n: 1, prev: first.id });
    const rival = await key.sign('rival', { n: 1, prev: first.id });
    const elsewhere = await key.sign('elsewhere', { n: 0 }, 'app.other');
    const later = await key.sign('later', { n: 1, prev: elsewhere.id }, 'app.other');

    await slip(bob, space, [first, second, rival, elsewhere, later]);
    await provenEverywhere([alice, bob], space, key.did, 1, 'app.note');
    for (const who of [alice, bob]) {
      assert.equal(await who.node.records.get(space, rival.key), null);
      assert.notEqual(await who.node.records.get(space, later.key), null, 'another line stands');
      assert.deepEqual(
        (await who.node.spaces.access(space)).forks.filter((fork) => fork.writer === key.did),
        [{ writer: key.did, collection: 'app.note', from: 1 }],
      );
    }
  });

  /** Slips versions into Bob's copy, from where they sync, as a modified client would write them */
  async function slip(bob: Person, space: string, versions: ReadonlyArray<Version>) {
    await letGo(bob.node, space);
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    for (const version of versions) await store.addVersion(version);
    await hold(bob.node, space);
  }

  const provenEverywhere = (
    who: ReadonlyArray<Person>,
    space: string,
    writer: string,
    from: number,
    collection = 'app.note',
  ) =>
    Promise.all(
      who.map((one) =>
        until(
          async () =>
            (await one.node.spaces.access(space)).forks.some(
              (f) => f.writer === writer && f.collection === collection && f.from === from,
            ),
          8000,
          'the break to be proven everywhere',
        ),
      ),
    );

  test('a version naming another key’s as the place before it breaks its line, from there on', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const someoneElse = await handKey(bob, space);
    const theirs = await someoneElse.sign('theirs', { n: 0 });
    const first = await key.sign('first', { n: 0 });
    const broken = await key.sign('broken', { n: 1, prev: theirs.id });

    await slip(bob, space, [theirs, first, broken]);
    await provenEverywhere([alice, bob], space, key.did, 1);
    for (const who of [alice, bob]) {
      assert.notEqual(await who.node.records.get(space, first.key), null, 'before the break still counts');
      assert.equal(await who.node.records.get(space, broken.key), null);
      assert.notEqual(await who.node.records.get(space, theirs.key), null, 'the other key is not to blame');
    }
  });

  test('a break is found whichever version arrives first', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const first = await key.sign('first', { n: 0 });
    // Names its own first version, but skips a place.
    const skipping = await key.sign('skipping', { n: 2, prev: first.id });

    await slip(bob, space, [skipping]);
    await until(
      async () => (await alice.node.records.get(space, skipping.key)) !== null,
      8000,
      'it to arrive',
    );
    await slip(bob, space, [first]);
    await provenEverywhere([alice, bob], space, key.did, 2);
  });

  test('two versions at one place in different collections are no fork', async () => {
    const { bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const a = await key.sign('a', { n: 0 });
    const b = await key.sign('b', { n: 0 }, 'app.other');
    assert.match(JSON.stringify(await checkFork(stubOf(a), stubOf(b), space, provider)), /one collection/);
  });

  test('naming a version in another collection as the place before breaks the line', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const zero = await key.sign('zero', { n: 0 });
    const there = await key.sign('there', { n: 0 }, 'app.other');
    const crossing = await key.sign('crossing', { n: 1, prev: there.id });
    assert.deepEqual(await checkFork(stubOf(there), stubOf(crossing), space, provider), {
      writer: key.did,
      collection: 'app.note',
      from: 1,
    });
    await slip(bob, space, [zero, there, crossing]);
    await provenEverywhere([alice, bob], space, key.did, 1);
    for (const who of [alice, bob]) {
      assert.notEqual(await who.node.records.get(space, zero.key), null);
      assert.equal(await who.node.records.get(space, crossing.key), null);
      assert.notEqual(await who.node.records.get(space, there.key), null, 'the named line is not to blame');
    }
  });

  test('a proof is checked by itself: one key, this space, one place, two versions, no bodies', async () => {
    const { bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const other = await handKey(bob, space);
    const a = await key.sign('a', { n: 3, prev: 'p' });
    const b = await key.sign('b', { n: 3, prev: 'p' });
    const proof = forkProof(a, b);
    assert.deepEqual(await checkFork(proof.a, proof.b, space, provider), {
      writer: key.did,
      collection: 'app.note',
      from: 3,
    });

    const refuse = async (x: unknown, y: unknown, why: RegExp, inSpace = space) =>
      assert.match(JSON.stringify(await checkFork(x, y, inSpace, provider)), why);
    await refuse(stubOf(a), stubOf(a), /two different versions/);
    await refuse(stubOf(a), stubOf(await other.sign('c', { n: 3, prev: 'p' })), /one key signed/);
    await refuse(stubOf(a), stubOf(await key.sign('d', { n: 4, prev: 'p' })), /one place/);
    await refuse(a, stubOf(b), /without their bodies/);
    await refuse(stubOf(a), stubOf(b), /versions of this space/, 'another-space');
    await refuse(stubOf(a), { ...stubOf(b), signature: stubOf(a).signature }, /Signature/);
  });

  test('a break is proven by the version that names the wrong one, and a true link proves nothing', async () => {
    const { bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const other = await handKey(bob, space);
    const zero = await key.sign('zero', { n: 0 });
    const one = await key.sign('one', { n: 1, prev: zero.id });
    const theirs = await other.sign('theirs', { n: 0 });
    const naming = await key.sign('naming', { n: 1, prev: theirs.id });
    const skipping = await key.sign('skipping', { n: 3, prev: zero.id });

    const proves = async (x: Version, y: Version) => checkFork(stubOf(x), stubOf(y), space, provider);
    const line = { writer: key.did, collection: 'app.note' };
    assert.deepEqual(await proves(naming, theirs), { ...line, from: 1 });
    assert.deepEqual(await proves(theirs, naming), { ...line, from: 1 }, 'in either order');
    assert.deepEqual(await proves(skipping, zero), { ...line, from: 3 });
    assert.match(JSON.stringify(await proves(one, zero)), /one place/, 'a true link');
  });
});
