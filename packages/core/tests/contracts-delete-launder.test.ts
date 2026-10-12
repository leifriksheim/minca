/** A delete between a failing step and the next launders it: checks skip deletes, and the chain check skips what follows one. */
import { test } from 'node:test';
import { ownedKey } from '../src/records/key.js';
import assert from 'node:assert/strict';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { ownRecords } from './helpers/own-records.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, settle } from './helpers/person.js';

test('a failing first version, then a delete, is laundered by the version after', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...ownRecords, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, {
    name: 'app.claim',
    schema: { type: 'object' },
    rules: {
      check: [{ that: 'seq > 0 || body.n <= 10.0', else: 'Created with at most 10' }],
    },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () =>
      (await bob.node.collections.list(space)).some((c) => c.name === 'app.claim' && c.version !== null),
    4000,
    'defs',
  );
  await letGo(bob.node, space);
  const k1 = await ownedKey(bob.node.did, 'k1');
  const bad = await forge(bob, space, {
    author: '',
    collection: 'app.claim',
    body: { n: 100 },
    retain: true,
    version: { key: k1, seq: 0 },
  });
  const gone = await forge(bob, space, {
    author: '',
    collection: 'app.claim',
    body: null,
    deleted: true,
    retain: false,
    version: { key: k1, seq: 1, prev: bad.id, genesis: bad.id },
  });
  await forge(bob, space, {
    author: '',
    collection: 'app.claim',
    body: { n: 100 },
    retain: true,
    version: { key: k1, seq: 2, prev: gone.id, genesis: bad.id },
  });
  await hold(bob.node, space);
  await until(async () => (await alice.node.records.history(space, k1)).length >= 3, 6000, 'sync').catch(
    () => {},
  );
  await settle(300);
  const got = await alice.node.records.get<{ n: number }>(space, k1);
  assert.equal(got, null, 'n=100 counts by way of a failing seq 0 and a delete');
});
