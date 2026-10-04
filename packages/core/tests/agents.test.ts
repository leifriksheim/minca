/**
 * Agents acting for a person: they write under a note that grants records
 * only, so no peer lets them change a space's collections or who may do what,
 * and that says "agent", so every record shows it. Collections they invent
 * arrive as blueprints someone who may define them applies.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';

import { createNode } from '../src/node/node.js';
import { runAction } from '../src/node/actions.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { AGENT_FACT, isAgentNote } from '../src/identity/agent-note.js';
import { createSigner } from '../src/schema/signer.js';
import { createExpression, type CreateExpressionParams } from '../src/schema/expression.js';
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
import { createWeaveAuth, type WeaveAuth } from '../src/session/auth.js';
import { grantSigner, type Grant } from '../src/session/connect.js';
import { acceptAgentLink, newAgentCode, offerAgentLink, readAgentCode } from '../src/session/agent-link.js';
import { deriveVaultKeyBytes } from '../src/identity/account-vault.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { seenBy } from './helpers/as-member.js';
import { joined } from './helpers/joined.js';
import { stored } from './helpers/stored.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { team } from '../src/space/presets.js';
import { memberKey } from '../src/space/space-access.js';
import { nextVersion } from '../src/records/version.js';
import { hold, letGo } from './helpers/hold.js';
import { isRecord } from '../src/utils/guards.js';
import { until } from './helpers/until.js';
import { open, person, settle, type Person } from './helpers/person.js';

/**
 * An agent key for this person, and a note from their account saying it is an
 * agent's, for these spaces: records only, unless `can` says otherwise.
 */
async function agentFor(
  who: Person,
  spaces: ReadonlyArray<string>,
  facts = [AGENT_FACT],
  can = 'expression/*',
) {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
  const note = await createLocalRootSigner(who.me, provider).delegate({
    audience: did,
    capabilities: spaces.map((id) => ({ with: `space:${id}`, can })),
    expiration: Math.floor(Date.now() / 1000) + 3600,
    facts,
  });
  return { keys, did, note: note.encoded };
}

/** A version the agent signs by hand — past every check its node would make — slipped into the person's store */
async function forgeAsAgent(
  who: Person,
  space: string,
  fields: Omit<CreateExpressionParams<unknown>, 'author' | 'space' | 'proof'>,
  note: { facts?: (typeof AGENT_FACT)[]; can?: string } = {},
) {
  const agent = await agentFor(who, [space], note.facts, note.can);
  const provider = who.manager.getProvider();
  const signed = await createSigner(provider).sign(
    createExpression({
      seen: await seenBy(who.node, space),
      ...fields,
      author: agent.did,
      space,
      proof: agent.note,
    }),
    agent.keys.privateKey,
  );
  await createStorageProvider(await who.stores(`spaces/${space}`)).addExpression(signed);
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
      rules: { edit: 'creator', delete: 'creator' },
    },
    {
      name: 'app.carpool.seat',
      title: 'Seat',
      schema: { type: 'object', properties: {} },
      links: { trip: { to: ['app.carpool.trip'], cardinality: 'one' } },
      rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:trip'] },
    },
  ],
};

