/** 5. Mutual credit, in both languages. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, parse } from '../src/datalog.js';
import { judge, type Host } from '../src/cel-host.js';
import { factsOf, version, type Version } from '../src/space.js';
import { datalog, payContract } from '../src/examples/credit.js';
import { shuffles } from './helpers.js';

const ALICE = 'did:key:alice';
const BOB = 'did:key:bob';
const CAROL = 'did:key:carol';
const DAVE = 'did:key:dave';

interface Pay {
  to: string;
  amount: number;
  balance: number;
  received?: string[];
  claimed?: string[];
  device?: string;
}

/** A payment: the next version of the payer's line, after `after` */
function pay(id: string, by: string, after: Version | null, p: Pay, seen: string[] = []): Version {
  const received = p.received ?? [];
  const claimed = p.claimed ?? received;
  return version({
    id,
    key: `line:${by}`,
    collection: 'app.pay',
    author: by,
    device: p.device ?? 'laptop',
    seq: after ? after.seq + 1 : 0,
    prev: after?.id ?? null,
    body: { to: p.to, amount: p.amount, balance: p.balance, received, claimed },
    seen: [...(after ? [after.id] : []), ...received, ...seen],
  });
}

const a0 = pay('a0', ALICE, null, { to: BOB, amount: 30, balance: -30 });
const a1 = pay('a1', ALICE, a0, { to: CAROL, amount: 50, balance: -80 });
// Bob spends 20 of the 30 Alice paid him.
const b0 = pay('b0', BOB, null, { to: CAROL, amount: 20, balance: 10, received: ['a0'] });
// Alice's phone spends after a0 too: a double spend of the same line.
const a1phone = pay('a1p', ALICE, a0, { to: DAVE, amount: 60, balance: -90, device: 'phone' });

const host: Host = {
  founders: [],
  members: [ALICE, BOB, CAROL, DAVE],
  contracts: { 'app.pay': payContract },
  forkKills: ['app.pay'],
};

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

const program = parse(datalog);
const dl = (held: Version[]) => evaluate(program, factsOf(held));

describe('mutual credit: payments and the limit', () => {
  const over = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -110 });

  test('CEL', async () => {
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

  test('Datalog', () => {
    const r = dl([a0, a1, b0, over]);
    assert.deepEqual(r.query('counts'), [['a0'], ['a1'], ['b0']]);
    assert.deepEqual(r.query('balance'), [
      [ALICE, -80],
      [BOB, 10],
    ]);
  });

  test('Datalog: in any order', () => {
    const facts = factsOf([a0, a1, b0, over, a1phone]);
    const expected = JSON.stringify(evaluate(program, facts).query('balance'));
    for (const order of shuffles(facts, 30))
      assert.equal(JSON.stringify(evaluate(program, order).query('balance')), expected);
  });

  test('a lying balance fails in both', async () => {
    const liar = pay('a2', ALICE, a1, { to: BOB, amount: 30, balance: -50 });
    assert.equal(await cel([a0, a1, liar]).verdict('a2'), 'fail');
    assert.ok(!dl([a0, a1, liar]).has('counts', 'a2'));
  });

  test('a payment claimed twice fails in both', async () => {
    const again = pay('b1', BOB, b0, {
      to: CAROL,
      amount: 0,
      balance: 40,
      received: ['a0'],
      claimed: ['a0', 'a0'],
    });
    assert.equal(await cel([a0, b0, again]).verdict('b1'), 'fail');
    assert.ok(!dl([a0, b0, again]).has('counts', 'b1'));
  });

  test("CEL's trap: sum([]) is the int 0, and an int plus a double is an error", async () => {
    const naive = payContract.map((c) => ({ ...c, that: c.that.replace(' + [0.0])', ')') }));
    const j = judge([a0], { ...host, contracts: { 'app.pay': naive } });
    assert.equal(await j.verdict('a0'), 'fail', 'a payment that claims nothing fails without "+ [0.0]"');
  });
});

describe('mutual credit: "every claimed payment counts", the direct ways', () => {
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

describe('mutual credit: a double spend from two devices of one account', () => {
  const held = [a0, a1, a1phone];
  test('CEL (with the host rule): neither counts; the one before still does', async () => {
    const j = cel(held);
    assert.deepEqual(await Promise.all(['a0', 'a1', 'a1p'].map((id) => j.verdict(id))), [
      'pass',
      'fail',
      'fail',
    ]);
    assert.equal(await celBalance(held, ALICE), -30);
  });
  test('Datalog: neither counts', () => {
    const r = dl(held);
    assert.deepEqual(r.query('counts'), [['a0']]);
    assert.deepEqual(r.query('balance'), [[ALICE, -30]]);
  });
  test('both: until the second arrives, the first counts, and so does what a payee built on it', async () => {
    const carol = pay('c0', CAROL, null, { to: BOB, amount: 0, balance: 50, received: ['a1'] });
    assert.equal(await cel([a0, a1, carol]).verdict('c0'), 'pass');
    assert.equal(await cel([a0, a1, carol, a1phone]).verdict('c0'), 'fail', 'not fixed by what it cited');
    assert.ok(dl([a0, a1, carol]).has('counts', 'c0'));
    assert.ok(!dl([a0, a1, carol, a1phone]).has('counts', 'c0'));
  });
});

describe('mutual credit: a payment arriving before its previous one', () => {
  test('CEL: it waits', async () => {
    assert.equal(await cel([a1]).verdict('a1'), 'pending');
    assert.equal(await cel([a1, a0]).verdict('a1'), 'pass');
  });
  test('Datalog: it does not count, and the program can say it waits', () => {
    const r = dl([a1]);
    assert.deepEqual(r.query('counts'), []);
    assert.deepEqual(r.query('waiting'), [['a1']]);
    assert.ok(dl([a1, a0]).has('counts', 'a1'));
  });
});
