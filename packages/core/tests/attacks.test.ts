/**
 * What a member — or a stranger in the room — must not be able to do to a
 * shared space. Each test is an attack found in a security audit, replayed
 * against the fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { SYNC_PROTOCOL_VERSION } from '../src/sync/sync-messages.js';
import { nextVersion } from '../src/records/version.js';
import { newRecordKey } from '../src/records/key.js';
import { isSealedBody } from '../src/privacy/space-encryption.js';
import { joined } from './helpers/joined.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { stored } from './helpers/stored.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { contactPublicKey, deriveContactKeyBytes } from '../src/identity/contact-key.js';
import { profileKey } from '../src/node/space-runtime.js';
import { until } from './helpers/until.js';
import type { Version } from '../src/types.js';
import { seenBy } from './helpers/as-member.js';
import { assignKey } from '../src/space/space-access.js';
import { ASSIGN_COLLECTION } from '../src/space/roles.js';
import { RECORD_DELETE, RECORD_WRITE } from '../src/space/grants.js';
import { forge, open, person, settle } from './helpers/person.js';
import { stubOf } from '../src/schema/version.js';
import type { SpaceRole } from '../src/types.js';

/** Editors here write and delete only what they made */
const ownOnly = [
  {
    name: 'editor',
    grants: [
      { cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] },
      { cmd: RECORD_DELETE, pol: [['==', '.byCreator', true]] },
    ],
  },
];

