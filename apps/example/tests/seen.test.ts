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

  store.look(space, 'chat', new Date(Date.now() + 1).toISOString());
  store.keep(space);
  const seenRecord = async () => {
    const { records } = await alice.node.records.query(registry, { collection: 'minca.seen' });
    return records[0];
  };
  await waitFor(async () => (await seenRecord()) !== undefined, 'the look is written');
  const record = await seenRecord();
  assert.ok(record);
  // Each write is an account change, which reads the registry again: it must find nothing to add.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const versions = await alice.node.records.history(registry, record.key);
  assert.equal(versions.length, 1, `written ${versions.length} times`);
  await alice.node.close();
});
