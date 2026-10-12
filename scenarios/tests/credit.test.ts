/** 5. Mutual credit. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { judge, lineKey } from '../host/cel-host.js';
import { version, type Version } from '../host/space.js';
import { ALICE, BOB, CAROL, a0, a1, a1phone, b0, host, pay, payContract } from '../communities/credit.js';

const cel = (held: Version[]) => judge(held, host);
/** The balance by CEL: the newest version of the line that counts. The library's job, not the language's. */
async function celBalance(held: Version[], who: string): Promise<number | null> {
  const j = cel(held);
  const line = held.filter((v) => v.author === who && v.collection === 'app.pay');
  const counting: Version[] = [];
  for (const v of line) if ((await j.verdict(v.id)) === 'pass') counting.push(v);
  const newest = counting.find((v) => !counting.some((w) => w.prev === v.id));
  const b = newest?.body;
  return b && typeof b === 'object' && !Array.isArray(b) && 'balance' in b && typeof b.balance === 'number'
    ? b.balance
    : null;
}

describe('mutual credit: payments and the limit', () => {
  const over = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -110 });

  test('a payment past the limit fails; balances follow the newest that counts', async () => {
    const j = cel([a0, a1, b0, over]);
    assert.deepEqual(await Promise.all(['a0', 'a1', 'b0', 'a2'].map((id) => j.verdict(id))), [
      'pass',
      'pass',
      'pass',
      'fail',
    ]);
    assert.equal(await celBalance([a0, a1, b0, over], ALICE), -80);
    assert.equal(await celBalance([a0, a1, b0, over], BOB), 10);
  });

  test('a lying balance fails', async () => {
    const liar = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -50 });
    assert.equal(await cel([a0, a1, liar]).verdict('a2'), 'fail');
  });

  test('a payment claimed twice along the line fails (`once`)', async () => {
    const again = pay('b1', BOB, b0, {
      to: CAROL,
      amount: 0,
      balance: 40,
      received: ['a0'],
    });
    assert.equal(await cel([a0, b0, again]).verdict('b1'), 'fail');
  });

  test('a payment claimed twice in one version fails (`once`)', async () => {
    const twice = pay('b0', BOB, null, { to: CAROL, amount: 0, balance: 60, received: ['a0', 'a0'] });
    assert.equal(await cel([a0, twice]).verdict('b0'), 'fail');
  });

  test("CEL's trap: sum([]) is the int 0 today, and an int plus a double is an error", async () => {
    // Decided: sum([]) returns 0.0 (plan §3), in step 6; until then the contract pads with [0.0].
    const naive = payContract.map((c) => ({ ...c, that: c.that.replace(' + [0.0])', ')') }));
    const j = judge([a0], { ...host, contracts: { 'app.pay': naive } });
    assert.equal(await j.verdict('a0'), 'fail', 'a payment that claims nothing fails without "+ [0.0]"');
  });
});

describe('mutual credit: a double spend from two devices of one account', () => {
  const held = [a0, a1, a1phone];
  test('with the host rule, neither counts; the one before still does', async () => {
    const j = cel(held);
    assert.deepEqual(await Promise.all(['a0', 'a1', 'a1p'].map((id) => j.verdict(id))), [
      'pass',
      'fail',
      'fail',
    ]);
    assert.equal(await celBalance(held, ALICE), -30);
  });
  test('until the second arrives, the first counts, and so does what a payee built on it', async () => {
    const carol = pay('c0', CAROL, null, { to: BOB, amount: 0, balance: 50, received: ['a1'] });
    assert.equal(await cel([a0, a1, carol]).verdict('c0'), 'pass');
    assert.equal(await cel([a0, a1, carol, a1phone]).verdict('c0'), 'fail', 'not fixed by what it cited');
  });
});

describe('mutual credit: a payment arriving before its previous one', () => {
  test('it waits', async () => {
    assert.equal(await cel([a1]).verdict('a1'), 'pending');
    assert.equal(await cel([a1, a0]).verdict('a1'), 'pass');
  });
});

describe("mutual credit: a line is its account's own", () => {
  test("Carol can't grief Alice's line with a first version at its key", async () => {
    const fake = version({
      id: 'x',
      key: lineKey('app.pay', ALICE),
      collection: 'app.pay',
      author: CAROL,
      body: {},
    });
    const j = cel([a0, a1, fake]);
    assert.equal(await j.verdict('x'), 'fail');
    assert.equal(await j.verdict('a0'), 'pass');
    assert.equal(await j.verdict('a1'), 'pass');
  });

  test("Carol can't grief Alice's line with a next version after a0", async () => {
    const fake = version({
      id: 'y',
      key: lineKey('app.pay', ALICE),
      collection: 'app.pay',
      author: CAROL,
      seq: 1,
      prev: 'a0',
      body: {},
    });
    const j = cel([a0, a1, fake]);
    assert.equal(await j.verdict('y'), 'fail');
    assert.equal(await j.verdict('a1'), 'pass');
  });

  test("Bob can't claim one payment twice through a second line: there is one per account", async () => {
    const b0 = pay('b0', BOB, null, { to: CAROL, amount: 0, balance: 30, received: ['a0'] });
    const b0x = {
      ...pay('b0x', BOB, null, { to: CAROL, amount: 0, balance: 30, received: ['a0'] }),
      key: 'line2:' + BOB,
    };
    const j = cel([a0, b0, b0x]);
    assert.equal(await j.verdict('b0'), 'pass');
    assert.equal(await j.verdict('b0x'), 'fail');
  });
});

