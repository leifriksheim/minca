/**
 * Shallow sets (05 §5): what a store keeps of each collection but the
 * unretained stubs past a record's first version, indexed as versions land.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion, stubOf } from '../src/schema/version.js';
import { createStorageProvider, inShallowSet, SHALLOW_PREFIX } from '../src/storage/storage-provider.js';
import { cidOfDigest } from '../src/utils/hash.js';
import type { StorageProvider } from '../src/storage/storage-provider.js';
import type { Version } from '../src/types.js';
import { makeKey } from './helpers/person.js';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import type { StoreFactory } from '../src/node/stores.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { hold } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { until } from './helpers/until.js';

const signer = createSigner(createP256Provider());
const COLLECTION = 'app.note';

/** One record edited `edits` times: its versions, first to last */
async function editedRecord(edits: number, options: { retain?: boolean } = {}): Promise<Version[]> {
  const author = await makeKey();
  const versions: Version[] = [];
  for (let seq = 0; seq <= edits; seq++) {
    const previous = versions.at(-1);
    versions.push(
      await signer.sign(
        createVersion({
          author: author.did,
          collection: COLLECTION,
          body: { seq },
          ...(options.retain ? { retain: true } : {}),
          ...(previous
            ? { version: { key: previous.key, seq, prev: previous.id, genesis: versions[0]!.id } }
            : {}),
        }),
        author.privateKey,
      ),
    );
  }
  return versions;
}

const idsOf = async (storage: StorageProvider, shallow: boolean) =>
  new Set(
    (await (shallow ? storage.shallowItems(COLLECTION) : storage.items(COLLECTION))).items.map((item) =>
      cidOfDigest(item.id),
    ),
  );

describe('shallow sets', () => {
  test('a record edited many times is its first and current version', async () => {
    const storage = createStorageProvider(createMemoryAdapter());
    const versions = await editedRecord(20);
    for (const version of versions) await storage.addVersion(version);

    assert.equal((await idsOf(storage, false)).size, 21);
    assert.deepEqual(await idsOf(storage, true), new Set([versions[0]!.id, versions[20]!.id]));
    assert.equal((await storage.shallowSums()).get(COLLECTION)?.count, 2);
  });

  test('a retained history is shallow whole', async () => {
    const storage = createStorageProvider(createMemoryAdapter());
    for (const version of await editedRecord(5, { retain: true })) await storage.addVersion(version);
    assert.deepEqual(await idsOf(storage, true), await idsOf(storage, false));
  });

  test('arriving in any order gives the same shallow set', async () => {
    const versions = await editedRecord(8);
    const inOrder = createStorageProvider(createMemoryAdapter());
    const reversed = createStorageProvider(createMemoryAdapter());
    for (const version of versions) await inOrder.addVersion(version);
    for (const version of [...versions].reverse()) await reversed.addVersion(version);
    assert.deepEqual(await inOrder.shallowSums(), await reversed.shallowSums());
  });

  test('a current version held only as its stub is not in the set until its body arrives', async () => {
    const versions = await editedRecord(2);
    const storage = createStorageProvider(createMemoryAdapter());
    await storage.addVersion(versions[0]!);
    await storage.addVersion(versions[1]!);
    await storage.addVersion(stubOf(versions[2]!));
    assert.ok(!(await idsOf(storage, true)).has(versions[2]!.id), 'a stub to fetch the body of');
    await storage.addVersion(versions[2]!);
    assert.ok((await idsOf(storage, true)).has(versions[2]!.id));
  });

  test('a removed version leaves the set', async () => {
    const storage = createStorageProvider(createMemoryAdapter());
    const versions = await editedRecord(3);
    for (const version of versions) await storage.addVersion(version);
    await storage.removeVersion(versions[3]!.id);
    assert.ok(!(await idsOf(storage, true)).has(versions[3]!.id));
  });

  test('a store kept before shallow sets is indexed once, the same as one kept with them', async () => {
    const adapter = createMemoryAdapter();
    const before = createStorageProvider(adapter);
    for (const version of [...(await editedRecord(12)), ...(await editedRecord(3, { retain: true }))])
      await before.addVersion(version);
    const expected = await before.shallowSums();

    // As a store written before `t/`: no entries, no marker.
    for (const key of await adapter.list(SHALLOW_PREFIX)) await adapter.delete(key);
    await adapter.delete('shallow-indexed');
    const after = createStorageProvider(adapter);
    assert.deepEqual(await after.shallowSums(), expected);
    assert.equal((await adapter.list(SHALLOW_PREFIX)).length, expected.get(COLLECTION)?.count);
    assert.ok(await adapter.get('shallow-indexed'), 'marked done');
  });

  test('which versions are shallow is decided by the version alone', async () => {
    const [first, second] = await editedRecord(1);
    assert.ok(inShallowSet(first!));
    assert.ok(inShallowSet(stubOf(first!)), 'a first version, also as its stub');
    assert.ok(inShallowSet(second!));
    assert.ok(!inShallowSet(stubOf(second!)), 'a stub past the first version');
  });
});