describe('an agent acting for a person', () => {
  test("what it writes counts as the person's, and every peer sees it came via an agent", async () => {
    const { alice, bob, space } = await setup();
    const agent = await agentFor(alice, [space]);
    const helper = await alice.node.asAgent({ keys: agent.keys, note: agent.note });
    assert.equal(helper.did, alice.node.did);
    assert.equal(helper.sessionDid, agent.did);

    const note = await helper.records.put(space, 'app.note', { text: 'Bring chalk' });
    assert.equal(note.viaAgent, true);
    const mine = await alice.node.records.put(space, 'app.note', { text: 'Bring rope' });
    assert.equal(mine.viaAgent, undefined, "the person's own writes are not marked");

    await until(
      async () => (await bob.node.records.get(space, note.key)) !== null,
      4000,
      'the record to reach Bob',
    );
    const seen = await bob.node.records.get(space, note.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.root, alice.node.did);
    assert.equal(seen?.viaAgent, true);
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
    await assert.rejects(() => helper.spaces.setMember(space, bob.node.did, null), /Ask the person/);
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

  test('a plain note will not do: the agent must be named as one', async () => {
    const { alice, space } = await setup();
    const plain = await agentFor(alice, [space], []);
    assert.equal(isAgentNote(plain.note), false);
    await assert.rejects(() => alice.node.asAgent({ keys: plain.keys, note: plain.note }), /not an agent/);
  });

  test('a definition an agent signs by hand is ignored by every peer', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    const forged = await forgeAsAgent(alice, space, {
      collection: 'sys.collection',
      body: { name: 'app.sneaky', schema: { type: 'object' }, version: 1 },
      retain: true,
      version: { key: 'collection:app.sneaky', seq: 0 },
    });
    await hold(alice.node, space);
    // Refused on arrival as not a change anyone may make; even the agent's own person ignores it.
    await settle(500);
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(forged.id),
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

  test('what counts is what the note grants, not whether it says agent', async () => {
    const { alice, bob, space } = await setup();
    await letGo(alice.node, space);
    // Records only, and no agent fact: still not a change to the space's collections.
    const narrow = await forgeAsAgent(
      alice,
      space,
      {
        collection: 'sys.collection',
        body: { name: 'app.narrow', schema: { type: 'object' }, version: 1 },
        retain: true,
        version: { key: 'collection:app.narrow', seq: 0 },
      },
      { facts: [] },
    );
    // The agent fact, but a note that grants everything, defining too: it counts.
    await forgeAsAgent(
      alice,
      space,
      {
        collection: 'sys.collection',
        body: { name: 'app.granted', schema: { type: 'object' }, version: 1 },
        retain: true,
        version: { key: 'collection:app.granted', seq: 0 },
      },
      { can: '*' },
    );
    await hold(alice.node, space);
    await until(
      async () => (await bob.node.collections.list(space)).some((c) => c.name === 'app.granted'),
      4000,
      'the granted definition',
    );
    assert.equal(
      await createStorageProvider(await bob.stores(`spaces/${space}`)).getExpression(narrow.id),
      null,
    );
    assert.equal(
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.narrow' && c.version !== null),
      false,
    );
  });

  test('taking someone out of the space, signed by an agent, is ignored too', async () => {
    const { alice, bob, space } = await setup();
    // Bob knowing he joined is not Alice having heard it yet.
    await until(
      async () =>
        (await (await stored(alice.stores, space)).getCurrent(await memberKey(bob.node.did))) !== null,
      4000,
      "Alice to hold Bob's member record",
    );
    const held = await (await stored(alice.stores, space)).getCurrent(await memberKey(bob.node.did));
    await letGo(alice.node, space);
    await forgeAsAgent(alice, space, {
      collection: 'sys.member',
      body: { did: bob.node.did, role: null },
      retain: true,
      version: nextVersion(held!),
    });
    await hold(alice.node, space);
    await settle(500);
    assert.equal((await bob.node.spaces.access(space)).role?.name, 'editor');
    assert.equal(
      (await alice.node.spaces.access(space)).members.find((m) => m.did === bob.node.did)?.role,
      'editor',
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
          viaAgent: z.boolean().optional(),
          applied: z.boolean(),
          proposedBy: z.string(),
        }),
      )
      .parse(await runAction(bob.node, 'collections_proposals', { space }));
    assert.equal(listed[0]?.title, 'Carpool');
    assert.equal(listed[0]?.viaAgent, true);
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
    await alice.node.collections.define(space, { ...carpool.collections[0]!, rules: {} });
    const review = reviewBlueprint(carpool, await alice.node.collections.list(space));
    assert.equal(review.collections[0]?.status, 'change');
    assert.deepEqual(review.collections[0]?.changes, ['changes who may do what']);
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
      rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
      permissions: ['moderate'],
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

  test('a person whose role does not hold define proposes the same way, and someone who may applies it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Choir', visibility: 'public' });
    await alice.node.spaces.putRole(space, { name: 'singer', title: 'Singer', rank: 1, permissions: [] });
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
      'Anyone in the space can add a vote.',
      'Only whoever added a vote can change or remove it.',
      'One vote per person per poll or proposal — adding another changes the first.',
      'Each vote points at one thing: a poll or a proposal (“about”).',
    ]);
  });

  test('a poll: different people change and remove, a fixed field, a permission', () => {
    assert.deepEqual(describeCollection(poll), [
      'Anyone in the space can add a poll.',
      'Only whoever added a poll can change it.',
      'Only whoever added a poll or those allowed to moderate can remove it.',
      "Once a poll is added, its “options” can't be changed.",
      'Roles in the space can be given permission to “moderate”.',
    ]);
  });

  test("one per something that isn't per person: the first one holds it, unless anyone may change it", () => {
    const seat = {
      name: 'app.chess.seat',
      title: 'Seat',
      rules: { edit: 'creator' as const, onePer: ['color'] },
    };
    assert.ok(describeCollection(seat).includes('One seat per color — whoever adds it first holds it.'));
    assert.ok(
      describeCollection({ ...seat, rules: { onePer: ['color'] } }).includes(
        'One seat per color — anyone adding another replaces the first.',
      ),
    );
  });

  test('no rules still says something: the defaults', () => {
    assert.deepEqual(describeCollection({ name: 'app.note' }), [
      'Anyone in the space can add a note.',
      'Anyone in the space can change or remove any note.',
    ]);
  });

  test('every rule the protocol accepts adds a sentence, and one it does not know is refused', () => {
    // The rule names checkRules lists in its error — the source of truth for what a rule can be.
    const known = /use ([^)]+)\)/.exec(checkRules({ nope: 1 })!)![1]!.split(', ');
    const samples: Record<string, CollectionRules> = {
      create: { create: 'can:post' },
      edit: { edit: 'creator' },
      delete: { delete: 'creator' },
      onePer: { onePer: ['@author'] },
      fixed: { fixed: ['x'] },
      check: { check: [{ that: { '>': [{ var: 'body.amount' }, 0] }, else: 'An amount is more than 0' }] },
      final: { final: true },
    };
    const baseline = describeCollection({ name: 'app.thing' });
    for (const rule of known) {
      assert.ok(
        rule in samples,
        `describe.ts has no sample for the rule "${rule}" — add one, and a sentence for it`,
      );
      const said = describeCollection({ name: 'app.thing', rules: samples[rule]!, permissions: ['post'] });
      assert.notDeepEqual(
        said.filter((s) => !s.includes('permission')),
        baseline,
        `the rule "${rule}" changes nothing in the summary`,
      );
    }
    // A rule from some later version, beside one this version knows.
    const later = { edit: 'creator' as const, someday: true };
    assert.throws(() => describeCollection({ name: 'app.thing', rules: later }), /No way to describe/);
  });
});

