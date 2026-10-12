/** 1. Chess club. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { argsFor, defineArgsFor, may, strikes, type Authority, type Delegation } from '../host/grants.js';
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

describe('chess: grants go only to roles, so losing a role loses its power', () => {
  const deletesAny = (a: Authority, who: string) =>
    may(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
  const DAVE2 = 'did:key:dave-fresh-key';

  test("Dave delegates /record/delete to a fresh key: it counts for nothing, then or after he's unassigned", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...grants, { iss: DAVE, aud: DAVE2, cmd: '/record/delete', pol: [], at: 1 }],
      assignments,
      unassignments: [{ by: ERIN, from: DAVE, role: 'referee', at: 2 }],
    };
    assert.ok(!deletesAny(a, DAVE));
    assert.ok(!deletesAny(a, DAVE2));
    assert.ok(
      !may(a, DAVE2, '/record/delete', { collection: 'app.chess', byCreator: false }, 2),
      'not even before',
    );
  });

  test('a key that is no member invokes nothing, whatever it was handed', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...grants, { iss: DAVE, aud: DAVE2, cmd: '/record', pol: [], at: 1 }],
      assignments,
      unassignments: [
        { by: ERIN, from: DAVE, role: 'referee', at: 2 },
        { by: ALICE, from: DAVE, role: 'member', at: 3 },
      ],
    };
    assert.ok(!may(a, DAVE2, '/record/write', { collection: 'app.chess' }));
    assert.ok(!may(a, DAVE, '/record/write', { collection: 'app.chess' }), 'Dave, removed, neither');
  });

  test("Mo's /member/remove handed to a fresh key goes nowhere, and Mo's own goes with his role", () => {
    const MO2 = 'did:key:mo-fresh';
    const a: Authority = {
      founders: [ALICE],
      delegations: [...grants, { iss: MO, aud: MO2, cmd: '/member/remove', pol: [], at: 1 }],
      assignments: [...assignments, ...moderation],
      unassignments: [{ by: ALICE, from: MO, role: 'moderator', at: 2 }],
    };
    assert.ok(!may(a, MO, '/member/remove', argsFor(a, MO, BOB)));
    assert.ok(!may(a, MO2, '/member/remove', argsFor(a, MO2, BOB)));
  });

  test("`.self` holds: Erin can't hand /role/assign to a key that then assigns her referee", () => {
    const E2 = 'did:key:erin-fresh';
    const a: Authority = {
      founders: [ALICE],
      delegations: [...grants, { iss: ERIN, aud: E2, cmd: '/role/assign', pol: [], at: 1 }],
      assignments: [...assignments, { by: E2, to: ERIN, role: 'referee', at: 2 }],
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

describe('chess: a limit of `.roles`', () => {
  test("it protects only from an invoker whose view holds the target's role", () => {
    // Mo, appointed at 1, removes Fred, made admin at 3, by naming a view at 2 (or acting
    // concurrently). The same limit as ranks today; no strike rule closes it (plan §2, §9).
    const FRED = 'did:key:fred';
    const a: Authority = {
      founders: [ALICE],
      delegations: grants,
      assignments: [
        ...assignments,
        { by: ERIN, to: MO, role: 'moderator', at: 1 },
        { by: ALICE, to: FRED, role: 'admin', at: 3 },
      ],
    };
    assert.ok(!may(a, MO, '/member/remove', argsFor(a, MO, FRED)), 'with Fred an admin in view: refused');
    assert.ok(
      may(a, MO, '/member/remove', argsFor(a, MO, FRED, undefined, 2), 2),
      'naming an older view: allowed',
    );
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
        def: 'coach1',
        at: 2,
      },
      // After her demotion, a definition by Erin counts for nothing, and replaces nothing.
      { iss: ERIN, aud: 'role:coach', cmd: '/record/delete', pol: [], def: 'coach2', at: 5 },
    ],
    definitions: [
      { id: 'coach1', by: ERIN, role: 'coach', at: 2 },
      { id: 'coach2', by: ERIN, role: 'coach', at: 5, saw: ['coach1'] },
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

describe('chess: parking power in a role you keep', () => {
  /** Admins define roles, under a template that says `.mine == false`, or one that doesn't */
  const template = (pol: Delegation['pol']): Delegation[] => [
    ...grants,
    { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol },
    { iss: ALICE, aud: 'role:admin', cmd: '/member/remove', pol: [['==', '.self', false]] },
  ];
  const removesBob = (a: Authority, who: string) =>
    may(a, who, '/member/remove', argsFor(a, who, BOB, undefined, 5), 5);
  // Erin, an admin and a member, writes /member/remove into role:member at 2, and loses admin at 4.
  const parked = (pol: Delegation['pol']): Authority => ({
    founders: [ALICE],
    delegations: [
      ...template(pol),
      {
        iss: ERIN,
        aud: 'role:member',
        cmd: '/member/remove',
        pol: [['==', '.self', false]],
        def: 'm1',
        at: 2,
      },
    ],
    definitions: [{ id: 'm1', by: ERIN, role: 'member', at: 2 }],
    assignments: [...assignments, { by: ALICE, to: ERIN, role: 'member' }],
    unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 4 }],
  });

  test('`mine` says whether the definer holds the role, directly or through nesting', () => {
    const a = parked([]);
    assert.deepEqual(defineArgsFor(a, ERIN, 'member', undefined, 3), { role: 'member', mine: true });
    assert.deepEqual(defineArgsFor(a, ERIN, 'coach', undefined, 3), { role: 'coach', mine: false });
  });

  test('without `.mine` in the template, the power outlives her admin role (the gap the argument closes)', () => {
    const a = parked([]);
    assert.ok(removesBob(a, ERIN));
    assert.ok(removesBob(a, FRANK));
  });

  test("under `.mine == false`, writing into a role she holds is refused, so there's nothing to keep", () => {
    const a = parked([['==', '.mine', false]]);
    assert.ok(!removesBob(a, ERIN));
    assert.ok(!removesBob(a, FRANK));
  });

  test('nor can she nest her role inside one she defines', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [
        ...template([['==', '.mine', false]]),
        {
          iss: ERIN,
          aud: 'role:park',
          cmd: '/member/remove',
          pol: [['==', '.self', false]],
          def: 'p1',
          at: 2,
        },
      ],
      definitions: [
        { id: 'p1', by: ERIN, role: 'park', at: 2 },
        { id: 'm1', by: ERIN, role: 'member', at: 3 },
      ],
      assignments: [...assignments, { by: ALICE, to: ERIN, role: 'member' }],
      nestings: [{ by: ERIN, role: 'member', holds: 'park', def: 'm1', at: 3 }],
      unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 4 }],
    };
    assert.ok(!removesBob(a, ERIN));
    assert.ok(!removesBob(a, FRANK));
  });
});

