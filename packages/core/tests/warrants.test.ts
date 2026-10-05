/**
 * Warrants (spec 03 §6.6): a version no honest writer could have signed is
 * proof against its account. The peer that refuses it writes the proof down,
 * every peer checks it, and the account is flagged for every member. A proof
 * that doesn't hold is proof against whoever wrote it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStorageProvider } from '../src/storage/storage-provider.js';
import { stubOf } from '../src/schema/version.js';
import { team } from '../src/space/presets.js';
import { MEMBER_COLLECTION } from '../src/space/roles.js';
import { memberKey, warrantKey, WARRANT_COLLECTION } from '../src/space/space-access.js';
import type { Version } from '../src/types.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, type Person } from './helpers/person.js';

async function sharedWithBob() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  return { hub, alice, bob, space };
}

/** Slips versions into someone's copy, from where they sync, as a modified client would write them */
async function slip(who: Person, space: string, versions: ReadonlyArray<Version>) {
  await letGo(who.node, space);
  const store = createStorageProvider(await who.stores(`spaces/${space}`));
  for (const version of versions) await store.addVersion(version);
  await hold(who.node, space);
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

  test('a warrant whose proof does not hold is proof against whoever wrote it', async () => {
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
        version: { key: await warrantKey(alice.node.did), seq: 0 },
        retain: true,
      },
      { keep: false },
    );
    await slip(bob, space, [lie]);
    await flaggedEverywhere([alice], space, bob.node.did, 'warrant');
    assert.equal(
      (await flaggedFor(alice, space)).some((f) => f.account === alice.node.did),
      false,
      'Alice is not flagged',
    );
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
