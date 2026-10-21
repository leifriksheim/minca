/**
 * Keys the account trusts less: they write under a note that grants records
 * only, so no peer lets them change a space's collections or who may do what,
 * or write in the account's own spaces. Then what the library builds on that:
 * a node acting under such a note (`asAgent`), and collections it invents
 * arriving as blueprints someone who may define them applies.
 */
import { test, describe } from 'node:test';
import { ownedKey } from '../src/records/key.js';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { noteTerms } from '../src/identity/abilities.js';
import type { Policy } from '../src/identity/policy.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { deriveAccountRegistry } from '../src/space/account-registry.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion, type CreateVersionParams } from '../src/schema/version.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { describeCollection } from '../src/records/describe.js';
import { checkRules, type CollectionRules } from '../src/records/rules.js';
import {
  applyBlueprint,
  checkBlueprint,
  copyBlueprint,
  reviewBlueprint,
  writeGuide,
  standardDefinition,
  standardSchemas,
  vote,
  poll,
  message,
  useSchemas as addSchemas,
  type Blueprint,
  type DraftCollection,
} from '../src/schemas/index.js';
import { createMincaAuth, type MincaAuth } from '../src/session/auth.js';
import { grantSigner, nodeOptionsFromGrant, type Grant } from '../src/session/connect.js';
import { connectWithCode, offerConnectCode } from '../src/session/connect-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { stored } from './helpers/stored.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { team } from '../src/space/presets.js';
import {
  assignKey,
  memberKeyRecordKey,
  removalKey,
  revokeKey,
  stepDownKey,
} from '../src/space/space-access.js';
import { nextVersion } from '../src/records/version.js';
import { hold, letGo } from './helpers/hold.js';
import { isRecord } from '../src/utils/guards.js';
import { until } from './helpers/until.js';
import { asked, open, person, settle, testAppKey, type Person } from './helpers/person.js';

