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

test('two devices that look at once each write their look, and neither answers the other', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const laptop = await person(hub, { accountKey: true });
  const phone = await person(hub, { accountKey: true, seed: laptop.seed });
  const { id: space } = await laptop.node.spaces.create({ name: 'Climbing', ...team, visibility: 'private' });
  const registry = await laptop.node.account.space();
  assert.ok(registry);
  const stores = [createSeenStore(laptop.node), createSeenStore(phone.node)];
  await waitFor(async () => {
    stores[0]!.begin(space);
    return stores.every((store) => store.read().has(space));
  }, 'both to know the space');

  // Each looks at a different app, at the same moment.
  const now = Date.now();
  stores[0]!.look(space, 'chat', new Date(now + 1).toISOString());
  stores[1]!.look(space, 'lists', new Date(now + 2).toISOString());
  for (const store of stores) store.keep(space);
  const current = async () =>
    (await laptop.node.records.query(registry, { collection: 'minca.seen' })).records[0]?.version;
  await waitFor(async () => (await current()) !== undefined, 'a look to be written');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const settled = await current();
  // Account changes keep coming in; nothing written answers them.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await current(), settled, 'a device wrote in answer to the other');
  await Promise.all([laptop.node.close(), phone.node.close()]);
});
