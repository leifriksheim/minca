/** 4. Hall of fame, in Datalog: over everything held, over a claim, and over a claim's past. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse } from '../datalog.js';
import { factsOf } from '../facts.js';
import { claimDatalog, datalog } from '../programs/fame.js';
import {
  M,
  base,
  claim,
  comment,
  f1,
  meh,
  react,
  reactions,
  removeM3,
  withdraw,
} from '../../communities/fame.js';
import type { Version } from '../../host/space.js';
import { shuffles } from './helpers.js';

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

describe('hall of fame in Datalog: five 🙂', () => {
  test('famous, with no claim at all', () => {
    assert.ok(famous(base.filter((v) => v.id !== 'f1')));
    assert.ok(!famous(base.filter((v) => v.id !== 'r5')));
  });
  test('over the claim and what it cites: the same as CEL', () => {
    const claimProgram = parse(claimDatalog);
    assert.ok(evaluate(claimProgram, factsOf([f1, ...reactions])).has('famous', 'f1', 'c'));
    const short = claim('f0', [], ['r1', 'r2', 'r3', 'r4', 'r6']);
    assert.ok(!evaluate(claimProgram, factsOf([short, ...reactions, meh])).has('famous', 'f0', 'c'));
  });
  test('in any order', () => {
    const facts = [...initial, ...factsOf([...base, withdraw(['r3']), removeM3([])])];
    const expected = JSON.stringify(evaluate(program, facts).query('smile'));
    for (const order of shuffles(facts, 30))
      assert.equal(JSON.stringify(evaluate(program, order).query('smile')), expected);
  });
});

describe('hall of fame in Datalog: a reaction withdrawn', () => {
  test('after the claim. Over everything: no longer famous', () => {
    assert.ok(!famous([...base, withdraw(['r3', 'f1'])]));
  });
  test("after the claim. Over the claim's past: still famous", () => {
    assert.ok(famousAsOf([...base, withdraw(['r3', 'f1'])], 'f1'));
  });
  test("before the claim. Over the claim's past: not famous", () => {
    const f2 = claim('f2', ['r1', 'r2', 'r3', 'r4', 'r5', 'd3']);
    assert.ok(!famousAsOf([comment, ...reactions, withdraw(['r3']), f2], 'f2'));
  });
});

describe('hall of fame in Datalog: a reaction from a removed member', () => {
  test("removed after the claim. Over the claim's past: still famous", () => {
    assert.ok(famousAsOf([...base, removeM3(['f1'])], 'f1'));
  });
  test('over everything: no longer famous, whenever the removal came', () => {
    assert.ok(!famous([...base, removeM3(['f1'])]));
  });
});

describe('hall of fame in Datalog: a device holding only some reactions', () => {
  test('over everything: a definite "no", until the rest arrives', () => {
    assert.equal(famous([comment, react(1), react(2), react(4), f1]), false);
    assert.equal(famous(base), true);
  });
});
