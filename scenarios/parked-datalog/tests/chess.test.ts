/** 1. Chess club, in Datalog: the same decisions as the scenario. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../datalog.js';
import { factsOf } from '../facts.js';
import { datalog } from '../programs/chess.js';
import { ALICE, BOB, CAROL, DAVE, FRANK, assignments, game, moves } from '../../communities/chess.js';
import { version } from '../../host/space.js';
import { shuffles } from './helpers.js';

describe('chess in Datalog', () => {
  const program = parse(datalog);
  const roleRecords = assignments.map((a, i) =>
    version({ id: `role${i}`, collection: 'std.role', author: a.by, body: { to: a.to, role: a.role } }),
  );
  const requests = [
    fact('request', BOB, '/record/write', 'app.chess', CAROL),
    fact('request', BOB, '/record/delete', 'app.chess', CAROL),
    fact('request', BOB, '/record/delete', 'app.chess', BOB),
    fact('request', DAVE, '/record/delete', 'app.chess', BOB),
    fact('request', DAVE, '/record/delete', 'app.poll', BOB),
    fact('request', FRANK, '/record/delete', 'app.chess', BOB),
  ];
  const facts: Fact[] = [fact('founder', ALICE), ...factsOf([...roleRecords, game, ...moves]), ...requests];
  const answer = (fs: Fact[]) => {
    const r = evaluate(program, fs);
    return { allowed: r.query('allowed'), legal: r.query('legal'), holds: r.query('holds') };
  };

  test('the same decisions, and a member deletes their own move', () => {
    const { allowed, legal } = answer(facts);
    assert.deepEqual(allowed, [
      [BOB, '/record/delete', 'app.chess', BOB],
      [BOB, '/record/write', 'app.chess', CAROL],
      [DAVE, '/record/delete', 'app.chess', BOB],
    ]);
    assert.deepEqual(legal, [['m0'], ['m1']]);
  });

  test('in any order', () => {
    const expected = JSON.stringify(answer(facts));
    for (const order of shuffles(facts, 30)) assert.equal(JSON.stringify(answer(order)), expected);
  });
});
