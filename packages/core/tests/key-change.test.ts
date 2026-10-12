/**
 * A private space's key changes when someone loses their place in it: the
 * replay that says when one is due, and real nodes that make it, seal it to
 * each member and take it in — so someone removed reads nothing new, a
 * member who was away catches up, and a newcomer still reads the past.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { Proof } from '../src/identity/ucan.js';
import type { P2PNode } from '../src/node/types.js';
import { newRecordKey } from '../src/records/key.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { deriveMemberKeyBytes } from '../src/identity/contact-key.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { replayAccess, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import {
  BOX_LABEL,
  boxBound,
  boxKey,
  deriveReadKey,
  memberKeyRecordKey,
  SPACE_KEY_RECORD,
} from '../src/space/space-access.js';
import {
  EARLIER_KEYS_LABEL,
  generateSpaceKey,
  MEMBERSHIP_LABEL,
  sealBody,
  spaceKeyFromRaw,
  type SpaceKey,
} from '../src/privacy/space-encryption.js';
import { sealValue } from '../src/identity/envelope.js';
import { sealValueTo } from '../src/identity/hpke.js';
import { createClientAuth, type ReadAccess } from '../src/network/peer-auth.js';
import { team } from '../src/space/presets.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, open, person as somebody } from './helpers/person.js';
import { stored } from './helpers/stored.js';

async function person(hub: FakeHub) {
  const who = await somebody(hub, { accountKey: true });
  return { ...who, accountKey: await deriveAccountKey(who.seed) };
}

const provider = createP256Provider();

// ─── The replay ────────────────────────────────────────────────────

const admin: Role = { name: 'admin', rank: 100, permissions: ['*'] };
const member: Role = { name: 'member', rank: 0, permissions: [] };
const genesis: AccessGenesis = {
  id: 'space',
  creator: 'alice',
  roles: [admin, member],
  creatorRole: 'admin',
  key: { keyId: 'k0', readKey: 'did:key:r0' },
};

let n = 0;
const id = (label: string) => `${label}-${String(n++).padStart(3, '0')}`;
const setRole = (root: string, did: string, role: string | null, seen: string[]): AccessEvent => ({
  id: id('m'),
  key: `member:${did}`,
  kind: 'member',
  root,
  did,
  role,
  seen,
  author: 'k',
  cutoff: new Map(),
});
const newKey = (root: string, keyId: string, seen: string[], eventId = id('k')): AccessEvent => ({
  id: eventId,
  key: 'key:space',
  kind: 'key',
  root,
  keyId,
  readKey: `did:key:r-${keyId}`,
  seen,
  author: 'k',
  cutoff: new Map(),
});

describe('when a new key is due', () => {
  test('someone losing their place makes one due; a new key by someone who manages clears it', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    assert.equal(replayAccess(genesis, [bob]).current.keyDue, false, 'joining takes nothing away');

    const removed = setRole('alice', 'bob', null, [bob.id]);
    assert.equal(replayAccess(genesis, [bob, removed]).current.keyDue, true);

    const changed = newKey('alice', 'k1', [removed.id]);
    const history = replayAccess(genesis, [bob, removed, changed]);
    assert.equal(history.current.keyDue, false);
    assert.deepEqual(
      history.current.keys.map((key) => key.keyId),
      ['k0', 'k1'],
    );
  });

  test('leaving yourself makes one due too', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const leaves = setRole('bob', 'bob', null, [bob.id]);
    assert.equal(replayAccess(genesis, [bob, leaves]).current.keyDue, true);
  });

  test('only someone who manages the space changes its key, and never back to one used before', () => {
    const bob = setRole('alice', 'bob', 'member', []);
    const byBob = newKey('bob', 'k1', [bob.id]);
    assert.equal(replayAccess(genesis, [bob, byBob]).status(byBob.id)?.status, 'dropped');

    const again = newKey('alice', 'k0', [bob.id]);
    assert.equal(replayAccess(genesis, [bob, again]).status(again.id)?.status, 'dropped');
  });

  test('a public space has no key to change', () => {
    const open: AccessGenesis = { ...genesis, key: undefined };
    const changed = newKey('alice', 'k1', []);
    assert.equal(replayAccess(open, [changed]).status(changed.id)?.status, 'dropped');
    const bob = setRole('alice', 'bob', 'member', []);
    assert.equal(replayAccess(open, [bob, setRole('alice', 'bob', null, [bob.id])]).current.keyDue, false);
  });

  test('two new keys made apart: both stand, and every peer takes the same one as current (#164)', () => {
    const carol = setRole('alice', 'carol', 'admin', []);
    const first = newKey('alice', 'ka', [carol.id], 'k-a');
    const second = newKey('carol', 'kb', [carol.id], 'k-b');
    const orders = [
      [carol, first, second],
      [second, first, carol],
    ];
    const current = orders.map((order) => replayAccess(genesis, order).current.keys.at(-1)!.keyId);
    assert.equal(current[0], current[1]);
    // Records sealed under either stay readable: both keys stand.
    assert.equal(replayAccess(genesis, orders[0]!).current.keys.length, 3);
  });
});

// ─── Real nodes ────────────────────────────────────────────────────

type Person = Awaited<ReturnType<typeof person>>;

/** Whether a node reads a note with this text */
const readsOn = async (node: P2PNode, space: string, text: string) =>
  (await node.records.list<{ text: string }>(space, { collection: 'app.note' })).some(
    (note) => note.body?.text === text,
  );
