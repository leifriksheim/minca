/** 1. Chess club. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { argsFor, may, type Authority } from '../host/grants.js';
import { judge, type Host } from '../host/cel-host.js';
import { version } from '../host/space.js';
import {
  ALICE,
  BOB,
  CAROL,
  DAVE,
  ERIN,
  FRANK,
  MO,
  assignments,
  moderation,
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

describe('chess: roles go to accounts, not roles', () => {
  const deletesAny = (a: Authority, who: string) =>
    may(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
  test('Erin assigning referee to role:admin is refused, so she gets no referee grants', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: grants,
      assignments: [...assignments, { by: ERIN, to: 'role:admin', role: 'referee' }],
    };
    assert.ok(!deletesAny(a, ERIN));
  });
  test('Erin assigning referee to role:member is refused: no member deletes any move', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: grants,
      assignments: [
        ...assignments,
        { by: ALICE, to: ERIN, role: 'member' },
        { by: ERIN, to: 'role:member', role: 'referee' },
      ],
    };
    assert.ok(!deletesAny(a, ERIN));
    assert.ok(!deletesAny(a, BOB));
  });
  test("nesting referee in admin is granting, and Erin doesn't hold what referee holds", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: grants,
      assignments,
      nestings: [{ by: ERIN, role: 'admin', holds: 'referee' }],
    };
    assert.ok(!deletesAny(a, ERIN));
  });
});

describe('chess: moderators, and who protects an admin', () => {
  const auth: Authority = {
    founders: [ALICE],
    delegations: grants,
    assignments: [...assignments, ...moderation],
  };
  test('a moderator removes a member', () => {
    assert.ok(may(auth, MO, '/member/remove', argsFor(auth, MO, BOB)));
  });
  test("a moderator can't remove the admin who appointed them: the policy reads `.roles`", () => {
    assert.deepEqual(argsFor(auth, MO, ERIN), { self: false, roles: ['admin'] });
    assert.ok(!may(auth, MO, '/member/remove', argsFor(auth, MO, ERIN)));
  });
});

describe('chess: unassigning', () => {
  const deletesAny = (a: Authority, who: string) =>
    may(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
  const base: Authority = { founders: [ALICE], delegations: grants, assignments };
  test('Dave leaves referee on his own: built in, no grant needed', () => {
    const a: Authority = { ...base, unassignments: [{ by: DAVE, from: DAVE, role: 'referee', at: 1 }] };
    assert.ok(deletesAny(base, DAVE));
    assert.ok(!deletesAny(a, DAVE));
  });
  test('an admin takes referee away; a member cannot', () => {
    assert.ok(
      !deletesAny({ ...base, unassignments: [{ by: ERIN, from: DAVE, role: 'referee', at: 1 }] }, DAVE),
    );
    assert.ok(
      deletesAny({ ...base, unassignments: [{ by: BOB, from: DAVE, role: 'referee', at: 1 }] }, DAVE),
    );
  });
});

describe('chess: a role keeps its grants when its definer is demoted (decided)', () => {
  const GUS = 'did:key:gus';
  const a: Authority = {
    founders: [ALICE],
    delegations: [
      ...grants,
      { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [['==', '.role', 'coach']] },
      // Erin, an admin, defines Coach: coaches assign Referee to others.
      {
        iss: ERIN,
        aud: 'role:coach',
        cmd: '/role/assign',
        pol: [
          ['==', '.role', 'referee'],
          ['==', '.self', false],
        ],
        at: 2,
      },
      // After her demotion, a definition by Erin counts for nothing.
      { iss: ERIN, aud: 'role:coach', cmd: '/record/delete', pol: [], at: 5 },
    ],
    assignments: [
      { by: ALICE, to: ERIN, role: 'admin', at: 1 },
      { by: ALICE, to: GUS, role: 'coach', at: 3 },
    ],
    unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 4 }],
  };
  test("Coach's grants, judged as of their definition, stand after Erin loses admin", () => {
    assert.ok(may(a, GUS, '/role/assign', argsFor(a, GUS, BOB, 'referee')));
    assert.ok(!may(a, ERIN, '/role/assign', argsFor(a, ERIN, BOB, 'referee')));
    assert.ok(!may(a, GUS, '/record/delete', { collection: 'app.chess', byCreator: false }));
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

/**
 * Whose record it is (`creator` here, `byCreator` in a grant) needs keys that
 * belong to their creator (#72): today two first versions can share a key,
 * and the creator is whichever a peer holds first. Skipped until #72, which
 * lands before or with the command arguments (plan §8).
 */
describe('chess: whose record (#72)', () => {
  test.skip('needs #72: two first versions at one key give one creator, whatever the order held', async () => {
    const h: Host = {
      founders: [ALICE],
      members: [BOB],
      contracts: { 'app.x': [{ that: 'seq == 0 || author == creator', else: 'Only its creator edits it' }] },
    };
    const x0a = version({ id: 'x0a', key: 'k', collection: 'app.x', author: ALICE });
    const x0b = version({ id: 'x0b', key: 'k', collection: 'app.x', author: BOB });
    const edit = version({ id: 'e', key: 'k', collection: 'app.x', author: BOB, seq: 1, prev: 'x0a' });
    const one = await judge([x0a, x0b, edit], h).verdict('e');
    const two = await judge([x0b, x0a, edit], h).verdict('e');
    assert.equal(one, two);
  });
});
