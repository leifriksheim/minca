/** 5. Mutual credit, in Datalog: the line walked, siblings seen, and the for-all it can't say directly. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, parse } from '../datalog.js';
import { factsOf } from '../facts.js';
import { datalog } from '../programs/credit.js';
import { ALICE, BOB, CAROL, a0, a1, a1phone, b0, pay } from '../../communities/credit.js';
import type { Version } from '../../host/space.js';
import { shuffles } from './helpers.js';

const program = parse(datalog);
const dl = (held: Version[]) => evaluate(program, factsOf(held));

describe('mutual credit in Datalog: payments and the limit', () => {
  const over = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -110 });

  test('counts and balances', () => {
    const r = dl([a0, a1, b0, over]);
    assert.deepEqual(r.query('counts'), [['a0'], ['a1'], ['b0']]);
    assert.deepEqual(r.query('balance'), [
      [ALICE, -80],
      [BOB, 10],
    ]);
  });

  test('in any order', () => {
    const facts = factsOf([a0, a1, b0, over, a1phone]);
    const expected = JSON.stringify(evaluate(program, facts).query('balance'));
    for (const order of shuffles(facts, 30))
      assert.equal(JSON.stringify(evaluate(program, order).query('balance')), expected);
  });

  test('a lying balance fails', () => {
    const liar = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -50 });
    assert.ok(!dl([a0, a1, liar]).has('counts', 'a2'));
  });

  test('a payment claimed twice fails', () => {
    const again = pay('b1', BOB, b0, {
      to: CAROL,
      amount: 0,
      balance: 40,
      received: ['a0'],
      claimed: ['a0', 'a0'],
    });
    assert.ok(!dl([a0, b0, again]).has('counts', 'b1'));
  });
});

describe('mutual credit in Datalog: "every claimed payment counts", the direct ways', () => {
  test('are refused: a for-all over counts, inside counts, recurses through negation or count', () => {
    const negation =
      datalog.replace('claims_ok($p, $n), size($p, "received", $n)', '!bad_claim($p)') +
      'bad_claim($p) <- item($p, "received", _, $r), !counts($r);';
    assert.throws(() => parse(negation), /can't be stratified/);
    const counting = datalog.replace(
      'claims_ok($p, $n), size($p, "received", $n)',
      '$c = count $r { item($p, "received", _, $r), counts($r) }, size($p, "received", $n), $c == $n',
    );
    assert.throws(() => parse(counting), /can't be stratified/);
  });
});

describe('mutual credit in Datalog: a double spend from two devices of one account', () => {
  test('neither counts', () => {
    const r = dl([a0, a1, a1phone]);
    assert.deepEqual(r.query('counts'), [['a0']]);
    assert.deepEqual(r.query('balance'), [[ALICE, -30]]);
  });
  test('until the second arrives, the first counts, and so does what a payee built on it', () => {
    const carol = pay('c0', CAROL, null, { to: BOB, amount: 0, balance: 50, received: ['a1'] });
    assert.ok(dl([a0, a1, carol]).has('counts', 'c0'));
    assert.ok(!dl([a0, a1, carol, a1phone]).has('counts', 'c0'));
  });
});

describe('mutual credit in Datalog: a payment arriving before its previous one', () => {
  test('it does not count, and the program can say it waits', () => {
    const r = dl([a1]);
    assert.deepEqual(r.query('counts'), []);
    assert.deepEqual(r.query('waiting'), [['a1']]);
    assert.ok(dl([a1, a0]).has('counts', 'a1'));
  });
});
