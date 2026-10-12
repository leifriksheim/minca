/** 1. Chess club. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { argsFor, mayIn, strikes, type Authority, type Delegation } from '../host/library.js';
import { judge, type Host } from '../host/cel-host.js';
import { version } from '../host/space.js';
import { ownedKey } from '../../packages/core/src/records/key.js';
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
    mayIn(auth, who, cmd, { collection, byCreator });

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
    assert.ok(mayIn(auth, ERIN, '/role/assign', { role: 'referee', self: false }));
    assert.ok(!mayIn(auth, ERIN, '/role/assign', { role: 'admin', self: false }));
    assert.ok(!mayIn(auth, ERIN, '/role/assign', { role: 'referee', self: true }));
  });

  test('Erin assigning herself Referee counts for nothing', () => {
    const self: Authority = {
      ...auth,
      assignments: [...assignments, { by: ERIN, to: ERIN, role: 'referee' }],
    };
    assert.ok(!mayIn(self, ERIN, '/record/delete', { collection: 'app.chess', byCreator: false }));
  });
});

describe('chess: roles go to accounts, not roles', () => {
  const deletesAny = (a: Authority, who: string) =>
    mayIn(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
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
    mayIn(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
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
      !mayIn(a, DAVE2, '/record/delete', { collection: 'app.chess', byCreator: false }, 2),
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
    assert.ok(!mayIn(a, DAVE2, '/record/write', { collection: 'app.chess' }));
    assert.ok(!mayIn(a, DAVE, '/record/write', { collection: 'app.chess' }), 'Dave, removed, neither');
  });

  test("Mo's /member/remove handed to a fresh key goes nowhere, and Mo's own goes with his role", () => {
    const MO2 = 'did:key:mo-fresh';
    const a: Authority = {
      founders: [ALICE],
      delegations: [...grants, { iss: MO, aud: MO2, cmd: '/member/remove', pol: [], at: 1 }],
      assignments: [...assignments, ...moderation],
      unassignments: [{ by: ALICE, from: MO, role: 'moderator', at: 2 }],
    };
    assert.ok(!mayIn(a, MO, '/member/remove', argsFor(a, MO, BOB)));
    assert.ok(!mayIn(a, MO2, '/member/remove', argsFor(a, MO2, BOB)));
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
    assert.ok(mayIn(auth, MO, '/member/remove', argsFor(auth, MO, BOB)));
  });
  test("a moderator can't remove the admin who appointed them: the policy reads `.roles`", () => {
    assert.deepEqual(argsFor(auth, MO, ERIN), { self: false, roles: ['admin'] });
    assert.ok(!mayIn(auth, MO, '/member/remove', argsFor(auth, MO, ERIN)));
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
    assert.ok(!mayIn(a, MO, '/member/remove', argsFor(a, MO, FRED)), 'with Fred an admin in view: refused');
    assert.ok(
      mayIn(a, MO, '/member/remove', argsFor(a, MO, FRED, undefined, 2), 2),
      'naming an older view: allowed',
    );
  });
});

describe('chess: unassigning', () => {
  const deletesAny = (a: Authority, who: string) =>
    mayIn(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
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
    assert.ok(mayIn(a, GUS, '/role/assign', argsFor(a, GUS, BOB, 'referee')));
    assert.ok(!mayIn(a, ERIN, '/role/assign', argsFor(a, ERIN, BOB, 'referee')));
    assert.ok(!mayIn(a, GUS, '/record/delete', { collection: 'app.chess', byCreator: false }));
  });
});

describe('chess: whoever may define roles is trusted to (by design)', () => {
  // Admins define roles and remove members, as in Discord or Slack.
  const template: Delegation[] = [
    ...grants,
    { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [] },
    { iss: ALICE, aud: 'role:admin', cmd: '/member/remove', pol: [['==', '.self', false]] },
  ];
  const removesBob = (a: Authority, who: string) =>
    mayIn(a, who, '/member/remove', argsFor(a, who, BOB, undefined, 9), 9);
  // Erin, an admin and a member, rewrites member at 2 to add /member/remove, and loses admin at 4.
  const parked: Authority = {
    founders: [ALICE],
    delegations: [
      ...template,
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
  };

  test('what she wrote into member stays after she loses admin: her unassignment takes only that role', () => {
    assert.ok(removesBob(parked, ERIN));
    assert.ok(removesBob(parked, FRANK), 'every member holds it');
  });

  test('another admin undoes it by rewriting member', () => {
    const GUS = 'did:key:gus';
    const undone: Authority = {
      ...parked,
      definitions: [
        ...(parked.definitions ?? []),
        { id: 'm2', by: GUS, role: 'member', at: 5, saw: ['m1'] } /* holds nothing more */,
      ],
      assignments: [...parked.assignments, { by: ALICE, to: GUS, role: 'admin', at: 1 }],
    };
    assert.ok(!removesBob(undone, ERIN));
    assert.ok(!removesBob(undone, FRANK));
  });

  test("a grant to a role outside any definition, not the constitution's, counts for nothing", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [...template, { iss: ERIN, aud: 'role:member', cmd: '/member/remove', pol: [], at: 2 }],
      assignments,
    };
    assert.ok(!removesBob(a, FRANK));
  });

  test('an assignment changes no definition: a reduction Erin wrote stands, whoever is assigned the role', () => {
    // The fifth review's path: an assignment racing a definition no longer touches it.
    const a: Authority = {
      founders: [ALICE],
      delegations: [
        ...template,
        {
          iss: ERIN,
          aud: 'role:coach',
          cmd: '/member/remove',
          pol: [['==', '.self', false]],
          def: 'c0',
          at: 2,
        },
        {
          iss: ERIN,
          aud: 'role:coach',
          cmd: '/record/write',
          pol: [['==', '.collection', 'app.lessons']],
          def: 'c1',
          at: 4,
        },
        { iss: ALICE, aud: 'role:staffer', cmd: '/role/assign', pol: [['==', '.role', 'coach']] },
      ],
      definitions: [
        { id: 'c0', by: ERIN, role: 'coach', at: 2 },
        { id: 'c1', by: ERIN, role: 'coach', at: 4, saw: ['c0'] },
      ],
      assignments: [
        ...assignments,
        { by: ALICE, to: CAROL, role: 'staffer', at: 1 },
        { by: CAROL, to: DAVE, role: 'coach', at: 3 },
        { by: CAROL, to: ERIN, role: 'coach', at: 7, view: 3 },
      ],
    };
    assert.ok(!removesBob(a, DAVE));
  });
});