describe("chess: `mine` can't be dodged by naming an older view", () => {
  const template: Delegation[] = [
    ...grants,
    { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [['==', '.mine', false]] },
    { iss: ALICE, aud: 'role:admin', cmd: '/member/remove', pol: [['==', '.self', false]] },
    // Coach exists, and is harmless.
    { iss: ALICE, aud: 'role:coach', cmd: '/record/write', pol: [['==', '.collection', 'app.lessons']] },
  ];
  const removesBob = (a: Authority, who: string) =>
    may(a, who, '/member/remove', argsFor(a, who, BOB, undefined, 7), 7);
  const parking = (def: { at: number; view?: number }): Delegation => ({
    iss: ERIN,
    aud: 'role:coach',
    cmd: '/member/remove',
    pol: [['==', '.self', false]],
    def: 'c1',
    ...def,
  });

  test('Erin, made coach at 3, writes into coach at 5 naming a view of 2: refused, since the assignment races it', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...template, parking({ at: 5, view: 2 })],
      definitions: [{ id: 'c1', by: ERIN, role: 'coach', at: 5, view: 2 }],
      assignments: [
        ...assignments,
        { by: ALICE, to: ERIN, role: 'coach', at: 3 },
        { by: ALICE, to: DAVE, role: 'coach', at: 4 },
      ],
      unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 6 }],
    };
    assert.deepEqual(defineArgsFor(a, ERIN, 'coach', undefined, 5, 2), { role: 'coach', mine: true });
    assert.ok(!removesBob(a, ERIN));
    assert.ok(!removesBob(a, DAVE), 'nor any other coach');
  });

  test('a nesting that puts her in the role, concurrent with the definition, counts the same', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...template, parking({ at: 5, view: 2 })],
      definitions: [{ id: 'c1', by: ERIN, role: 'coach', at: 5, view: 2 }],
      assignments: [...assignments, { by: ALICE, to: ERIN, role: 'member' }],
      // Alice puts every member in coach at 3; Erin's definition hadn't seen it.
      nestings: [{ by: ALICE, role: 'member', holds: 'coach', at: 3 }],
      unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 6 }],
    };
    assert.deepEqual(defineArgsFor(a, ERIN, 'coach', undefined, 5, 2), { role: 'coach', mine: true });
    assert.ok(!removesBob(a, ERIN));
  });

  test('the honest order works: Erin defines coach at 2, and Alice, having seen it, makes her coach at 3', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...template, parking({ at: 2 })],
      definitions: [{ id: 'c1', by: ERIN, role: 'coach', at: 2 }],
      assignments: [...assignments, { by: ALICE, to: ERIN, role: 'coach', at: 3 }],
      unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 6 }],
    };
    assert.deepEqual(defineArgsFor(a, ERIN, 'coach', undefined, 2), { role: 'coach', mine: false });
    assert.ok(removesBob(a, ERIN), 'Alice made her coach knowing what coach holds');
  });

  test('`mine` follows only nestings that count: a bogus one gives a `.mine == true` template nothing', () => {
    // Under "define only roles you hold", Bob (no definer) nests member inside coach.
    const a: Authority = {
      founders: [ALICE],
      delegations: [
        ...grants,
        { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [['==', '.mine', true]] },
      ],
      definitions: [{ id: 'b1', by: BOB, role: 'member', at: 1 }],
      assignments: [...assignments, { by: ALICE, to: ERIN, role: 'member' }],
      nestings: [{ by: BOB, role: 'member', holds: 'coach', def: 'b1', at: 1 }],
    };
    assert.deepEqual(defineArgsFor(a, ERIN, 'coach', undefined, 2), { role: 'coach', mine: false });
    assert.ok(!may(a, ERIN, '/role/define', defineArgsFor(a, ERIN, 'coach', undefined, 2), 2));
  });

  test("a grant to a role outside any definition, not the constitution's, counts for nothing", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...template, { iss: ERIN, aud: 'role:coach', cmd: '/member/remove', pol: [], at: 2 }],
      assignments: [...assignments, { by: ALICE, to: DAVE, role: 'coach', at: 3 }],
    };
    assert.ok(!removesBob(a, DAVE));
  });
});

