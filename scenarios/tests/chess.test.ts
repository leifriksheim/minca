/** 1. Chess club. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { may, type Authority } from '../host/grants.js';
import { judge } from '../host/cel-host.js';
import {
  ALICE,
  BOB,
  CAROL,
  DAVE,
  ERIN,
  FRANK,
  assignments,
  game,
  grants,
  moveContract,
  moves,
} from '../communities/chess.js';

describe('chess: grants', () => {
  const auth: Authority = { founders: [ALICE], delegations: grants, assignments };
  /** The arguments a host fills in for a record command */
  const doing = (who: string, cmd: string, collection: string, byCreator = false) =>
    may(auth, who, cmd, { collection, byCreator });

  test('members play', () => {
    assert.ok(doing(BOB, '/record/write', 'app.chess'));
    assert.ok(!doing(BOB, '/record/delete', 'app.chess'), "a member can't delete others' moves");
  });

  test('a member deletes their own move, through `.byCreator`', () => {
    assert.ok(doing(BOB, '/record/delete', 'app.chess', true));
    assert.ok(!doing(BOB, '/record/delete', 'app.poll', true), 'only in app.chess');
  });

  test('a referee Erin assigned deletes any move, only in app.chess', () => {
    assert.ok(doing(DAVE, '/record/delete', 'app.chess'));
    assert.ok(!doing(DAVE, '/record/delete', 'app.poll'));
  });

  test('only admins assign, only Referee, and not to themselves', () => {
    assert.ok(!doing(FRANK, '/record/delete', 'app.chess'), 'Bob is no admin, so Frank is no referee');
    assert.ok(may(auth, ERIN, '/role/assign', { role: 'referee', self: false }));
    assert.ok(!may(auth, ERIN, '/role/assign', { role: 'admin', self: false }));
    assert.ok(!may(auth, ERIN, '/role/assign', { role: 'referee', self: true }));
  });

  test('Erin assigning herself Referee counts for nothing', () => {
    const self: Authority = {
      ...auth,
      assignments: [...assignments, { by: ERIN, to: ERIN, role: 'referee' }],
    };
    assert.ok(!may(self, ERIN, '/record/delete', { collection: 'app.chess', byCreator: false }));
  });
});

describe('chess: the contract on moves', () => {
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
