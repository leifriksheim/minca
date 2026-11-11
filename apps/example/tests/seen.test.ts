import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHub } from '../../../packages/core/tests/helpers/fake-transport.js';
import { person } from '../../../packages/core/tests/helpers/person.js';
import { team } from '@minca/core';
import { createSeenStore } from '../src/seen-store.js';
import { waitFor } from './helpers.js';

test('a look is written once, not again each time the account changes', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub, { accountKey: true });
  const { id: space } = await alice.node.spaces.create({ name: 'Climbing', ...team, visibility: 'private' });
  const registry = await alice.node.account.space();
  assert.ok(registry);
  const store = createSeenStore(alice.node);
  // Once the registry is read, a space none of her devices has seen begins.
  await waitFor(async () => {
    store.begin(space);
    return store.read().has(space);
  }, 'the registry is read');

  // A look counts only once it is later than the space began, in another millisecond.
  await waitFor(async () => {
    store.look(space, 'chat', new Date().toISOString());
    return 'chat' in (store.read().get(space)?.apps ?? {});
  }, 'the look is taken');
  store.keep(space);
  const seenRecord = async () => {
    const { records } = await alice.node.records.query(registry, { collection: 'minca.seen' });
    return records[0];
  };
  const seqOfLook = 1;
  await waitFor(async () => ((await seenRecord())?.seq ?? -1) >= seqOfLook, 'the look is written');
  // Each write is an account change, which reads the registry again: it must find nothing to add.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const record = await seenRecord();
  assert.ok(record);
  assert.equal(record.seq, seqOfLook, `written ${record.seq + 1} times`);
  await alice.node.close();
});