describe("chess: the constitution's grants are a role's first definition", () => {
  const GUS = 'did:key:gus';
  const deletes = (a: Authority) =>
    mayIn(a, FRANK, '/record/delete', { collection: 'app.chess', byCreator: false });

  test('a later definition that saw them supersedes them: a rewrite removes a constitution grant', () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [
        { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [] },
        { iss: ALICE, aud: 'role:member', cmd: '/record/delete', pol: [] },
      ],
      assignments: [
        { by: ALICE, to: GUS, role: 'admin', at: 1 },
        { by: ALICE, to: FRANK, role: 'member', at: 1 },
      ],
    };
    assert.ok(deletes(a));
    // Gus, an admin, rewrites member to hold nothing.
    assert.ok(!deletes({ ...a, definitions: [{ id: 'm1', by: GUS, role: 'member', at: 2 }] }));
  });

  test("a founder's later grant outside a definition gives nothing: founders define like anyone", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [{ iss: ALICE, aud: 'role:member', cmd: '/member/remove', pol: [], at: 10 }],
      assignments: [{ by: ALICE, to: FRANK, role: 'member', at: 1 }],
    };
    assert.ok(!mayIn(a, FRANK, '/member/remove', argsFor(a, FRANK, BOB)));
    const defined: Authority = {
      ...a,
      definitions: [{ id: 'm1', by: ALICE, role: 'member', at: 10 }],
      delegations: [{ iss: ALICE, aud: 'role:member', cmd: '/member/remove', pol: [], def: 'm1', at: 10 }],
    };
    assert.ok(mayIn(defined, FRANK, '/member/remove', argsFor(defined, FRANK, BOB)));
  });
});

