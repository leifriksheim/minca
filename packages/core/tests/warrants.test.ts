/**
 * Warrants (docs/warrants.md): a version no honest writer could have signed
 * is proof against its account. The peer that refuses it writes the proof
 * down, every peer checks it, and the account is flagged for every member. A
 * proof that doesn't hold flags nobody.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStorageProvider } from '../src/storage/storage-provider.js';
import { stubOf } from '../src/schema/version.js';
import { team } from '../src/space/presets.js';
import { MEMBER_COLLECTION } from '../src/space/roles.js';
import { isRecord } from '../src/utils/guards.js';
import { readWarrant } from '../src/records/warrant.js';
import { memberKey, newWarrantKey, WARRANT_COLLECTION } from '../src/space/space-access.js';
import type { Version } from '../src/types.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, type Person } from './helpers/person.js';
import { seenBy } from './helpers/as-member.js';

async function sharedWithBob() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  // And Alice has his join: until then, to her he is no member.
  await until(
    async () => (await alice.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
    4000,
    'Alice to see Bob join',
  );
  return { hub, alice, bob, space };
}

/** Slips versions into someone's copy, from where they sync, as a modified client would write them */
async function slip(who: Person, space: string, versions: ReadonlyArray<Version>) {
  await letGo(who.node, space);
  const store = createStorageProvider(await who.stores(`spaces/${space}`));
  for (const version of versions) await store.addVersion(version);
  await hold(who.node, space);
}

/** A warrant's first version in someone's copy, found by the offence it proves */
async function warrantAbout(who: Person, space: string, offence: string): Promise<Version | null> {
  const store = createStorageProvider(await who.stores(`spaces/${space}`));
  for (const versions of (await store.histories('warrant:')).values())
    for (const version of versions) {
      const offending = readWarrant(version.body)?.evidence[0];
      if (version.seq === 0 && offending?.id === offence) return version;
    }
  return null;
}

const flaggedFor = async (who: Person, space: string) => (await who.node.spaces.access(space)).flagged;

/** Until both see the account flagged for that kind */
const flaggedEverywhere = (people: ReadonlyArray<Person>, space: string, account: string, kind: string) =>
  Promise.all(
    people.map((one) =>
      until(
        async () => (await flaggedFor(one, space)).some((f) => f.account === account && f.kind === kind),
        8000,
        `${kind} to be flagged`,
      ),
    ),
  );

