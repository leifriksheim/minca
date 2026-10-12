/**
 * Keys that belong to their creator (spec 02 §4.1, #72): a first version
 * outside `sys.*` is at a key its account owns, or at a shared `one:` key a
 * collection's `onePer` gives. A member who writes a first version at someone
 * else's key, however low its id, is refused by every peer, whichever version
 * reaches it first; and a private space's `onePer` keys can't be guessed by
 * anyone without its key (#87).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  keyKind,
  lineKey,
  newRecordKey,
  ownedKey,
  ownerTag,
  ownsKey,
  RECORD_KEY_PATTERN,
} from '../src/records/key.js';
import { onePerKey, onePerSecret } from '../src/records/rules.js';
import { replayAccess, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';
import { SYNC_PROTOCOL_VERSION } from '../src/sync/sync-messages.js';
import { team } from '../src/space/presets.js';
import type { Version } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { hold, letGo } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { stored } from './helpers/stored.js';
import { until } from './helpers/until.js';
import { forge, person, type Person } from './helpers/person.js';

const SEED_7_DID = 'did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ';

describe('the kinds of key', () => {
  test('the examples in 02 §4.1', async () => {
    const owner = await ownerTag(SEED_7_DID);
    assert.equal(owner, 'iz75dwgy223gqtlqlqv3qzjq4y');
    assert.equal(await ownedKey(SEED_7_DID, 'settings'), 'iz75dwgy223gqtlqlqv3qzjq4y.settings');
    assert.equal(
      await lineKey(SEED_7_DID, 'app.pay'),
      'iz75dwgy223gqtlqlqv3qzjq4y.line:klp5y62opzf5madcl4zhreep3a',
    );
    const fresh = await newRecordKey(SEED_7_DID);
    assert.equal(fresh.length, 53);
    assert.match(fresh, RECORD_KEY_PATTERN);
    assert.ok(await ownsKey(fresh, SEED_7_DID));
    assert.ok(!(await ownsKey(fresh, 'did:key:zDnaem2ikLwS3eYm46gspC7nm6dmYYCMHUHU5yvVHNgARcsWf')));
  });

  test('a key is owned, shared, or neither', () => {
    assert.equal(keyKind('iz75dwgy223gqtlqlqv3qzjq4y.profile'), 'owned');
    assert.equal(keyKind(`one:${'0'.repeat(40)}`), 'shared');
    for (const neither of [
      'mfrggzdfmztwq2lknnwg23tpoa',
      'profile',
      'collection:app.poll',
      `one:${'0'.repeat(39)}`,
      `ONE:${'0'.repeat(40)}`,
      'blz5ozlw6dwa5cn2n2lfu4rjb.profile',
      'iz75dwgy223gqtlqlqv3qzjq4y.',
      'blz5ozlw6dwa5cn2n2lfu4rjb1.profile',
    ])
      assert.equal(keyKind(neither), null, neither);
  });

  test('a name too long for an owned key is refused, not cut', async () => {
    await assert.rejects(ownedKey(SEED_7_DID, 'x'.repeat(102)), /1–101 characters/);
    assert.equal((await ownedKey(SEED_7_DID, 'x'.repeat(101))).length, 128);
  });
});

describe('onePer keys', () => {
  const about = [{ rel: 'about', to: 'iz75dwgy223gqtlqlqv3qzjq4y.poll' }];

  test('the example in 02 §7.3', async () => {
    const secret = await onePerSecret({ spaceId: 'bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a' });
    const vote = await onePerKey(secret, 'std.vote', ['@author', 'link:about'], {
      root: SEED_7_DID,
      links: about,
      body: { choice: 0 },
    });
    assert.equal(vote, 'iz75dwgy223gqtlqlqv3qzjq4y.one:04b56dc63076a6a7c759e41275fbeedf0514435e');
    const decision = await onePerKey(secret, 'std.decision', ['link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.equal(decision, 'one:7c302bdcb25613e2fb9d49a41bccd0a24e1a2f24');
  });

  test('with @author it is an owned key of the author; without, a shared one', async () => {
    const secret = await onePerSecret({ spaceId: 'b-space' });
    const mine = await onePerKey(secret, 'app.vote', ['@author', 'link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.ok(mine && (await ownsKey(mine, SEED_7_DID)));
    const shared = await onePerKey(secret, 'app.decision', ['link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.equal(shared && keyKind(shared), 'shared');
  });

  test('a field is hashed as canonical JSON: member order makes no difference (#20)', async () => {
    const secret = await onePerSecret({ spaceId: 'b-space' });
    const key = (body: unknown) => onePerKey(secret, 'app.slot', ['when'], { root: '', links: [], body });
    const a = await key({ when: { day: 'mon', hour: 9 } });
    const b = await key(JSON.parse('{"when":{"hour":9,"day":"mon"}}'));
    assert.ok(a);
    assert.equal(a, b);
  });

  test('in a private space, nobody without its key can compute or test one (#87)', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Vote', ...team, visibility: 'private' });
    await alice.node.collections.define(space, {
      name: 'app.vote',
      schema: { type: 'object' },
      links: { about: { to: '*', cardinality: 'one' } },
      rules: { onePer: ['@author', 'link:about'] },
    });
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    const links = [{ rel: 'about', to: poll.key }];
    const vote = await alice.node.records.put(space, 'app.vote', { choice: 1 }, { links });
    // An outsider who knows Alice's DID and the poll's key tries what anyone can compute.
    const guessed = await onePerKey(
      await onePerSecret({ spaceId: space }),
      'app.vote',
      ['@author', 'link:about'],
      { root: alice.node.did, links, body: {} },
    );
    assert.notEqual(vote.key, guessed);
    // Only its owner part says whose it is, which the version's note says anyway.
    assert.ok(await ownsKey(vote.key, alice.node.did));
    assert.equal(vote.key, await alice.node.records.onePerKey(space, 'app.vote', {}, { links }));
    // And the same vote in another private space has another key.
    const { id: other } = await alice.node.spaces.create({ name: 'Vote 2', ...team, visibility: 'private' });
    await alice.node.collections.define(other, {
      name: 'app.vote',
      schema: { type: 'object' },
      links: { about: { to: '*', cardinality: 'one' } },
      rules: { onePer: ['@author', 'link:about'] },
    });
    assert.notEqual(await alice.node.records.onePerKey(other, 'app.vote', {}, { links }), vote.key);
  });
});

/** Alice, Bob and Carol in a public space where only a record's creator may edit it */
async function club() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
  for (const who of [bob, carol]) {
    await who.node.spaces.join(await alice.node.spaces.invite(space));
    await joined(who.node, space);
  }
  await hold(alice.node, space);
  for (const name of ['app.poll', 'app.settings'])
    await alice.node.collections.define(space, {
      name,
      schema: { type: 'object' },
      rules: { edit: 'creator', delete: 'creator' },
    });
  await alice.node.collections.define(space, {
    name: 'app.vote',
    schema: { type: 'object' },
    links: { about: { to: '*', cardinality: 'one' } },
    rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
  });
  for (const who of [bob, carol])
    await until(
      async () => (await who.node.collections.list(space)).filter((c) => c.version !== null).length === 3,
      4000,
      'the definitions',
    );
  return { hub, alice, bob, carol, space };
}