describe('chess: rivals can lock a role that defines itself', () => {
  const GUS = 'did:key:gus';
  // admin's first definition (Alice's) lets admins define admin and do anything with records.
  const a0 = (iss: string, def: string, at?: number, view?: number): Delegation[] => [
    { iss, aud: 'role:admin', cmd: '/role/define', pol: [], def, at, view },
    { iss, aud: 'role:admin', cmd: '/record', pol: [], def, at, view },
  ];
  const locked: Authority = {
    founders: [ALICE],
    delegations: [
      ...a0(ALICE, 'a0'),
      // Erin and Gus each rewrite admin apart; Gus narrows /role/define's policy.
      ...a0(ERIN, 'a1', 2),
      {
        iss: GUS,
        aud: 'role:admin',
        cmd: '/role/define',
        pol: [['!=', '.role', 'owner']],
        def: 'a2',
        at: 3,
        view: 1,
      },
    ],
    definitions: [
      { id: 'a0', by: ALICE, role: 'admin' },
      { id: 'a1', by: ERIN, role: 'admin', at: 2, saw: ['a0'] },
      { id: 'a2', by: GUS, role: 'admin', at: 3, view: 1, saw: ['a0'] },
    ],
    assignments: [
      { by: ALICE, to: ERIN, role: 'admin' },
      { by: ALICE, to: GUS, role: 'admin' },
    ],
  };

  test('the rivals share no /role/define, so no admin can write the definition that ends the rivalry', () => {
    assert.ok(!mayIn(locked, ERIN, '/role/define', { role: 'admin' }));
    assert.ok(!mayIn(locked, GUS, '/role/define', { role: 'admin' }));
    const tries: Authority = {
      ...locked,
      definitions: [
        ...(locked.definitions ?? []),
        { id: 'a3', by: ERIN, role: 'admin', at: 4, saw: ['a1', 'a2'] },
      ],
      delegations: [...locked.delegations, ...a0(ERIN, 'a3', 4)],
    };
    assert.ok(
      !mayIn(tries, ERIN, '/role/define', { role: 'admin' }),
      "Erin's settling definition doesn't stand",
    );
  });

  test('a founder repairs it (without one, it takes a successor space)', () => {
    const repaired: Authority = {
      ...locked,
      definitions: [
        ...(locked.definitions ?? []),
        { id: 'a3', by: ALICE, role: 'admin', at: 4, saw: ['a1', 'a2'] },
      ],
      delegations: [...locked.delegations, ...a0(ALICE, 'a3', 4)],
    };
    assert.ok(mayIn(repaired, ERIN, '/role/define', { role: 'admin' }));
  });

  test('the recommended template: a separate steward role defines admin, so rivals on admin lock nothing', () => {
    const STEW = 'did:key:steward';
    const stewarded: Authority = {
      ...locked,
      delegations: [
        ...locked.delegations,
        { iss: ALICE, aud: 'role:steward', cmd: '/role/define', pol: [['==', '.role', 'admin']] },
      ],
      assignments: [...locked.assignments, { by: ALICE, to: STEW, role: 'steward' }],
    };
    assert.ok(mayIn(stewarded, STEW, '/role/define', { role: 'admin' }));
  });
});