/** Alice founds a shared space whose editors change only their own records; Bob is an editor. */
async function setup() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({
    name: 'Polls',
    roles: ownOnly,
    visibility: 'public',
  });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  await alice.node.collections.define(space, {
    name: 'app.poll',
    schema: { type: 'object' },
    rules: { fixed: ['options'] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await until(
    async () =>
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.poll' && c.version !== null),
    4000,
    'the definition',
  );
  const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?', options: ['a'] });
  await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
  return { hub, alice, bob, space, poll };
}

describe('attacks on a shared space', () => {
  test('a sealed body copied into another record, or another collection, reads as unreadable', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Diary', ...team, visibility: 'private' });
    const note = await alice.node.records.put(space, 'app.note', { text: 'secret' });
    const sealed = (await (await stored(alice.stores, space)).getCurrent(note.key))!.body;
    assert.ok(isSealedBody(sealed));
    // The same ciphertext, signed into a record of its own and into another collection.
    const moved = await forge(alice, space, { collection: 'app.note', body: sealed });
    const relabelled = await forge(alice, space, {
      collection: 'app.other',
      body: sealed,
      version: { key: await newRecordKey(alice.node.did), seq: 0 },
    });
    assert.deepEqual((await alice.node.records.get(space, note.key))?.body, { text: 'secret' });
    for (const copy of [moved, relabelled]) {
      const read = await alice.node.records.get(space, copy.key);
      assert.ok(read, 'the copy is held, and shown');
      assert.equal(read.body, null);
    }
  });

  test("a version cannot escape its record's rules by naming another record as its first", async () => {
    const { alice, bob, space, poll } = await setup();
    const unruled = await bob.node.records.put(space, 'app.other', { x: 1 });
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'app.poll',
      body: { question: 'Hijacked', options: ['zzz'] },
      version: { key: poll.key, seq: 5, prev: poll.version, genesis: unruled.version },
    });
    await hold(bob.node, space);
    await until(async () => (await bob.node.spaces.status(space)).peers.length > 0, 4000, 'Bob to reconnect');
    await settle();
    assert.equal(
      (await alice.node.records.get<{ question: string }>(space, poll.key))?.body?.question,
      'Where?',
    );
  });

  test("a member cannot take down a collection's definition they did not write", async () => {
    const { alice, bob, space } = await setup();
    const definition = await createStorageProvider(await bob.stores(`spaces/${space}`)).getCurrent(
      'collection:app.poll',
    );
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'sys.collection',
      body: null,
      deleted: true,
      retain: true,
      version: nextVersion(definition!),
    });
    await hold(bob.node, space);
    // It does arrive — and changes nothing.
    await until(
      async () =>
        (await (await stored(alice.stores, space)).getCurrent('collection:app.poll'))?.seq ===
        definition!.seq + 1,
      4000,
      'the delete to arrive',
    );
    const poll = (await alice.node.collections.list(space)).find((c) => c.name === 'app.poll');
    assert.equal(poll?.version, 1);
    assert.deepEqual(poll?.rules, { fixed: ['options'] });
  });

  test("a definition the validator can't use can't break reading the collection, or the space", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const mallory = await person(hub);
    // team lets editors define collections
    const { id: space } = await alice.node.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    await mallory.node.spaces.join(await alice.node.spaces.invite(space, { role: 'editor' }));
    for (const { node } of [alice, mallory]) await hold(node, space);
    await joined(mallory.node, space);
    const message = {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
    };
    await alice.node.collections.define(space, { name: 'app.chat.message', schema: message });
    const note = await alice.node.records.put(space, 'app.chat.message', { text: 'hello' });
    await until(async () => (await mallory.node.records.get(space, note.key)) !== null, 4000, 'the message');

    // Values the validator can't build a schema from: a bad $id in an annotation,
    // which it follows anywhere it doesn't know, and a property name with a lone surrogate.
    await mallory.node.collections.define(space, {
      name: 'app.chat.message',
      schema: {
        ...message,
        'x-kind': { $id: 'http://[' },
        properties: { text: { type: 'string' }, '\uD800': { type: 'string' } },
      },
    });
    await until(
      async () =>
        (await alice.node.collections.list(space)).some(
          (c) => c.name === 'app.chat.message' && c.version === 2,
        ),
      4000,
      'the new definition',
    );
    assert.deepEqual((await alice.node.records.get(space, note.key))?.body, { text: 'hello' });
    assert.equal((await alice.node.records.list(space, { collection: 'app.chat.message' })).length, 1);
    assert.ok((await alice.node.records.list(space)).length > 0);
    await alice.node.records.put(space, 'app.chat.message', { text: 'still here' });
  });

  test('a member cannot freeze a record by skipping ahead to a seq nobody can outrank', async () => {
    const { alice, bob, space } = await setup();
    const note = await alice.node.records.put(space, 'app.note', { text: 'first' });
    await until(async () => (await bob.node.records.get(space, note.key)) !== null, 4000, 'the note');
    const rejected: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });

    const current = await createStorageProvider(await bob.stores(`spaces/${space}`)).getCurrent(note.key);
    await letGo(bob.node, space);
    await forge(bob, space, {
      collection: 'app.note',
      body: { text: 'frozen' },
      version: { ...nextVersion(current!), seq: Number.MAX_SAFE_INTEGER },
    });
    await hold(bob.node, space);

    await until(async () => rejected.length > 0, 4000, 'the jump to be refused');
    assert.match(rejected[0]!, /not one more/);
    // Alice's next edit is still the one that counts.
    await alice.node.records.update(space, note.key, { text: 'second' });
    assert.deepEqual((await alice.node.records.get(space, note.key))?.body, { text: 'second' });
  });

  test('a stranger sending a mangled copy first does not get the real record refused', async () => {
    const { hub, alice, bob, space } = await setup();
    await letGo(bob.node, space);
    const second = await alice.node.records.put(space, 'app.poll', { question: 'Second', options: ['a'] });
    const real = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(second.key);
    await letGo(alice.node, space);

    const rejected: string[] = [];
    bob.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    // No keys at all: just a copy with its signature broken, pushed unasked.
    const stranger = hub.transport('did:key:zstranger', space);
    stranger.on('connected', (peer: string) => {
      const payload = {
        v: SYNC_PROTOCOL_VERSION,
        type: 'push-update',
        version: { ...real!, signature: 'AAAA' },
      };
      stranger.send(
        peer,
        new TextEncoder().encode(JSON.stringify({ type: 'sync', from: 'did:key:zstranger', payload })),
      );
    });
    await stranger.connect();
    await hold(bob.node, space);
    await until(async () => rejected.length > 0, 4000, 'the mangled copy to be refused');

    await hold(alice.node, space);
    await until(
      async () => (await bob.node.records.get(space, second.key)) !== null,
      4000,
      'the real record',
    );
  });

  test('a copy with the real id and signature but another envelope is refused, though the real one stands', async () => {
    const { hub, alice, bob, space } = await setup();
    // Bob writes, then edits: every peer has judged the first version, and keeps it as a stub.
    const note = await bob.node.records.put(space, 'app.note', { text: 'honest' });
    const first = (await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(
      note.version,
    ))!;
    await until(async () => (await alice.node.records.get(space, note.key)) !== null, 4000, 'the note');
    await bob.node.records.update(space, note.key, { text: 'edited' });

    const rejected: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') rejected.push(event.reason);
    });
    // The same id, signature and body, under a record key Bob never wrote.
    const stranger = hub.transport('did:key:zstranger', space);
    stranger.on('connected', (peer: string) => {
      const payload = {
        v: SYNC_PROTOCOL_VERSION,
        type: 'push-update',
        version: { ...first, key: 'planted' },
      };
      stranger.send(
        peer,
        new TextEncoder().encode(JSON.stringify({ type: 'sync', from: 'did:key:zstranger', payload })),
      );
    });
    await stranger.connect();
    await until(async () => rejected.length > 0, 4000, 'the copy to be refused');
    assert.match(rejected.join(' '), /not the hash of what it says/);
    assert.equal(await alice.node.records.get(space, 'planted'), null);
  });

  test('changes nobody had the power for never freeze a space, however many (#183)', async () => {
    const { alice, bob, space } = await setup();
    const seen = [...(await seenBy(bob.node, space))];
    // More concurrent changes than a version may name, each dropped: none is a head.
    const flood: Version[] = [];
    for (let w = 0; w < 65; w++) {
      const did = `did:key:zWide${w}`;
      flood.push(
        await forge(
          bob,
          space,
          {
            collection: ASSIGN_COLLECTION,
            body: { did, role: 'editor', assigned: true },
            version: { key: await assignKey(did, 'editor'), seq: 0 },
            retain: true,
            seen,
          },
          { keep: false },
        ),
      );
    }
    await letGo(bob.node, space);
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    for (const version of flood) await store.addVersion(version);
    await hold(bob.node, space);
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(
      async () => (await Promise.all(flood.map((v) => aliceStore.getVersion(v.id)))).every(Boolean),
      20000,
      'the flood at Alice',
    );
    assert.ok((await alice.node.spaces.access(space)).heads.length <= 2);
    await alice.node.records.put(space, 'app.note', { text: 'still here' });
    await alice.node.spaces.removeMember(space, bob.node.did);
  });
});

