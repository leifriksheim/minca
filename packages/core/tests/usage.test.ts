/**
 * A host's usage meter (spec 08 §1.1): distinct writers and readers per space
 * over a rolling window, kept so they name nobody.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createUsageMeter } from '../src/node/usage.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { utf8Decode } from '../src/utils/encoding.js';

const DAY = 86_400;
const alice = 'did:key:zDnaeAlice111111111111111111111111111111111111';
const bob = 'did:key:zDnaeBob22222222222222222222222222222222222222222';

describe('the usage meter', () => {
  test('counts each account once however often it writes, and each space apart', async () => {
    const meter = await createUsageMeter({ store: createMemoryAdapter(), windowDays: 30 });
    for (let i = 0; i < 5; i += 1) await meter.wrote('club', alice);
    await meter.wrote('club', bob);
    await meter.wrote('notes', alice);
    meter.read('club', 'did:key:zDnaePhone');
    meter.read('club', 'did:key:zDnaePhone');
    meter.read('club', 'did:key:zDnaeLaptop');
    assert.deepEqual(await meter.usage('club'), { writers: 2, readers: 2, windowDays: 30 });
    assert.deepEqual(await meter.usage('notes'), { writers: 1, readers: 0, windowDays: 30 });
  });

  test('counts someone once over the window though they wrote on many days, and drops days past it', async () => {
    let now = 1_790_000_000;
    const store = createMemoryAdapter();
    const meter = await createUsageMeter({ store, windowDays: 30, now: () => now });
    await meter.wrote('club', alice);
    now += 10 * DAY;
    await meter.wrote('club', alice);
    await meter.wrote('club', bob);
    assert.equal((await meter.usage('club')).writers, 2);
    // Alice's first day falls out of the window; her second still counts.
    now += 25 * DAY;
    assert.equal((await meter.usage('club')).writers, 2);
    now += 10 * DAY;
    assert.equal((await meter.usage('club')).writers, 0);
    await meter.prune();
    await meter.flushed();
    assert.deepEqual(
      (await store.list('usage:')).filter((key) => key.startsWith('usage:club')),
      [],
      'the days past the window are gone from the store',
    );
  });

  test('writers survive a restart without being counted twice; readers start again', async () => {
    const store = createMemoryAdapter();
    const before = await createUsageMeter({ store, windowDays: 30 });
    await before.wrote('club', alice);
    before.read('club', 'did:key:zDnaePhone');
    await before.flushed();
    const after = await createUsageMeter({ store, windowDays: 30 });
    await after.wrote('club', alice);
    assert.deepEqual(await after.usage('club'), { writers: 1, readers: 0, windowDays: 30 });
  });

  test('the store holds no DID, only salted hashes', async () => {
    const store = createMemoryAdapter();
    const meter = await createUsageMeter({ store, windowDays: 30 });
    await meter.wrote('club', alice);
    await meter.wrote('club', bob);
    meter.read('club', 'did:key:zDnaePhone');
    await meter.flushed();
    for (const key of await store.list('')) {
      const bytes = await store.get(key);
      const text = bytes ? utf8Decode(bytes) : '';
      assert.ok(!key.includes('did:') && !text.includes('did:'), `${key} names nobody`);
    }
    // Another host, with its own salt, hashes the same account differently.
    const other = createMemoryAdapter();
    const elsewhere = await createUsageMeter({ store: other, windowDays: 30 });
    await elsewhere.wrote('club', alice);
    await elsewhere.flushed();
    const [here] = await store.list('usage:club');
    const [there] = await other.list('usage:club');
    assert.ok(here && there);
    const ours: unknown = JSON.parse(utf8Decode((await store.get(here))!));
    const theirs: unknown = JSON.parse(utf8Decode((await other.get(there))!));
    assert.ok(Array.isArray(ours) && Array.isArray(theirs));
    assert.ok(!ours.includes(theirs[0]));
  });

  test('with the members given, only their writes count; readers stop growing at a cap', async () => {
    const meter = await createUsageMeter({ store: createMemoryAdapter(), windowDays: 30 });
    await meter.wrote('club', alice);
    await meter.wrote('club', bob);
    assert.equal((await meter.usage('club', [alice])).writers, 1, 'Bob was removed');
    for (let i = 0; i < 20_000; i += 1) meter.read('club', `did:key:zDnaeMadeUp${i}`);
    assert.equal((await meter.usage('club')).readers, 10_000);
  });

  test('readers stop growing for a space across the whole window, not only for a day', async () => {
    let now = 1_800_000_000;
    const meter = await createUsageMeter({ store: createMemoryAdapter(), windowDays: 30, now: () => now });
    for (let day = 0; day < 30; day += 1) {
      for (let i = 0; i < 1_000; i += 1) meter.read('club', `did:key:zDnae${day}x${i}`);
      now += DAY;
    }
    now -= DAY;
    assert.equal((await meter.usage('club')).readers, 10_000);
  });

  test('forgetting a space drops its counts', async () => {
    const store = createMemoryAdapter();
    const meter = await createUsageMeter({ store, windowDays: 30 });
    await meter.wrote('club', alice);
    await meter.forget('club');
    await meter.flushed();
    assert.equal((await meter.usage('club')).writers, 0);
    assert.deepEqual(await store.list('usage:club'), []);
  });
});