/**
 * Bob's first version at a key that is someone else's, its id ground below
 * theirs, and his edit on top of it: what would make him the record's
 * creator if the lowest id decided.
 */
async function takeOver(
  bob: Person,
  space: string,
  theirs: Version,
  body: unknown,
  collection = theirs.collection,
) {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; ; i++) {
    const first = await forge(
      bob,
      space,
      {
        collection,
        body,
        retain: true,
        createdAt: new Date(base + i).toISOString(),
        version: { key: theirs.key, seq: 0 },
        ...(theirs.links ? { links: theirs.links } : {}),
      },
      { keep: false },
    );
    if (first.id >= theirs.id) continue;
    const edit = await forge(
      bob,
      space,
      {
        collection,
        body,
        retain: true,
        version: { key: theirs.key, seq: 1, prev: first.id, genesis: first.id },
        log: { n: 1, prev: first.id },
      },
      { keep: false },
    );
    return [first, edit] as const;
  }
}

/** Hands `to` versions straight from a stranger's connection, before anything else reaches it */
async function pushTo(hub: FakeHub, space: string, versions: ReadonlyArray<Version>) {
  const stranger = hub.transport('did:key:zstranger', space);
  stranger.on('connected', (peer: string) => {
    for (const version of versions) {
      const payload = { v: SYNC_PROTOCOL_VERSION, type: 'push-update', version };
      stranger.send(
        peer,
        new TextEncoder().encode(JSON.stringify({ type: 'sync', from: 'did:key:zstranger', payload })),
      );
    }
  });
  await stranger.connect();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Carol, offline while Alice writes, gets Bob's takeover first and Alice's
 * record after. She refuses Bob's first version, so his edit never counts,
 * and reads Alice's record with Alice as its creator.
 */
async function attackerFirst(
  setup: Awaited<ReturnType<typeof club>>,
  theirs: Version,
  takeover: ReadonlyArray<Version>,
  read: (body: unknown) => unknown,
  expected: unknown,
  refusal = /belongs to another account/,
) {
  const { hub, alice, bob, carol, space } = setup;
  await letGo(alice.node, space);
  await letGo(bob.node, space);
  const refusals: string[] = [];
  carol.node.subscribe((event) => {
    if (event.type === 'rejected') refusals.push(event.reason);
  });
  await hold(carol.node, space);
  await pushTo(hub, space, takeover);
  const store = await stored(carol.stores, space);
  assert.equal(await store.getVersion(takeover[0]!.id), null, 'Carol refuses the first version');
  assert.ok(
    refusals.some((reason) => refusal.test(reason)),
    refusals.join('; '),
  );
  assert.equal(await carol.node.records.get(space, theirs.key), null, 'and shows nothing yet');

  await hold(alice.node, space);
  await until(
    async () => read((await carol.node.records.get(space, theirs.key))?.body) === expected,
    4000,
    'Alice’s record at Carol’s',
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const shown = (await carol.node.records.get(space, theirs.key))!;
  assert.equal(read(shown.body), expected);
  assert.equal(shown.createdBy, alice.node.did);
  assert.equal(await store.getVersion(takeover[0]!.id), null);
  assert.equal(await store.getVersion(takeover[1]!.id), null);
}

/** Alice, who holds her record, is handed Bob's takeover and refuses it too */
async function ownerRefuses(
  setup: Awaited<ReturnType<typeof club>>,
  theirs: Version,
  takeover: ReadonlyArray<Version>,
  read: (body: unknown) => unknown,
  expected: unknown,
) {
  const { hub, alice, space } = setup;
  await pushTo(hub, space, takeover);
  const store = await stored(alice.stores, space);
  assert.equal(await store.getVersion(takeover[0]!.id), null);
  const shown = (await alice.node.records.get(space, theirs.key))!;
  assert.equal(read(shown.body), expected);
  assert.equal(shown.createdBy, alice.node.did);
}

const question = (body: unknown) =>
  body && typeof body === 'object' && 'question' in body ? body.question : undefined;
const choice = (body: unknown) =>
  body && typeof body === 'object' && 'choice' in body ? body.choice : undefined;

describe('a first version at someone else’s key, ground to a lower id', () => {
  test('a fresh key: refused by a peer that gets it before the owner’s, and by the owner', async () => {
    const setup = await club();
    const { alice, bob, carol, space } = setup;
    await letGo(carol.node, space);
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    const theirs = (await (await stored(alice.stores, space)).getVersion(poll.version))!;
    const takeover = await takeOver(bob, space, theirs, { question: 'Hijacked' });
    assert.ok(takeover[0].id < theirs.id, 'the lower id the lowest-id rule would have taken');
    await attackerFirst(setup, theirs, takeover, question, 'Where?');
    await ownerRefuses(setup, theirs, takeover, question, 'Where?');
  });

  test('a chosen key: two accounts choosing one name get two keys, and neither can take the other’s', async () => {
    const setup = await club();
    const { alice, bob, carol, space } = setup;
    await letGo(carol.node, space);
    const hers = await alice.node.records.put(
      space,
      'app.settings',
      { question: 'dark' },
      { key: 'settings' },
    );
    const his = await bob.node.records.put(space, 'app.settings', { question: 'light' }, { key: 'settings' });
    assert.notEqual(hers.key, his.key);
    assert.equal(hers.key, await bob.node.records.keyFor(space, 'settings', alice.node.did));
    await assert.rejects(
      bob.node.records.put(space, 'app.settings', { question: 'mine' }, { key: hers.key }),
      /belongs to another account/,
    );
    const theirs = (await (await stored(alice.stores, space)).getVersion(hers.version))!;
    const takeover = await takeOver(bob, space, theirs, { question: 'Hijacked' });
    await attackerFirst(setup, theirs, takeover, question, 'dark');
    await ownerRefuses(setup, theirs, takeover, question, 'dark');
  });

  test('a onePer key that names its author: someone else’s vote can’t be written for them', async () => {
    const setup = await club();
    const { alice, bob, carol, space } = setup;
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    await letGo(carol.node, space);
    const vote = await alice.node.records.put(
      space,
      'app.vote',
      { choice: 1 },
      { links: [{ rel: 'about', to: poll.key }] },
    );
    const theirs = (await (await stored(alice.stores, space)).getVersion(vote.version))!;
    const takeover = await takeOver(bob, space, theirs, { choice: 0 });
    await attackerFirst(setup, theirs, takeover, choice, 1);
    await ownerRefuses(setup, theirs, takeover, choice, 1);
  });

  test('in a sys.* collection, which keeps keys of its own, it is refused too: it can’t be read in place of theirs', async () => {
    const setup = await club();
    const { alice, bob, carol, space } = setup;
    await letGo(carol.node, space);
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    const theirs = (await (await stored(alice.stores, space)).getVersion(poll.version))!;
    const takeover = await takeOver(bob, space, theirs, { question: 'Shadow' }, 'sys.shadow');
    await attackerFirst(setup, theirs, takeover, question, 'Where?', /never at an owned or a one: key/);
    await ownerRefuses(setup, theirs, takeover, question, 'Where?');
  });

  test('a key of no kind is refused outside sys.*, whoever writes it', async () => {
    const { alice, bob, space } = await club();
    const refusals: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') refusals.push(event.reason);
    });
    await letGo(bob.node, space);
    const odd = await forge(bob, space, {
      collection: 'app.poll',
      body: { question: 'Old style' },
      version: { key: 'mfrggzdfmztwq2lknnwg23tpoa', seq: 0 },
    });
    await hold(bob.node, space);
    await until(async () => refusals.length > 0, 4000, 'Alice to refuse it');
    assert.match(refusals.join('; '), /needs a key its account owns/);
    assert.equal(await (await stored(alice.stores, space)).getVersion(odd.id), null);
  });

  test('a shared one: key is refused in a collection whose rules have no onePer', async () => {
    const { alice, bob, space } = await club();
    const refusals: string[] = [];
    alice.node.subscribe((event) => {
      if (event.type === 'rejected') refusals.push(event.reason);
    });
    await letGo(bob.node, space);
    const squat = await forge(bob, space, {
      collection: 'app.poll',
      body: { question: 'Moved' },
      version: { key: `one:${'ab'.repeat(20)}`, seq: 0 },
    });
    await hold(bob.node, space);
    await until(async () => refusals.length > 0, 4000, 'Alice to refuse it');
    assert.match(refusals.join('; '), /only for a collection whose rules have onePer/);
    assert.equal(await (await stored(alice.stores, space)).getVersion(squat.id), null);
  });
});

