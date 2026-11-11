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
import { forge, makeKey } from './helpers/person.js';
import { createNode } from '../src/node/node.js';
import type { CacheConfig, P2PNode, ShallowMode } from '../src/node/types.js';
import type { StoreFactory } from '../src/node/stores.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { hold, letGo } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { until } from './helpers/until.js';
import { lineKey } from '../src/records/key.js';
import { assignKey } from '../src/space/space-access.js';

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

  test('a stub at a line key is in the set: a losing twin decides what counts', async () => {
    const [, second] = await editedRecord(1);
    const atLine = { ...stubOf(second!), key: await lineKey(second!.author, 'app.pay') };
    assert.ok(inShallowSet(atLine));
  });
});

describe('a node that syncs shallow', () => {
  const nodes: P2PNode[] = [];
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.close().catch(() => {})));
  });

  async function personOn(
    hub: FakeHub,
    options: { shallow?: ShallowMode; seed?: Uint8Array; cache?: CacheConfig } = {},
  ) {
    const manager = createIdentityManager();
    const seed = options.seed ?? generateSeed();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    let session = '';
    const config = {
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      watchIntervalMs: 0,
      network: {
        transports: (spaceId: string, sessionDid: string) => {
          session = sessionDid;
          return [hub.transport(sessionDid, spaceId)];
        },
      },
    };
    const node = await createNode({
      ...config,
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.shallow ? { shallow: options.shallow } : {}),
    });
    nodes.push(node);
    return { node, me, manager, stores, config, seed, session: () => session };
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
  async function newcomer(hub: FakeHub, alice: P2PNode, space: string, key: string, shallow?: ShallowMode) {
    const dave = await personOn(hub, shallow ? { shallow } : {});
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
    const dave = await newcomer(hub, alice.node, space, key, 'always');
    assert.equal(await versionsAt(dave), 2);
  });

  test('where the space names no keepers, nobody vouches for what it skips: it takes every edit', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200, { keepers: false });
    const dave = await newcomer(hub, alice.node, space, key, 'always');
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });

  test('shallow at first, it reads the latest edit, then takes the rest of the history', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200);
    const dave = await newcomer(hub, alice.node, space, key, 'first');
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });

  test('shallow at first, a space it already holds records of syncs whole from the start', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200);
    const dave = await newcomer(hub, alice.node, space, key, 'always');
    assert.equal(await versionsAt(dave), 2);
    await dave.node.close();
    const daveAgain = await createNode({ ...dave.config, shallow: 'first' });
    nodes.push(daveAgain);
    await hold(daveAgain, space);
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });

  test('a new device that removes someone at once waits for their whole line: what they wrote stands', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space, key } = await editedSpace(hub, 200);
    for (let n = 201; n <= 250; n++) await bob.node.records.update(space, key, { n });
    const latest = async (node: P2PNode) => (await node.records.get<{ n: number }>(space, key))?.body?.n;
    await until(async () => (await latest(alice.node)) === 250, 10_000, 'Alice to have Bob’s edits');

    const aliceAgain = await personOn(hub, { shallow: 'first', seed: alice.seed });
    await aliceAgain.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(aliceAgain.node, space);
    await until(async () => (await latest(aliceAgain.node)) === 250, 20_000, 'the latest edit');
    await aliceAgain.node.spaces.removeMember(space, bob.node.did);

    await until(
      async () =>
        !(await alice.node.spaces.access(space)).members.some((member) => member.did === bob.node.did),
      10_000,
      'Bob removed',
    );
    assert.equal(await latest(alice.node), 250, 'Bob’s edits before he was removed stand');
  });

  test('a node that stays shallow refuses to remove someone whose line it lacks', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space, key } = await editedSpace(hub, 20);
    for (let n = 21; n <= 30; n++) await bob.node.records.update(space, key, { n });
    const aliceAgain = await personOn(hub, { shallow: 'always', seed: alice.seed });
    await aliceAgain.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(aliceAgain.node, space);
    await until(
      async () => (await aliceAgain.node.records.get<{ n: number }>(space, key))?.body?.n === 30,
      20_000,
      'the latest edit',
    );
    await assert.rejects(
      aliceAgain.node.spaces.removeMember(space, bob.node.did),
      /doesn't hold all they wrote/,
    );
  });

  test('a payment line is held whole, so a shallow device pays after the last payment and its contract holds', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await personOn(hub);
    const bob = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Credit', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, {
      name: 'app.pay',
      schema: { type: 'object' },
      contract: {
        check: [
          {
            that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount',
            else: 'The balance follows from the one before',
          },
        ],
        line: { once: ['received'] },
      },
    });
    const line = await lineKey(alice.node.did, 'app.pay');
    await alice.node.records.put(space, 'app.pay', { amount: 1, balance: -1 }, { key: line });
    for (let paid = 2; paid <= 5; paid++)
      await alice.node.records.update(space, line, { amount: 1, balance: -paid });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(bob.node, space);
    await joined(bob.node, space);
    await until(
      async () => (await bob.node.records.get<{ balance: number }>(space, line))?.body?.balance === -5,
      10_000,
      'Bob to keep the line',
    );
    await alice.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'Bob’s host' }]);
    await until(
      async () => (await bob.node.spaces.access(space)).keepers.length === 1,
      10_000,
      'Bob keeping it',
    );

    const aliceAgain = await personOn(hub, { shallow: 'always', seed: alice.seed });
    await aliceAgain.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(aliceAgain.node, space);
    await until(
      async () => (await aliceAgain.node.records.get<{ balance: number }>(space, line))?.body?.balance === -5,
      20_000,
      'the last payment',
    );
    const sixth = await aliceAgain.node.records.update(space, line, { amount: 1, balance: -6 });
    assert.equal(
      (await createStorageProvider(await aliceAgain.stores(`spaces/${space}`)).sums()).get('app.pay')?.count,
      6,
      'every payment, retained',
    );
    await until(
      async () => (await alice.node.records.get<{ balance: number }>(space, line))?.body?.balance === -6,
      10_000,
      'Alice’s first device to count the sixth payment',
    );
    assert.notEqual((await alice.node.records.contracts(space, line, sixth.version))?.passes, false);
  });

  test('a node that does not sync shallow takes every edit, as before', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, space, key, versionsAt } = await editedSpace(hub, 200);
    const dave = await newcomer(hub, alice.node, space, key);
    await until(async () => (await versionsAt(dave)) === 201, 10_000, 'every edit');
  });

  test('a double spend counts on no shallow node: a line is held whole, losing twins too', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await personOn(hub);
    const bob = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Credit', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, {
      name: 'app.pay',
      schema: { type: 'object' },
      contract: { line: { once: ['received'] } },
    });
    const line = await lineKey(alice.node.did, 'app.pay');
    const first = await alice.node.records.put(space, 'app.pay', { amount: 30, balance: -30 }, { key: line });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(bob.node, space);
    await joined(bob.node, space);
    await alice.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'Bob’s host' }]);
    await until(
      async () => (await bob.node.spaces.access(space)).keepers.length === 1,
      10_000,
      'Bob keeps it',
    );

    // Two payments after the first, the losing one without `retain`: a superseded stub past the first.
    await letGo(alice.node, space);
    const after = { key: line, seq: 1, prev: first.version, genesis: first.version };
    const pay = (amount: number, retain: boolean) =>
      forge(
        alice,
        space,
        {
          collection: 'app.pay',
          ...(retain ? { retain: true } : {}),
          body: { amount, balance: -30 - amount, received: [] },
          version: after,
        },
        { keep: false },
      );
    let [winner, twin] = [await pay(50, true), await pay(60, false)];
    while (winner.id > twin.id) [winner, twin] = [await pay(50, true), await pay(60, false)];
    const store = createStorageProvider(await alice.stores(`spaces/${space}`));
    await store.addVersion(winner);
    await store.addVersion(twin);
    await hold(alice.node, space);
    const balance = async (node: P2PNode) =>
      (await node.records.get<{ balance: number }>(space, line))?.body?.balance;
    await until(async () => (await balance(bob.node)) === -30, 10_000, 'the keeper to fail both twins');

    const dave = await personOn(hub, { shallow: 'always' });
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(
      async () => (await balance(dave.node)) === -30,
      20_000,
      'the shallow node to fail both twins',
    );
  });

  test('a new device with its keeper away takes the latest edits whole from any other peer', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space, key } = await editedSpace(hub, 20);
    await bob.node.close();
    const dave = await personOn(hub, { shallow: 'first' });
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await until(
      async () => (await dave.node.records.get<{ n: number }>(space, key))?.body?.n === 20,
      20_000,
      'the latest edit, from Alice',
    );
  });

  /** As an app connected to an account home starts its node (`startConnectedNode`) */
  const APP_DEVICE = { shallow: 'first', cache: { collections: ['app.card'] } } as const;

  /** Alice's new space with Mallory in it and one card of hers, both on devices started with `options`, and no keeper */
  async function spaceOfTwoDevices(hub: FakeHub, options: Parameters<typeof personOn>[1]) {
    const alice = await personOn(hub, options);
    const mallory = await personOn(hub, options);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, { name: 'app.card', schema: { type: 'object' } });
    await mallory.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(mallory.node, space);
    await joined(mallory.node, space);
    const card = await mallory.node.records.put(space, 'app.card', { n: 1 });
    return { alice, mallory, space, card };
  }

  for (const [devices, options] of [
    ['two app devices', APP_DEVICE],
    ['two devices shallow at first', { shallow: 'first' }],
  ] as const) {
    test(`${devices} in a space with no keeper sync its records: neither waits for a node holding it whole`, async () => {
      const hub = createFakeHub({ latencyMs: 1 });
      const { alice, space, card } = await spaceOfTwoDevices(hub, options);
      await until(async () => (await alice.node.records.get(space, card.key)) !== null, 10_000, 'the card');
    });

    test(`${devices}, no keeper: whoever made the space removes a member at once, alone`, async () => {
      const hub = createFakeHub({ latencyMs: 1 });
      const { alice, mallory, space, card } = await spaceOfTwoDevices(hub, options);
      await until(async () => (await alice.node.records.get(space, card.key)) !== null, 10_000, 'the card');
      await mallory.node.close();

      const started = Date.now();
      await alice.node.spaces.removeMember(space, mallory.node.did);
      assert.ok(Date.now() - started < 5_000, 'no keeper to ask for shallow sets, so no history to wait for');
    });
  }

  test('a new device whose keeper is away removes someone only once it holds what they wrote: it stands', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space, key } = await editedSpace(hub, 5, { keepers: false });
    for (let n = 6; n <= 10; n++) await bob.node.records.update(space, key, { n });
    const latest = async (node: P2PNode) => (await node.records.get<{ n: number }>(space, key))?.body?.n;
    await until(async () => (await latest(alice.node)) === 10, 10_000, 'Alice to have Bob’s edits');
    const hostAway = await personOn(createFakeHub({ latencyMs: 1 }));
    await alice.node.spaces.setKeepers(space, [{ did: hostAway.node.did, name: 'A host, away' }]);
    await until(async () => (await bob.node.spaces.access(space)).keepers.length === 1, 10_000, 'the keeper');

    const aliceAgain = await personOn(hub, { shallow: 'first', seed: alice.seed });
    await aliceAgain.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(aliceAgain.node, space);
    await until(
      async () => (await aliceAgain.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
      10_000,
      'the new device to know Bob',
    );
    await aliceAgain.node.spaces.removeMember(space, bob.node.did);

    await until(
      async () =>
        !(await alice.node.spaces.access(space)).members.some((member) => member.did === bob.node.did),
      10_000,
      'Bob removed',
    );
    assert.equal(await latest(alice.node), 10, 'Bob’s edits before he was removed stand');
  });

  test('a device holding a space whole removes a member at once, a gap in their log or not', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await personOn(hub, { shallow: 'first' });
    const mallory = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, { name: 'app.card', schema: { type: 'object' } });
    await mallory.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(mallory.node, space);
    await joined(mallory.node, space);
    await letGo(mallory.node, space);
    const gapped = await forge(mallory, space, {
      collection: 'app.card',
      body: { spam: true },
      log: { n: 5, prev: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    await hold(mallory.node, space);
    await until(async () => (await alice.node.records.get(space, gapped.key)) !== null, 10_000, 'the spam');

    const started = Date.now();
    await alice.node.spaces.removeMember(space, mallory.node.did);
    assert.ok(Date.now() - started < 5_000, 'no wait for a gap that never fills');
  });

  /** Alice's card edited 10 times, kept by Bob; Bob, keeper and editor, slips in what `skipAhead` signs, past his gatekeeper */
  async function frozenOnNewDevice(
    hub: FakeHub,
    skipAhead: (
      bob: Awaited<ReturnType<typeof personOn>>,
      space: string,
      card: { key: string; first: string; second: string },
    ) => Promise<Version>,
  ) {
    const alice = await personOn(hub);
    const bob = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await alice.node.collections.define(space, { name: 'app.card', schema: { type: 'object' } });
    const first = await alice.node.records.put(space, 'app.card', { n: 0 });
    const second = await alice.node.records.update(space, first.key, { n: 1 });
    for (let n = 2; n <= 10; n++) await alice.node.records.update(space, first.key, { n });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(bob.node, space);
    await joined(bob.node, space);
    await alice.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'Bob’s host' }]);
    await until(
      async () => (await bob.node.spaces.access(space)).keepers.length === 1,
      10_000,
      'Bob keeps it',
    );
    const versionsAt = async (who: { stores: StoreFactory }) =>
      (await createStorageProvider(await who.stores(`spaces/${space}`)).sums()).get('app.card')?.count ?? 0;
    await until(async () => (await versionsAt(bob)) === 11, 10_000, 'Bob to keep every edit');

    await letGo(bob.node, space);
    const frozen = await skipAhead(bob, space, {
      key: first.key,
      first: first.version,
      second: second.version,
    });
    await hold(bob.node, space);

    const dave = await personOn(hub, { shallow: 'first' });
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(async () => (await versionsAt(dave)) >= 11, 20_000, 'the whole history');
    await alice.node.records.update(space, first.key, { n: 11 });
    await until(
      async () => (await dave.node.records.get<{ n: unknown }>(space, first.key))?.body?.n === 11,
      15_000,
      'the latest honest edit',
    );
    assert.equal(
      await createStorageProvider(await dave.stores(`spaces/${space}`)).getVersion(frozen.id),
      null,
    );
  }

  const frozenAt = (prev: string, card: { key: string; first: string }, seq = Number.MAX_SAFE_INTEGER) => ({
    collection: 'app.card',
    body: { n: 'frozen' },
    version: { key: card.key, seq, prev, genesis: card.first },
  });

  test('a version a keeper vouched for goes once the history shows it breaks the chain', async () => {
    await frozenOnNewDevice(createFakeHub({ latencyMs: 1 }), (bob, space, card) =>
      forge(bob, space, frozenAt(card.second, card)),
    );
  });

  test('a version a keeper vouched for goes once the history shows nobody has the one before', async () => {
    await frozenOnNewDevice(createFakeHub({ latencyMs: 1 }), (bob, space, card) =>
      forge(bob, space, frozenAt('bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', card)),
    );
  });

  test('a version a keeper vouched for goes when what it follows breaks the chain, and so does that', async () => {
    await frozenOnNewDevice(createFakeHub({ latencyMs: 1 }), async (bob, space, card) => {
      const broken = await forge(bob, space, frozenAt(card.second, card, Number.MAX_SAFE_INTEGER - 1));
      return forge(bob, space, frozenAt(broken.id, card));
    });
  });

  test('a keeper vouches for nothing in the access history: a role it slips in counts nowhere', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await personOn(hub);
    const bob = await personOn(hub);
    const erin = await personOn(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Board', ...team, visibility: 'public' });
    await hold(alice.node, space);
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(bob.node, space);
    await joined(bob.node, space);
    await alice.node.spaces.assign(space, bob.node.did, 'editor');
    await alice.node.spaces.setKeepers(space, [{ did: bob.session(), name: 'Bob’s host' }]);
    await alice.node.spaces.assign(space, erin.node.did, 'editor');
    await alice.node.spaces.unassign(space, erin.node.did, 'editor');
    const erinRoles = async (node: P2PNode) =>
      (await node.spaces.access(space)).members.find((member) => member.did === erin.node.did)?.roles ?? [];
    await until(
      async () => (await bob.node.spaces.access(space)).keepers.length === 1,
      10_000,
      'Bob keeps it',
    );
    await until(async () => (await erinRoles(bob.node)).length === 0, 10_000, 'Bob to see Erin unassigned');

    // Bob gives the role back at seq 1, after a version nobody has, with an id that leaves Alice's seq 1 current.
    const key = await assignKey(erin.node.did, 'editor');
    const assigned = await createStorageProvider(await alice.stores(`spaces/${space}`)).history(key);
    const [first, unassigned] = [assigned.find((v) => v.seq === 0)!, assigned.find((v) => v.seq === 1)!];
    const giveBack = () =>
      forge(
        bob,
        space,
        {
          collection: 'sys.assign',
          body: { did: erin.node.did, role: 'editor', assigned: true },
          retain: true,
          version: {
            key,
            seq: 1,
            prev: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
            genesis: first.id,
          },
        },
        { keep: false },
      );
    let slipped = await giveBack();
    while (slipped.id < unassigned.id) slipped = await giveBack();
    await letGo(bob.node, space);
    await createStorageProvider(await bob.stores(`spaces/${space}`)).addVersion(slipped);
    await hold(bob.node, space);

    const dave = await personOn(hub, { shallow: 'first' });
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(
      async () => (await dave.node.spaces.access(space)).keepers.length === 1,
      10_000,
      'Dave to know',
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(
      await createStorageProvider(await dave.stores(`spaces/${space}`)).getVersion(slipped.id),
      null,
    );
    assert.deepEqual(await erinRoles(dave.node), []);
  });

  test('a node that restarts while taking the history holds it once it is level again', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space } = await editedSpace(hub, 5);
    await alice.node.close();
    // As if it closed between deepening and being level on whole sets.
    await (await alice.stores(`spaces/${space}`)).put('taking-history', new Uint8Array());
    const aliceAgain = await createNode({ ...alice.config, shallow: 'first' });
    nodes.push(aliceAgain);
    await hold(aliceAgain, space);
    await aliceAgain.spaces.removeMember(space, bob.node.did);
  });

  test('shallow at first, with a keeper that never says it is level, it takes the history anyway', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { alice, bob, space, versionsAt } = await editedSpace(hub, 20);
    // One version every other node refuses, in the keeper's store: their shallow sets never match.
    const other = await alice.node.records.put(space, 'app.card', { other: 0 });
    await until(
      async () => (await bob.node.records.get(space, other.key)) !== null,
      10_000,
      'Bob to keep it',
    );
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'app.card',
      body: { other: 'refused' },
      version: { key: other.key, seq: 1000, prev: other.version, genesis: other.version },
    });
    await hold(bob.node, space);
    const dave = await personOn(hub, { shallow: 'first' });
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await joined(dave.node, space);
    await until(async () => (await versionsAt(dave)) === 22, 45_000, 'every edit, after a while');
  });
});
