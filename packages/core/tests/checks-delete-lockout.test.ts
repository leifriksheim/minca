/** A delete continues a record's chain under checks: one after a failing step fails too (packages/core/docs/checks.md). */
/** A forged failing step then a delete locks every honest writer out of the key for good. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, settle } from './helpers/person.js';

test('a forged step and a delete after it hide nothing: the honest record reads on, and can be written', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, {
    name: 'app.setting',
    schema: { type: 'object' },
    rules: { check: [{ that: 'body.n <= 10.0', else: 'At most 10' }] },
  });
  const shared = (await alice.node.records.put(space, 'app.setting', { n: 5 }, { key: 'shared' })).key;
  await joined(bob.node, space);
  await until(async () => (await bob.node.records.get(space, shared)) !== null, 6000, 'v0 at bob');
  const id0 = (await bob.node.records.history(space, shared))[0]!.version;
  await letGo(bob.node, space);
  const bad = await forge(bob, space, {
    author: '',
    collection: 'app.setting',
    body: { n: 100 },
    retain: true,
    version: { key: shared, seq: 1, prev: id0, genesis: id0 },
  });
  await forge(bob, space, {
    author: '',
    collection: 'app.setting',
    body: null,
    deleted: true,
    retain: false,
    version: { key: shared, seq: 2, prev: bad.id, genesis: id0 },
  });
  await hold(bob.node, space);
  await until(async () => (await alice.node.records.history(space, shared)).length >= 3, 6000, 'sync').catch(
    () => {},
  );
  await settle(300);
  // The forged step and the delete after it count for no reader: Alice still reads her own, and can go on.
  assert.equal((await alice.node.records.get<{ n: number }>(space, shared))?.body?.n, 5);
  const next = await alice.node.records.update(space, shared, { n: 6 });
  assert.equal(next.body?.n, 6);
});