describe('who first defined a collection', () => {
  const steward: Role = { name: 'steward', rank: 10, permissions: ['define'] };
  const admin: Role = { name: 'admin', rank: 100, permissions: ['*'] };
  const genesis: AccessGenesis = {
    id: 'space',
    creator: 'root',
    roles: [admin, steward],
    creatorRole: 'admin',
  };
  const member = (did: string, id: string): AccessEvent => ({
    id,
    key: `member:${did}`,
    kind: 'member',
    root: 'root',
    did,
    role: 'steward',
    seen: [],
    author: 'k',
    cutoff: new Map(),
  });
  const define = (root: string, id: string, seen: string[]): AccessEvent => ({
    id,
    key: 'collection:app.poll',
    kind: 'definition',
    root,
    name: 'app.poll',
    deleted: false,
    seen,
    author: 'k',
    cutoff: new Map(),
  });

  test('rival first definitions by two accounts name no one, whichever id is lower', () => {
    const alice = member('alice', 'm1');
    const mallory = member('mallory', 'm2');
    for (const [hers, theirs] of [
      ['d-b', 'd-a'],
      ['d-a', 'd-b'],
    ] as const) {
      const first = define('alice', hers, ['m1', 'm2']);
      // Mallory's, backdated to before Alice's, with whichever id she ground.
      const rival = define('mallory', theirs, ['m1', 'm2']);
      for (const order of [
        [alice, mallory, first, rival],
        [alice, mallory, rival, first],
      ]) {
        const history = replayAccess(genesis, order);
        assert.equal(history.current.definitions.get('app.poll')?.definedBy, null);
        // Neither may change it now; only someone who manages the space.
        const change = (root: string, id: string) => define(root, id, [hers, theirs]);
        const after = replayAccess(genesis, [
          ...order,
          change('mallory', 'x1'),
          change('alice', 'x2'),
          change('root', 'x3'),
        ]);
        assert.equal(after.status('x1')?.status, 'dropped');
        assert.equal(after.status('x2')?.status, 'dropped');
        assert.equal(after.status('x3')?.status, 'applied');
      }
    }
  });

  test('one account’s first definition makes it the definer, and its later changes count', () => {
    const history = replayAccess(genesis, [
      member('alice', 'm1'),
      member('mallory', 'm2'),
      define('alice', 'd1', ['m1', 'm2']),
      define('alice', 'd2', ['d1']),
      define('mallory', 'd3', ['d2']),
    ]);
    assert.equal(history.current.definitions.get('app.poll')?.definedBy, 'alice');
    assert.equal(history.status('d2')?.status, 'applied');
    assert.equal(history.status('d3')?.status, 'dropped');
  });
});