const reads = (who: Person, space: string, text: string) => readsOn(who.node, space, text);

/** Whether a note with this text has reached someone — readable or not */
const holdsNote = async (who: Person, space: string, count: number) =>
  (await who.node.records.list(space, { collection: 'app.note' })).length >= count;

const keyChanges = async (who: Person, space: string) => (await who.node.spaces.access(space)).key;

/** Alice's private team space, with Bob and Carol joined as editors and everyone's profile in */
async function team3() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'private' });
  await hold(alice.node, space);
  for (const who of [bob, carol]) {
    await who.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(who.node, space);
    await joined(who.node, space);
  }
  // Alice must have their joins before she can change who is in.
  await until(
    async () => {
      const members = new Set((await alice.node.spaces.access(space)).members.map((m) => m.did));
      return members.has(bob.node.did) && members.has(carol.node.did);
    },
    6000,
    'Alice to see both join',
  );
  await alice.node.records.put(space, 'app.note', { text: 'before' });
  for (const who of [bob, carol]) await until(() => reads(who, space, 'before'), 6000, 'the first note');
  return { hub, alice, bob, carol, space };
}

describe('removing someone from a private space', () => {
  test('changes the key by itself: the others read on, the one removed reads nothing new', async () => {
    const { alice, bob, carol, space } = await team3();
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await until(
      async () =>
        (await keyChanges(bob, space))?.held === true && (await keyChanges(bob, space))?.changes === 1,
      6000,
      'Bob to get it',
    );

    await bob.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => reads(alice, space, 'after'), 6000, 'Alice to read it');
    // Nobody sends Carol anything more, and she couldn't open it if they did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await holdsNote(carol, space, 2), false);
    assert.equal(await reads(carol, space, 'after'), false);
    // She never even hears that the key changed.
    assert.equal((await keyChanges(carol, space))?.changes, 0);
    // What was written before stays readable to those still in.
    assert.equal(await reads(bob, space, 'before'), true);
  });

  test('a newcomer after the change reads what came before it too', async () => {
    const { hub, alice, carol, space } = await team3();
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'after' });

    const dave = await person(hub);
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await until(
      async () => (await reads(dave, space, 'after')) && (await reads(dave, space, 'before')),
      6000,
      'Dave to read both',
    );
  });

  test('a member who was away catches up: the new key waits for them, sealed to them', async () => {
    const { alice, bob, carol, space } = await team3();
    await letGo(bob.node, space);
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'while away' });

    await hold(bob.node, space);
    await until(() => reads(bob, space, 'while away'), 6000, 'Bob to catch up');
    // And he writes with the new key, not the one Carol still has.
    await bob.node.records.put(space, 'app.note', { text: 'back' });
    await until(() => reads(alice, space, 'back'), 6000, 'Alice to read it');
    assert.equal(await reads(carol, space, 'back'), false);
  });

  test('someone joining with a link made before the change gets the new key once they are in', async () => {
    const { hub, alice, carol, space } = await team3();
    const oldLink = await alice.node.spaces.invite(space);
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await alice.node.records.put(space, 'app.note', { text: 'after' });

    const erin = await person(hub);
    await erin.node.spaces.join(oldLink);
    await hold(erin.node, space);
    await joined(erin.node, space);
    await until(() => reads(erin, space, 'after'), 6000, 'Erin to read the new note');
  });

  test('changes the key before the removal returns, so closing at once leaves nobody reading', async () => {
    const { alice, bob, carol, space } = await team3();
    await alice.node.spaces.setMember(space, carol.node.did, null);
    assert.equal((await keyChanges(alice, space))?.changes, 1, 'changed before it returned');
    await alice.node.close();

    await until(async () => (await keyChanges(bob, space))?.held === true, 6000, 'Bob to get the new key');
    assert.equal((await keyChanges(bob, space))?.changes, 1);
    await bob.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => reads(bob, space, 'after'), 6000, 'Bob to read his own note');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await reads(carol, space, 'after'), false);
  });

  test('the one removed hears no live messages, and is not heard', async () => {
    const { alice, bob, carol, space } = await team3();
    const heard: unknown[] = [];
    const heardFromCarol: unknown[] = [];
    carol.node.subscribe((event) => {
      if (event.type === 'message') heard.push(event.message);
    });
    bob.node.subscribe((event) => {
      if (event.type === 'message' && event.from === carol.node.did) heardFromCarol.push(event.message);
    });
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(
      async () => !(await bob.node.spaces.access(space)).members.some((m) => m.did === carol.node.did),
      6000,
      'Bob to see Carol removed',
    );

    await bob.node.spaces.send(space, { text: 'after' });
    await carol.node.spaces.send(space, { text: 'still here?' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(heard, []);
    assert.deepEqual(heardFromCarol, []);
  });

  test('with nobody here to change the key, the members let go of the one who lost their place', async () => {
    const { alice, bob, carol, space } = await team3();
    // Alice, the only one who may change the key, is away.
    await letGo(alice.node, space);
    // Carol gives up her place but keeps the space open, holding the key.
    await carol.node.spaces.setMember(space, carol.node.did, null);
    await until(
      async () => (await bob.node.spaces.access(space)).members.length === 2,
      6000,
      'Bob to see it',
    );
    assert.equal((await keyChanges(bob, space))?.changes, 0, 'no new key yet');
    await until(
      async () => (await carol.node.spaces.status(space)).peers.length === 0,
      6000,
      'Bob to let Carol go',
    );

    await bob.node.records.put(space, 'app.note', { text: 'while the key is due' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await reads(carol, space, 'while the key is due'),
      false,
      'she would read it, if it reached her',
    );
    assert.deepEqual((await carol.node.spaces.status(space)).peers, [], 'and nobody lets her back');
  });

  test('a public space has no key to change', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Open', ...team, visibility: 'public' });
    assert.equal((await alice.node.spaces.access(space)).key, null);
    await assert.rejects(alice.node.spaces.changeKey(space), /public space has no key/);
  });

  test('only someone who manages the space changes its key by hand', async () => {
    const { bob, space } = await team3();
    await assert.rejects(bob.node.spaces.changeKey(space), /Only someone who manages/);
  });
});

