/** 5. Mutual credit. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { judge } from '../host/cel-host.js';
import type { Version } from '../host/space.js';
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

  test('a payment claimed twice fails', async () => {
    const again = pay('b1', BOB, b0, {
      to: CAROL,
      amount: 0,
      balance: 40,
      received: ['a0'],
      claimed: ['a0', 'a0'],
    });
    assert.equal(await cel([a0, b0, again]).verdict('b1'), 'fail');
  });

  test("CEL's trap, which the plan fixes: sum([]) is the int 0, and an int plus a double is an error", async () => {
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
