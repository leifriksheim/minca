/**
 * The line rule (spec 09 §6): one line per account per collection, at
 * `lineKey(root, collection)`; two versions after the same one are a double
 * spend and neither counts; `once` fields claim each citation once along the
 * counted chain; a declaration with a key the library doesn't know leaves
 * the collection unjudged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lineKey } from '../src/records/key.js';
import { checkLine, type Contract } from '../src/records/contracts.js';
import type { DefineCollection } from '../src/node/types.js';
import type { Version } from '../src/types.js';
import { communityNode, type Community } from './helpers/community.js';
import { forge, person, type Person } from './helpers/person.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { team } from '../src/space/presets.js';

// No `+ [0.0]`: `sum([])` is `0.0`, so a payment that claims nothing adds up.
const PAY: Contract[] = [
  {
    that: "versions(body.received).all(r, r.collection == 'app.pay' && r.body.to == author)",
    else: 'Claim only payments to you',
  },
  {
    that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount + sum(versions(body.received).map(r, r.body.amount))',
    else: 'The balance follows from the one before',
  },
];

const pays = (line: unknown = { once: ['received'] }): DefineCollection => ({
  name: 'app.pay',
  schema: { type: 'object' },
  rules: { check: PAY },
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a declaration another implementation may have written
  line: line as DefineCollection['line'],
});

interface Pay {
  readonly to: string;
  readonly amount: number;
  readonly balance: number;
  readonly received?: ReadonlyArray<string>;
}

/** A payment: the next version of `by`'s line after `after`, from a device of its own */
async function pay(c: Community, by: Person, after: Version | null, p: Pay): Promise<Version> {
  return c.sign(by, {
    collection: 'app.pay',
    body: { received: [], ...p },
    version: after
      ? { key: after.key, seq: after.seq + 1, prev: after.id, genesis: after.genesis ?? after.id }
      : { key: await lineKey(by.node.did, 'app.pay'), seq: 0 },
  });
}

async function credit(line?: unknown) {
  const c = await communityNode(2, [pays(line)]);
  const bob = c.members[0]!;
  const carol = c.members[1]!;
  return { c, alice: c.founder, bob, carol };
}

describe('the line rule: a double spend', () => {
  test('two devices of one account pay after the same payment: neither counts, the one before does', async () => {
    const { c, alice, bob, carol } = await credit();
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 30, balance: -30 });
    const a1 = await pay(c, alice, a0, { to: carol.node.did, amount: 50, balance: -80 });
    const phone = await pay(c, alice, a0, { to: carol.node.did, amount: 60, balance: -90 });
    await c.add(a0, a1);
    assert.deepEqual(await c.verdicts(a0, a1), ['pass', 'pass'], 'a payment counts until its twin arrives');
    // Carol builds on a1, which counts so far.
    const c0 = await pay(c, carol, null, { to: bob.node.did, amount: 0, balance: 50, received: [a1.id] });
    await c.add(c0);
    assert.equal(await c.verdict(c0), 'pass');

    await c.add(phone);
    assert.deepEqual(await c.verdicts(a0, a1, phone, c0), ['pass', 'fail', 'fail', 'fail']);
    const head = await alice.node.records.get<Pay>(c.space, a0.key);
    assert.equal(head?.body?.balance, -30, "the line's count stops at the payment before the twins");
    assert.equal(await alice.node.records.get(c.space, c0.key), null, 'what cited a twin falls with it');
  });

  test('no corrections: another payment after the last that counts is a twin too', async () => {
    const { c, alice, bob } = await credit();
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 10, balance: -10 });
    const a1 = await pay(c, alice, a0, { to: bob.node.did, amount: 10, balance: -20 });
    const a1x = await pay(c, alice, a0, { to: bob.node.did, amount: 20, balance: -30 });
    await c.add(a0, a1, a1x);
    await assert.rejects(
      alice.node.records.update(c.space, a0.key, { to: bob.node.did, amount: 1, balance: -11, received: [] }),
      /double spend/,
      'the writer refuses its own',
    );
    const again = await pay(c, alice, a0, { to: bob.node.did, amount: 1, balance: -11 });
    await c.add(again);
    assert.deepEqual(await c.verdicts(a0, a1, a1x, again), ['pass', 'fail', 'fail', 'fail']);
  });
});