describe('chess: rival definitions of a role hold only what they share', () => {
  const GUS = 'did:key:gus';
  const HAL = 'did:key:hal';
  const deletes = (a: Authority, collection: string) =>
    may(a, HAL, '/record/delete', { collection, byCreator: false });
  const base: Authority = {
    founders: [ALICE],
    delegations: [
      ...grants,
      { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [['==', '.mine', false]] },
      { iss: ALICE, aud: 'role:admin', cmd: '/record', pol: [] },
    ],
    assignments: [
      ...assignments,
      { by: ALICE, to: GUS, role: 'admin' },
      { by: ALICE, to: HAL, role: 'judge' },
    ],
  };
  const del = (iss: string, def: string, collection: string, at: number): Delegation => ({
    iss,
    aud: 'role:judge',
    cmd: '/record/delete',
    pol: [['==', '.collection', collection]],
    def,
    at,
  });
  // Erin's j1 (chess and polls) and Gus's j2 (chess), written apart: neither saw the other.
  const rivals: Authority = {
    ...base,
    definitions: [
      { id: 'j1', by: ERIN, role: 'judge', at: 2 },
      { id: 'j2', by: GUS, role: 'judge', at: 3, view: 1 },
    ],
    delegations: [
      ...base.delegations,
      del(ERIN, 'j1', 'app.chess', 2),
      del(ERIN, 'j1', 'app.poll', 2),
      del(GUS, 'j2', 'app.chess', 3),
    ],
  };

  test('while they are rivals, the role holds the intersection', () => {
    assert.ok(deletes(rivals, 'app.chess'));
    assert.ok(!deletes(rivals, 'app.poll'), 'only j1 has it');
  });

  test('a definition that saw both ends the rivalry', () => {
    const settled: Authority = {
      ...rivals,
      definitions: [
        ...(rivals.definitions ?? []),
        { id: 'j3', by: ERIN, role: 'judge', at: 4, saw: ['j1', 'j2'] },
      ],
      delegations: [...rivals.delegations, del(ERIN, 'j3', 'app.poll', 4)],
    };
    assert.ok(deletes(settled, 'app.poll'));
    assert.ok(!deletes(settled, 'app.chess'));
  });

  test('rivals with nothing in common leave the role empty: it fails closed', () => {
    const apart: Authority = {
      ...rivals,
      delegations: [...base.delegations, del(ERIN, 'j1', 'app.poll', 2), del(GUS, 'j2', 'app.chess', 3)],
    };
    assert.ok(!deletes(apart, 'app.chess'));
    assert.ok(!deletes(apart, 'app.poll'));
  });

  test('a rival its author could not write is no rival', () => {
    const bogus: Authority = {
      ...base,
      definitions: [
        { id: 'j1', by: ERIN, role: 'judge', at: 2 },
        { id: 'jb', by: BOB, role: 'judge', at: 3, view: 1 },
      ],
      delegations: [...base.delegations, del(ERIN, 'j1', 'app.chess', 2)],
    };
    assert.ok(deletes(bogus, 'app.chess'), 'Bob holds no /role/define: his empty definition changes nothing');
  });
});

