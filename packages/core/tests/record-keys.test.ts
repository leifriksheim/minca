/**
 * Keys that belong to their creator and their collection (spec 02 §4.1, #72,
 * #463): a first version outside `sys.*` is at a key its account owns in its
 * collection, or at a shared `one:` key of its collection. A member who writes a first version at someone
 * else's key, however low its id, is refused by every peer, whichever version
 * reaches it first; and a private space's `onePer` keys can't be guessed by
 * anyone without its key (#87).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSharedKeyOf,
  keyKind,
  lineKey,
  newRecordKey,
  ownedKey,
  ownerTag,
  ownsKey,
  RECORD_KEY_PATTERN,
  sharedKey,
} from '../src/records/key.js';
import { changedFixedField, onePerKey, onePerSecret } from '../src/records/rules.js';
import { replayAccess, type AccessEvent, type AccessGenesis } from '../src/space/roles.js';
import { COLLECTION_DEFINE, ROLE_ASSIGN } from '../src/space/grants.js';
import { OWN } from './helpers/own-records.js';
import { team } from '../src/space/presets.js';
import { SYNC_PROTOCOL_VERSION } from '../src/sync/sync-messages.js';
import type { Version } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { hold, letGo } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { stored } from './helpers/stored.js';
import { until } from './helpers/until.js';
import { forge, person, type Person } from './helpers/person.js';

const SEED_7_DID = 'did:key:zDnaemCBstFw5hzNdNggFHZm6GpHoHqNGrwEtrVi9CxGH9V7E';

describe('the kinds of key', () => {
  test('the examples in 02 §4.1', async () => {
    const owner = await ownerTag(SEED_7_DID, 'app.settings');
    assert.equal(owner, 'mj6bhbzx5m7tqmu35fjtg4wo4u');
    assert.equal(
      await ownedKey(SEED_7_DID, 'app.settings', 'settings'),
      'mj6bhbzx5m7tqmu35fjtg4wo4u.settings',
    );
    assert.equal(await lineKey(SEED_7_DID, 'app.pay'), 've3nypi5dox6ldsyoc25rsgdge.line');
    const fresh = await newRecordKey(SEED_7_DID, 'app.note');
    assert.equal(fresh.length, 53);
    assert.match(fresh, RECORD_KEY_PATTERN);
    assert.ok(await ownsKey(fresh, SEED_7_DID, 'app.note'));
    assert.ok(!(await ownsKey(fresh, SEED_7_DID, 'app.other')), 'not in another collection');
    assert.ok(
      !(await ownsKey(fresh, 'did:key:zDnaes7SHHEzJcR4LfXNL8UjSMWQ3VMFfQiv6vZzoxgkaCNqt', 'app.note')),
      'not by another account',
    );
    const shared = await sharedKey('std.decision', '0'.repeat(40));
    assert.equal(shared, `one:7elebqud5aetyhmrmrpaoiaggq.${'0'.repeat(40)}`);
    assert.ok(await isSharedKeyOf(shared, 'std.decision'));
    assert.ok(!(await isSharedKeyOf(shared, 'std.vote')));
  });

  test('a key is owned, shared, or neither', () => {
    assert.equal(keyKind('akthxqofxox3iszhpi5j3zhl6a.profile'), 'owned');
    assert.equal(keyKind(`one:${'a'.repeat(26)}.${'0'.repeat(40)}`), 'shared');
    for (const neither of [
      'mfrggzdfmztwq2lknnwg23tpoa',
      'profile',
      'collection:app.poll',
      `one:${'0'.repeat(40)}`,
      `one:${'a'.repeat(26)}.${'0'.repeat(39)}`,
      `ONE:${'0'.repeat(40)}`,
      'blz5ozlw6dwa5cn2n2lfu4rjb.profile',
      'akthxqofxox3iszhpi5j3zhl6a.',
      'blz5ozlw6dwa5cn2n2lfu4rjb1.profile',
    ])
      assert.equal(keyKind(neither), null, neither);
  });

  test('a name too long for an owned key is refused, not cut', async () => {
    await assert.rejects(ownedKey(SEED_7_DID, 'app.x', 'x'.repeat(102)), /1–101 characters/);
    assert.equal((await ownedKey(SEED_7_DID, 'app.x', 'x'.repeat(101))).length, 128);
  });
});

describe('onePer keys', () => {
  const about = [{ rel: 'about', to: 'g67js7ozqmkbn2kkcvjhl2ke3u.poll' }];

  test('the example in 02 §7.3', async () => {
    const secret = await onePerSecret({ spaceId: 'bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a' });
    const vote = await onePerKey(secret, 'std.vote', ['@author', 'link:about'], {
      root: SEED_7_DID,
      links: about,
      body: { choice: 0 },
    });
    assert.equal(vote, '3gtuspob6srwlkr5ixzbwnobtq.one:093e7d2020c9e1c35ed7f0fb97d8294ed376afc3');
    const decision = await onePerKey(secret, 'std.decision', ['link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.equal(decision, 'one:7elebqud5aetyhmrmrpaoiaggq.6c339b678bdb967bbc4f5e0ec9aee9c9a6f000cf');
    // In a private space whose first key K₀ is 03 §8.1's `ff fe … e0`.
    const k0 = new Uint8Array(32).map((_, i) => 0xff - i);
    const hidden = await onePerKey(
      await onePerSecret({ spaceKey: k0 }),
      'std.vote',
      ['@author', 'link:about'],
      {
        root: SEED_7_DID,
        links: about,
        body: { choice: 0 },
      },
    );
    assert.equal(hidden, '3gtuspob6srwlkr5ixzbwnobtq.one:9872ccec89c8f4d056b34f410d026134e2bcee45');
  });

  test('with @author it is an owned key of the author; without, a shared one', async () => {
    const secret = await onePerSecret({ spaceId: 'b-space' });
    const mine = await onePerKey(secret, 'app.vote', ['@author', 'link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.ok(mine && (await ownsKey(mine, SEED_7_DID, 'app.vote')));
    const shared = await onePerKey(secret, 'app.decision', ['link:about'], {
      root: SEED_7_DID,
      links: about,
      body: {},
    });
    assert.ok(shared && (await isSharedKeyOf(shared, 'app.decision')));
  });

  test('a field is hashed as canonical JSON: member order makes no difference (#20)', async () => {
    const secret = await onePerSecret({ spaceId: 'b-space' });
    const key = (body: unknown) => onePerKey(secret, 'app.slot', ['when'], { root: '', links: [], body });
    const a = await key({ when: { day: 'mon', hour: 9 } });
    const b = await key(JSON.parse('{"when":{"hour":9,"day":"mon"}}'));
    assert.ok(a);
    assert.equal(a, b);
    // And a fixed field compares the same way.
    const first = { when: { day: 'mon', hour: 9 } };
    assert.equal(changedFixedField(['when'], first, JSON.parse('{"when":{"hour":9,"day":"mon"}}')), null);
    assert.equal(changedFixedField(['when'], first, { when: { day: 'tue', hour: 9 } }), 'when');
    assert.equal(changedFixedField(['when'], first, {}), 'when');
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
    assert.ok(await ownsKey(vote.key, alice.node.did, 'app.vote'));
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

/**
 * Alice, Bob and Carol in a public space where only a record's creator may
 * edit it. Its editors may define `app.notice` only when `defines` says so.
 */