/** A key for this person, and a note from their account for these spaces: records only, unless `command` says otherwise */
async function agentFor(
  who: Person,
  spaces: ReadonlyArray<string> | 'all',
  command = '/record',
  policy: Policy = [],
) {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const terms = noteTerms(command, spaces);
  const note = await createLocalRootSigner(who.me, provider).delegate({
    audience: did,
    ...terms,
    policy: [...(terms.policy ?? []), ...policy],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  return { keys, did, note };
}

/** A version signed by hand under such a note — past every check its node would make — slipped into the person's store */
async function forgeAsAgent(
  who: Person,
  space: string,
  fields: Omit<CreateVersionParams<unknown>, 'author' | 'space' | 'proof'>,
  note: { command?: string; policy?: Policy; everywhere?: boolean } = {},
) {
  const agent = await agentFor(who, note.everywhere ? 'all' : [space], note.command, note.policy);
  const provider = who.manager.getProvider();
  const signed = await createSigner(provider).sign(
    createVersion({
      seen: await seenBy(who.node, space),
      ...fields,
      author: agent.did,
      space,
      proof: agent.note,
      log: { n: 0 },
    }),
    agent.keys.privateKey,
  );
  await createStorageProvider(await who.stores(`spaces/${space}`)).addVersion(signed);
  return signed;
}

/** Alice owns a team space; Bob is an editor there */
async function setup() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Climbing', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  await hold(bob.node, space);
  return { hub, alice, bob, space };
}

const carpool: Blueprint = {
  title: 'Carpool',
  description: 'Who drives to the gym on Saturday',
  collections: [
    {
      name: 'app.carpool.trip',
      title: 'Trip',
      schema: {
        type: 'object',
        properties: { when: { type: 'string' }, seats: { type: 'integer', minimum: 1 } },
        required: ['when', 'seats'],
      },
    },
    {
      name: 'app.carpool.seat',
      title: 'Seat',
      schema: { type: 'object', properties: {} },
      links: { trip: { to: ['app.carpool.trip'], cardinality: 'one' } },
      rules: { onePer: ['@author', 'link:trip'] },
    },
  ],
};

describe('an agent acting for a person', () => {
  test("what it writes counts as the person's, and every peer sees it was written under a records-only note", async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.equal(helper.did, alice.node.did);
    assert.equal(helper.sessionDid, agent.did);

    const note = await helper.records.put(space, 'app.note', { text: 'Bring chalk' });
    const mine = await alice.node.records.put(space, 'app.note', { text: 'Bring rope' });
    assert.equal(note.recordsOnly, true, 'its note grants records only, which apps can trust by');
    assert.equal(mine.recordsOnly, undefined, "the person's own writes are not marked");

    await until(
      async () => (await bob.node.records.get(space, note.key)) !== null,
      4000,
      'the record to reach Bob',
    );
    const seen = await bob.node.records.get(space, note.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.root, alice.node.did);
    assert.equal(seen?.recordsOnly, true);
  });

  test('it only reaches the spaces its note names', async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Diary', visibility: 'private' });
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.deepEqual(
      (await helper.spaces.list()).map((s) => s.id),
      [space],
    );
    await assert.rejects(() => helper.records.list(other), /not given this space/);
    await assert.rejects(() => helper.records.put(other, 'app.note', { text: 'x' }), /not given this space/);
  });

  test('it can see who can be written to directly, but neither sends nor reads direct messages', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    await assert.rejects(() => helper.direct.send(space, [bob.node.did], 'hi'), /Ask the person/);
    await assert.rejects(() => helper.direct.list(space), /Ask the person/);
  });

  test('it cannot define collections, change roles, invite, or join — those need a person', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    await assert.rejects(
      () => helper.collections.define(space, { name: 'app.x', schema: { type: 'object' } }),
      /collections_propose/,
    );
    await assert.rejects(() => helper.spaces.invite(space), /Ask the person/);
    await assert.rejects(() => helper.spaces.removeMember(space, bob.node.did), /Ask the person/);
    await assert.rejects(() => helper.spaces.unassign(space, bob.node.did, 'editor'), /Ask the person/);
    await assert.rejects(() => helper.spaces.join('anything'), /Ask the person/);
    await assert.rejects(
      () => runAction(helper, 'collections_define', { space, name: 'app.x', schema: { type: 'object' } }),
      /collections_propose/,
    );
  });

  test("it cannot change a space's key, relays or keepers — not even one it was not given", async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Diary', visibility: 'private' });
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const before = (await alice.node.spaces.access(other)).key?.changes;
    for (const id of [space, other]) {
      await assert.rejects(() => helper.spaces.changeKey(id), /Ask the person/);
      await assert.rejects(() => helper.spaces.setRelays(id, ['wss://elsewhere.example']), /Ask the person/);
      await assert.rejects(() => helper.spaces.setKeepers(id, []), /Ask the person/);
    }
    assert.equal((await alice.node.spaces.access(other)).key?.changes, before);
  });

  test('a note that grants more than records will not do', async () => {
    const { alice, space } = await setup();
    const wide = await agentFor(alice, [space], '/');
    await assert.rejects(
      () => alice.node.asAgent({ keys: wide.keys, note: wide.note }),
      /grants more than records/,
    );
  });

  test('a definition signed by hand under a records-only note is ignored by every peer', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    const forged = await forgeAsAgent(alice, space, {
      collection: 'sys.collection',
      body: { name: 'app.sneaky', schema: { type: 'object' }, version: 1 },
      retain: true,
      version: { key: 'collection:app.sneaky', seq: 0 },
    });
    await hold(alice.node, space);
    // Refused on arrival as not a change anyone may make; even the person whose note it is ignores it.
    await settle(500);
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(forged.id),
      null,
    );
    assert.equal(
      (await alice.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null),
      false,
    );
    assert.equal(
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.sneaky' && c.version !== null),
      false,
    );
  });

  test('what counts is what the note grants', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    // Records only: not a change to the space's collections.
    const narrow = await forgeAsAgent(alice, space, {
      collection: 'sys.collection',
      body: { name: 'app.narrow', schema: { type: 'object' }, version: 1 },
      retain: true,
      version: { key: 'collection:app.narrow', seq: 0 },
    });
    // The same kind of key, under a note that grants everything, defining too: it counts.
    await forgeAsAgent(
      alice,
      space,
      {
        collection: 'sys.collection',
        body: { name: 'app.granted', schema: { type: 'object' }, version: 1 },
        retain: true,
        version: { key: 'collection:app.granted', seq: 0 },
      },
      { command: '/' },
    );
    await hold(alice.node, space);
    await until(
      async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.granted'),
      4000,
      'the granted definition',
    );
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(narrow.id),
      null,
    );
    assert.equal(
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.narrow' && c.version !== null),
      false,
    );
  });

  test('a note’s policy is checked by every peer: a key limited to one collection writes in no other', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    const policy: Policy = [['==', '.collection', 'app.note']];
    const inside = await forgeAsAgent(
      alice,
      space,
      {
        collection: 'app.note',
        body: { text: 'in' },
        version: { key: await ownedKey(alice.node.did, 'in'), seq: 0 },
      },
      { policy },
    );
    const outside = await forgeAsAgent(
      alice,
      space,
      {
        collection: 'app.other',
        body: { text: 'out' },
        version: { key: await ownedKey(alice.node.did, 'out'), seq: 0 },
      },
      { policy },
    );
    await hold(alice.node, space);
    await until(
      async () =>
        (await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(inside.id)) !== null,
      4000,
      'the version its note allows',
    );
    await settle(300);
    // Refused on arrival: its note's policy doesn't hold for `{ collection: "app.other", space }`.
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(outside.id),
      null,
    );
    assert.equal((await bob.node.records.get(space, outside.key))?.verified ?? null, null);
    assert.equal((await bob.node.records.get(space, inside.key))?.verified, true);
  });

  test('taking someone out of the space, under a records-only note, is ignored too', async () => {
    const { alice, bob, space } = await setup();
    // Bob knowing he joined is not Alice having heard it yet.
    await until(
      async () =>
        (await (await stored(alice.stores, space)).getCurrent(await assignKey(bob.node.did, 'editor'))) !==
        null,
      4000,
      "Alice to hold Bob's assignment",
    );
    const held = await (
      await stored(alice.stores, space)
    ).getCurrent(await assignKey(bob.node.did, 'editor'));
    await letGo(alice.node, space);
    await forgeAsAgent(alice, space, {
      collection: 'sys.assign',
      body: { did: bob.node.did, role: 'editor', assigned: false },
      retain: true,
      version: nextVersion(held!),
    });
    await hold(alice.node, space);
    await settle(500);
    assert.deepEqual((await bob.node.spaces.access(space)).mine, ['editor']);
    assert.deepEqual(
      (await alice.node.spaces.access(space)).members.find((m) => m.did === bob.node.did)?.roles,
      ['editor'],
    );
  });

  test("an app given a space never changes the account's own place there: every peer ignores it", async () => {
    const { alice, bob, space } = await setup();
    await until(
      async () =>
        (await (await stored(alice.stores, space)).getCurrent(await assignKey(bob.node.did, 'editor'))) !==
        null,
      4000,
      "Alice to hold Bob's assignment",
    );
    const held = await (
      await stored(alice.stores, space)
    ).getCurrent(await assignKey(bob.node.did, 'editor'));
    // The key Alice's node writes with.
    const { author: aliceKey } = await alice.node.records.put(space, 'app.note', { text: 'before' });
    await letGo(alice.node, space);
    await letGo(bob.node, space);
    // A note for everything, but about this one space: what a home gives an app it grants the space.
    const asApp = { command: '/' };
    // Each slipped into its own account's store: the other peer must refuse it.
    const bobs = [
      // Bob's app gives up Bob's role, makes Bob leave, and puts its own key where others seal to Bob.
      await forgeAsAgent(
        bob,
        space,
        {
          collection: 'sys.assign',
          body: { did: bob.node.did, role: 'editor', assigned: false },
          retain: true,
          version: nextVersion(held!),
        },
        asApp,
      ),
      await forgeAsAgent(
        bob,
        space,
        {
          collection: 'sys.remove',
          body: { did: bob.node.did },
          retain: true,
          version: { key: await removalKey(bob.node.did), seq: 0 },
        },
        asApp,
      ),
      await forgeAsAgent(
        bob,
        space,
        {
          collection: 'sys.memberkey',
          body: { key: (await agentFor(bob, [space])).did },
          retain: true,
          version: { key: await memberKeyRecordKey(bob.node.did), seq: 0 },
        },
        asApp,
      ),
    ];
    const alices = [
      // Alice's app steps her down, and revokes the key her node writes with.
      await forgeAsAgent(
        alice,
        space,
        {
          collection: 'sys.stepdown',
          body: { did: alice.node.did },
          retain: true,
          version: { key: await stepDownKey(alice.node.did), seq: 0 },
        },
        asApp,
      ),
      await forgeAsAgent(
        alice,
        space,
        {
          collection: 'sys.revoke',
          body: { key: aliceKey },
          retain: true,
          version: { key: await revokeKey(aliceKey, alice.node.did), seq: 0 },
        },
        asApp,
      ),
    ];
    await hold(alice.node, space);
    await hold(bob.node, space);
    await settle(500);
    for (const version of bobs)
      assert.equal(
        await createStorageProvider(await alice.stores(`spaces/${space}`)).getVersion(version.id),
        null,
      );
    for (const version of alices)
      assert.equal(
        await createStorageProvider(await bob.stores(`spaces/${space}`)).getVersion(version.id),
        null,
      );
    const access = await alice.node.spaces.access(space);
    assert.equal(access.founder, true);
    assert.deepEqual(access.members.find((m) => m.did === bob.node.did)?.roles, ['editor']);
    assert.deepEqual((await bob.node.spaces.access(space)).mine, ['editor']);
    // Alice still writes with the key her app tried to revoke.
    const after = await alice.node.records.put(space, 'app.note', { text: 'still here' });
    await until(
      async () => (await bob.node.records.get(space, after.key))?.verified === true,
      4000,
      "Alice's next note at Bob's",
    );
  });

  test('the same change under a note about the whole account counts: that key is one of the account’s devices', async () => {
    const { alice, bob, space } = await setup();
    await letGo(bob.node, space);
    const leaving = await forgeAsAgent(
      bob,
      space,
      {
        collection: 'sys.remove',
        body: { did: bob.node.did },
        retain: true,
        version: { key: await removalKey(bob.node.did), seq: 0 },
      },
      { command: '/', everywhere: true },
    );
    await hold(bob.node, space);
    await until(
      async () =>
        (await createStorageProvider(await alice.stores(`spaces/${space}`)).getVersion(leaving.id)) !== null,
      4000,
      "Bob's leaving at Alice's",
    );
    await until(
      async () => !(await alice.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
      4000,
      'Bob gone',
    );
  });
});

