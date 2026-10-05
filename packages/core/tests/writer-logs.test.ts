/**
 * Writers' logs (spec 02 §4.10): every key's writes in a space form one line,
 * a version at two places in it is a fork, and a proven fork stops what the
 * key signed from there on counting, at every peer.
 */
import { test, describe } from 'node:test';
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
    capabilities: [{ with: `space:${space}`, can: 'record/write' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const { heads: seen } = await bob.node.spaces.access(space);
  return {
    did,
    sign: (text: string, log: WriterLog) =>
      createSigner(provider).sign(
        createVersion({
          author: did,
          collection: 'app.note',
          space,
          body: { text },
          proof: note.encoded,
          seen,
          log,
        }),
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
    // Whatever else the node wrote first (its profile, its member key), the three follow each other.
    const first = logs[0]!.n;
    assert.deepEqual(logs, [
      { n: first, prev: logs[0]!.prev },
      { n: first + 1, prev: ids[0] },
      { n: first + 2, prev: ids[1] },
    ]);

    const other = await alice.node.spaces.create({ name: 'Other', visibility: 'public' });
    const there = await alice.node.records.put(other.id, 'app.note', { text: 'elsewhere' });
    assert.ok((await versionOf(alice, other.id, there.version)).log!.n < first + 3);
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
    assert.deepEqual(await read(b.version), { n: (await read(a.version))!.n + 1, prev: a.version });
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
      return { keys: taken.keys, heads, release: async () => void (taken.held = false) };
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
    assert.deepEqual(await read(b.version), { n: (await read(a.version))!.n + 1, prev: a.version });
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
            (fork) => fork.writer === key.did && fork.from === 1,
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

  test('a proof is checked by itself: one key, this space, one place, two versions, no bodies', async () => {
    const { bob, space } = await sharedWithBob();
    const key = await handKey(bob, space);
    const other = await handKey(bob, space);
    const a = await key.sign('a', { n: 3, prev: 'p' });
    const b = await key.sign('b', { n: 3, prev: 'p' });
    const proof = forkProof(a, b);
    assert.deepEqual(await checkFork(proof.a, proof.b, space, provider), { writer: key.did, from: 3 });

    const refuse = async (x: unknown, y: unknown, why: RegExp, inSpace = space) =>
      assert.match(JSON.stringify(await checkFork(x, y, inSpace, provider)), why);
    await refuse(stubOf(a), stubOf(a), /two different versions/);
    await refuse(stubOf(a), stubOf(await other.sign('c', { n: 3, prev: 'p' })), /one key signed/);
    await refuse(stubOf(a), stubOf(await key.sign('d', { n: 4, prev: 'p' })), /one place/);
    await refuse(a, stubOf(b), /without their bodies/);
    await refuse(stubOf(a), stubOf(b), /versions of this space/, 'another-space');
    await refuse(stubOf(a), { ...stubOf(b), signature: stubOf(a).signature }, /Signature/);
  });
});