describe('warrants', () => {
  test('a member who signs past their place, as of what they had seen, is flagged for everyone', async () => {
    const { alice, bob, space } = await sharedWithBob();
    // Only those who may post can create one, and editors may not.
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      permissions: ['post'],
      rules: { create: 'can:post' },
    });
    await until(
      async () => !(await bob.node.records.can(space, 'create', 'app.notice')),
      4000,
      'the rules to reach Bob',
    );
    const forged = await forge(
      bob,
      space,
      { collection: 'app.notice', body: { text: 'hi' } },
      { keep: false },
    );
    await slip(bob, space, [forged]);

    await flaggedEverywhere([alice, bob], space, bob.node.did, 'standing');
    const [flag] = (await flaggedFor(alice, space)).filter((f) => f.account === bob.node.did);
    assert.equal(flag?.key, forged.author, 'the key that signed it');
    assert.equal(flag?.by, alice.node.did, 'Alice brought the proof');
  });

  test('a change to who may do what that its author had no power for, as of what they had seen', async () => {
    const { alice, bob, space } = await sharedWithBob();
    // Bob, an editor, makes himself an owner: the next version of his own member record.
    const store = createStorageProvider(await bob.stores(`spaces/${space}`));
    const current = (await store.getCurrent(await memberKey(bob.node.did)))!;
    const proper = await forge(
      bob,
      space,
      {
        collection: MEMBER_COLLECTION,
        body: { did: bob.node.did, role: 'owner' },
        version: {
          key: current.key,
          seq: current.seq + 1,
          prev: current.id,
          genesis: current.genesis ?? current.id,
        },
        retain: true,
      },
      { keep: false },
    );
    await slip(bob, space, [proper]);
    await flaggedEverywhere([alice, bob], space, bob.node.did, 'access');
    assert.equal(
      (await alice.node.spaces.access(space)).members.find((m) => m.did === bob.node.did)?.role,
      'editor',
    );
  });

  test('a version that does not follow the one it names', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const mine = await bob.node.records.put(space, 'app.note', { text: 'mine' });
    const other = await bob.node.records.put(space, 'app.note', { text: 'other' });
    // An edit of one record that names the other's version as the one before.
    const crossed = await forge(
      bob,
      space,
      {
        collection: 'app.note',
        body: { text: 'crossed' },
        version: { key: mine.key, seq: 1, prev: other.version, genesis: mine.version },
      },
      { keep: false },
    );
    await slip(bob, space, [crossed]);
    await flaggedEverywhere([alice, bob], space, bob.node.did, 'chain');
  });

  test('a warrant whose proof does not hold is stored like any record, and flags nobody', async () => {
    const { alice, bob, space } = await sharedWithBob();
    // Alice's honest note, offered as "proof" that she had no place.
    const honest = await alice.node.records.put(space, 'app.note', { text: 'honest' });
    const store = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => (await store.getVersion(honest.version)) !== null, 4000, 'the note');
    const evidence = stubOf((await store.getVersion(honest.version))!);
    const lie = await forge(
      bob,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'standing', evidence: [evidence] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(bob, space, [lie]);
    await until(async () => (await store.getVersion(lie.id)) !== null, 4000, 'the lie at Alice’s');
    for (const who of [alice, bob]) assert.deepEqual(await flaggedFor(who, space), [], 'nobody is flagged');
  });

  test('the accused can’t overwrite the proof against them: a warrant is its writer’s own record', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      permissions: ['post'],
      rules: { create: 'can:post' },
    });
    await until(async () => !(await bob.node.records.can(space, 'create', 'app.notice')), 4000, 'the rules');
    const bad = await forge(bob, space, { collection: 'app.notice', body: { text: 'hi' } }, { keep: false });
    await slip(bob, space, [bad]);
    await flaggedEverywhere([alice, bob], space, bob.node.did, 'standing');

    // Bob writes the next version of Alice's warrant against him: of a kind nobody knows, with one
    // of his own versions as evidence — so it names him, and would stand unjudged and flag no one.
    const own = await bob.node.records.put(space, 'app.note', { text: 'mine' });
    const bobStore = createStorageProvider(await bob.stores(`spaces/${space}`));
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(
      async () => (await warrantAbout(bob, space, bad.id)) !== null,
      4000,
      'Alice’s warrant at Bob’s',
    );
    const current = (await warrantAbout(bob, space, bad.id))!;
    const { key } = current;
    const overwrite = await forge(
      bob,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'nothingtosee', evidence: [stubOf((await bobStore.getVersion(own.version))!)] },
        version: { key, seq: current.seq + 1, prev: current.id, genesis: current.genesis ?? current.id },
        retain: true,
      },
      { keep: false },
    );
    await slip(bob, space, [overwrite]);
    const after = await bob.node.records.put(space, 'app.note', { text: 'after' });
    await until(
      async () => (await alice.node.records.get(space, after.key)) !== null,
      4000,
      'Bob’s next note',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Any member may write a record's next version; the proof is the first, kept whole.
    await until(async () => (await aliceStore.getVersion(overwrite.id)) !== null, 4000, 'the overwrite');
    for (const who of [alice, bob])
      assert.ok(
        (await flaggedFor(who, space)).some((f) => f.account === bob.node.did && f.kind === 'standing'),
        'Bob is still flagged',
      );
  });

  test('the accused can’t get in first: a warrant against yourself is never proof', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      permissions: ['post'],
      rules: { create: 'can:post' },
    });
    await until(async () => !(await bob.node.records.can(space, 'create', 'app.notice')), 4000, 'the rules');
    const bad = await forge(bob, space, { collection: 'app.notice', body: { text: 'hi' } }, { keep: false });
    // Bob warrants himself first, hoping Alice's node sees him flagged and writes nothing.
    const self = await forge(
      bob,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'standing', evidence: [stubOf(bad)] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(bob, space, [self, bad]);
    // Flagged all the same, for whichever Alice's node saw first: the false self-warrant, or the post.
    for (const who of [alice, bob])
      await until(
        async () =>
          (await flaggedFor(who, space)).some((f) => f.account === bob.node.did && f.by === alice.node.did),
        8000,
        'Bob to be flagged by Alice',
      );
    // His warrant against himself is a record like any other, and flags nobody.
    assert.equal(
      (await flaggedFor(alice, space)).some((f) => f.by === bob.node.did),
      false,
    );
    const hers = await Promise.all([self.id, bad.id].map((id) => warrantAbout(alice, space, id)));
    assert.ok(hers.some(Boolean), 'Alice wrote her own');
  });

  test('removing a witness withdraws their warrant, but doesn’t silence them: back in, they warrant the next offence', async () => {
    const { alice, bob, space } = await sharedWithBob();
    /** A version whose `prev` names a version of another record: a broken chain */
    const crossed = async () => {
      const mine = await alice.node.records.put(space, 'app.note', { text: 'mine' });
      const other = await alice.node.records.put(space, 'app.note', { text: 'other' });
      return forge(
        alice,
        space,
        {
          collection: 'app.note',
          body: { text: 'x' },
          version: { key: mine.key, seq: 1, prev: other.version, genesis: mine.version },
        },
        { keep: false },
      );
    };
    const flaggedBy = async () =>
      (await flaggedFor(bob, space)).some((f) => f.account === alice.node.did && f.by === bob.node.did);
    await slip(alice, space, [await crossed()]);
    await until(flaggedBy, 8000, 'Bob’s warrant');

    // Alice removes Bob, keeping nothing: his warrant is withdrawn with the rest.
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    const membership = (await aliceStore.getCurrent(await memberKey(bob.node.did)))!;
    const removal = await forge(
      alice,
      space,
      {
        collection: MEMBER_COLLECTION,
        body: { did: bob.node.did, role: null },
        version: {
          key: membership.key,
          seq: membership.seq + 1,
          prev: membership.id,
          genesis: membership.genesis ?? membership.id,
        },
        retain: true,
      },
      { keep: false },
    );
    await slip(alice, space, [removal]);
    await until(async () => (await bob.node.spaces.access(space)).role === null, 8000, 'the removal');
    await until(async () => !(await flaggedBy()), 4000, 'the warrant to be withdrawn');

    // Alice gives him his place back, and he sees her break a chain again.
    await alice.node.spaces.setMember(space, bob.node.did, 'editor');
    await letGo(bob.node, space);
    await hold(bob.node, space);
    await joined(bob.node, space, 8000);
    await slip(alice, space, [await crossed()]);
    await until(flaggedBy, 8000, 'Bob’s warrant again');
    await until(
      async () => (await flaggedFor(alice, space)).some((f) => f.account === alice.node.did),
      8000,
      'Alice to see it too',
    );
  });

  test('a copy with the real id and signature but another body proves nothing against its author', async () => {
    const { hub, alice, bob, space } = await sharedWithBob();
    const mallory = await person(hub);
    await mallory.node.spaces.join(await alice.node.spaces.invite(space));
    await joined(mallory.node, space);
    await hold(mallory.node, space);
    // Alice, honestly, takes Bob's role away, and every peer judges the change.
    await alice.node.spaces.setMember(space, bob.node.did, null);
    const mallorysStore = createStorageProvider(await mallory.stores(`spaces/${space}`));
    await until(
      async () => !(await mallory.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
      4000,
      'the change at Mallory’s',
    );
    const real = (await mallorysStore.getCurrent(await memberKey(bob.node.did)))!;
    // Mallory keeps its id, signature and body hash, and swaps the body for a change no owner
    // could make: to a role that doesn't exist.
    assert.ok(isRecord(real.body));
    const counterfeit = { ...real, body: { ...real.body, role: 'nosuch' } };
    const lie = await forge(
      mallory,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'access', evidence: [counterfeit] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(mallory, space, [lie]);
    const after = await mallory.node.records.put(space, 'app.note', { text: 'after' });
    await until(
      async () => (await alice.node.records.get(space, after.key)) !== null,
      4000,
      'Mallory’s next note',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const who of [alice, mallory])
      assert.equal(
        (await flaggedFor(who, space)).some((f) => f.account === alice.node.did),
        false,
      );
  });

  test('a copy with the real id and signature but another envelope proves nothing against its author', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const honest = await bob.node.records.put(space, 'app.note', { text: 'honest' });
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(
      async () => (await aliceStore.getVersion(honest.version)) !== null,
      4000,
      'the note at Alice’s',
    );
    // Every peer has judged the real one. Alice rewrites what its envelope says it had seen.
    const rewritten = { ...stubOf((await aliceStore.getVersion(honest.version))!), seen: [] };
    const lie = await forge(
      alice,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'standing', evidence: [rewritten] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(alice, space, [lie]);
    const after = await alice.node.records.put(space, 'app.note', { text: 'after' });
    await until(
      async () => (await bob.node.records.get(space, after.key)) !== null,
      4000,
      'Alice’s next note',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const who of [alice, bob])
      assert.equal(
        (await flaggedFor(who, space)).some((f) => f.account === bob.node.did),
        false,
      );
  });

  test('a rival change that arrives late can’t turn an honest write into proof against its writer', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const mallory = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({
      name: 'Plans',
      roles: [
        { name: 'owner', title: 'Owner', rank: 100, permissions: ['*'] },
        { name: 'manager', title: 'Manager', rank: 50, permissions: ['manage', 'invite'] },
        { name: 'editor', title: 'Editor', rank: 10, permissions: [] },
        { name: 'viewer', title: 'Viewer', rank: 5, permissions: [] },
      ],
      creatorRole: 'owner',
      visibility: 'public',
    });
    await hold(alice.node, space);
    await mallory.node.spaces.join(await alice.node.spaces.invite(space, { role: 'manager' }));
    await joined(mallory.node, space);
    await hold(mallory.node, space);
    // Carol holds the space with no role: a rival change will give her her first.
    await carol.node.spaces.join(await alice.node.spaces.invite(space, { write: false }));
    await hold(carol.node, space);
    await until(
      async () => (await mallory.node.spaces.access(space)).members.length === 2,
      8000,
      'Mallory in',
    );
    const roleAt = async (who: Person) =>
      (await who.node.spaces.access(space)).members.find((m) => m.did === carol.node.did)?.role ?? null;

    // Mallory signs two rivals as of the same point: R makes Carol an editor, X (sorting
    // first) a viewer. Only R goes out.
    const seen = await seenBy(mallory.node, space);
    const next = { key: await memberKey(carol.node.did), seq: 0 };
    const rival = (role: string) =>
      forge(
        mallory,
        space,
        {
          collection: MEMBER_COLLECTION,
          body: { did: carol.node.did, role },
          version: next,
          retain: true,
          seen,
        },
        { keep: false },
      );
    const back = await rival('editor');
    let first = await rival('viewer');
    while (first.id >= back.id) first = await rival('viewer');
    await slip(mallory, space, [back]);
    await until(async () => (await roleAt(alice)) === 'editor', 8000, 'Carol made an editor');
    await joined(carol.node, space, 8000);

    // Carol writes, honestly; then the rival arrives, and Mallory cites her note.
    const note = await carol.node.records.put(space, 'app.note', { text: 'honest' });
    await until(async () => (await mallory.node.records.get(space, note.key)) !== null, 8000, 'the note');
    await slip(mallory, space, [first]);
    await until(async () => (await roleAt(alice)) === 'viewer', 8000, 'the rival');
    const mallorysStore = createStorageProvider(await mallory.stores(`spaces/${space}`));
    const written = (await mallorysStore.getVersion(note.version))!;
    const accusation = await forge(
      mallory,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'standing', evidence: [stubOf(written)] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(mallory, space, [accusation]);
    // As of what her note saw, Carol was an editor, whatever came after: the accusation flags nobody.
    const alicesStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => (await alicesStore.getVersion(accusation.id)) !== null, 8000, 'the accusation');
    assert.equal(
      (await flaggedFor(alice, space)).some((f) => f.account === carol.node.did),
      false,
    );
  });

  test('a warrant of a kind this peer doesn’t know flags nobody', async () => {
    const { alice, bob, space } = await sharedWithBob();
    const own = await bob.node.records.put(space, 'app.note', { text: 'mine' });
    const bobStore = createStorageProvider(await bob.stores(`spaces/${space}`));
    const evidence = stubOf((await bobStore.getVersion(own.version))!);
    const unknown = await forge(
      alice,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'someday', evidence: [evidence] },
        version: { key: newWarrantKey(), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(alice, space, [unknown]);
    const after = await alice.node.records.put(space, 'app.note', { text: 'after' });
    await until(
      async () => (await bob.node.records.get(space, after.key)) !== null,
      4000,
      'Alice’s next note',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(await bobStore.getVersion(unknown.id), 'stored like any record');
    assert.equal((await flaggedFor(bob, space)).length, 0, 'and nobody is flagged for it');
  });

  test('a burst of offences costs an honest node one warrant', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      permissions: ['post'],
      rules: { create: 'can:post' },
    });
    await until(async () => !(await bob.node.records.can(space, 'create', 'app.notice')), 4000, 'the rules');
    const offences: Version[] = [];
    for (let i = 0; i < 20; i++)
      offences.push(await forge(bob, space, { collection: 'app.notice', body: { i } }, { keep: false }));
    await slip(bob, space, offences);
    await flaggedEverywhere([alice], space, bob.node.did, 'standing');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    assert.equal((await aliceStore.queryVersions(WARRANT_COLLECTION)).length, 1);
  });

  test('a warrant out of shape, such as one from an older version, flags nobody', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await alice.node.collections.define(space, {
      name: 'app.notice',
      schema: { type: 'object' },
      permissions: ['post'],
      rules: { create: 'can:post' },
    });
    await until(async () => !(await bob.node.records.can(space, 'create', 'app.notice')), 4000, 'the rules');
    const bad = await forge(bob, space, { collection: 'app.notice', body: { text: 'hi' } }, { keep: false });
    // A true proof, at a key that isn't a warrant's.
    const misplaced = await forge(
      alice,
      space,
      {
        collection: WARRANT_COLLECTION,
        body: { kind: 'standing', evidence: [stubOf(bad)] },
        version: { key: 'misplaced', seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(alice, space, [misplaced]);
    const after = await alice.node.records.put(space, 'app.note', { text: 'after' });
    await until(
      async () => (await bob.node.records.get(space, after.key)) !== null,
      4000,
      'Alice’s next note',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bobStore = createStorageProvider(await bob.stores(`spaces/${space}`));
    assert.ok(await bobStore.getVersion(misplaced.id), 'stored like any record');
    assert.deepEqual(await flaggedFor(bob, space), []);
  });

  test('a race is not misconduct: a version withdrawn by a change it had not seen is never warranted', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await bob.node.records.put(space, 'app.note', { text: 'before' });
    // What a version Bob wrote now would name: read from his node, not a second copy of its store.
    const seenThen = (await bob.node.spaces.access(space)).heads;
    await alice.node.spaces.setMember(space, bob.node.did, null);
    await until(async () => (await bob.node.spaces.access(space)).role === null, 4000, 'the removal');
    // Written as if before the removal: withdrawn, as a write racing it would be — not refused.
    const backdated = await forge(
      bob,
      space,
      { collection: 'app.note', body: { text: 'backdated' }, seen: seenThen },
      { keep: false },
    );
    await slip(bob, space, [backdated]);
    const aliceStore = createStorageProvider(await alice.stores(`spaces/${space}`));
    await until(async () => (await aliceStore.getVersion(backdated.id)) !== null, 4000, 'it to arrive');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await flaggedFor(alice, space), []);
  });
});