describe('collections proposed in a blueprint', () => {
  test('an agent proposes, someone who may define applies it, and the space then has the collections', async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });

    const proposed = z
      .object({
        key: z.string(),
        collections: z.array(z.object({ status: z.string(), summary: z.array(z.string()) })),
      })
      .parse(await runAction(helper, 'collections_propose', { space, ...carpool }));
    assert.deepEqual(
      proposed.collections.map((n) => n.status),
      ['new', 'new'],
    );
    assert.ok(
      proposed.collections[1]!.summary.includes(
        'One seat per person per trip — adding another changes the first.',
      ),
    );
    assert.equal(
      (await alice.node.collections.list(space)).some((c) => c.name === 'app.carpool.trip'),
      false,
      'nothing is defined yet',
    );

    // Bob sees it, and that an agent proposed it.
    await until(
      async () => (await bob.node.records.get(space, proposed.key)) !== null,
      4000,
      'the proposal to reach Bob',
    );
    const listed = z
      .array(
        z.object({
          title: z.string(),
          recordsOnly: z.boolean().optional(),
          applied: z.boolean(),
          proposedBy: z.string(),
        }),
      )
      .parse(await runAction(bob.node, 'collections_proposals', { space }));
    assert.equal(listed[0]?.title, 'Carpool');
    assert.equal(listed[0]?.recordsOnly, true);
    assert.equal(listed[0]?.applied, false);
    assert.equal(listed[0]?.proposedBy, alice.node.did);

    // The agent can't apply it, whatever route it takes.
    await assert.rejects(
      () => applyBlueprint(helper, space, proposed.key),
      /collections_propose|doesn't let/,
    );

    // Bob, an editor, may define collections: he applies it.
    const review = await applyBlueprint(bob.node, space, proposed.key);
    assert.equal(review.applied, true);
    const names = (await bob.node.collections.list(space))
      .filter((c) => c.version !== null)
      .map((c) => c.name);
    assert.ok(
      names.includes('app.carpool.trip') &&
        names.includes('app.carpool.seat') &&
        names.includes('std.blueprint'),
    );

    // And the agent can now use it, as Alice.
    const trip = await helper.records.put(space, 'app.carpool.trip', { when: 'Saturday 9:00', seats: 3 });
    await helper.records.put(space, 'app.carpool.seat', {}, { links: [{ rel: 'trip', to: trip.key }] });
  });

  test('an update replaces the blueprint it names: once applied, the old version is not offered again', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const Listed = z.array(
      z.object({
        key: z.string(),
        applied: z.boolean(),
        superseded: z.boolean(),
        updates: z.string().optional(),
      }),
    );
    const Proposed = z.object({ key: z.string() });
    const list = async () => Listed.parse(await runAction(alice.node, 'collections_proposals', { space }));
    const find = async (key: string) => (await list()).find((a) => a.key === key)!;
    const [trip, seat] = carpool.collections;
    assert.ok(trip && seat && isRecord(trip.schema.properties));
    const properties = trip.schema.properties;
    const withField = (field: string): Blueprint => ({
      ...carpool,
      collections: [
        { ...trip, schema: { ...trip.schema, properties: { ...properties, [field]: { type: 'string' } } } },
        seat,
      ],
    });

    const first = Proposed.parse(await runAction(helper, 'collections_propose', { space, ...carpool }));
    await applyBlueprint(alice.node, space, first.key);

    // The agent changes it: a new proposal that names the one it updates.
    const second = Proposed.parse(
      await runAction(helper, 'collections_propose', { space, ...withField('from'), updates: first.key }),
    );
    assert.equal((await find(second.key)).updates, first.key);
    assert.deepEqual(
      [(await find(first.key)).applied, (await find(first.key)).superseded],
      [true, false],
      'the added app stays until its update is',
    );

    await applyBlueprint(alice.node, space, second.key);
    assert.deepEqual([(await find(first.key)).applied, (await find(first.key)).superseded], [false, true]);
    assert.equal((await find(second.key)).applied, true);

    // Adding the old version again would only undo the update: refused.
    await assert.rejects(() => applyBlueprint(alice.node, space, first.key), /newer version/);

    // An update to the update replaces both before it.
    const third = Proposed.parse(
      await runAction(helper, 'collections_propose', { space, ...withField('note'), updates: second.key }),
    );
    await applyBlueprint(alice.node, space, third.key);
    assert.deepEqual(
      (await list())
        .filter((a) => a.superseded)
        .map((a) => a.key)
        .sort(),
      [first.key, second.key].sort(),
    );
    await assert.rejects(() => applyBlueprint(alice.node, space, second.key), /newer version/);

    // An update must name an app that is here.
    await assert.rejects(
      () => runAction(helper, 'collections_propose', { space, ...carpool, updates: 'nothing' }),
      /names no blueprint/,
    );
    assert.match(checkBlueprint({ ...carpool, updates: '' })!, /updates/);
  });

  test('a proposal that changes a collection the space has says so, and says how', async () => {
    const { alice, space } = await setup();
    await alice.node.collections.define(space, { ...carpool.collections[0]!, rules: { fixed: ['seats'] } });
    const review = reviewBlueprint(carpool, await alice.node.collections.list(space));
    assert.equal(review.collections[0]?.status, 'change');
    assert.deepEqual(review.collections[0]?.changes, ['changes what its records must keep to']);
    assert.equal(review.collections[1]?.status, 'new');
  });

  test('a change to a collection another blueprint uses names it, and warns the agent', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const Proposed = z.object({
      key: z.string(),
      warnings: z.array(z.string()).optional(),
      collections: z.array(
        z.object({ name: z.string(), status: z.string(), usedBy: z.array(z.string()).optional() }),
      ),
    });
    const first = Proposed.parse(await runAction(helper, 'collections_propose', { space, ...carpool }));
    await applyBlueprint(alice.node, space, first.key);

    const [trip] = carpool.collections;
    assert.ok(trip);
    const rides = { title: 'Rides', collections: [{ ...trip, schema: { type: 'object', properties: {} } }] };
    const clash = Proposed.parse(await runAction(helper, 'collections_propose', { space, ...rides }));
    assert.deepEqual(clash.collections[0]?.usedBy, ['Carpool']);
    assert.match(clash.warnings?.[0] ?? '', /app\.carpool\.trip, which Carpool uses/);

    // As a new version of Carpool itself, it touches nothing else.
    const update = Proposed.parse(
      await runAction(helper, 'collections_propose', { space, ...rides, updates: first.key }),
    );
    assert.equal(update.warnings, undefined);
    assert.equal(update.collections[0]?.usedBy, undefined);
  });

  test('a standard collection by name is exactly the library’s; a look-alike std.* is refused', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    const host = { name: 'meetup.host', schema: { type: 'object', properties: {} } };
    const Proposed = z.object({ key: z.string() });

    const proposed = Proposed.parse(
      await runAction(helper, 'collections_propose', {
        space,
        title: 'Meetups',
        collections: ['std.event', 'std.rsvp', host],
      }),
    );
    const record = await alice.node.records.get<Blueprint>(space, proposed.key);
    const stored = record?.body?.collections ?? [];
    assert.deepEqual(
      stored.map((n) => n.name),
      ['std.event', 'std.rsvp', 'meetup.host'],
    );
    assert.deepEqual(stored[0]?.rules, standardDefinition('std.event')?.rules);
    assert.deepEqual(stored[1]?.links, standardDefinition('std.rsvp')?.links);

    // Its own title on a standard collection is fine; its own shape is not.
    const event = standardDefinition('std.event')!;
    await runAction(helper, 'collections_propose', {
      space,
      title: 'Calendar',
      collections: [{ ...event, title: 'Gig' }],
    });
    await assert.rejects(
      () =>
        runAction(helper, 'collections_propose', {
          space,
          title: 'Calendar',
          collections: [{ ...event, rules: { edit: 'member' } }],
        }),
      /different shape/,
    );
    await assert.rejects(
      () => runAction(helper, 'collections_propose', { space, title: 'X', collections: ['std.made-up'] }),
      /not in the standard library/,
    );
  });

  test('collections_standard lists the library by area, and gives definitions in full', async () => {
    const { alice } = await setup();
    const Areas = z.array(
      z.object({ area: z.string(), collections: z.array(z.object({ name: z.string(), title: z.string() })) }),
    );
    const areas = Areas.parse(await runAction(alice.node, 'collections_standard', {}));
    const listed = areas.flatMap((a) => a.collections.map((c) => c.name));
    assert.equal(listed.length, standardSchemas.length);
    assert.ok(listed.includes('std.event') && listed.includes('std.list-item'));

    const Full = z.array(
      z.object({ name: z.string(), schema: z.object({}).loose(), summary: z.array(z.string()) }),
    );
    const [rsvp] = Full.parse(await runAction(alice.node, 'collections_standard', { names: ['std.rsvp'] }));
    assert.equal(rsvp?.name, 'std.rsvp');
    assert.ok(rsvp?.summary.some((line) => /One rsvp per person per event/.test(line)));
    await assert.rejects(
      () => runAction(alice.node, 'collections_standard', { names: ['std.nope'] }),
      /not in the standard library/,
    );
  });

  test('copying a blueprint into another space proposes it there, and says where it came from', async () => {
    const { alice, space } = await setup();
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    const proposed = await alice.node.records.put(space, 'std.blueprint', carpool);
    const copy = await copyBlueprint(alice.node, space, proposed.key, other);
    assert.equal(copy.body?.from, `${space}/${proposed.key}`);
    assert.equal(
      (await alice.node.collections.list(other)).some((c) => c.name === 'app.carpool.trip'),
      false,
    );
  });

  test("a proposal may not name the protocol's own collections, a version, or one collection twice", () => {
    assert.match(
      checkBlueprint({ title: 'x', collections: [{ name: 'sys.role', schema: { type: 'object' } }] })!,
      /protocol's own/,
    );
    assert.match(
      checkBlueprint({
        title: 'x',
        collections: [{ name: 'app.a', schema: { type: 'object' }, version: 3 }],
      })!,
      /version/,
    );
    assert.match(
      checkBlueprint({ title: 'x', collections: [carpool.collections[0], carpool.collections[0]] })!,
      /twice/,
    );
    assert.match(checkBlueprint({ title: 'x', collections: [] })!, /collections: Array has too few items/);
    assert.equal(checkBlueprint(carpool), null);
  });

  test("a blueprint made against an earlier standard definition is met by the library's current one, not offered as a change back", async () => {
    const { alice, space } = await setup();
    // std.message as it was before mentions and replies, the way an older proposal holds it.
    const earlier: DraftCollection = {
      name: message.name,
      title: 'Message',
      schema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } },
        required: ['text'],
      },
    };
    const oldChat: Blueprint = { title: 'Old chat', collections: [earlier] };

    await alice.node.collections.define(space, earlier);
    assert.equal(reviewBlueprint(oldChat, await alice.node.collections.list(space)).applied, true);
    await addSchemas(alice.node, space, [message]); // the library skips a collection the space has
    await alice.node.collections.define(space, message); // moving it to the current one is a choice

    const now = await alice.node.collections.list(space);
    assert.equal(reviewBlueprint(oldChat, now).applied, true);
    // A collection of its own is compared as it is.
    assert.equal(
      reviewBlueprint({ ...carpool, collections: [carpool.collections[0]!] }, now).collections[0]?.status,
      'new',
    );
  });

  test('a person whose role holds no /collection/define proposes the same way, and someone who may applies it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({
      name: 'Choir',
      visibility: 'public',
      roles: [{ name: 'singer', title: 'Singer', grants: [{ cmd: '/record', pol: [] }] }],
    });
    await carol.node.spaces.join(await alice.node.spaces.invite(space, { role: 'singer' }));
    await hold(alice.node, space);
    await joined(carol.node, space);
    await hold(carol.node, space);

    await assert.rejects(() => carol.node.collections.define(space, carpool.collections[0]!));
    const proposed = z
      .object({ key: z.string() })
      .parse(await runAction(carol.node, 'collections_propose', { space, ...carpool }));
    await until(
      async () => (await alice.node.records.get(space, proposed.key)) !== null,
      4000,
      "Carol's blueprint",
    );
    assert.equal((await applyBlueprint(alice.node, space, proposed.key)).applied, true);
  });

  test('collections_list points at the guides written about each collection', async () => {
    const { alice, space } = await setup();
    await alice.node.collections.define(space, carpool.collections[0]!);
    const guide = {
      name: 'carpool.how',
      title: 'Offering a ride',
      text: 'Write one trip per drive, and say how many seats are free.',
      collections: ['app.carpool.trip'],
    };
    await writeGuide(alice.node, space, guide);
    await writeGuide(alice.node, space, guide); // the same again writes nothing new
    const Lines = z.array(
      z.object({
        name: z.string(),
        guides: z.array(z.object({ key: z.string(), title: z.string() })).optional(),
      }),
    );
    const lines = Lines.parse(await runAction(alice.node, 'collections_list', { space }));
    const trip = lines.find((line) => line.name === 'app.carpool.trip');
    assert.equal(trip?.guides?.length, 1);
    assert.equal(trip?.guides?.[0]?.title, 'Offering a ride');
    const key = trip?.guides?.[0]?.key;
    assert.ok(key);
    const read = await alice.node.records.get<{ text: string }>(space, key);
    assert.equal(read?.body?.text, guide.text);
  });
});

