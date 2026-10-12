/** 1. Chess club, in both languages. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../src/datalog.js';
import { may, type Authority } from '../src/grants.js';
import { judge } from '../src/cel-host.js';
import { factsOf, version } from '../src/space.js';
import { ALICE, BOB, CAROL, DAVE, ERIN, datalog, grants, moveContract } from '../src/examples/chess.js';
import { shuffles } from './helpers.js';

const FRANK = 'did:key:frank';

// Alice founds; makes Erin admin and Bob, Carol, Dave, Frank members; Erin makes Dave referee; Bob tries Frank.
const assignments = [
  { by: ALICE, to: ERIN, role: 'admin' },
  ...[BOB, CAROL, DAVE, FRANK].map((to) => ({ by: ALICE, to, role: 'member' })),
  { by: ERIN, to: DAVE, role: 'referee' },
  { by: BOB, to: FRANK, role: 'referee' },
];

const game = version({
  id: 'game',
  collection: 'app.chess.game',
  author: BOB,
  body: { white: BOB, black: CAROL },
});
const moves = [
  version({ id: 'm0', collection: 'app.chess', author: BOB, body: { game: 'game', ply: 0 } }),
  version({ id: 'm1', collection: 'app.chess', author: CAROL, body: { game: 'game', ply: 1 } }),
  version({ id: 'm1-bob', collection: 'app.chess', author: BOB, body: { game: 'game', ply: 1 } }),
];

describe('chess (A): UCAN grants', () => {
  const auth: Authority = { founders: [ALICE], delegations: grants, assignments };
  const doing = (who: string, cmd: string, collection: string) => may(auth, who, cmd, { collection });

  test('members play', () => {
    assert.ok(doing(BOB, '/record/write', 'app.chess'));
    assert.ok(!doing(BOB, '/record/delete', 'app.chess'), "a member can't delete others' moves");
  });

  test('a referee Erin assigned deletes moves, only in app.chess', () => {
    assert.ok(doing(DAVE, '/record/delete', 'app.chess'));
    assert.ok(!doing(DAVE, '/record/delete', 'app.poll'));
  });

  test('only admins assign, and only Referee', () => {
    assert.ok(!doing(FRANK, '/record/delete', 'app.chess'), 'Bob is no admin, so Frank is no referee');
    assert.ok(may(auth, ERIN, '/role/assign', { role: 'referee', to: BOB }));
    assert.ok(!may(auth, ERIN, '/role/assign', { role: 'admin', to: BOB }));
  });

  test("deleting one's own move is not in the policy: UCAN policies can't name the invoker", () => {
    // `creator == invoker` compares two values; a policy compares a selector with a literal.
    assert.ok(!doing(BOB, '/record/delete', 'app.chess'));
  });
});

describe('chess (A): CEL contract on moves', () => {
  test('the player whose turn it is moves', async () => {
    const j = judge([game, ...moves], {
      founders: [ALICE],
      members: [BOB, CAROL],
      contracts: { 'app.chess': moveContract },
    });
    assert.equal(await j.verdict('m0'), 'pass');
    assert.equal(await j.verdict('m1'), 'pass');
    assert.equal(await j.verdict('m1-bob'), 'fail');
  });
});

describe('chess (C): Datalog', () => {
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