describe('leaving a private space', () => {
  test('gives up your place: the others stop counting you, and the key changes', async () => {
    const { alice, bob, carol, space } = await team3();
    await carol.node.spaces.leave(space);
    assert.equal(await carol.node.spaces.get(space), null, 'Carol forgot the space');

    const members = async (who: Person) => (await who.node.spaces.access(space)).members.map((m) => m.did);
    for (const who of [alice, bob])
      await until(async () => !(await members(who)).includes(carol.node.did), 6000, 'the removal to arrive');
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    await until(async () => (await keyChanges(bob, space))?.held === true, 6000, 'Bob to get it');
  });

  test('shared to view, there is nothing to give up', async () => {
    const { hub, alice, space } = await team3();
    const dave = await person(hub);
    await dave.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    await hold(dave.node, space);
    const before = (await alice.node.spaces.access(space)).heads;

    const started = Date.now();
    await dave.node.spaces.leave(space);
    assert.ok(Date.now() - started < 1000, 'no removal to wait for');
    assert.equal(await dave.node.spaces.get(space), null);
    assert.deepEqual((await alice.node.spaces.access(space)).heads, before);
  });
});

describe('proving you may read, after the key changed', () => {
  /** A session key for someone, with the note that makes it theirs */
  async function session(who: Person, space: string) {
    const pair = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
      audience: did,
      command: '/record/write',
      subject: `space:${space}`,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    return { did, key: pair.privateKey, note: [note] };
  }

  /** A reader holding `key`, sending its note sealed with it when `sendNote` */
  function reader(space: string, key: SpaceKey, note: Proof | null): ReadAccess {
    return {
      key: () => deriveReadKey(key, provider),
      current: () => 'did:key:not-this-one',
      membership: async () => (note ? sealValue(key.seal, MEMBERSHIP_LABEL, { space }, note) : null),
    };
  }

  test('the current key lets you in; an old one only with a note from someone still a member', async () => {
    const { alice, bob, carol, space } = await team3();
    const oldKey = await spaceKeyFromRaw(
      base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!),
    );
    await alice.node.spaces.setMember(space, carol.node.did, null);
    await until(async () => (await keyChanges(alice, space))?.changes === 1, 6000, 'a new key');
    const newKey = await spaceKeyFromRaw(
      base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!),
    );
    assert.notEqual(newKey.id, oldKey.id);

    const server = (await alice.node.spaces.authenticator(space))!;
    const nodeDid = 'did:key:zNode';
    const tries = async (who: Person, key: SpaceKey, withNote: boolean) => {
      const me = await session(who, space);
      const read = reader(space, key, withNote ? me.note : null);
      const hello = await createClientAuth(space, { did: me.did, key: me.key }, read, provider).hello(
        me.did,
        nodeDid,
        'nonce',
      );
      return server.checkHello(me.did, nodeDid, 'nonce', hello);
    };

    assert.equal(await tries(bob, newKey, false), true, 'the current key');
    assert.equal(await tries(bob, oldKey, true), true, 'an old key, from a member');
    assert.equal(
      await tries(bob, oldKey, false),
      false,
      'an old key alone — a view-only link from before, say',
    );
    assert.equal(await tries(carol, oldKey, true), false, 'an old key, from someone removed');
    assert.equal(await tries(bob, newKey, true), true, 'the current key, with a note from a member');
    // A key made since the removal: someone invited back holds it, and gets in before their join lands.
    assert.equal(await tries(carol, newKey, true), true, 'a key made after the removal');
  });
});