describe('chess: rival definitions of a role hold only what they share', () => {
  const GUS = 'did:key:gus';
  const HAL = 'did:key:hal';
  const deletes = (a: Authority, collection: string) =>
    mayIn(a, HAL, '/record/delete', { collection, byCreator: false });
  const base: Authority = {
    founders: [ALICE],
    delegations: [
      ...grants,
      { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [] },
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

describe('chess: a struck definition carries nothing (replayed by the library)', () => {
  // Admins define member; Alice takes admin from Erin at 5.
  const template: Delegation[] = [
    ...grants,
    { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [['==', '.role', 'member']] },
    { iss: ALICE, aud: 'role:admin', cmd: '/member/remove', pol: [['==', '.self', false]] },
  ];
  const base: Authority = {
    founders: [ALICE],
    delegations: template,
    assignments: [{ by: ALICE, to: ERIN, role: 'admin', at: 1 }, ...assignments],
    unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 5 }],
  };
  const parked = (at: number, view: number): Authority => ({
    ...base,
    delegations: [
      ...template,
      { iss: ERIN, aud: 'role:member', cmd: '/record/write', pol: [], def: 'm1', at, view },
      {
        iss: ERIN,
        aud: 'role:member',
        cmd: '/member/remove',
        pol: [['==', '.self', false]],
        def: 'm1',
        at,
        view,
      },
    ],
    definitions: [{ id: 'm1', by: ERIN, role: 'member', at, view }],
  });
  const removesBob = (a: Authority, who: string) =>
    mayIn(a, who, '/member/remove', argsFor(a, who, BOB, undefined, 9), 9);

  test('a definition concurrent with its author’s unassignment gives neither her nor anyone its grants (Q1)', () => {
    // Written at 6 having seen up to 4: concurrent with the unassignment at 5.
    assert.ok(!removesBob(parked(6, 4), FRANK), 'Frank, a member, gets nothing from it');
    // The same definition written before the unassignment, and seen by it, stands (by design).
    assert.ok(removesBob(parked(3, 2), FRANK));
  });

  test("a former definer's backdated rival definition is struck by the unassignment it hid from", () => {
    // Written after losing admin, naming a view from before: it would empty member for everyone.
    const a: Authority = {
      ...base,
      definitions: [{ id: 'm9', by: ERIN, role: 'member', at: 7, view: 4 }],
    };
    assert.ok(mayIn(a, BOB, '/record/write', { collection: 'app.chess' }), 'member keeps its grants');
  });
});

describe('chess: the strike counterfactual takes the role from the author only', () => {
  test("unassigning admin doesn't strike Erin's concurrent delete through member, which her earlier m1 gave", () => {
    const a: Authority = {
      founders: [ALICE],
      delegations: [
        { iss: ALICE, aud: 'role:admin', cmd: '/role/define', pol: [] },
        { iss: ALICE, aud: 'role:admin', cmd: '/record', pol: [] },
        { iss: ERIN, aud: 'role:member', cmd: '/record/delete', pol: [], def: 'm1', at: 2 },
      ],
      definitions: [{ id: 'm1', by: ERIN, role: 'member', at: 2 }],
      assignments: [
        { by: ALICE, to: ERIN, role: 'admin', at: 1 },
        { by: ALICE, to: ERIN, role: 'member', at: 1 },
      ],
      unassignments: [{ by: ALICE, from: ERIN, role: 'admin', at: 5 }],
    };
    // Erin deletes having seen up to 4, concurrently with the unassignment at 5.
    const del = {
      who: ERIN,
      cmd: '/record/delete',
      args: { collection: 'app.chess', byCreator: false },
      at: 4.5,
    };
    assert.ok(
      !strikes(a, { who: ERIN, role: 'admin' }, del),
      'm1, judged at its own view, still gives member it',
    );
    // What only admin gave her is struck.
    const write = { who: ERIN, cmd: '/record/write', args: { collection: 'app.chess' }, at: 4.5 };
    assert.ok(strikes(a, { who: ERIN, role: 'admin' }, write));
  });
});

describe('chess: a removal ends the assignments that had not seen it', () => {
  const deletesAny = (a: Authority, who: string) =>
    mayIn(a, who, '/record/delete', { collection: 'app.chess', byCreator: false });
  const writes = (a: Authority) => mayIn(a, BOB, '/record/write', { collection: 'app.chess' });
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
 * Whose record it is (`creator` here, `byCreator` in a grant) is read from
 * its key (#72, spec 02 §4.1): only Alice may write a first version at a key
 * she owns, so a second first version there, Bob's, fails whatever its id,
 * and an edit's creator is the author its own chain starts from, whichever
 * first version the host held first.
 */
describe('chess: whose record (#72)', () => {
  test('two first versions at one key give one creator, whatever the order held', async () => {
    const h: Host = {
      founders: [ALICE],
      members: [BOB],
      contracts: { 'app.x': [{ that: 'seq == 0 || author == creator', else: 'Only its creator edits it' }] },
    };
    const key = await ownedKey(ALICE, 'k');
    const hers = version({ id: 'x-alice', key, collection: 'app.x', author: ALICE });
    // Bob's, with the lower id the lowest-id rule would have taken.
    const his = version({ id: 'a-bob', key, collection: 'app.x', author: BOB });
    const onHis = version({ id: 'e-his', key, collection: 'app.x', author: BOB, seq: 1, prev: 'a-bob' });
    const onHers = version({ id: 'e-hers', key, collection: 'app.x', author: BOB, seq: 1, prev: 'x-alice' });
    for (const held of [
      [hers, his, onHis, onHers],
      [his, hers, onHers, onHis],
    ]) {
      const j = judge(held, h);
      assert.equal(await j.verdict('a-bob'), 'fail', "Bob's first version at Alice's key");
      assert.equal(await j.verdict('x-alice'), 'pass');
      assert.equal(await j.verdict('e-his'), 'fail', 'built on a first version that fails');
      assert.equal(await j.verdict('e-hers'), 'fail', "Bob editing Alice's record");
    }
  });
});
