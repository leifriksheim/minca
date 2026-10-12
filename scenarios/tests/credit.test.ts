/** 5. Mutual credit, judged by the library. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lineKey } from '../../packages/core/src/records/key.js';
import { story } from '../communities/credit.js';

describe('mutual credit: payments and the limit', () => {
  test('a payment past the limit fails; balances follow the newest that counts', async () => {
    const { c, alice, bob, pay, balance, a0, a1, b0 } = await story();
    const over = await pay(alice, a1, { to: bob, amount: 30, balance: -110 });
    await c.add(a0, a1, b0, over);
    assert.deepEqual(await c.verdicts(a0, a1, b0, over), ['pass', 'pass', 'pass', 'fail']);
    assert.equal(await balance(alice), -80);
    assert.equal(await balance(bob), 10);
  });

  test('a lying balance fails', async () => {
    const { c, alice, bob, pay, a0, a1 } = await story();
    const liar = await pay(alice, a1, { to: bob, amount: 30, balance: -50 });
    await c.add(a0, a1, liar);
    assert.equal(await c.verdict(liar), 'fail');
  });

  test('a payment claimed twice along the line fails (`once`)', async () => {
    const { c, bob, carol, pay, a0, b0 } = await story();
    const again = await pay(bob, b0, { to: carol, amount: 0, balance: 40, received: [a0] });
    await c.add(a0, b0, again);
    assert.equal(await c.verdict(again), 'fail');
  });

  test('a payment claimed twice in one version fails (`once`)', async () => {
    const { c, bob, carol, pay, a0 } = await story();
    const twice = await pay(bob, null, { to: carol, amount: 0, balance: 60, received: [a0, a0] });
    await c.add(a0, twice);
    assert.equal(await c.verdict(twice), 'fail');
  });

  test('sum([]) is 0.0: a payment that claims nothing adds up', async () => {
    const { c, a0 } = await story();
    await c.add(a0);
    assert.equal(await c.verdict(a0), 'pass');
  });
});

describe('mutual credit: a double spend from two devices of one account', () => {
  test('neither counts; the one before still does', async () => {
    const { c, alice, a0, a1, a1phone, balance } = await story();
    await c.add(a0, a1, a1phone);
    assert.deepEqual(await c.verdicts(a0, a1, a1phone), ['pass', 'fail', 'fail']);
    assert.equal(await balance(alice), -30);
  });
  test('until the second arrives, the first counts, and so does what a payee built on it', async () => {
    const { c, bob, carol, pay, a0, a1, a1phone } = await story();
    const c0 = await pay(carol, null, { to: bob, amount: 0, balance: 50, received: [a1] });
    await c.add(a0, a1, c0);
    assert.equal(await c.verdict(c0), 'pass');
    await c.add(a1phone);
    assert.equal(await c.verdict(c0), 'fail', 'not fixed by what it cited');
  });
});

describe('mutual credit: a payment arriving before its previous one', () => {
  test('it waits', async () => {
    const { c, a0, a1 } = await story();
    await c.add(a1);
    assert.equal(await c.verdict(a1), 'pending');
    await c.add(a0);
    assert.equal(await c.verdict(a1), 'pass');
  });
});

describe("mutual credit: a line is its account's own", () => {
  test("Carol can't grief Alice's line with a first version at its key", async () => {
    const { c, alice, carol, a0, a1 } = await story();
    const fake = await c.sign(carol, {
      collection: 'app.pay',
      body: {},
      version: { key: await lineKey(alice.node.did, 'app.pay'), seq: 0 },
    });
    await c.add(a0, a1, fake);
    assert.deepEqual(await c.verdicts(fake, a0, a1), ['fail', 'pass', 'pass']);
  });

  test("Carol can't grief Alice's line with a next version after a0", async () => {
    const { c, carol, a0, a1 } = await story();
    const fake = await c.sign(carol, {
      collection: 'app.pay',
      body: {},
      version: { key: a0.key, seq: 1, prev: a0.id, genesis: a0.id },
    });
    await c.add(a0, a1, fake);
    assert.deepEqual(await c.verdicts(fake, a1), ['fail', 'pass']);
  });

  test("Bob can't claim one payment twice through a second line: there is one per account", async () => {
    const { c, bob, carol, pay, a0 } = await story();
    const b0 = await pay(bob, null, { to: carol, amount: 0, balance: 30, received: [a0] });
    const b0x = await c.sign(bob, {
      collection: 'app.pay',
      body: { to: carol.node.did, amount: 0, balance: 30, received: [a0.id] },
    });
    await c.add(a0, b0, b0x);
    assert.deepEqual(await c.verdicts(b0, b0x), ['pass', 'fail']);
  });
});

describe('mutual credit: a payee who built on a double spend (a v1 limit)', () => {
  // Carol pays Bob 10, claims Alice's a1 (+50), pays Bob 30. Then Alice's phone double-spends.
  const carols = async (s: Awaited<ReturnType<typeof story>>) => {
    const c0 = await s.pay(s.carol, null, { to: s.bob, amount: 10, balance: -10 });
    const c1 = await s.pay(s.carol, c0, { to: s.bob, amount: 0, balance: 40, received: [s.a1] });
    const c2 = await s.pay(s.carol, c1, { to: s.bob, amount: 30, balance: 10 });
    return { c0, c1, c2 };
  };

  test('what she built on a1 falls with it', async () => {
    const s = await story();
    const { c0, c1, c2 } = await carols(s);
    await s.c.add(s.a0, s.a1, c0, c1, c2);
    assert.equal(await s.c.verdict(c2), 'pass');
    await s.c.add(s.a1phone);
    assert.deepEqual(await s.c.verdicts(c1, c2), ['fail', 'fail']);
    assert.equal(await s.balance(s.carol), -10);
  });

  test('there are no corrections in v1: a new payment after c0 is a double spend, and the line ends there', async () => {
    const s = await story();
    const { c0, c1, c2 } = await carols(s);
    const after = await s.pay(s.carol, c0, { to: s.bob, amount: 0, balance: -10 });
    await s.c.add(s.a0, s.a1, s.a1phone, c0, c1, c2, after);
    assert.deepEqual(await s.c.verdicts(after, c0), ['fail', 'pass']);
  });

  test("a double spend of one's own after a payment that counts: neither counts", async () => {
    const s = await story();
    const c0 = await s.pay(s.carol, null, { to: s.bob, amount: 10, balance: -10 });
    const fine = await s.pay(s.carol, c0, { to: s.bob, amount: 5, balance: -15 });
    const again = await s.pay(s.carol, c0, { to: s.bob, amount: 30, balance: -40 });
    await s.c.add(c0, fine, again);
    assert.deepEqual(await s.c.verdicts(fine, again), ['fail', 'fail']);
  });
});

describe('mutual credit: line declarations have closed keys', () => {
  test('the library refuses to declare a line with a key it does not know', async () => {
    await assert.rejects(story({ once: ['received'], restate: ['to', 'amount'] }), /line takes only "once"/);
  });
});
