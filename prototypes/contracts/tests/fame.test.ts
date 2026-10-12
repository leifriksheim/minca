/** 4. Hall of fame, in both languages, with the hard cases. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse } from '../src/datalog.js';
import { judge, type Host } from '../src/cel-host.js';
import { factsOf, next, version, type Version } from '../src/space.js';
import { claimContract, claimDatalog, datalog } from '../src/examples/fame.js';
import { shuffles } from './helpers.js';

const ALICE = 'did:key:alice';
const M = [1, 2, 3, 4, 5, 6].map((n) => `did:key:m${n}`);
const m = (i: number) => M[i - 1] ?? '';

const comment = version({ id: 'c', collection: 'app.comment', author: ALICE, body: { text: 'gg' } });
const react = (i: number, emoji = '🙂') =>
  version({
    id: `r${i}`,
    collection: 'app.reaction',
    author: m(i),
    body: { emoji },
    links: [{ rel: 'on', to: 'c' }],
    seen: ['c'],
  });
const reactions = [1, 2, 3, 4, 5].map((i) => react(i));
const meh = react(6, '😐');
const claim = (id: string, seen: string[], cites = ['r1', 'r2', 'r3', 'r4', 'r5']) =>
  version({
    id,
    collection: 'app.fame',
    author: ALICE,
    body: { reactions: cites },
    links: [{ rel: 'on', to: 'c' }],
    seen,
  });
const f1 = claim('f1', ['r1', 'r2', 'r3', 'r4', 'r5']);
const base = [comment, ...reactions, meh, f1];

/** r3 withdrawn: a delete, after the claim (`seen`) or before it */
const withdraw = (seen: string[]) => next(react(3), { id: 'd3', body: null, seen });
const removeM3 = (seen: string[]) =>
  version({ id: 'x3', collection: 'std.member', author: ALICE, body: { op: 'remove', did: m(3) }, seen });

const host: Host = { founders: [ALICE], members: M, contracts: { 'app.fame': claimContract } };
const cel = async (held: Version[], id: string) => judge(held, host).verdict(id);

const program = parse(datalog);
const initial = M.map((x) => fact('initial', x));
/** Datalog over everything held */
const famous = (held: Version[]) => evaluate(program, [...initial, ...factsOf(held)]).has('famous', 'c');
/** Datalog over a claim's past: what its writer had seen */
const famousAsOf = (held: Version[], id: string) => {
  const byId = new Map(held.map((v) => [v.id, v]));
  const past = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0)
    for (const s of byId.get(queue.pop() ?? '')?.seen ?? [])
      if (!past.has(s)) {
        past.add(s);
        queue.push(s);
      }
  return famous(held.filter((v) => past.has(v.id)));
};

describe('hall of fame: five 🙂', () => {
  test('CEL: the claim passes', async () => {
    assert.equal(await cel(base, 'f1'), 'pass');
  });
  test('CEL: a claim citing the 😐 instead fails', async () => {
    assert.equal(
      await cel([...base, claim('f0', ['r1', 'r2', 'r3', 'r4', 'r6'], ['r1', 'r2', 'r3', 'r4', 'r6'])], 'f0'),
      'fail',
    );
  });
  test('Datalog: famous, with no claim at all', () => {
    assert.ok(famous(base.filter((v) => v.id !== 'f1')));
    assert.ok(!famous(base.filter((v) => v.id !== 'r5')));
  });
  test('Datalog over the claim and what it cites: the same as CEL', () => {
    const claimProgram = parse(claimDatalog);
    assert.ok(evaluate(claimProgram, factsOf([f1, ...reactions])).has('famous', 'f1', 'c'));
    const short = claim('f0', [], ['r1', 'r2', 'r3', 'r4', 'r6']);
    assert.ok(!evaluate(claimProgram, factsOf([short, ...reactions, meh])).has('famous', 'f0', 'c'));
  });
  test('Datalog: in any order', () => {
    const facts = [...initial, ...factsOf([...base, withdraw(['r3']), removeM3([])])];
    const expected = JSON.stringify(evaluate(program, facts).query('smile'));
    for (const order of shuffles(facts, 30))
      assert.equal(JSON.stringify(evaluate(program, order).query('smile')), expected);
  });
});

describe('hall of fame: a reaction withdrawn', () => {
  test('after the claim. CEL: still famous, fixed by what was cited', async () => {
    assert.equal(await cel([...base, withdraw(['r3', 'f1'])], 'f1'), 'pass');
  });
  test('after the claim. Datalog over everything: no longer famous', () => {
    assert.ok(!famous([...base, withdraw(['r3', 'f1'])]));
  });
  test("after the claim. Datalog over the claim's past: still famous", () => {
    assert.ok(famousAsOf([...base, withdraw(['r3', 'f1'])], 'f1'));
  });
  test('before the claim, which had seen it. CEL: passes anyway, citing the old version (a gap)', async () => {
    const f2 = claim('f2', ['r1', 'r2', 'r3', 'r4', 'r5', 'd3']);
    assert.equal(await cel([comment, ...reactions, withdraw(['r3']), f2], 'f2'), 'pass');
  });
  test("before the claim. Datalog over the claim's past: not famous", () => {
    const f2 = claim('f2', ['r1', 'r2', 'r3', 'r4', 'r5', 'd3']);
    assert.ok(!famousAsOf([comment, ...reactions, withdraw(['r3']), f2], 'f2'));
  });
});

describe('hall of fame: a reaction from a removed member', () => {
  test('removed after the claim. CEL: still famous', async () => {
    assert.equal(await cel([...base, removeM3(['f1'])], 'f1'), 'pass');
  });
  test('removed, and a claim that had seen it cites the reaction. CEL: fails', async () => {
    const f3 = claim('f3', ['r1', 'r2', 'r3', 'r4', 'r5', 'x3']);
    assert.equal(await cel([...base, removeM3(['r3']), f3], 'f3'), 'fail');
  });
  test("removed after the claim. Datalog over the claim's past: still famous", () => {
    assert.ok(famousAsOf([...base, removeM3(['f1'])], 'f1'));
  });
  test('Datalog over everything: no longer famous, whenever the removal came', () => {
    assert.ok(!famous([...base, removeM3(['f1'])]));
  });
});

describe('hall of fame: a device holding only some reactions', () => {
  const partial = [comment, react(1), react(2), react(4), f1];
  test('CEL: the claim waits; it is never judged false', async () => {
    assert.equal(await cel(partial, 'f1'), 'pending');
    assert.equal(await cel(base, 'f1'), 'pass');
  });
  test('Datalog over everything: a definite "no", until the rest arrives', () => {
    assert.equal(famous(partial), false);
    assert.equal(famous(base), true);
  });
});
