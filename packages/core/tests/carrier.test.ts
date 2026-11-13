/**
 * Carriers: a node holding passes, not keys, that keeps an account's spaces
 * online — and its pod current — without being able to read or write them.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { createCarrierNode, createCarryCore, type CarrierNode } from '../src/node/carrier.js';
import { folderStores, type StoreFactory } from '../src/node/stores.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createMeshAuth } from '../src/network/peer-auth.js';
import { makePass, openPass, carriedRecord } from '../src/space/pass.js';
import { readKeyFromSeed } from '../src/space/space-access.js';
import { base64UrlEncode } from '../src/utils/encoding.js';
import { joined } from './helpers/joined.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { until } from './helpers/until.js';
import { selfSigner } from './helpers/invitation.js';

const provider = createP256Provider();
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function account(seed = generateSeed()) {
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveAccountKey(seed),
  };
}
type Account = Awaited<ReturnType<typeof account>>;

const onHub = (hub: FakeHub) => ({
  transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
});

async function device(
  me: Account,
  hub: FakeHub | null,
  stores: StoreFactory = memoryStores(),
  options: { accountKey?: boolean } = {},
): Promise<P2PNode> {
  const node = await createNode({
    signer: me.signer,
    stores,
    ...(options.accountKey === false ? {} : { accountKey: me.accountKey }),
    watchIntervalMs: 20,
    ...(hub ? { network: onHub(hub) } : {}),
  });
  open.push(node);
  return node;
}

async function carrierKey() {
  const keys = await provider.generateKeyPair();
  return { keys, did: publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC) };
}

async function carrier(
  me: Account,
  invite: string,
  hub: FakeHub,
  stores = memoryStores(),
  key?: CryptoKeyPair,
): Promise<CarrierNode> {
  const node = await createCarrierNode({
    key: key ?? (await carrierKey()).keys,
    account: me.did,
    carry: invite,
    stores,
    network: onHub(hub),
    watchIntervalMs: 20,
  });
  open.push(node);
  return node;
}

const carries = (node: CarrierNode, spaceId: string) => async () =>
  (await node.spaces()).some((space) => space.id === spaceId);

describe('passes', () => {
  test('a pass opens a private space for carrying, and holds no key', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const record = await registry.create({
      name: 'Notes',
      visibility: 'private',
      creator: 'did:key:zCreator',
    });
    const pass = await makePass(record);

    assert.equal(
      JSON.stringify(pass).includes(
        parseSpaceInvite(await registry.createInvite(record.space.id, await selfSigner())).key!,
      ),
      false,
    );
    const opened = await openPass(pass, provider);
    assert.ok(opened);
    assert.equal(opened.read?.did, record.space.readKey);
    assert.equal(carriedRecord(opened).key, null);
  });

  test("a pass whose space was edited, or whose read key is another space's, is refused", async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const a = await registry.create({ name: 'A', visibility: 'private', creator: 'did:key:zCreator' });
    const b = await registry.create({ name: 'B', visibility: 'private', creator: 'did:key:zCreator' });
    const pass = await makePass(a);

    assert.equal(
      await openPass({ ...pass, space: { ...pass.space, creator: 'did:key:zSomeoneElse' } }, provider),
      null,
    );
    assert.equal(await openPass({ ...pass, read: (await makePass(b)).read }, provider), null);
    assert.equal(await openPass({ ...pass, read: 7 }, provider), null);
  });

  test('a pass for a private space may bring no read key: it opens, with nothing to prove read with', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const a = await registry.create({ name: 'A', visibility: 'private', creator: 'did:key:zCreator' });
    const { space } = await makePass(a);
    assert.deepEqual(await openPass({ v: 1, space }, provider), { space, read: null });
  });

  test('a carrier that is only dialled takes nothing from a pass but the space: no pass handed over reopens it', async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const record = await registry.create({
      name: 'Club',
      visibility: 'private',
      creator: 'did:key:zCreator',
    });
    const fromAMember = await makePass(record);
    const core = await createCarryCore({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      emit: () => {},
      onClosed: () => {},
    });
    await core.addPass(fromAMember);
    const opened = core.carried.get(record.space.id)?.runtime;
    assert.ok(opened);
    assert.equal(core.carried.get(record.space.id)?.record.read, null, 'it keeps no read key');

    // Someone holding only the constitution: a pass with no seed, then one with a seed of their own making.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const madeUp = {
      v: 1,
      space: fromAMember.space,
      read: base64UrlEncode(seed),
      readKey: (await readKeyFromSeed(seed, provider)).did,
    };
    for (const pass of [{ v: 1, space: fromAMember.space }, madeUp]) {
      await core.addPass(pass);
      assert.equal(core.carried.get(record.space.id)?.runtime, opened, 'the space stays open as it was');
    }
    assert.equal(core.readKeyOf(record.space.id), record.space.readKey);
    await core.close();
  });

  test("the read key from a pass is enough to join the space's peers", async () => {
    const registry = createSpaceManager(createMemoryAdapter(), provider);
    const record = await registry.create({
      name: 'Notes',
      visibility: 'private',
      creator: 'did:key:zCreator',
    });
    const opened = (await openPass(await makePass(record), provider))!;

    const one = await carrierKey();
    const two = await carrierKey();
    const read = { key: opened.read, publicDid: record.space.readKey! };
    const prover = createMeshAuth(
      record.space.id,
      { did: one.did, key: one.keys.privateKey },
      read,
      provider,
    );
    const checker = createMeshAuth(
      record.space.id,
      { did: two.did, key: two.keys.privateKey },
      read,
      provider,
    );
    const proof = await prover.prove(two.did, 'nonce', null);
    assert.equal(await checker.check(one.did, 'nonce', null, proof), true);
  });
});

describe('a carrier', () => {
  test('added twice at once, it gets one carry space', async () => {
    const me = await account();
    const home = await device(me, null);
    const did = (await carrierKey()).did;
    const [one, two] = await Promise.all([
      home.carriers.add({ did, name: 'host.example' }),
      home.carriers.add({ did, name: 'host.example' }),
    ]);
    assert.equal(one.space, two.space);
    assert.equal((await home.carriers.list()).length, 1);
  });

  test('its carry space cannot be left, as the registry and the contacts cannot', async () => {
    const me = await account();
    const home = await device(me, null);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    await assert.rejects(home.spaces.leave(added.space), /carry space cannot be left/);
    assert.equal((await home.carriers.list()).length, 1);
  });

  test('the carry space of a carrier that was removed is still a carry space', async () => {
    const me = await account();
    const home = await device(me, null);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    await home.carriers.remove(added.space);
    assert.deepEqual(await home.carriers.list(), []);
    await assert.rejects(home.spaces.leave(added.space), /carry space cannot be left/);
  });

  test('adding one that fails leaves no carry space behind, to come back as a space the account uses', async () => {
    const me = await account();
    const stores = memoryStores();
    const home = await device(me, null, stores);
    // A home whose key the account revoked: every write to the registry is refused.
    await home.account.revoke(home.sessionDid);
    await assert.rejects(home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' }), /revoked/);
    assert.deepEqual(await home.spaces.list(), []);
    await home.close();

    // Started again with a new key, it finds nothing it holds but never recorded.
    const again = await device(me, null, stores);
    assert.deepEqual(await again.spaces.list(), []);
  });

  test("carries every space of the account, and holds no key but its carry space's", async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const blog = await laptop.spaces.create({ name: 'Blog', visibility: 'public' });

    const { did, keys } = await carrierKey();
    const added = await laptop.carriers.add({ did, name: 'Chrome' });
    const stores = memoryStores();
    const node = await carrier(me, added.invite, hub, stores, keys);

    await until(carries(node, notes.id), 5000, 'the private space to be carried');
    await until(carries(node, blog.id), 5000, 'the public space to be carried');
    assert.deepEqual(
      (await laptop.carriers.list()).map((c) => c.did),
      [did],
    );
    // Connected in the space, it is named a carrier — not one of the account's devices.
    await until(
      async () => (await laptop.spaces.status(notes.id)).carriers.includes(did),
      5000,
      'the carrier to be named',
    );
    assert.deepEqual((await laptop.spaces.status(notes.id)).own, []);
    // The carry space is the account's, but not a space it uses.
    assert.equal(
      (await laptop.spaces.list()).some((space) => space.id === added.space),
      false,
    );

    // Its own registry holds one space — the carry space — and so one key.
    const registry = createSpaceManager(await stores('registry'), provider);
    assert.deepEqual(
      (await registry.list()).map((record) => record.space.id),
      [added.space],
    );
  });

  test('is named a keeper of the spaces the account manages, and no longer once removed', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const keepers = async () => (await laptop.spaces.access(notes.id)).keepers;

    const { did } = await carrierKey();
    const added = await laptop.carriers.add({ did, name: 'Chrome' });
    await until(
      async () => (await keepers()).some((k) => k.did === did),
      5000,
      'the carrier to be named a keeper',
    );
    assert.deepEqual(await keepers(), [{ did, name: 'Chrome' }]);

    // The account's personal space names it too, as a keeper of everything it lists; its own carry space does not.
    const registry = (await laptop.account.space())!;
    const registryKeepers = async () => (await laptop.spaces.access(registry)).keepers;
    await until(
      async () => (await registryKeepers()).some((k) => k.did === did),
      5000,
      'the registry to name the carrier',
    );
    assert.deepEqual((await laptop.spaces.access(added.space)).keepers, []);

    // A space made after the carrier was added names it too.
    const later = await laptop.spaces.create({ name: 'Later', visibility: 'public' });
    await until(
      async () => (await laptop.spaces.access(later.id)).keepers.length === 1,
      5000,
      'the new space to name it',
    );

    await laptop.carriers.remove(added.space);
    await until(async () => (await keepers()).length === 0, 5000, 'the carrier to be no longer named');
    await until(async () => (await registryKeepers()).length === 0, 5000, 'nor in the registry');
  });

  test('two devices never online together meet through it, and it cannot read what it carries', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    await laptop.records.put(notes.id, 'note', { text: 'the secret plan' });
    const added = await laptop.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const stores = memoryStores();
    const node = await carrier(me, added.invite, hub, stores);

    const rootOf = async (n: { spaces: { status(id: string): Promise<{ fingerprint: string }> } }) =>
      (await n.spaces.status(notes.id)).fingerprint;
    const carriedRoot = async () =>
      (await node.spaces()).find((s) => s.id === notes.id) && (await laptopStatusRoot());
    const laptopStatusRoot = async () => rootOf(laptop);
    await until(async () => !!(await carriedRoot()), 5000, 'the space to be carried');
    // Wait until the carrier holds what the laptop holds.
    await until(
      async () => (await stores(`spaces/${notes.id}`)).list('').then((keys) => keys.length > 0),
      5000,
      'records at the carrier',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await laptop.close();

    // Nothing readable at the carrier.
    const adapter = await stores(`spaces/${notes.id}`);
    for (const key of await adapter.list('')) {
      const bytes = await adapter.get(key);
      assert.equal(new TextDecoder().decode(bytes ?? new Uint8Array()).includes('the secret plan'), false);
    }

    // A phone that was never online with the laptop gets everything from the carrier.
    const phone = await device(me, hub);
    await until(
      async () => (await phone.spaces.list()).some((space) => space.id === notes.id),
      5000,
      'the phone to learn of the space',
    );
    await until(
      async () => (await phone.records.list(notes.id)).length === 1,
      5000,
      'the note to reach the phone',
    );
    assert.deepEqual((await phone.records.list(notes.id))[0]?.body, { text: 'the secret plan' });
  });

  test("the account's list never names its carry space, and a list that does is not followed", async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const carrySpace = parseSpaceInvite(added.invite).space.id;
    const registry = await home.account.space();
    assert.ok(registry);
    const listed = async (node: P2PNode) =>
      (await node.records.list(registry, { collection: 'sys.joined' })).map((record) => record.key);

    // Joined with its invite where the carrier is known, it stays off the list.
    await home.spaces.join(added.invite);
    assert.deepEqual(await listed(home), []);

    // A device that hasn't heard of the carrier yet lists it, as older devices did.
    const offline = memoryStores();
    const old = await device(me, null, offline);
    await old.spaces.join(added.invite);
    assert.deepEqual(await listed(old), [`space:${carrySpace}`]);
    await old.close();
    await device(me, hub, offline);
    await until(async () => (await listed(home)).length === 1, 5000, 'the listing to reach the home');

    // A new device opens it as the carry space it is, and never joins it as one of the account's spaces.
    const stores = memoryStores();
    const phone = await device(me, hub, stores);
    await until(async () => (await listed(phone)).length === 1, 5000, 'the list to reach the phone');
    await until(
      async () => (await phone.carriers.list()).length === 1,
      5000,
      'the phone to hear of the carrier',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const registryStore = await stores('registry');
    const held = (await registryStore.list('')).join(' ');
    assert.equal(held.includes(carrySpace), false, 'joined the carry space from the list');
  });

  test('a listing of its carry space that is deleted is not followed as leaving it', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const homeStores = memoryStores();
    const home = await device(me, hub, homeStores);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const carrySpace = parseSpaceInvite(added.invite).space.id;
    await home.spaces.join(added.invite);
    const registry = await home.account.space();
    assert.ok(registry);

    // A device that hasn't heard of the carrier lists the carry space, then leaves it.
    const offline = memoryStores();
    const old = await device(me, null, offline);
    await old.spaces.join(added.invite);
    await old.spaces.leave(carrySpace);
    await old.close();
    await device(me, hub, offline);
    await until(
      async () =>
        (await home.records.list(registry, { collection: 'sys.joined', includeDeleted: true })).length === 1,
      5000,
      'the deleted listing to reach the home',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const held = (await (await homeStores('registry')).list('')).join(' ');
    assert.equal(held.includes(carrySpace), true, 'the home let its carry space go');
  });

  test('a space made after it was added is carried, with nothing done in the home', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub);

    // Another device of the account — an app with the account key — makes a space.
    const app = await device(me, hub);
    await until(async () => (await app.carriers.list()).length === 1, 5000, 'the app to hear of the carrier');
    const made = await app.spaces.create({ name: 'Made in an app', visibility: 'private' });
    await until(carries(node, made.id), 5000, 'the new space to be carried');

    await app.spaces.leave(made.id);
    await until(async () => !(await carries(node, made.id)()), 5000, 'the space left to stop being carried');
  });

  test('opens each pass once while it stays, though it reads them all on every change', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const first = await home.spaces.create({ name: 'First', visibility: 'private' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    let derived = 0;
    const node = await createCarrierNode({
      key: (await carrierKey()).keys,
      account: me.did,
      carry: added.invite,
      stores: memoryStores(),
      network: onHub(hub),
      provider: {
        ...provider,
        deriveKeyPairFromSeed: (seed: Uint8Array) => {
          derived += 1;
          return provider.deriveKeyPairFromSeed(seed);
        },
      },
    });
    open.push(node);
    await until(carries(node, first.id), 5000, 'the first space to be carried');
    const before = derived;

    // Each new pass is a change to the carry space: every pass is read again, and only the new one opened.
    const more = [];
    for (const name of ['Second', 'Third'])
      more.push(await home.spaces.create({ name, visibility: 'private' }));
    for (const space of more) await until(carries(node, space.id), 5000, `${space.name} to be carried`);
    assert.equal(derived - before, more.length);
  });

  test('keeps the pod current while every app is closed', async () => {
    const me = await account();
    const friend = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const pod = createMemoryDirectory('pod');
    const dataPath = 'accounts/me/stores';
    const podStores = () => folderStores(pod.open(), { basePath: dataPath, local: memoryStores() });

    // The home, on the pod.
    const home = await device(me, hub, podStores());
    const shared = await home.spaces.create({ name: 'Shared', visibility: 'private', ...team });
    const invite = await home.spaces.invite(shared.id, { role: 'editor' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });

    const node = await carrier(me, added.invite, hub);
    await node.usePod(podStores());
    await until(carries(node, shared.id), 5000, 'the shared space to be carried');

    const theirs = await device(friend, hub);
    await theirs.spaces.join(invite);
    await until(
      async () => await theirs.records.can(shared.id, 'create', 'note'),
      5000,
      'the friend to join',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await home.close();

    // The friend writes while every one of our apps is closed.
    await theirs.records.put(shared.id, 'note', { text: 'while you were away' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await theirs.close();

    // The home opens on the pod, with nobody online at all, and it is there.
    const back = await device(me, null, podStores());
    await until(
      async () => (await back.records.list(shared.id)).length === 1,
      5000,
      'the note to be in the pod',
    );
    assert.deepEqual((await back.records.list(shared.id))[0]?.body, { text: 'while you were away' });

    // It only ever wrote spaces: the account's sealed registry is the home's alone.
    assert.ok(
      pod
        .paths()
        .every(
          (path) =>
            !path.startsWith(`${dataPath}/`) ||
            path.startsWith(`${dataPath}/spaces/`) ||
            path.startsWith(`${dataPath}/registry/`),
        ),
    );
  });

  test('added on two devices at once, it gets one carry space, and a removal on either closes it', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const phoneStores = memoryStores();
    const offline = await device(me, null, phoneStores);
    const { did, keys } = await carrierKey();
    // Neither has heard of the other's when it adds its own.
    const onLaptop = await laptop.carriers.add({ did, name: 'host.example' });
    const onPhone = await offline.carriers.add({ did, name: 'Chrome' });
    // One carry space, whichever device signed the invite to it.
    assert.equal(onPhone.space, onLaptop.space);
    assert.equal(parseSpaceInvite(onPhone.invite).space.id, parseSpaceInvite(onLaptop.invite).space.id);
    await offline.close();
    const phone = await device(me, hub, phoneStores);
    // The carrier holds the phone's answer.
    const node = await carrier(me, onPhone.invite, hub, memoryStores(), keys);
    let closed = false;
    node.subscribe((event) => {
      if (event.type === 'closed') closed = true;
    });
    await until(async () => (await node.spaces()).length > 0, 8000, 'the carrier to carry');

    await laptop.carriers.remove(onLaptop.space);
    assert.deepEqual(await laptop.carriers.list(), []);
    await until(async () => closed, 8000, 'the carrier to be told to forget');
    await until(async () => (await phone.carriers.list()).length === 0, 8000, 'the phone to hear');
  });

  test('added again after it was removed, it gets a new carry space, and is not told to forget there', async () => {
    // A host keeps its key: the account stops paying, then pays again.
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const notes = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    const { did, keys } = await carrierKey();
    const first = await home.carriers.add({ did, name: 'host.example' });
    await home.carriers.remove(first.space);
    const again = await home.carriers.add({ did, name: 'host.example' });
    assert.notEqual(again.space, first.space);
    assert.deepEqual(
      (await home.carriers.list()).map((c) => c.space),
      [again.space],
    );
    const node = await carrier(me, again.invite, hub, memoryStores(), keys);
    let closed = false;
    node.subscribe((event) => {
      if (event.type === 'closed') closed = true;
    });
    await until(carries(node, notes.id), 5000, 'Notes to be carried');
    assert.equal(closed, false);
  });

  test('removed while a refill runs, no pass is written back', async () => {
    const me = await account();
    const home = await device(me, null);
    for (let i = 0; i < 8; i++) await home.spaces.create({ name: `S${i}`, visibility: 'private' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    assert.ok(await home.carriers.settled(10_000));
    // A new space starts a refill; the removal lands while it runs.
    await home.spaces.create({ name: 'More', visibility: 'private' });
    await home.carriers.remove(added.space);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const live = (await home.records.list(added.space, { collection: 'sys.pass' })).filter((r) =>
      r.key.startsWith('pass:'),
    );
    assert.deepEqual(live, []);
  });

  test('removing it tells it to forget, and stops the passes', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    await home.spaces.create({ name: 'Notes', visibility: 'private' });
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub);
    // Its own carry space, the registry, the contacts, and Notes.
    await until(async () => (await node.spaces()).length === 4, 5000, 'the spaces to be carried');

    let closed = false;
    node.subscribe((event) => {
      if (event.type === 'closed') closed = true;
    });
    await home.carriers.remove(added.space);
    await until(async () => closed, 5000, 'the carrier to hear it was removed');
    assert.deepEqual(await home.carriers.list(), []);
  });

  test('a home that closes once the carrier is reached leaves it everything, with no other device online', async () => {
    // The account home's window adds the carrier, answers, and goes: nothing else holds what it wrote.
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const popup = await device(me, hub);
    const notes = await popup.spaces.create({ name: 'Notes', visibility: 'private' });
    const { did, keys } = await carrierKey();
    const added = await popup.carriers.add({ did, name: 'Chrome' });
    // The extension starts its carrier once the answer reaches it, while the window waits.
    const reached = popup.carriers.reached(added.space, 5000);
    const node = await carrier(me, added.invite, hub, memoryStores(), keys);
    assert.equal(await reached, true);
    await popup.close();

    await until(carries(node, notes.id), 5000, 'Notes to be carried once the home has closed');
    // A device that comes later hears of the carrier from the carrier itself.
    const laptop = await device(me, hub);
    await until(
      async () => (await laptop.carriers.list()).some((c) => c.did === did),
      5000,
      'the next device to learn of the carrier',
    );
  });

  test('a space made just now, carried before its invite goes out, can be joined with the maker gone', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const { did, keys } = await carrierKey();
    const added = await laptop.carriers.add({ did, name: 'host.example' });
    await carrier(me, added.invite, hub, memoryStores(), keys);
    assert.equal(await laptop.carriers.reached(added.space, 5000), true);

    // Made, invited to, carried with its invite, and the laptop goes at once.
    const pair = await laptop.spaces.create({ name: 'Us', ...team, visibility: 'private' });
    const invite = await laptop.spaces.invite(pair.id, { role: 'editor' });
    assert.equal(await laptop.spaces.carried(pair.id), true);
    await laptop.close();

    // A friend who was never online with the laptop joins through the carrier, and takes the role.
    const friend = await device(await account(), hub);
    await friend.spaces.join(invite);
    await joined(friend, pair.id);
    await until(async () => friend.spaces.holdsRole(pair.id, 'editor'), 5000, 'the friend to hold the role');
  });

  test('carried is false at once with no carrier, or with one that is not online', async () => {
    const me = await account();
    const home = await device(me, createFakeHub({ latencyMs: 1 }));
    const space = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    for (const step of ['none', 'offline']) {
      if (step === 'offline') await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
      const started = Date.now();
      assert.equal(await home.spaces.carried(space.id), false);
      assert.ok(Date.now() - started < 1000, `${step}: took ${Date.now() - started} ms`);
    }
  });

  test('reached is true at once for a carrier already level', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const notes = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    const { did, keys } = await carrierKey();
    const added = await home.carriers.add({ did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub, memoryStores(), keys);
    await until(carries(node, notes.id), 5000, 'Notes to be carried');
    await home.carriers.reached(added.space, 5000);
    // Level, the peer has nothing to say back to a hello: this must not wait for one.
    const started = Date.now();
    assert.equal(await home.carriers.reached(added.space, 4000), true);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });

  test('reached is false when the carrier never comes', async () => {
    const me = await account();
    const home = await device(me, createFakeHub({ latencyMs: 1 }));
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    assert.equal(await home.carriers.reached(added.space, 200), false);
  });

  test('the same carrier connecting again keeps its carry space, and is not told to forget', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const notes = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    const { did, keys } = await carrierKey();
    const first = await home.carriers.add({ did, name: 'Chrome' });
    const node = await carrier(me, first.invite, hub, memoryStores(), keys);
    await until(carries(node, notes.id), 5000, 'Notes to be carried');
    let closed = false;
    node.subscribe((event) => {
      if (event.type === 'closed') closed = true;
    });

    const again = await home.carriers.add({ did, name: 'Chrome' });
    assert.equal(again.space, first.space);
    assert.equal(parseSpaceInvite(again.invite).space.id, first.space);
    assert.equal((await home.carriers.list()).length, 1);
    assert.equal(await home.carriers.reached(again.space, 5000), true);
    assert.equal(closed, false);
  });

  test('a device without the account key does not see carriers, and apps cannot write passes', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const home = await device(me, hub);
    const added = await home.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const notes = await home.spaces.create({ name: 'Notes', visibility: 'private' });
    await assert.rejects(home.records.put(notes.id, 'sys.pass', { v: 1 }), /written by the node itself/);
    await assert.rejects(home.records.put(added.space, 'sys.pass', { v: 1 }), /written by the node itself/);
  });
});

describe('what a carrier sees of a space', () => {
  test('what a carrier can offer to notify about: the kinds of record, by name; a title and topics only where it can read the definition', async () => {
    const me = await account();
    const hub = createFakeHub({ latencyMs: 1 });
    const laptop = await device(me, hub);
    const club = await laptop.spaces.create({ name: 'Club', visibility: 'private' });
    const blog = await laptop.spaces.create({ name: 'Blog', visibility: 'public' });
    for (const space of [club, blog]) {
      await laptop.collections.define(space.id, {
        name: 'app.chat',
        title: 'Chat message',
        schema: { type: 'object' },
        topics: ['mentions'],
      });
      await laptop.records.put(space.id, 'app.chat', { text: 'hi' });
    }

    const added = await laptop.carriers.add({ did: (await carrierKey()).did, name: 'Chrome' });
    const node = await carrier(me, added.invite, hub);
    const settled = async (spaceId: string, title?: string) => {
      const [found] = await node.collections(spaceId);
      return found?.records === 1 && found.title === title;
    };
    await until(() => settled(club.id), 5000, "the private space's record to be carried");
    await until(
      () => settled(blog.id, 'Chat message'),
      5000,
      "the public space's record and definition to be carried",
    );

    assert.deepEqual(
      await node.collections(club.id),
      [{ name: 'app.chat', topics: [], records: 1 }],
      'private: the name, from the outside of records',
    );
    assert.deepEqual(await node.collections(blog.id), [
      { name: 'app.chat', title: 'Chat message', topics: ['mentions'], records: 1 },
    ]);
    assert.deepEqual(await node.collections(node.carrySpace), [], 'its carry space offers nothing');
  });
});