describe('what a collection allows, in words', () => {
  test('a vote, from its rules', () => {
    assert.deepEqual(describeCollection(vote), [
      'One vote per person per poll or proposal — adding another changes the first.',
      'Each vote points at one thing: a poll or a proposal (“about”).',
    ]);
  });

  test('a poll: a fixed field', () => {
    assert.deepEqual(describeCollection(poll), ["Once a poll is added, its “options” can't be changed."]);
  });

  test("one per something that isn't per person: anyone adding another replaces the first", () => {
    const seat = { name: 'app.chess.seat', title: 'Seat', rules: { onePer: ['color'] } };
    assert.ok(
      describeCollection(seat).includes('One seat per color — anyone adding another replaces the first.'),
    );
  });

  test('no rules say nothing: who may write is the space’s grants, not the definition’s', () => {
    assert.deepEqual(describeCollection({ name: 'app.note' }), []);
  });

  test('every rule the protocol accepts adds a sentence, and one it does not know is refused', () => {
    // The rule names checkRules lists in its error — the source of truth for what a rule can be.
    const known = /use ([^)]+)\)/.exec(checkRules({ nope: 1 })!)![1]!.split(', ');
    const samples: Record<string, CollectionRules> = {
      onePer: { onePer: ['@author'] },
      fixed: { fixed: ['x'] },
      final: { final: true },
    };
    const baseline = describeCollection({ name: 'app.thing' });
    for (const rule of known) {
      assert.ok(
        rule in samples,
        `describe.ts has no sample for the rule "${rule}" — add one, and a sentence for it`,
      );
      const said = describeCollection({ name: 'app.thing', rules: samples[rule]! });
      assert.notDeepEqual(said, baseline, `the rule "${rule}" changes nothing in the summary`);
    }
    // A contract is not a rule, and says itself in its own words.
    assert.ok(
      describeCollection({
        name: 'app.thing',
        contract: { check: [{ that: 'body.amount > 0', else: 'An amount is more than 0' }] },
      }).some((sentence) => sentence.includes('An amount is more than 0')),
    );
    // A rule from some later version, beside one this version knows.
    const later = { final: true as const, someday: true };
    assert.throws(() => describeCollection({ name: 'app.thing', rules: later }), /No way to describe/);
  });
});

