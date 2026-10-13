/**
 * Where a contract lives (spec 09 §1): a definition's `contract`, apart from
 * its `rules`. Peers check `rules` and refuse a definition that puts a
 * contract there; readers judge `contract`, and leave unjudged one with a
 * member they don't know.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules } from '../src/records/rules.js';
import { checkContractShape } from '../src/records/contracts.js';
import { communityNode } from './helpers/community.js';

const NEVER = [{ that: 'false', else: 'Never' }];

describe('contracts: where they live', () => {
  test('a contract in rules is refused: rules are what peers check, a contract is what readers count', () => {
    assert.match(checkRules({ check: NEVER }) ?? '', /contract\.check/);
    assert.match(checkRules({ onePer: ['@author'], check: NEVER }) ?? '', /contract\.check/);
    assert.equal(checkContractShape({ check: NEVER, line: { once: ['x'] } }), null);
    assert.equal(checkContractShape({ check: NEVER, later: true }), 'unknown');
    assert.match(checkContractShape([]) ?? '', /must be an object/);
  });

  test('a peer treats a definition with a contract in its rules as no definition: nothing is judged by it', async () => {
    const c = await communityNode(0, []);
    const alice = c.founder;
    // Written by hand, or by an implementation from before contracts left rules.
    const old = await c.sign(alice, {
      collection: 'sys.collection',
      body: { name: 'app.note', schema: { type: 'object' }, version: 1, rules: { check: NEVER } },
      version: { key: 'collection:app.note', seq: 0 },
    });
    await c.add(old);
    const listed = (await alice.node.collections.list(c.space)).find((one) => one.name === 'app.note');
    assert.equal(listed?.version ?? null, null, 'an invalid definition is no definition');
    const note = await c.sign(alice, { collection: 'app.note', body: { n: 1 } });
    await c.add(note);
    assert.equal(await c.verdict(note), 'pass', 'no contract is in force, so none fails it');
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