describe('the line rule: claiming once', () => {
  test('a payment claimed again later along the line fails, and so does one claimed twice in one version', async () => {
    const { c, alice, bob, carol } = await credit();
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 30, balance: -30 });
    const b0 = await pay(c, bob, null, { to: carol.node.did, amount: 0, balance: 30, received: [a0.id] });
    const b1 = await pay(c, bob, b0, { to: carol.node.did, amount: 0, balance: 60, received: [a0.id] });
    await c.add(a0, b0, b1);
    assert.deepEqual(await c.verdicts(b0, b1), ['pass', 'fail']);
    assert.match(
      (await alice.node.records.contracts(c.space, b1.key, b1.id))?.reason ?? '',
      /already claimed/,
    );

    const { c: c2, alice: alice2, bob: bob2, carol: carol2 } = await credit();
    const x0 = await pay(c2, alice2, null, { to: bob2.node.did, amount: 30, balance: -30 });
    const twice = await pay(c2, bob2, null, {
      to: carol2.node.did,
      amount: 0,
      balance: 60,
      received: [x0.id, x0.id],
    });
    await c2.add(x0, twice);
    assert.equal(await c2.verdict(twice), 'fail');
  });

  test('a second line of one account claims nothing: only the line key counts', async () => {
    const { c, alice, bob, carol } = await credit();
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 30, balance: -30 });
    const elsewhere = await c.sign(bob, {
      collection: 'app.pay',
      body: { to: carol.node.did, amount: 0, balance: 30, received: [a0.id] },
    });
    await c.add(a0, elsewhere);
    assert.equal(await c.verdict(elsewhere), 'fail');
    assert.match(
      (await alice.node.records.contracts(c.space, elsewhere.key, elsewhere.id))?.reason ?? '',
      /line key/,
    );
  });
});

describe('the line rule: arriving out of order', () => {
  test('a payment arriving before the one it follows waits, then counts', async () => {
    const { c, alice, bob } = await credit();
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 30, balance: -30 });
    const a1 = await pay(c, alice, a0, { to: bob.node.did, amount: 10, balance: -40 });
    await c.add(a1);
    assert.equal(await c.verdict(a1), 'pending');
    await c.add(a0);
    assert.deepEqual(await c.verdicts(a0, a1), ['pass', 'pass']);
  });
});

describe('the line rule: closed keys', () => {
  test('the library refuses to define a line with a key it does not know', async () => {
    assert.equal(checkLine({ once: ['received'] }), null);
    assert.equal(checkLine({ once: ['received'], restate: ['to'] }), 'unknown');
    assert.match(checkLine({ once: 'received' }) ?? '', /list of field names/);
    await assert.rejects(credit({ once: ['received'], restate: ['to'] }), /line takes only "once"/);
  });

  test("a line declared with a key it doesn't know leaves the collection unjudged: counted and failed by no one", async () => {
    const c = await communityNode(1, [
      {
        name: 'app.claim',
        schema: { type: 'object' },
        rules: { check: [{ that: 'versions(body.cites).size() == 1', else: 'Cite one' }] },
      },
    ]);
    const alice = c.founder;
    const bob = c.members[0]!;
    // A definition written by an implementation that knows `restate`.
    const later = await c.sign(alice, {
      collection: 'sys.collection',
      body: {
        name: 'app.pay',
        schema: { type: 'object' },
        version: 1,
        rules: { check: PAY },
        line: { once: ['received'], restate: ['to', 'amount'] },
      },
      version: { key: 'collection:app.pay', seq: 0 },
    });
    await c.add(later);
    const a0 = await pay(c, alice, null, { to: bob.node.did, amount: 30, balance: -30 });
    await c.add(a0);
    const found = await alice.node.records.contracts(c.space, a0.key, a0.id);
    assert.equal(found?.unjudged, true);
    assert.equal(found?.passes, null);
    assert.equal(await alice.node.records.get(c.space, a0.key), null);
    // What cites it can't be judged here either.
    const claim = await c.sign(alice, { collection: 'app.claim', body: { cites: [a0.id] } });
    await c.add(claim);
    assert.equal(await c.verdict(claim), 'unjudged');
  });
});