describe('mutual credit: a payee recovers after a double spend', () => {
  // Carol pays Bob 10, claims Alice's a1 (+50), pays Bob 30. Then Alice's phone double-spends.
  const c0 = pay('c0', CAROL, null, { to: BOB, amount: 10, balance: -10 });
  const c1 = pay('c1', CAROL, c0, { to: BOB, amount: 0, balance: 40, received: ['a1'] });
  const c2 = pay('c2', CAROL, c1, { to: BOB, amount: 30, balance: 10 });
  /** Her correction restates c1 without a1, after her last counted payment; then c2, restated */
  const c1x = pay('c1x', CAROL, c0, { to: BOB, amount: 0, balance: -10 }, ['c1', 'c2', 'a1p']);
  const c2x = pay('c2x', CAROL, c1x, { to: BOB, amount: 30, balance: -40 });

  test('what she built on a1 falls with it', async () => {
    assert.equal(await cel([a0, a1, c0, c1, c2]).verdict('c2'), 'pass');
    const j = cel([a0, a1, a1phone, c0, c1, c2]);
    assert.equal(await j.verdict('c1'), 'fail');
    assert.equal(await j.verdict('c2'), 'fail');
  });

  test('a correction after c0 counts, since c1 failed only for what it cited, and so does c2 restated', async () => {
    const held = [a0, a1, a1phone, c0, c1, c2, c1x, c2x];
    const j = cel(held);
    assert.equal(await j.verdict('c1x'), 'pass');
    assert.equal(await j.verdict('c2x'), 'pass');
    assert.equal(await celBalance(held, CAROL), -40);
    // Past the end of what fell, the line is free.
    const c3 = pay('c3', CAROL, c2x, { to: ALICE, amount: 5, balance: -45 });
    assert.equal(await cel([...held, c3]).verdict('c3'), 'pass');
  });

  test("a correction can't rewrite what she paid: Bob's 30 stays paid", async () => {
    // Carol cites a1 (Alice will fork it) and pays Bob 30; after the fork she "corrects" to paying nothing.
    const d0 = pay('c0', CAROL, null, { to: BOB, amount: 0, balance: 0 });
    const d1 = pay('c1', CAROL, d0, { to: BOB, amount: 30, balance: 20, received: ['a1'] });
    const unpay = pay('c1z', CAROL, d0, { to: BOB, amount: 0, balance: 0 }, ['c1', 'a1p']);
    const after = pay('c2', CAROL, unpay, { to: BOB, amount: 0, balance: 0 });
    const j = cel([a0, a1, a1phone, d0, d1, unpay, after]);
    assert.equal(await j.verdict('c1z'), 'fail');
    assert.equal(await j.verdict('c2'), 'fail');
    // The honest correction restates the 30, and the limit still holds.
    const restated = pay('c1r', CAROL, d0, { to: BOB, amount: 30, balance: -30 }, ['c1', 'a1p']);
    assert.equal(await cel([a0, a1, a1phone, d0, d1, restated]).verdict('c1r'), 'pass');
  });

  test("a correction that restates c2 out of order, or skips it, doesn't count", async () => {
    const skip = pay('c2x', CAROL, c1x, { to: ALICE, amount: 5, balance: -15 });
    assert.equal(await cel([a0, a1, a1phone, c0, c1, c2, c1x, skip]).verdict('c2x'), 'fail');
  });

  test('a restatement past the limit kills the line, as before', async () => {
    const e0 = pay('c0', CAROL, null, { to: BOB, amount: 60, balance: -60 });
    const e1 = pay('c1', CAROL, e0, { to: BOB, amount: 70, balance: -80, received: ['a1'] });
    const fix = pay('c1x', CAROL, e0, { to: BOB, amount: 70, balance: -130 }, ['c1', 'a1p']);
    assert.equal(await cel([a0, a1, a1phone, e0, e1, fix]).verdict('c1x'), 'fail');
  });

  test('a "correction" of a payment that still counts is a double spend: neither counts', async () => {
    const fine = pay('c1', CAROL, c0, { to: BOB, amount: 5, balance: -15 });
    const again = pay('c1y', CAROL, c0, { to: BOB, amount: 30, balance: -40 }, ['c1']);
    const j = cel([c0, fine, again]);
    assert.equal(await j.verdict('c1'), 'fail');
    assert.equal(await j.verdict('c1y'), 'fail');
  });
});