describe('proving you may read, while a new key is due', () => {
  test('someone who lost their place is refused on the current key, with their own note', async () => {
    const { alice, bob, carol, space } = await team3();
    const key = await spaceKeyFromRaw(
      base64UrlDecode(parseSpaceInvite(await bob.node.spaces.invite(space, { write: false })).key!),
    );
    await letGo(alice.node, space);
    await carol.node.spaces.setMember(space, carol.node.did, null);
    await until(
      async () => (await bob.node.spaces.access(space)).members.length === 2,
      6000,
      'Bob to see it',
    );

    const server = (await bob.node.spaces.authenticator(space))!;
    const tries = async (who: Person) => {
      const pair = await provider.generateKeyPair();
      const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
      const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
        audience: did,
        command: '/record/write',
        subject: `space:${space}`,
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });
      const read: ReadAccess = {
        key: () => deriveReadKey(key, provider),
        current: () => 'did:key:not-this-one',
        membership: async () => sealValue(key.seal, MEMBERSHIP_LABEL, { space }, [note]),
      };
      const hello = await createClientAuth(space, { did, key: pair.privateKey }, read, provider).hello(
        did,
        'did:key:zNode',
        'nonce',
      );
      return server.checkHello(did, 'did:key:zNode', 'nonce', hello);
    };
    assert.equal(await tries(bob), true, 'a member');
    assert.equal(await tries(carol), false, 'Carol, who still holds the key');
  });
});

describe('everything else that holds a space follows its new key', () => {
  test('an app given one space by its home — no account key, just that space’s member key — gets the next key', async () => {
    const { hub, alice, bob, carol, space } = await team3();
    // Bob's app: his identity, no account key, the space's member key from his home.
    const seedless = await createNode({
      signer: createLocalRootSigner(bob.me, bob.manager.getProvider()),
      stores: memoryStores(),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(seedless);
    await seedless.spaces.join(await bob.node.spaces.invite(space, { write: false }), {
      memberKey: await deriveMemberKeyBytes(bob.accountKey, space),
    });
    await letGo(bob.node, space);
    await seedless.spaces.hold(space);

    await alice.node.spaces.setMember(space, carol.node.did, null);
    await alice.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => readsOn(seedless, space, 'after'), 6000, 'the app to read the new note');
  });

  test('a carrier gets a new pass, proving the new read key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Notes', visibility: 'private' });
    const added = await alice.node.carriers.add({ did: 'did:key:zCarrier', name: 'Chrome' });
    const passReadKey = async () => {
      const passes = await alice.node.records.list<{ space: { id: string }; readKey?: string }>(added.space, {
        collection: 'sys.pass',
      });
      return passes.find((pass) => pass.body?.space.id === space)?.body?.readKey ?? null;
    };
    await until(
      async () => (await alice.node.records.list(added.space, { collection: 'sys.pass' })).length > 0,
      6000,
      'the passes',
    );
    assert.equal(await passReadKey(), null, 'the first key: the space vouches for it');

    await alice.node.spaces.changeKey(space);
    const key = await spaceKeyFromRaw(
      base64UrlDecode(parseSpaceInvite(await alice.node.spaces.invite(space, { write: false })).key!),
    );
    const readKey = (await deriveReadKey(key, provider)).did;
    await until(async () => (await passReadKey()) === readKey, 6000, 'the pass to carry the new read key');
  });
});