describe('chess: what an unassignment strikes', () => {
  const FRED = 'did:key:fred';
  const a: Authority = {
    founders: [ALICE],
    delegations: [
      ...grants,
      { iss: ALICE, aud: 'role:greeter', cmd: '/record/write', pol: [['==', '.collection', 'app.welcome']] },
    ],
    assignments: [
      ...assignments,
      { by: ALICE, to: FRED, role: 'admin' },
      { by: ALICE, to: FRED, role: 'greeter' },
    ],
  };
  // Alice unassigns greeter at 5; Fred acts at 6 having seen only up to 4.
  const greeter = { who: FRED, role: 'greeter' };
  const assignReferee = {
    who: FRED,
    cmd: '/role/assign',
    args: argsFor(a, FRED, BOB, 'referee', 4.5),
    at: 4.5,
  };
  const welcome = { who: FRED, cmd: '/record/write', args: { collection: 'app.welcome' }, at: 4.5 };

  test("unassigning greeter doesn't strike Fred's concurrent admin actions", () => {
    assert.ok(!strikes(a, greeter, assignReferee));
  });
  test('it strikes what needed greeter, and so does Fred leaving greeter himself (#168)', () => {
    assert.ok(strikes(a, greeter, welcome));
  });
  test('a removal strikes everything concurrent', () => {
    assert.ok(strikes(a, { who: FRED }, assignReferee));
  });
});

describe('chess: a removal ends the assignments that had not seen it', () => {
  const deletesAny = (a: Authority, who: string) =>
    may(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
  const writes = (a: Authority) => may(a, BOB, '/record/write', { collection: 'app.chess' });
  // Alice removes Bob at 3; Erin, concurrently (seen up to 2), makes him referee at 4.
  const removed: Authority = {
    founders: [ALICE],
    delegations: grants,
    assignments: [...assignments, { by: ERIN, to: BOB, role: 'referee', at: 4, view: 2 }],
    removals: [{ by: ALICE, who: BOB, at: 3 }],
  };

  test('his member role ends, and the concurrent referee assignment does not survive', () => {
    assert.ok(!writes(removed));
    assert.ok(!deletesAny(removed, BOB));
  });

  test('after a re-add, only assignments that saw the removal count', () => {
    const readded: Authority = {
      ...removed,
      assignments: [...removed.assignments, { by: ALICE, to: BOB, role: 'member', at: 5 }],
    };
    assert.ok(writes(readded));
    assert.ok(!deletesAny(readded, BOB), 'the concurrent referee assignment stays dead');
    const again: Authority = {
      ...readded,
      assignments: [...readded.assignments, { by: ERIN, to: BOB, role: 'referee', at: 6 }],
    };
    assert.ok(deletesAny(again, BOB));
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
