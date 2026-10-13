/**
 * Where a contract lives (spec 09 §1): a definition's `contract`, apart from
 * its `rules`. Peers keep a contract left in `rules.check` unread, so the
 * rules still hold; readers leave its collection unjudged. Readers judge
 * `contract`, and leave unjudged one with a member they don't know.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules } from '../src/records/rules.js';
import { checkContractShape } from '../src/records/contracts.js';
import { communityNode } from './helpers/community.js';
import { lineKey } from '../src/records/key.js';

const NEVER = [{ that: 'false', else: 'Never' }];

describe('contracts: where they live', () => {
  test('a contract in rules is kept unread by peers, and the library writes none there', async () => {
    assert.equal(checkRules({ check: NEVER }), null);
    assert.equal(checkRules({ onePer: ['@author'], check: NEVER }), null);
    assert.equal(checkContractShape({ check: NEVER, line: { once: ['x'] } }), null);
    assert.equal(checkContractShape({ check: NEVER, later: true }), 'unknown');
    assert.match(checkContractShape([]) ?? '', /must be an object/);
    const c = await communityNode(0, []);
    await assert.rejects(
      c.founder.node.collections.define(c.space, {
        name: 'app.note',
        schema: { type: 'object' },
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- where an older library put it
        rules: { check: NEVER } as never,
      }),
      /contract\.check/,
    );
  });

  test('a definition with its contract in rules keeps its rules, and leaves what is written under it unjudged, even after it is fixed', async () => {
    const c = await communityNode(1, []);
    const alice = c.founder;
    const bob = c.members[0]!;
    const atMost10 = [{ that: 'body.amount <= 10.0', else: 'At most 10' }];
    // As an older library stored it, or as written by hand.
    const old = await c.sign(alice, {
      collection: 'sys.collection',
      body: {
        name: 'app.pay',
        schema: { type: 'object' },
        version: 1,
        rules: { final: true, check: atMost10 },
      },
      version: { key: 'collection:app.pay', seq: 0 },
    });
    await c.add(old);
    const listed = (await alice.node.collections.list(c.space)).find((one) => one.name === 'app.pay');
    assert.equal(listed?.version, 1, 'still a definition');

    const mint = await c.sign(bob, { collection: 'app.pay', body: { amount: 1_000_000 } });
    await c.add(mint);
    assert.equal(await c.verdict(mint), 'unjudged', 'a contract no reader reads: never counted as if none');
    const edit = await c.sign(bob, {
      collection: 'app.pay',
      body: { amount: 2_000_000 },
      version: { key: mint.key, seq: 1, prev: mint.id, genesis: mint.id },
    });
    await c.add(edit);
    const kept = (await alice.node.records.list(c.space, { collection: 'app.pay' })).find(
      (r) => r.key === mint.key,
    );
    assert.notEqual(kept?.seq, 1, 'final still holds: the edit does not stand');

    // Defined again the new way: what comes after is judged, what came before still counts for nothing.
    await alice.node.collections.define(c.space, {
      name: 'app.pay',
      schema: { type: 'object' },
      rules: { final: true },
      contract: { check: atMost10 },
    });
    const later = await c.sign(bob, { collection: 'app.pay', body: { amount: 1_000_000 } });
    await c.add(later);
    assert.equal(await c.verdict(later), 'fail');
    assert.equal(await c.verdict(mint), 'unjudged');
  });

  test('a top-level line, the older format, leaves its collection unjudged: twins never both count', async () => {
    const c = await communityNode(1, []);
    const bob = c.members[0]!;
    const old = await c.sign(c.founder, {
      collection: 'sys.collection',
      body: { name: 'app.log', schema: { type: 'object' }, version: 1, line: { once: ['received'] } },
      version: { key: 'collection:app.log', seq: 0 },
    });
    await c.add(old);
    const key = await lineKey(bob.node.did, 'app.log');
    const b0 = await c.sign(bob, {
      collection: 'app.log',
      body: { n: 0, received: [] },
      version: { key, seq: 0 },
    });
    const twin = (n: number) =>
      c.sign(bob, {
        collection: 'app.log',
        body: { n, received: [] },
        version: { key, seq: 1, prev: b0.id, genesis: b0.id },
      });
    const t1 = await twin(1);
    const t2 = await twin(2);
    await c.add(b0, t1, t2);
    assert.deepEqual(await c.verdicts(b0, t1, t2), ['unjudged', 'unjudged', 'unjudged']);
  });

  test('a step under the older format, not kept whole, leaves what follows it uncounted after the fix', async () => {
    const c = await communityNode(1, []);
    const bob = c.members[0]!;
    const old = await c.sign(c.founder, {
      collection: 'sys.collection',
      body: { name: 'app.pay', schema: { type: 'object' }, version: 1, rules: { check: NEVER } },
      version: { key: 'collection:app.pay', seq: 0 },
    });
    await c.add(old);
    const v0 = await c.sign(bob, { collection: 'app.pay', body: { amount: 1_000_000 }, retain: false });
    await c.add(v0);
    await c.founder.node.collections.define(c.space, {
      name: 'app.pay',
      schema: { type: 'object' },
      contract: { check: [{ that: 'body.amount > 0.0', else: 'More than nothing' }] },
    });
    const v1 = await c.sign(bob, {
      collection: 'app.pay',
      body: { amount: 1_000_000 },
      version: { key: v0.key, seq: 1, prev: v0.id, genesis: v0.id },
    });
    await c.add(v1);
    assert.notEqual(await c.verdict(v1), 'pass');
  });

  test('the same condition under contract.check is judged: no reader counts what fails it', async () => {
    const c = await communityNode(0, [
      { name: 'app.note', schema: { type: 'object' }, contract: { check: NEVER } },
    ]);
    const note = await c.sign(c.founder, { collection: 'app.note', body: { n: 1 } });
    await c.add(note);
    assert.equal(await c.verdict(note), 'fail');
    assert.equal(await c.founder.node.records.get(c.space, note.key), null);
  });

  test("a contract with a member a reader doesn't know leaves the collection unjudged, and the library won't define one", async () => {
    const c = await communityNode(0, []);
    const alice = c.founder;
    await assert.rejects(
      alice.node.collections.define(c.space, {
        name: 'app.other',
        schema: { type: 'object' },
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a member from a later version
        contract: { check: NEVER, later: true } as never,
      }),
      /contract takes only "check" and "line"/,
    );
    // A definition written by an implementation that knows `later`.
    const later = await c.sign(alice, {
      collection: 'sys.collection',
      body: {
        name: 'app.note',
        schema: { type: 'object' },
        version: 1,
        contract: { check: NEVER, later: true },
      },
      version: { key: 'collection:app.note', seq: 0 },
    });
    await c.add(later);
    const note = await c.sign(alice, { collection: 'app.note', body: { n: 1 } });
    await c.add(note);
    assert.equal(await c.verdict(note), 'unjudged');
    assert.equal(await alice.node.records.get(c.space, note.key), null);
  });
});
