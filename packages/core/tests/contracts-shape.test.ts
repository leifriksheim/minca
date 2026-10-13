/**
 * Where a contract lives (spec 09 §1): a definition's `contract`, apart from
 * its `rules`. A contract is not a rule: a definition with `check` in its
 * rules is invalid. Readers judge `contract`, and leave unjudged one with a
 * member they don't know.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules } from '../src/records/rules.js';
import { checkContractShape } from '../src/records/contracts.js';
import { communityNode } from './helpers/community.js';

const NEVER = [{ that: 'false', else: 'Never' }];

describe('contracts: where they live', () => {
  test('a contract is not a rule: the library writes none in rules, and peers hold a definition with one as no definition', async () => {
    assert.match(checkRules({ check: NEVER }) ?? '', /rules\.check is gone/);
    assert.match(checkRules({ onePer: ['@author'], check: [] }) ?? '', /rules\.check is gone/);
    assert.equal(checkContractShape({ check: NEVER, line: { once: ['x'] } }), null);
    assert.equal(checkContractShape({ check: NEVER, later: true }), 'unknown');
    assert.match(checkContractShape([]) ?? '', /must be an object/);
    const c = await communityNode(0, []);
    await assert.rejects(
      c.founder.node.collections.define(c.space, {
        name: 'app.note',
        schema: { type: 'object' },
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- what the library refuses to write
        rules: { check: NEVER } as never,
      }),
      /contract\.check/,
    );
    // Written by hand, or by another implementation.
    const def = await c.sign(c.founder, {
      collection: 'sys.collection',
      body: { name: 'app.pay', schema: { type: 'object' }, version: 1, rules: { final: true, check: NEVER } },
      version: { key: 'collection:app.pay', seq: 0 },
    });
    await c.add(def);
    const listed = (await c.founder.node.collections.list(c.space)).find((one) => one.name === 'app.pay');
    assert.equal(listed, undefined, 'invalid: no definition at all (spec 02 §6.1, §7.5)');
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

describe('a definition’s version', () => {
  test('one stored past 2^53 can’t lock the collection: the library follows it with 1, and writes none like it', async () => {
    const c = await communityNode(0, []);
    const alice = c.founder;
    const locked = await c.sign(alice, {
      collection: 'sys.collection',
      body: { name: 'app.note', schema: { type: 'object' }, version: 2 ** 53, rules: { final: true } },
      version: { key: 'collection:app.note', seq: 0 },
    });
    await c.add(locked);
    const defined = await alice.node.collections.define(c.space, {
      name: 'app.note',
      schema: { type: 'object' },
    });
    assert.equal(defined.version, 1);
    assert.deepEqual(defined.rules, {});
    await assert.rejects(
      alice.node.collections.define(c.space, {
        name: 'app.other',
        schema: { type: 'object' },
        version: 2 ** 53,
      }),
      /below 2\^53/,
    );
  });
});
