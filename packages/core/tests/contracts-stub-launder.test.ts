/** Contracts are judged by readers: a version that fails or waits for ever can't hold a key, or be laundered (spec/09-contracts.md). */
import { test } from 'node:test';
import { ownedKey } from '../src/records/key.js';
import assert from 'node:assert/strict';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { ownRecords } from './helpers/own-records.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, settle } from './helpers/person.js';

async function setup(name: string, check: { that: string; else: string }) {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...ownRecords, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, {
    name,
    schema: { type: 'object' },
    rules: { check: [check] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () => (await bob.node.collections.list(space)).some((c) => c.name === name && c.version !== null),
    4000,
    'defs',
  );
  return { alice, bob, space };
}

test('a failing first version, not kept whole, is laundered by the next', async () => {
  const { alice, bob, space } = await setup('app.claim', {
    that: 'seq > 0 || body.n <= 10.0',
    else: 'Created with at most 10',
  });
  await letGo(bob.node, space);
  const k1 = await ownedKey(bob.node.did, 'k1');
  const bad = await forge(bob, space, {
    author: '',
    collection: 'app.claim',
    body: { n: 100 },
    retain: false,
    version: { key: k1, seq: 0 },
  });
  await forge(bob, space, {
    author: '',
    collection: 'app.claim',
    body: { n: 100 },
    retain: true,
    version: { key: k1, seq: 1, prev: bad.id, genesis: bad.id },
  });
  await hold(bob.node, space);
  await until(async () => (await alice.node.records.history(space, k1)).length >= 2, 4000, 'sync').catch(
    () => {},
  );
  await settle(300);
  const got = await alice.node.records.get<{ n: number }>(space, k1);
  assert.equal(got, null, 'n=100 counts by way of a failing seq 0 that was not kept whole');
});