describe('a program connected by code, through the account home', () => {
  async function home(
    hub: FakeHub,
    values = new Map<string, string>([['minca.stay-signed-in', '"never"']]),
  ): Promise<MincaAuth> {
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const auth = createMincaAuth({
      rpId: 'home.test',
      storage: {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => void values.set(k, v),
        removeItem: (k) => void values.delete(k),
      },
      browser: { accounts: async () => accounts, stores: () => stores },
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    await auth.start();
    await auth.createAccount('Ada');
    const code = auth.getState().freshCode!;
    auth.codeSaved();
    // Whole-account grants need the person to have just proved it is them.
    await auth.confirm({ code });
    open.push({ close: () => auth.signOut() });
    return auth;
  }

  test('over a code: the program learns the app’s origin, and its proof is refused from any other', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const origin = 'https://example.test';
    const network = { relays: [], transport: (did: string) => hub.transport(did, 'code') };
    const program = await testAppKey('did:key:zCodeProgram');
    let proof = '';
    const offer = await offerConnectCode(
      { ...network, account: auth.getState().session!.did, origin },
      (stage) => {
        if (stage.kind !== 'asking') return;
        proof = stage.asking.proof;
        void auth
          .grant({
            origin,
            request: {
              v: 1,
              audience: stage.asking.did,
              proof: stage.asking.proof,
              name: stage.asking.name,
              access: 'write',
              scope: 'account',
              chooseSpaces: false,
              recordsOnly: true,
              via: 'code',
            },
            spaceIds: [],
          })
          .then((grant) => stage.allow({ ...grant, home: 'https://home.test/connect' }));
      },
    );
    open.push({ close: async () => offer.stop() });
    const grant = await connectWithCode({
      code: offer.code,
      key: program,
      name: 'Agent on laptop',
      recordsOnly: true,
      network,
    });
    assert.equal(grant.note.payload.cmd, '/record');
    assert.equal(grant.note.payload.sub, grant.did, 'about the whole account');
    assert.equal(grant.contactKey, undefined);

    // Gone again: its proof is refused from another origin, and still good from the app's.
    await auth.disconnect(origin, { audience: program.did });
    const replayed = {
      v: 1,
      audience: program.did,
      proof,
      access: 'write',
      scope: 'account',
      recordsOnly: true,
      via: 'code',
    } as const;
    await assert.rejects(
      auth.grant({ origin: 'https://other.test', request: replayed, spaceIds: [] }),
      /holds the key/,
    );
    await auth.grant({ origin, request: replayed, spaceIds: [] });
  });

  test('a connection kept in an older shape is dropped, not read as the app’s own', async () => {
    const values = new Map<string, string>([['minca.stay-signed-in', '"never"']]);
    const auth = await home(createFakeHub({ latencyMs: 1 }), values);
    const origin = 'https://app.test';
    const program = await testAppKey('did:key:zOldAgent');
    const key = `minca.connections:${auth.getState().session!.account.id}`;
    const kept = {
      origin,
      name: 'Agent',
      audience: program.did,
      access: 'write',
      scope: 'account',
      spaces: [],
      grantedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    // Before `via` and `recordsOnly`, a program's connection said `agent: true`.
    values.set(
      key,
      JSON.stringify([
        { ...kept, agent: true },
        { ...kept, audience: 'x', access: 'all' },
      ]),
    );
    assert.deepEqual(auth.connections(), [], 'neither is read in part');

    // So the program connects again by code, and the app connecting again leaves it be.
    const whole = { v: 1, access: 'write', scope: 'account', via: 'code', recordsOnly: true } as const;
    await auth.grant({
      origin,
      request: await asked({ ...whole, audience: 'did:key:zOldAgent' }, undefined, origin),
      spaceIds: [],
    });
    await auth.grant({
      origin,
      request: await asked({ v: 1, audience: 'did:key:zApp', access: 'write' }),
      spaceIds: [],
    });
    assert.deepEqual(
      auth
        .connections()
        .map((c) => [c.audience, c.via])
        .sort(),
      [
        [(await testAppKey('did:key:zApp')).did, undefined],
        [program.did, 'code'],
      ].sort(),
    );
  });

  test("the home signs a records-only note for the program's key, kept apart from the app's own; the app going takes it too", async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const gym = await node.spaces.create({ name: 'Gym', visibility: 'private' });
    const origin = 'https://app.test';

    const app = await auth.grant({
      origin,
      request: await asked({ v: 1, audience: 'did:key:zApp', access: 'write' }),
      spaceIds: [gym.id],
    });
    const agent = await auth.grant({
      origin,
      request: await asked(
        {
          v: 1,
          audience: 'did:key:zAgent',
          access: 'write',
          via: 'code',
          recordsOnly: true,
        },
        undefined,
        origin,
      ),
      spaceIds: [gym.id],
    });
    assert.equal(agent.note.payload.meta, undefined, 'no label: the note says what it grants');
    // What keeps it from defining collections anywhere: its note grants records only.
    assert.equal(agent.note.payload.cmd, '/record');
    assert.equal(agent.note.payload.sub, `space:${gym.id}`);
    assert.equal(app.note.payload.cmd, '/');
    assert.equal(app.note.payload.sub, `space:${gym.id}`);
    assert.equal(agent.accountKey, undefined);
    assert.equal(auth.connections().length, 2, 'the program does not replace the app');

    await assert.rejects(
      async () =>
        auth.grant({
          origin,
          request: await asked(
            {
              v: 1,
              audience: 'did:key:zAgent',
              access: 'write',
              via: 'code',
              recordsOnly: true,
              create: [{ name: 'Mine', visibility: 'private' }],
            },
            undefined,
            origin,
          ),
          spaceIds: [],
        }),
      /spaces that exist/,
    );

    await auth.disconnect(origin, { byCode: true });
    assert.deepEqual(
      auth.connections().map((c) => c.audience),
      [(await testAppKey('did:key:zApp')).did],
    );
    await auth.grant({
      origin,
      request: await asked(
        {
          v: 1,
          audience: 'did:key:zAgent2',
          access: 'write',
          via: 'code',
          recordsOnly: true,
        },
        undefined,
        origin,
      ),
      spaceIds: [gym.id],
    });
    await auth.disconnect(origin);
    assert.equal(auth.connections().length, 0);
  });

  test('a program on a computer gets the whole account, records only, for as long as asked; each is its own connection', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const origin = 'https://app.test';
    const whole = {
      v: 1,
      access: 'write',
      via: 'code',
      recordsOnly: true,
      scope: 'account',
      chooseSpaces: false,
    } as const;

    const laptop = await auth.grant({
      origin,
      request: await asked(
        { ...whole, audience: 'did:key:zLaptop', name: 'Agent on laptop', days: 30 },
        undefined,
        origin,
      ),
      spaceIds: [],
    });
    const desk = await auth.grant({
      origin,
      request: await asked(
        { ...whole, audience: 'did:key:zDesk', name: 'Agent on desk', days: 1 },
        undefined,
        origin,
      ),
      spaceIds: [],
    });
    assert.ok(laptop.accountKey, 'it follows the account, so spaces made later reach it');
    assert.equal(laptop.note.payload.cmd, '/record');
    assert.equal(laptop.note.payload.sub, laptop.did);
    assert.equal(
      laptop.contactKey,
      undefined,
      'the whole account, but never the contact key: it opens contact requests and knocks',
    );
    const app = await auth.grant({
      origin: 'https://whole.test',
      request: await asked({ v: 1, access: 'write', scope: 'account', audience: 'did:key:zWholeApp' }),
      spaceIds: [],
    });
    assert.ok(app.contactKey, 'an app given the whole account does get it');
    await auth.disconnect('https://whole.test');
    const day = 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(laptop.expiresAt - (now + 30 * day)) < 60);
    assert.ok(Math.abs(desk.expiresAt - (now + day)) < 60);
    assert.equal(auth.connections().length, 2, 'a second program does not replace the first');

    await auth.disconnect(origin, { audience: (await testAppKey('did:key:zLaptop')).did });
    assert.deepEqual(
      auth.connections().map((c) => c.name),
      ['Agent on desk'],
    );
  });
});