describe('an agent connected through the account home', () => {
  async function home(hub: FakeHub): Promise<WeaveAuth> {
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const values = new Map<string, string>([['weave.stay-signed-in', '"never"']]);
    const auth = createWeaveAuth({
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
    auth.codeSaved();
    open.push({ close: () => auth.signOut() });
    return auth;
  }

  test("the home signs an agent note, kept apart from the app's own; the app going takes its agents too", async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const gym = await node.spaces.create({ name: 'Gym', visibility: 'private' });
    const origin = 'https://app.test';

    const app = await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zApp', access: 'write' },
      spaceIds: [gym.id],
    });
    const agent = await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zAgent', access: 'write', agent: true },
      spaceIds: [gym.id],
    });
    assert.equal(isAgentNote(app.token), false);
    assert.equal(isAgentNote(agent.token), true);
    assert.equal(agent.agent, true);
    assert.equal(agent.accountKey, undefined);
    assert.equal(auth.connections().length, 2, 'the agent does not replace the app');

    await assert.rejects(
      () =>
        auth.grant({
          origin,
          request: {
            v: 1,
            audience: 'did:key:zAgent',
            access: 'write',
            agent: true,
            create: [{ name: 'Mine', visibility: 'private' }],
          },
          spaceIds: [],
        }),
      /spaces that exist/,
    );

    await auth.disconnect(origin, { agent: true });
    assert.deepEqual(
      auth.connections().map((c) => c.audience),
      ['did:key:zApp'],
    );
    await auth.grant({
      origin,
      request: { v: 1, audience: 'did:key:zAgent2', access: 'write', agent: true },
      spaceIds: [gym.id],
    });
    await auth.disconnect(origin);
    assert.equal(auth.connections().length, 0);
  });

  test('an agent on a computer gets the whole account, for as long as asked; each is its own connection', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const origin = 'https://app.test';
    const whole = { v: 1, access: 'write', agent: true, scope: 'account', chooseSpaces: false } as const;

    const laptop = await auth.grant({
      origin,
      request: { ...whole, audience: 'did:key:zLaptop', name: 'Agent on laptop', days: 30 },
      spaceIds: [],
    });
    const desk = await auth.grant({
      origin,
      request: { ...whole, audience: 'did:key:zDesk', name: 'Agent on desk', days: 1 },
      spaceIds: [],
    });
    assert.ok(laptop.accountKey, 'it follows the account, so spaces made later reach it');
    assert.ok(isAgentNote(laptop.token));
    assert.equal(
      laptop.contactKey,
      undefined,
      'the whole account, but never the contact key: it opens contact requests and knocks',
    );
    const app = await auth.grant({
      origin: 'https://whole.test',
      request: { v: 1, access: 'write', scope: 'account', audience: 'did:key:zWholeApp' },
      spaceIds: [],
    });
    assert.ok(app.contactKey, 'an app given the whole account does get it');
    await auth.disconnect('https://whole.test');
    const day = 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(laptop.expiresAt - (now + 30 * day)) < 60);
    assert.ok(Math.abs(desk.expiresAt - (now + day)) < 60);
    assert.equal(auth.connections().length, 2, 'a second agent does not replace the first');

    await auth.disconnect(origin, { audience: 'did:key:zLaptop' });
    assert.deepEqual(
      auth.connections().map((c) => c.name),
      ['Agent on desk'],
    );
  });
});