describe('the line rule: a twin arriving by sync', () => {
  test('a reader that counted a payment stops counting it, and what cites it, once its twin syncs in', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Credit', ...team, visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(space));
    await alice.node.collections.define(space, pays());
    await hold(alice.node, space);
    await hold(bob.node, space);
    await joined(bob.node, space);
    await until(
      async () => (await bob.node.collections.list(space)).some((c) => c.version !== null),
      4000,
      'defs',
    );

    const key = await lineKey(bob.node.did, 'app.pay');
    const b0 = await bob.node.records.put(
      space,
      'app.pay',
      { to: alice.node.did, amount: 10, balance: -10, received: [] },
      {
        key: key.slice(key.indexOf('.') + 1),
      },
    );
    const b1 = await bob.node.records.update(space, b0.key, {
      to: alice.node.did,
      amount: 5,
      balance: -15,
      received: [],
    });
    await until(
      async () => (await alice.node.records.get<Pay>(space, key))?.body?.balance === -15,
      4000,
      'b1 to Alice',
    );
    const a0 = await alice.node.records.put(
      space,
      'app.pay',
      { to: bob.node.did, amount: 0, balance: 5, received: [b1.version] },
      {
        key: (await lineKey(alice.node.did, 'app.pay')).split('.').slice(1).join('.'),
      },
    );
    assert.equal((await alice.node.records.get<Pay>(space, a0.key))?.body?.balance, 5);

    // Bob's phone pays after b0 too, and it reaches Alice while she holds the space open.
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: 'app.pay',
      body: { to: alice.node.did, amount: 7, balance: -17, received: [] },
      retain: true,
      version: { key, seq: 1, prev: b0.version, genesis: b0.version },
    });
    await hold(bob.node, space);
    await until(
      async () => (await alice.node.records.get<Pay>(space, key))?.body?.balance === -10,
      4000,
      'the twin to undo b1',
    );
    assert.equal(await alice.node.records.get(space, a0.key), null, 'what claimed b1 falls with it');
  });
});

describe('the line rule: deletes', () => {
  /** A line in which every claim cites a thing, so `once` can tell a second claim of the same thing */
  async function claims() {
    const c = await communityNode(1, [
      { name: 'app.thing', schema: { type: 'object' } },
      {
        name: 'app.claim',
        schema: { type: 'object' },
        rules: {
          check: [
            { that: 'versions(body.claimed).all(v, v.collection == "app.thing")', else: 'Claim things' },
          ],
        },
        line: { once: ['claimed'] },
      },
    ]);
    const alice = c.founder;
    const x = await c.sign(c.members[0]!, { collection: 'app.thing', body: { n: 1 } });
    const key = await lineKey(alice.node.did, 'app.claim');
    const a0 = await c.sign(alice, {
      collection: 'app.claim',
      body: { claimed: [] },
      version: { key, seq: 0 },
    });
    const after = (v: Version) => ({ key, seq: v.seq + 1, prev: v.id, genesis: v.genesis ?? v.id });
    return { c, alice, x, a0, after };
  }

  for (const retain of [false, true]) {
    test(`a delete written as a twin of a payment is a double spend (retain: ${retain})`, async () => {
      const { c, alice, x, a0, after } = await claims();
      const a1 = await c.sign(alice, {
        collection: 'app.claim',
        body: { claimed: [x.id] },
        version: after(a0),
      });
      const d = await c.sign(alice, {
        collection: 'app.claim',
        body: null,
        deleted: true,
        retain,
        version: after(a0),
      });
      const e = await c.sign(alice, {
        collection: 'app.claim',
        body: { claimed: [x.id] },
        version: after(d),
      });
      await c.add(x, a0, a1, d);
      assert.deepEqual(await c.verdicts(a1, d), ['fail', 'fail']);
      await c.add(e);
      assert.deepEqual(await c.verdicts(a0, a1, d, e), ['pass', 'fail', 'fail', 'fail']);
    });
  }

  test('a delete ends a line for good: nothing after it counts, so no balance starts again', async () => {
    const { c, alice, x, a0, after } = await claims();
    const d = await c.sign(alice, {
      collection: 'app.claim',
      body: null,
      deleted: true,
      retain: false,
      version: after(a0),
    });
    const e = await c.sign(alice, { collection: 'app.claim', body: { claimed: [x.id] }, version: after(d) });
    await c.add(x, a0, d, e);
    assert.equal(await c.verdict(e), 'fail');
    assert.match((await alice.node.records.contracts(c.space, e.key, e.id))?.reason ?? '', /ends its line/);
  });
});