describe('an agent running a node of its own', () => {
  test('it never takes a contact key, even one a home sent with a records-only note', async () => {
    const { alice, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const wide = await agentFor(alice, [space], '/');
    const grant = (note: Grant['note']): Grant => ({
      v: 2,
      did: alice.node.did,
      name: 'Alice',
      note,
      access: 'write',
      scope: 'spaces',
      spaces: [],
      contactKey: base64UrlEncode(new Uint8Array(32).fill(7)),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      home: 'https://home.test/connect',
    });
    assert.equal(nodeOptionsFromGrant(grant(agent.note)).contactKey, undefined);
    assert.ok(nodeOptionsFromGrant(grant(wide.note)).contactKey);
  });

  /** What `minca connect` ends up with: its own key, and the home's grant for the whole account */
  async function agentNode(
    who: { me: Person['me']; manager: Person['manager']; seed: Uint8Array },
    hub: FakeHub,
  ) {
    const provider = who.manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(who.me, provider).delegate({
      audience: did,
      command: '/record',
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const grant: Grant = {
      v: 2,
      did: who.me.did,
      name: 'Ada',
      note,
      access: 'write',
      scope: 'account',
      spaces: [],
      accountKey: base64UrlEncode(await deriveAccountKey(who.seed)),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      home: 'https://home.test/connect',
    };
    const base = await createNode({
      signer: grantSigner(grant),
      sessionKey: keys,
      stores: memoryStores(),
      accountKey: base64UrlDecode(grant.accountKey!),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(base);
    return { base, node: await base.asAgent({ keys, note }), did };
  }

  async function accountHolder(hub: FakeHub) {
    const manager = createIdentityManager();
    const seed = generateSeed();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      accountKey: await deriveAccountKey(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    return { node, me, manager, stores, seed };
  }

  test("it finds the account's spaces by itself — ones made later too — and writes in them, records only", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const before = await ada.node.spaces.create({ name: 'Before', visibility: 'private' });
    const agent = await agentNode(ada, hub);
    await until(
      async () => (await agent.node.spaces.list()).some((space) => space.id === before.id),
      4000,
      'the space made before',
    );

    const after = await ada.node.spaces.create({ name: 'After', visibility: 'private' });
    await until(
      async () => (await agent.node.spaces.list()).some((space) => space.id === after.id),
      4000,
      'the space made after',
    );

    await hold(agent.node, after.id);
    await hold(ada.node, after.id);
    const note = await agent.node.records.put(after.id, 'app.note', { text: 'from the terminal' });
    await until(
      async () => (await ada.node.records.get(after.id, note.key)) !== null,
      4000,
      'the note reaching Ada',
    );
    const seen = await ada.node.records.get(after.id, note.key);
    assert.equal(seen?.recordsOnly, true);
    assert.equal(seen?.createdBy, ada.me.did);
  });

  test("in the account's own spaces, a version under a records-only note does not stand", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    await ada.node.account.setName('Ada');
    const registry = (await deriveAccountRegistry(await deriveAccountKey(ada.seed), ada.me.did)).space.id;
    const provider = ada.manager.getProvider();
    const slipIn = async (command: string) => {
      const pair = await provider.generateKeyPair();
      const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
      const note = await createLocalRootSigner(ada.me, provider).delegate({
        audience: did,
        command,
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });
      const signed = await createSigner(provider).sign(
        createVersion({
          seen: await seenBy(ada.node, registry),
          collection: 'app.note',
          version: {
            key: await ownedKey(ada.node.did, `note-${command === '/' ? 'all' : 'records'}`),
            seq: 0,
          },
          body: { text: 'Joined somewhere' },
          author: did,
          space: registry,
          log: { n: 0 },
          proof: note,
        }),
        pair.privateKey,
      );
      await createStorageProvider(await ada.stores(`spaces/${registry}`)).addVersion(signed);
      return ada.node.records.get(registry, signed.key);
    };
    // Past every writer's check, straight into the account's store: judged on reading, as from a peer.
    assert.equal(await slipIn('/record'), null, 'records only: it does not count');
    assert.equal((await slipIn('/'))?.verified, true, 'a note that grants /account/write: it does');
  });

  test('it never writes the account itself: not its list of spaces, not its name', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const home = await ada.node.spaces.create({ name: 'Home', visibility: 'private' });
    const agent = await agentNode(ada, hub);
    await until(
      async () => (await agent.node.spaces.list()).length === 1,
      4000,
      'the agent following the account',
    );
    await assert.rejects(() => agent.node.spaces.leave(home.id), /can't leave spaces/);
    // Past the agent's wrapper, on the node underneath: the account's own space refuses it too.
    await assert.rejects(() => agent.base.spaces.leave(home.id), /doesn't let it change the account/);
    await assert.rejects(() => agent.base.account.setName('Hacked'), /doesn't let it change the account/);
    await settle();
    assert.deepEqual(
      (await ada.node.spaces.list()).map((space) => space.name),
      ['Home'],
    );
  });
});