describe('a key change that leaves out the first key', () => {
  test('is taken as malformed: a manager replaces it, and a newcomer still gets the first key', async () => {
    const { hub, alice, bob, carol, space } = await team3();
    // A modified app of Alice's changes the key with no earlier key sealed inside, and boxes it to everyone.
    await letGo(alice.node, space);
    const store = await stored(alice.stores, space);
    const memberKeys = new Map<string, string>();
    for (const [key, versions] of await store.histories('memberkey:'))
      for (const { body } of versions)
        if (body && typeof body === 'object' && 'key' in body && typeof body.key === 'string')
          memberKeys.set(key, body.key);
    const next = await generateSpaceKey();
    await forge(alice, space, {
      collection: 'sys.key',
      retain: true,
      body: {
        keyId: next.id,
        readKey: (await deriveReadKey(next, provider)).did,
        earlier: await sealValue(next.seal, EARLIER_KEYS_LABEL, { space, keyId: next.id }, []),
      },
      version: { key: SPACE_KEY_RECORD, seq: 0 },
    });
    for (const who of [alice, bob, carol]) {
      const to = who.node.did;
      const memberKey = memberKeys.get(await memberKeyRecordKey(to));
      assert.ok(memberKey, 'every member has published a member key');
      await forge(alice, space, {
        collection: 'sys.box',
        body: {
          keyId: next.id,
          to,
          sealed: await sealValueTo(memberKey, BOX_LABEL, boxBound(space, next.id, to), {
            key: base64UrlEncode(next.raw),
          }),
        },
        version: { key: await boxKey(next.id, to, alice.node.did), seq: 0 },
      });
    }
    await hold(alice.node, space);
    // Alice's node, holding the first key, takes nothing from it and changes the key again.
    await until(
      async () => (await keyChanges(alice, space))?.changes === 2,
      6000,
      'a key change to replace it',
    );

    const dave = await person(hub);
    await dave.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(dave.node, space);
    await until(() => reads(dave, space, 'before'), 6000, 'Dave to read what the first key sealed');
  });
});

describe('a key record that did not count', () => {
  /** The current key, as Bob, an editor, can read it from an invite he may make */
  const currentOf = async (who: Person, space: string) =>
    spaceKeyFromRaw(
      base64UrlDecode(parseSpaceInvite(await who.node.spaces.invite(space, { write: false })).key!),
    );

  test('forces no key change, however malformed', async () => {
    const { alice, bob, space } = await team3();
    const current = await currentOf(bob, space);
    for (let round = 0; round < 2; round++) {
      // Not a manager, so it never counts; its earlier doesn't open.
      await forge(bob, space, {
        collection: 'sys.key',
        retain: true,
        body: {
          keyId: current.id,
          readKey: (await deriveReadKey(current, provider)).did,
          earlier: 'not sealed',
        },
        version: { key: SPACE_KEY_RECORD, seq: 0 },
      });
      await bob.node.records.put(space, 'app.note', { text: `nudge ${round}` });
      await until(() => reads(alice, space, `nudge ${round}`), 6000, 'the nudge');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await keyChanges(alice, space))?.changes, 0);
  });

  test('gives no reader a key the history doesn’t name', async () => {
    const { alice, bob, space } = await team3();
    const current = await currentOf(bob, space);
    const planted = await generateSpaceKey();
    // Sealed under the current key, so it opens, and carrying a key no key change made.
    await forge(bob, space, {
      collection: 'sys.key',
      retain: true,
      body: {
        keyId: current.id,
        readKey: (await deriveReadKey(current, provider)).did,
        earlier: await sealValue(current.seal, EARLIER_KEYS_LABEL, { space, keyId: current.id }, [
          base64UrlEncode(current.raw),
          base64UrlEncode(planted.raw),
        ]),
      },
      version: { key: SPACE_KEY_RECORD, seq: 0 },
    });
    // A note sealed under the planted key.
    const key = await newRecordKey(bob.node.did);
    await forge(bob, space, {
      collection: 'app.note',
      body: await sealBody({ body: { text: 'planted' } }, planted, { space, collection: 'app.note', key }),
      version: { key, seq: 0 },
    });
    await bob.node.records.put(space, 'app.note', { text: 'after' });
    await until(() => reads(alice, space, 'after'), 6000, 'the note after');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await reads(alice, space, 'planted'), false);
  });
});