describe('an agent running a node of its own', () => {
  /** What `weave connect` ends up with: its own key, and the home's grant for the whole account */
  async function agentNode(
    who: { me: Person['me']; manager: Person['manager']; seed: Uint8Array },
    hub: FakeHub,
  ) {
    const provider = who.manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(who.me, provider).delegate({
      audience: did,
      capabilities: [{ with: '*', can: 'expression/*' }],
      expiration: Math.floor(Date.now() / 1000) + 3600,
      facts: [AGENT_FACT],
    });
    const grant: Grant = {
      v: 1,
      did: who.me.did,
      name: 'Ada',
      token: note.encoded,
      access: 'write',
      scope: 'account',
      spaces: [],
      accountKey: base64UrlEncode(await deriveVaultKeyBytes(who.seed)),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      agent: true,
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
    return { base, node: await base.asAgent({ keys, note: note.encoded }), did };
  }

  async function accountHolder(hub: FakeHub) {
    const manager = createIdentityManager();
    const seed = generateSeed();
    const me = await manager.fromSeed(seed);
    const stores = memoryStores();
    const node = await createNode({
      signer: createLocalRootSigner(me, manager.getProvider()),
      stores,
      accountKey: await deriveVaultKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)] },
    });
    open.push(node);
    return { node, me, manager, stores, seed };
  }

  test("it finds the account's spaces by itself — ones made later too — and writes in them via agent", async () => {
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
    assert.equal(seen?.viaAgent, true);
    assert.equal(seen?.createdBy, ada.me.did);
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

describe('connecting an agent with a code', () => {
  test("the app asks the person, the terminal gets a checked agent's note", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const provider = who.manager.getProvider();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const network = { relays: [], transport: (peer: string) => hub.transport(peer, 'agent-link') };

    const stages: string[] = [];
    const offer = await offerAgentLink(network, (stage) => {
      stages.push(stage.kind);
      if (stage.kind !== 'asking') return;
      assert.equal(stage.agent.name, 'Agent on laptop');
      void (async () => {
        const note = await createLocalRootSigner(who.me, provider).delegate({
          audience: stage.agent.did,
          capabilities: [{ with: '*', can: 'expression/*' }],
          expiration: Math.floor(Date.now() / 1000) + 3600,
          facts: [AGENT_FACT],
        });
        await stage.allow({
          v: 1,
          did: who.me.did,
          name: 'Ada',
          token: note.encoded,
          access: 'write',
          scope: 'account',
          spaces: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          agent: true,
          home: 'https://home.test/connect',
        });
      })();
    });
    open.push({ close: async () => offer.stop() });

    // Someone with a different code in the same place gets nowhere.
    await assert.rejects(
      () =>
        acceptAgentLink({
          code: newAgentCode(),
          did: 'did:key:zStranger',
          name: 'x',
          network,
          findTimeoutMs: 300,
        }),
      /did not answer/,
    );

    const grant = await acceptAgentLink({
      code: `npx weave connect ${offer.code}`,
      did,
      name: 'Agent on laptop',
      network,
    });
    assert.equal(grant.did, who.me.did);
    assert.ok(isAgentNote(grant.token));
    await until(async () => stages.includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(stages, ['waiting', 'asking', 'connected']);
  });

  test('saying no reaches the terminal, and a note for another key is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const network = { relays: [], transport: (peer: string) => hub.transport(peer, 'agent-link') };
    const offer = await offerAgentLink(network, (stage) => {
      if (stage.kind === 'asking') stage.deny('Not today.');
    });
    open.push({ close: async () => offer.stop() });
    await assert.rejects(
      () => acceptAgentLink({ code: offer.code, did: 'did:key:zLaptop', name: 'Agent', network }),
      /Not today/,
    );
    assert.throws(() => readAgentCode('wv_short'), /not a connect code/);
  });
});
