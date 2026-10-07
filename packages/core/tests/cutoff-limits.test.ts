/**
 * What a cutoff may name is bounded (spec 03 §6.3), and shared: nobody can
 * make themselves unremovable, or crowd others out, by writing into many
 * collections. Apart from the other access tests: each writes over a
 * thousand records.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { team } from '../src/space/presets.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { person } from './helpers/person.js';

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

describe('cutoff limits', () => {
  test('nobody makes themselves unremovable by writing into more collections than a cutoff may name', async () => {
    const { alice, bob, space } = await sharedWithBob();
    let last = await bob.node.records.put(space, 'app.junk0', { i: 0 });
    for (let i = 1; i < 1030; i++) last = await bob.node.records.put(space, `app.junk${i}`, { i });
    await until(
      async () => (await alice.node.records.get(space, last.key)) !== null,
      20000,
      'all at Alice’s',
    );
    await alice.node.spaces.setMember(space, bob.node.did, null);
    assert.equal(
      (await alice.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
      false,
    );
  });
  test('a change reaching many accounts shares what its cutoff may name: one holder’s writing can’t crowd out another’s', async () => {
    const { hub, alice, bob, space } = await sharedWithBob();
    const carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    await joined(carol.node, space);
    const note = await carol.node.records.put(space, 'app.note', { text: 'honest' });
    let last = await bob.node.records.put(space, 'app.junk0', { i: 0 });
    for (let i = 1; i < 1030; i++) last = await bob.node.records.put(space, `app.junk${i}`, { i });
    await until(
      async () =>
        (await alice.node.records.get(space, last.key)) !== null &&
        (await alice.node.records.get(space, note.key)) !== null,
      20000,
      'all at Alice’s',
    );
    await alice.node.spaces.removeRole(space, 'editor');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.notEqual(
      await alice.node.records.get(space, note.key),
      null,
      'what Alice had seen of Carol stands',
    );
  });
});