async function club(defines = false) {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const carol = await person(hub);
  const roles = [
    {
      name: 'editor',
      grants: [
        ...OWN,
        { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'editor']] },
        ...(defines ? [{ cmd: COLLECTION_DEFINE, pol: [['==', '.collection', 'app.notice']] }] : []),
      ],
    },
  ];
  const { id: space } = await alice.node.spaces.create({ name: 'Club', roles, visibility: 'public' });
  for (const who of [bob, carol]) {
    await who.node.spaces.join(await alice.node.spaces.invite(space));
    await joined(who.node, space);
  }
  await hold(alice.node, space);
  for (const name of ['app.poll', 'app.settings'])
    await alice.node.collections.define(space, {
      name,
      schema: { type: 'object' },
    });
  await alice.node.collections.define(space, {
    name: 'app.vote',
    schema: { type: 'object' },
    links: { about: { to: '*', cardinality: 'one' } },
    rules: { onePer: ['@author', 'link:about'] },
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
  refusal = /not one its account may write first/,
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
    assert.equal(hers.key, await bob.node.records.keyFor(space, 'app.settings', 'settings', alice.node.did));
    await assert.rejects(
      bob.node.records.put(space, 'app.settings', { question: 'mine' }, { key: hers.key }),
      /isn't a key of yours in app\.settings/,
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
});

describe('a key in another collection', () => {
  /** Rejections a node reports, as they come */
  const refusalsAt = (who: Person) => {
    const refusals: string[] = [];
    who.node.subscribe((event) => {
      if (event.type === 'rejected') refusals.push(event.reason);
    });
    return refusals;
  };

  test('the same name in two collections gives two records, and neither touches the other', async () => {
    const { alice, bob, space } = await club();
    const settings = await alice.node.records.put(
      space,
      'app.settings',
      { theme: 'dark' },
      { key: 'settings' },
    );
    const poll = await alice.node.records.put(space, 'app.poll', { question: '?' }, { key: 'settings' });
    assert.notEqual(poll.key, settings.key);
    await until(async () => (await bob.node.records.get(space, poll.key)) !== null, 4000, 'the poll');
    await alice.node.records.delete(space, poll.key);
    await until(async () => (await bob.node.records.get(space, poll.key)) === null, 4000, 'the delete');
    assert.deepEqual((await bob.node.records.get(space, settings.key))?.body, { theme: 'dark' });
  });

  test('a key of another collection is refused, owned or shared: no record can squat one', async () => {
    const { alice, bob, space } = await club();
    await alice.node.collections.define(space, {
      name: 'app.decision',
      schema: { type: 'object' },
      links: { about: { to: '*', cardinality: 'one' } },
      rules: { onePer: ['link:about'] },
    });
    await until(
      async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.decision'),
      4000,
      'the definition',
    );
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    const links = [{ rel: 'about', to: poll.key }];
    const voteKey = (await bob.node.records.onePerKey(space, 'app.vote', {}, { links }))!;
    const decisionKey = (await bob.node.records.onePerKey(space, 'app.decision', {}, { links }))!;
    await assert.rejects(
      bob.node.records.put(space, 'app.poll', { question: 'Squat' }, { key: voteKey }),
      /isn't a key of yours in app\.poll/,
    );
    // Signed by hand, every peer refuses them: the key names another collection.
    const refusals = refusalsAt(alice);
    await letGo(bob.node, space);
    const squats = [
      await forge(bob, space, {
        collection: 'app.poll',
        body: { question: 'Squat' },
        version: { key: voteKey, seq: 0 },
      }),
      await forge(bob, space, {
        collection: 'app.vote',
        body: {},
        retain: true,
        links,
        version: { key: decisionKey, seq: 0 },
      }),
    ];
    await hold(bob.node, space);
    await until(async () => refusals.length >= 2, 4000, 'Alice to refuse them');
    assert.match(refusals.join('; '), /not one its account may write first in app\.poll/);
    assert.match(refusals.join('; '), /not one its account may write first in app\.vote/);
    for (const squat of squats)
      assert.equal(await (await stored(alice.stores, space)).getVersion(squat.id), null);
    // Alice's decision and vote are untouched by any of it.
    const decision = await alice.node.records.put(space, 'app.decision', {}, { links });
    assert.equal(decision.key, decisionKey);
    const vote = await alice.node.records.put(space, 'app.vote', { choice: 1 }, { links });
    await until(async () => (await bob.node.records.get(space, vote.key)) !== null, 4000, 'the vote');
    await until(async () => (await bob.node.records.get(space, decision.key)) !== null, 4000, 'the decision');
  });

  test('a shared key in a collection whose onePer names @author is refused: it is not the derived key', async () => {
    const { alice, bob, space } = await club();
    const poll = await alice.node.records.put(space, 'app.poll', { question: 'Where?' });
    const refusals = refusalsAt(alice);
    await letGo(bob.node, space);
    const shared = await forge(bob, space, {
      collection: 'app.vote',
      body: { choice: 0 },
      retain: true,
      links: [{ rel: 'about', to: poll.key }],
      version: { key: await sharedKey('app.vote', 'cd'.repeat(20)), seq: 0 },
    });
    await hold(bob.node, space);
    await until(async () => refusals.length > 0, 4000, 'Alice to refuse it');
    assert.match(refusals.join('; '), /its key must be derived from them/);
    assert.equal(await (await stored(alice.stores, space)).getVersion(shared.id), null);
  });
});

describe('who first defined a collection', () => {
  // Stewards may define collections. The founder narrows steward at `narrow`, written apart from
  // their definitions: a change that saw it is judged without the grant, by whether it is its definer's.
  const genesis: AccessGenesis = {
    id: 'space',
    resolver: 'strong-remove/1',
    founders: ['root'],
    roles: [{ name: 'steward', grants: [{ cmd: COLLECTION_DEFINE, pol: [] }] }],
  };
  const member = (did: string, id: string): AccessEvent => ({
    id,
    key: `assign:${did}|steward`,
    kind: 'assign',
    root: 'root',
    did,
    role: 'steward',
    assigned: true,
    seen: [],
    author: 'k',
    cutoff: new Map(),
  });
  const narrow: AccessEvent = {
    id: 'n0',
    key: 'role:steward',
    kind: 'role',
    root: 'root',
    name: 'steward',
    grants: [],
    nests: [],
    seen: ['m1', 'm2'],
    author: 'k',
    cutoff: new Map(),
  };
  const define = (root: string, id: string, seen: string[], deleted = false): AccessEvent => ({
    id,
    key: 'collection:app.poll',
    kind: 'definition',
    root,
    name: 'app.poll',
    deleted,
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
        // Neither is in force: which would be is an id, and Mallory could grind hers lower.
        assert.equal(history.current.definitions.get('app.poll'), undefined);
        assert.ok(history.current.contested.has('app.poll'));
        // Neither may change it once steward is narrowed; only someone who may define it.
        const change = (root: string, id: string) => define(root, id, [hers, theirs, 'n0']);
        const after = replayAccess(genesis, [
          ...order,
          narrow,
          change('mallory', 'x1'),
          change('alice', 'x2'),
          change('root', 'x3'),
        ]);
        assert.equal(after.status('x1')?.status, 'dropped');
        assert.equal(after.status('x2')?.status, 'dropped');
        assert.equal(after.status('x3')?.status, 'applied');
        // The founder's, which saw them both, settles it; it names no definer.
        assert.deepEqual(after.current.definitions.get('app.poll'), { event: 'x3', definedBy: null });
        assert.ok(!after.current.contested.has('app.poll'));
      }
    }
  });

  test('a backdated rival with a ground-low id does not put its rules in force', () => {
    const events = [
      member('alice', 'm1'),
      member('mallory', 'm2'),
      define('alice', 'd5', ['m1', 'm2']),
      define('alice', 'd6', ['d5']),
      // Mallory's rival "first" definition, as of before Alice's, with the lowest id.
      define('mallory', 'd0', ['m1', 'm2']),
    ];
    for (const order of [events, [events[0]!, events[1]!, events[4]!, events[2]!, events[3]!]]) {
      const history = replayAccess(genesis, order);
      assert.equal(history.current.definitions.get('app.poll'), undefined, 'no definition in force');
      assert.ok(history.current.contested.has('app.poll'));
      // Mallory, having seen both and the narrowing, can't settle it in her favour.
      const again = replayAccess(genesis, [...order, narrow, define('mallory', 'd7', ['d6', 'd0', 'n0'])]);
      assert.equal(again.status('d7')?.status, 'dropped');
      assert.equal(again.current.definitions.get('app.poll'), undefined);
      // A rival raced against a manager's settling puts it out of force again, and still chooses nothing.
      const settled = replayAccess(genesis, [
        ...order,
        define('root', 'd8', ['d6', 'd0']),
        define('mallory', 'c0', ['m1', 'm2']),
      ]);
      assert.equal(settled.current.definitions.get('app.poll'), undefined);
      assert.ok(settled.current.contested.has('app.poll'));
    }
  });

  const remove = (root: string, id: string, seen: string[]) => define(root, id, seen, true);

  test('a backdated delete of nothing, however low its id, is refused', () => {
    const events = [
      member('alice', 'm1'),
      member('mallory', 'm2'),
      define('alice', 'd5', ['m1', 'm2']),
      define('alice', 'd6', ['d5']),
      // As of before Alice's first definition, ground below hers.
      remove('mallory', 'a0', ['m1', 'm2']),
    ];
    const history = replayAccess(genesis, events);
    assert.equal(history.status('a0')?.status, 'dropped');
    assert.deepEqual(history.current.definitions.get('app.poll'), { event: 'd6', definedBy: 'alice' });
    // So her definition after it, having seen both and the narrowing, changes someone else's: refused.
    const after = replayAccess(genesis, [...events, narrow, define('mallory', 'z9', ['d6', 'a0', 'n0'])]);
    assert.equal(after.status('z9')?.status, 'dropped');
    assert.equal(after.current.definitions.get('app.poll')?.definedBy, 'alice');
  });

  test('a ground-low delete of her own rival does not win by id: it contests, and settles nothing for her', () => {
    const events = [
      member('alice', 'm1'),
      member('mallory', 'm2'),
      define('alice', 'd5', ['m1', 'm2']),
      define('alice', 'd6', ['d5']),
      define('mallory', 'r0', ['m1', 'm2']),
      remove('mallory', 'a1', ['r0']),
    ];
    for (const order of [events, [...events].reverse()]) {
      const history = replayAccess(genesis, order);
      assert.equal(history.current.definitions.get('app.poll'), undefined);
      assert.deepEqual(history.current.contested.get('app.poll'), ['a1', 'd6']);
      const after = replayAccess(genesis, [...order, narrow, define('mallory', 'z9', ['d6', 'a1', 'n0'])]);
      assert.equal(after.status('z9')?.status, 'dropped');
      // The founder settles it; after a delete it saw, that starts the collection afresh, as the founder's.
      const settled = replayAccess(genesis, [...order, define('root', 'z8', ['d6', 'a1'])]);
      assert.deepEqual(settled.current.definitions.get('app.poll'), { event: 'z8', definedBy: 'root' });
    }
  });

  test('once settled with no definer, changes made apart by those who may define it are picked between by id', () => {
    const settle = [
      member('alice', 'm1'),
      member('bob', 'm2'),
      define('alice', 'd5', ['m1', 'm2']),
      define('bob', 'd4', ['m1', 'm2']),
      define('root', 'd8', ['d5', 'd4']),
    ];
    assert.deepEqual(replayAccess(genesis, settle).current.definitions.get('app.poll'), {
      event: 'd8',
      definedBy: null,
    });
    // The founder on two devices.
    const history = replayAccess(genesis, [
      ...settle,
      define('root', 'e2', ['d8']),
      define('root', 'e1', ['d8']),
    ]);
    assert.deepEqual(history.current.definitions.get('app.poll'), { event: 'e1', definedBy: null });
    assert.equal(history.current.contested.size, 0);
  });

  test('the definer and someone who may define it changing it apart: picked between by id, not contested', () => {
    const history = replayAccess(genesis, [
      member('alice', 'm1'),
      define('alice', 'd1', ['m1']),
      define('alice', 'd3', ['d1']),
      define('root', 'd2', ['d1']),
    ]);
    assert.deepEqual(history.current.definitions.get('app.poll'), { event: 'd2', definedBy: 'alice' });
    assert.equal(history.current.contested.size, 0);
  });

  test('on real nodes, a ground-low backdated delete can’t take a collection from its definer', async () => {
    const { alice, bob, carol, space } = await club();
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      rules: { fixed: ['text'] },
    });
    const listed = async () =>
      (await carol.node.collections.list(space)).find((c) => c.name === 'app.notice');
    await until(async () => !!(await listed()), 4000, 'Alice’s definition at Carol’s');
    const hers = (await (await stored(alice.stores, space)).queryVersions('sys.collection')).find(
      (v) => v.key === 'collection:app.notice',
    )!;
    await letGo(bob.node, space);
    let removal: Version | undefined;
    // Each try beats her id with the chance her id is above; 200 failed about one run in 200.
    for (let i = 0; i < 5000 && !removal; i++) {
      const tried = await forge(
        bob,
        space,
        {
          collection: 'sys.collection',
          body: null,
          deleted: true,
          retain: true,
          seen: hers.seen ?? [],
          version: { key: 'collection:app.notice', seq: 0 },
        },
        { keep: false },
      );
      if (tried.id < hers.id) removal = tried;
    }
    assert.ok(removal, 'ground a lower id');
    await (await stored(bob.stores, space)).addVersion(removal);
    const his = await forge(bob, space, {
      collection: 'sys.collection',
      retain: true,
      body: { ...Object(hers.body), rules: {} },
      seen: [hers.id, removal.id],
      version: { key: 'collection:app.notice', seq: 1, prev: removal.id, genesis: removal.id },
      log: { n: 0 },
    });
    await hold(bob.node, space);
    await until(
      async () => (await (await stored(carol.stores, space)).getVersion(his.id)) !== null,
      4000,
      'his definition at Carol’s',
    ).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shown = await listed();
    assert.equal(shown?.definedBy, alice.node.did);
    assert.deepEqual(shown?.rules, { fixed: ['text'] });
  });

  test('on real nodes, rivals that differ put no rules in force; rivals that agree do', async () => {
    for (const agree of [false, true]) {
      const { alice, bob, carol, space } = await club(true);
      await alice.node.collections.define(space, {
        name: 'app.notice',
        title: 'Notice',
        schema: { type: 'object' },
        rules: { fixed: ['text'] },
      });
      const inForce = async () =>
        (await carol.node.collections.list(space)).some((c) => c.name === 'app.notice');
      await until(inForce, 4000, 'Alice’s definition at Carol’s');
      const store = await stored(alice.stores, space);
      const hers = (await store.queryVersions('sys.collection')).find(
        (v) => v.key === 'collection:app.notice',
      )!;
      const body: unknown = agree ? hers.body : { ...Object(hers.body), rules: {} };
      // Bob's rival, as of the same point as hers, so neither saw the other.
      await letGo(bob.node, space);
      const rival = await forge(bob, space, {
        collection: 'sys.collection',
        body,
        retain: true,
        seen: hers.seen ?? [],
        version: { key: 'collection:app.notice', seq: 0 },
      });
      await hold(bob.node, space);
      for (const who of [alice, carol])
        await until(
          async () => (await (await stored(who.stores, space)).getVersion(rival.id)) !== null,
          4000,
          'the rival',
        );
      if (agree) {
        assert.ok(await inForce(), 'the same definition, whoever wrote it');
        continue;
      }
      await until(async () => !(await inForce()), 4000, 'the rivals to put it out of force');
      // Out of force is not anything goes: no one writes in it until it is settled.
      await assert.rejects(
        carol.node.records.put(space, 'app.notice', { text: 'free for all' }),
        /Rival definitions/,
      );
      const refusals: string[] = [];
      alice.node.subscribe((event) => {
        if (event.type === 'rejected') refusals.push(event.reason);
      });
      await letGo(bob.node, space);
      const slipped = await forge(bob, space, { collection: 'app.notice', body: { text: 'slipped in' } });
      await hold(bob.node, space);
      await until(
        async () => refusals.some((reason) => /Rival definitions/.test(reason)),
        4000,
        'Alice to refuse it',
      );
      assert.equal(await (await stored(alice.stores, space)).getVersion(slipped.id), null);
      // Alice, the founder, settles it with hers.
      await alice.node.collections.define(space, {
        name: 'app.notice',
        title: 'Notice',
        schema: { type: 'object' },
        rules: { fixed: ['text'] },
      });
      await until(inForce, 4000, 'the settled definition');
      const settled = (await carol.node.collections.list(space)).find((c) => c.name === 'app.notice')!;
      assert.deepEqual(settled.rules, { fixed: ['text'] });
      assert.equal(settled.definedBy, null);
    }
  });

  test('one account’s first definition makes it the definer, and its later changes count', () => {
    const history = replayAccess(genesis, [
      member('alice', 'm1'),
      member('mallory', 'm2'),
      define('alice', 'd1', ['m1', 'm2']),
      define('alice', 'd2', ['d1']),
      narrow,
      define('mallory', 'd3', ['d2', 'n0']),
    ]);
    assert.equal(history.current.definitions.get('app.poll')?.definedBy, 'alice');
    assert.equal(history.status('d2')?.status, 'applied');
    assert.equal(history.status('d3')?.status, 'dropped');
  });
});