describe('a node that syncs shallow', () => {
  const nodes: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => {})));
  });

  async function personOn(hub: FakeHub, options: { shallow?: boolean } = {}) {
    const manager = createIdentityManager();
    const stores = memoryStores();
    let session = '';
    const node = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(generateSeed()), manager.getProvider()),
      stores,
      watchIntervalMs: 0,
      ...(options.shallow ? { shallow: true } : {}),
      network: {
        transports: (spaceId: string, sessionDid: string) => {
          session = sessionDid;
          return [hub.transport(sessionDid, spaceId)];
        },
      },
    });
    nodes.push(node);
    return { node, stores, session: () => session };
  }

  /** Alice's space with one card edited `edits` times, kept whole by Bob, who it names its keeper */
  async function editedSpace(hub: FakeHub, edits: number, options: { keepers?: false } = {}) {
    const alice = await personOn(hub);
    const bob = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, { name: 'app.card', schema: { type: 'object' } });
    const { key } = await alice.node.records.put(space, 'app.card', { n: 0 });
    for (let n = 1; n <= edits; n++) await alice.node.records.update(space, key, { n });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(bob.node, space);
    await joined(bob.node, space);
    const versionsAt = async (who: { stores: StoreFactory }) =>
      (await createStorageProvider(await who.stores(`spaces/${space}`)).sums()).get('app.card')?.count ?? 0;
    await until(async () => (await versionsAt(bob)) === edits + 1, 10_000, 'Bob to keep every edit');
    if (options.keepers !== false) {
      await alice.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'Bob’s host' }]);
      // As at a host: the keeper knows it is one before anyone new comes.
      await until(
        async () => (await bob.node.spaces.access(space)).keepers.length === 1,
        10_000,
        'Bob to know he keeps it',
      );
    }
    return { alice, bob, space, key, versionsAt };
  }

  /** A new node of someone Alice invites, with the card's latest edit once it reads it */
  async function newcomer(hub: FakeHub, alice: P2PNode, space: string, key: string, shallow: boolean) {
    const dave = await personOn(hub, { shallow });
    await dave.node.spaces.join(await alice.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(
      async () => (await dave.node.records.get<{ n: number }>(space, key))?.body?.n === 200,
      20_000,
      'the latest edit',
    );
    return dave;
  }

  test('takes a record edited 200 times as its first and current version, from its keeper', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200);
    const dave = await newcomer(hub, alice.node, space, key, true);
    assert.equal(await versionsAt(dave), 2);
  });

  test('where the space names no keepers, nobody vouches for what it skips: it takes every edit', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200, { keepers: false });
    const dave = await newcomer(hub, alice.node, space, key, true);
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });

  test('a node that does not sync shallow takes every edit, as before', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200);
    const dave = await newcomer(hub, alice.node, space, key, false);
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });
});