describe('attacks on contacts', () => {
  /** Someone with a name, a contacts space and a contact key, in `space` as an editor */
  async function contactPerson(hub: FakeHub, name: string) {
    const seed = generateSeed();
    const manager = createIdentityManager();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      accountKey: await deriveAccountKey(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    await node.account.setName(name);
    return { node, me, manager, stores, seed };
  }

  /** Leif, Anna and Carol in a space Leif made, each seeing the others' contact keys */
  async function threeIn(visibility: 'public' | 'private') {
    const hub = createFakeHub({ latencyMs: 1 });
    const leif = await contactPerson(hub, 'Leif');
    const anna = await contactPerson(hub, 'Anna');
    const carol = await contactPerson(hub, 'Carol');
    const { id: space } = await leif.node.spaces.create({ name: 'Book club', ...team, visibility });
    for (const other of [anna, carol]) {
      await other.node.spaces.join(await leif.node.spaces.invite(space, { role: 'editor' }));
      await joined(other.node, space);
    }
    for (const who of [leif, anna, carol]) await hold(who.node, space);
    for (const who of [leif, anna, carol]) {
      await until(
        async () => (await who.node.spaces.profiles(space)).filter((p) => p.contactKey).length === 3,
        5000,
        'everyone’s contact key',
      );
    }
    return { hub, leif, anna, carol, space };
  }

  test('a contact key on a profile signed by another account is ignored', async () => {
    const { leif, anna, carol, space } = await threeIn('public');
    const annasKey = contactPublicKey(await deriveContactKeyBytes(anna.seed));
    const current = await createStorageProvider(await carol.stores(`spaces/${space}`)).getCurrent(
      await profileKey(anna.node.did),
    );
    await letGo(carol.node, space);
    // Carol writes "Anna's" profile, carrying Carol's own contact key.
    await forge(carol, space, {
      collection: 'sys.profile',
      body: { name: 'Anna', contactKey: contactPublicKey(await deriveContactKeyBytes(carol.seed)) },
      retain: true,
      version: { key: current!.key, seq: current!.seq + 1, prev: current!.id, genesis: current!.id },
    });
    await hold(carol.node, space);
    await until(
      async () =>
        (await (await stored(leif.stores, space)).getCurrent(await profileKey(anna.node.did)))?.seq ===
        current!.seq + 1,
      4000,
      'the forgery to arrive',
    );
    const seen = (await leif.node.spaces.profiles(space)).find((profile) => profile.did === anna.node.did);
    assert.equal(seen?.contactKey, annasKey);
  });

  test('a knock re-posted by someone else does not open as theirs, nor as anyone’s', async () => {
    const { leif, anna, carol, space } = await threeIn('private');
    await leif.node.contacts.ask(space, anna.node.did);
    await until(
      async () => (await carol.node.records.list(space, { collection: 'std.contact-request' })).length === 1,
      5000,
      'the knock',
    );
    const [original] = await carol.node.records.list<{ to: string; sealed: string }>(space, {
      collection: 'std.contact-request',
    });

    // Carol leaves Leif's sealed knock as her own.
    await carol.node.records.put(space, 'std.contact-request', original!.body!);
    await until(
      async () => (await anna.node.records.list(space, { collection: 'std.contact-request' })).length === 2,
      5000,
      'Carol’s copy',
    );
    assert.deepEqual(
      (await anna.node.contacts.requests(space)).map((request) => [request.key, request.from]),
      [[original!.key, leif.node.did]],
      'only the original, from Leif',
    );
  });
});

// Found by the adversarial review of grants: a stub and its whole version share an id and a
// signature, so a verdict on the stub, judged without its body, was kept for the whole.
describe('a stub sent ahead of its body', () => {
  /** Pushes versions to whoever connects, one at a time, as a stranger in the room */
  async function push(hub: FakeHub, space: string, versions: ReadonlyArray<unknown>) {
    const stranger = hub.transport('did:key:zstubber', space);
    // One at a time, so each is judged before the next arrives.
    const sendAll = async (peer: string) => {
      for (const version of versions) {
        const payload = { v: SYNC_PROTOCOL_VERSION, type: 'push-update', version };
        stranger.send(
          peer,
          new TextEncoder().encode(JSON.stringify({ type: 'sync', from: 'did:key:zstubber', payload })),
        );
        await settle(300);
      }
    };
    stranger.on('connected', (peer: string) => void sendAll(peer));
    await stranger.connect();
  }

  async function space(roles: ReadonlyArray<SpaceRole>) {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id } = await alice.node.spaces.create({ name: 'S', roles, visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(id, { role: 'editor' }));
    await hold(alice.node, id);
    await joined(bob.node, id);
    await settle(300);
    return { hub, alice, bob, space: id };
  }

  test('does not get the whole version past a policy on its body', async () => {
    const {
      hub,
      alice,
      bob,
      space: id,
    } = await space([
      {
        name: 'editor',
        grants: [
          {
            cmd: RECORD_WRITE,
            pol: [
              ['==', '.collection', 'app.note'],
              ['!=', '.body.text', 'spam'],
            ],
          },
        ],
      },
    ]);
    const bad = await forge(bob, id, { collection: 'app.note', body: { text: 'spam' } }, { keep: false });
    const good = await forge(bob, id, { collection: 'app.note', body: { text: 'hello' } }, { keep: false });
    await push(hub, id, [stubOf(bad), bad, stubOf(good), good]);
    await until(async () => (await alice.node.records.get(id, good.key)) !== null, 6000, 'the honest note');
    assert.equal(await alice.node.records.get(id, bad.key), null, 'the body its grant forbids');
  });

  test('does not get the whole edit past `fixed`', async () => {
    const {
      hub,
      alice,
      bob,
      space: id,
    } = await space([{ name: 'editor', grants: [{ cmd: '/record', pol: [] }] }]);
    await alice.node.collections.define(id, {
      name: 'app.poll',
      schema: { type: 'object' },
      rules: { fixed: ['options'] },
    });
    const poll = await alice.node.records.put(id, 'app.poll', { question: 'Q', options: ['a'] });
    await until(async () => (await bob.node.records.get(id, poll.key)) !== null, 4000, 'the poll');
    const current = await (await stored(bob.stores, id)).getCurrent(poll.key);
    const bad = await forge(
      bob,
      id,
      { collection: 'app.poll', body: { question: 'Q', options: ['zzz'] }, version: nextVersion(current!) },
      { keep: false },
    );
    await push(hub, id, [stubOf(bad), bad]);
    await settle(1200);
    const read = await alice.node.records.get<{ options: string[] }>(id, poll.key);
    assert.deepEqual(read?.body?.options, ['a']);
  });
});
