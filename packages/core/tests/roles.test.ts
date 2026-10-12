/**
 * The access history, replayed by `strong-remove/1` over grants (spec 03
 * §2–§5): founders, roles and their definitions, assignments, removals,
 * invites, and the conflicts that happen when people change them while
 * apart. Pure: no nodes, no crypto, just events.
 */
import { test, describe } from 'node:test';
import type { SpaceGrant as Grant } from '../src/types.js';
import assert from 'node:assert/strict';

import {
  holdsRole,
  isMember,
  may,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
} from '../src/space/roles.js';
import {
  COLLECTION_DEFINE,
  MEMBER_REMOVE,
  RECORD_DELETE,
  RECORD_WRITE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
} from '../src/space/grants.js';
import { assign, collection, define, invite, remove, revoke, unassign, writes } from './helpers/access.js';
import { community } from '../src/space/presets.js';

const ADMIN: ReadonlyArray<Grant> = [
  { cmd: '/record', pol: [] },
  { cmd: ROLE_ASSIGN, pol: [] },
  { cmd: ROLE_UNASSIGN, pol: [['not', ['any', '.roles', ['==', '.', 'admin']]]] },
  { cmd: MEMBER_REMOVE, pol: [['not', ['any', '.roles', ['==', '.', 'admin']]]] },
  { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'admin']] },
  { cmd: COLLECTION_DEFINE, pol: [] },
];
const MEMBER: ReadonlyArray<Grant> = [
  { cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] },
  { cmd: RECORD_DELETE, pol: [['==', '.byCreator', true]] },
];
const MODERATOR: ReadonlyArray<Grant> = [
  { cmd: RECORD_DELETE, pol: [] },
  {
    cmd: MEMBER_REMOVE,
    pol: [
      ['==', '.self', false],
      ['not', ['any', '.roles', ['==', '.', 'admin']]],
    ],
  },
];

const genesis: AccessGenesis = {
  id: 'space',
  resolver: 'strong-remove/1',
  founders: ['alice'],
  roles: [
    { name: 'admin', grants: ADMIN },
    { name: 'moderator', grants: MODERATOR },
    { name: 'member', grants: MEMBER },
  ],
};

/** Replays in several orders, checks each reaches the same state, and gives the first */
function replayed(events: ReadonlyArray<AccessEvent>, g: AccessGenesis = genesis): AccessHistory {
  const orders = [events, [...events].reverse(), [...events].sort((a, b) => b.id.localeCompare(a.id))];
  const results = orders.map((order) => replayAccess(g, order));
  const shape = (h: AccessHistory) =>
    JSON.stringify({
      founders: [...h.current.founders].sort(),
      assigned: [...h.current.assigned].map(([did, roles]) => [did, [...roles.keys()].sort()]).sort(),
      roles: [...h.current.roles].map(([name, defs]) => [name, defs.map((d) => d.event)]).sort(),
      invites: [...h.current.invites].sort(),
      statuses: events.map((e) => h.status(e.id)),
    });
  for (const result of results) assert.equal(shape(result), shape(results[0]!), 'every order agrees');
  return results[0]!;
}

const writesIn = (h: AccessHistory, did: string, c = 'app.x', byCreator = true) =>
  may(h.current, did, RECORD_WRITE, writes(c, byCreator));
const deletesAny = (h: AccessHistory, did: string, c = 'app.x') =>
  may(h.current, did, RECORD_DELETE, writes(c, false));
const status = (h: AccessHistory, e: AccessEvent) => h.status(e.id)?.status;

describe('founders and roles', () => {
  test('the founder holds every command, and is a member with no role', () => {
    const h = replayed([]);
    assert.ok(isMember(h.current, 'alice'));
    assert.deepEqual(rolesOf(h.current, 'alice'), []);
    assert.ok(may(h.current, 'alice', '/anything/at/all', {}));
  });

  test('an account holds power only through its roles; with none it invokes nothing', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const h = replayed([bob]);
    assert.ok(writesIn(h, 'bob'));
    assert.ok(!writesIn(h, 'bob', 'app.x', false), "a member can't change others' records");
    assert.ok(!writesIn(h, 'carol'), 'a stranger invokes nothing');
  });

  test('roles go to accounts, not to roles', () => {
    const bob = assign('alice', 'bob', 'admin', []);
    const toRole = assign('bob', 'role:member', 'moderator', [bob.id]);
    const h = replayed([bob, toRole]);
    assert.equal(status(h, toRole), 'dropped');
  });

  test('assigning is limited by its policy: `.self` and `.roles`', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'hr', grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.hr']] }] },
        {
          name: 'staffer',
          grants: [
            {
              cmd: ROLE_ASSIGN,
              pol: [
                ['==', '.role', 'hr'],
                ['==', '.self', false],
              ],
            },
          ],
        },
      ],
    };
    const ann = assign('alice', 'ann', 'staffer', []);
    const self = assign('ann', 'ann', 'hr', [ann.id]);
    const other = assign('ann', 'hal', 'hr', [ann.id]);
    const admin = assign('ann', 'hal', 'admin', [ann.id]);
    const h = replayed([ann, self, other, admin], g);
    assert.equal(status(h, self), 'dropped');
    assert.equal(status(h, other), 'applied');
    assert.equal(status(h, admin), 'dropped');
    assert.ok(may(h.current, 'hal', RECORD_WRITE, writes('app.hr')));
    assert.ok(!may(h.current, 'ann', RECORD_WRITE, writes('app.hr')));
  });

  test('nobody but a founder removes or demotes a founder', () => {
    const bob = assign('alice', 'bob', 'admin', []);
    const g: AccessGenesis = {
      ...genesis,
      roles: [{ name: 'admin', grants: [{ cmd: '/', pol: [] }] }],
    };
    const removes = remove('bob', 'alice', [bob.id]);
    const h = replayed([bob, removes], g);
    assert.equal(status(h, removes), 'dropped');
    assert.ok(h.current.founders.has('alice'));
  });

  test('a founder steps down by leaving: no longer a founder, and what it did concurrently is struck', () => {
    const bob = assign('alice', 'bob', 'admin', []);
    const leaves = remove('alice', 'alice', [bob.id]);
    // Alice's other device, apart, adds Carol.
    const carol = assign('alice', 'carol', 'admin', [bob.id]);
    const h = replayed([bob, leaves, carol]);
    assert.ok(!h.current.founders.has('alice'));
    assert.ok(!isMember(h.current, 'alice'));
    assert.equal(status(h, carol), 'dropped');
    // Bob runs it now, but can't remove another admin under the template.
    const later = assign('bob', 'dave', 'member', [leaves.id]);
    assert.equal(status(replayed([bob, leaves, later]), later), 'applied');
  });
});

describe('definitions', () => {
  test("the constitution's grants are a role's first definition: a later one replaces them", () => {
    const bob = assign('alice', 'bob', 'member', []);
    const narrowed = define(
      'alice',
      'member',
      [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.y']] }],
      [bob.id],
    );
    const h = replayed([bob, narrowed]);
    assert.ok(!writesIn(h, 'bob', 'app.x'));
    assert.ok(writesIn(h, 'bob', 'app.y'));
  });

  test('only those holding /role/define for the role write its definition', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const erin = assign('alice', 'erin', 'admin', [bob.id]);
    const byBob = define('bob', 'member', [{ cmd: '/', pol: [] }], [erin.id]);
    const byErinOnAdmin = define('erin', 'admin', [{ cmd: '/', pol: [] }], [erin.id]);
    const byErin = define('erin', 'moderator', [{ cmd: RECORD_DELETE, pol: [] }], [erin.id]);
    const h = replayed([bob, erin, byBob, byErinOnAdmin, byErin]);
    assert.equal(status(h, byBob), 'dropped');
    assert.equal(status(h, byErinOnAdmin), 'dropped', 'admins define every role but admin');
    assert.equal(status(h, byErin), 'applied');
  });

  test('a definition holds only what its author could do, as of it (attenuation)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    // Erin may define moderator, but holds no /key/change: the grant counts for nothing.
    const def = define(
      'erin',
      'moderator',
      [
        { cmd: '/key/change', pol: [] },
        { cmd: RECORD_DELETE, pol: [] },
      ],
      [erin.id],
    );
    const mo = assign('erin', 'mo', 'moderator', [def.id]);
    const h = replayed([erin, def, mo]);
    assert.ok(!may(h.current, 'mo', '/key/change', {}));
    assert.ok(deletesAny(h, 'mo'));
  });

  test('a role keeps its grants when its definer is later demoted', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const def = define('erin', 'moderator', [{ cmd: RECORD_DELETE, pol: [] }], [erin.id]);
    const mo = assign('alice', 'mo', 'moderator', [def.id]);
    const demoted = unassign('alice', 'erin', 'admin', [mo.id]);
    const h = replayed([erin, def, mo, demoted]);
    assert.ok(deletesAny(h, 'mo'), 'judged at the definition, the grant stands');
    assert.ok(!deletesAny(h, 'erin'));
    // A definition Erin writes after, having seen her demotion, counts for nothing and replaces nothing.
    const after = define('erin', 'moderator', [], [demoted.id]);
    const h2 = replayed([erin, def, mo, demoted, after]);
    assert.equal(status(h2, after), 'dropped');
    assert.ok(deletesAny(h2, 'mo'));
  });

  test('rival definitions hold only the grants they share, compared as {cmd, pol}', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const gus = assign('alice', 'gus', 'admin', [erin.id]);
    const hal = assign('alice', 'hal', 'moderator', [gus.id]);
    const chess = { cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.chess']] };
    const poll = { cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.poll']] };
    const j1 = define('erin', 'moderator', [chess, poll], [hal.id]);
    const j2 = define('gus', 'moderator', [chess], [hal.id]);
    const h = replayed([erin, gus, hal, j1, j2]);
    assert.equal(h.current.roles.get('moderator')?.length, 2);
    assert.ok(deletesAny(h, 'hal', 'app.chess'));
    assert.ok(!deletesAny(h, 'hal', 'app.poll'), 'only one rival has it');
    // A definition that saw both ends the rivalry.
    const j3 = define('erin', 'moderator', [poll], [j1.id, j2.id]);
    const settled = replayed([erin, gus, hal, j1, j2, j3]);
    assert.ok(deletesAny(settled, 'hal', 'app.poll'));
    assert.ok(!deletesAny(settled, 'hal', 'app.chess'));
  });

  test('rivals with nothing in common leave the role empty: it fails closed, whatever the ids', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const gus = assign('alice', 'gus', 'admin', [erin.id]);
    const hal = assign('alice', 'hal', 'moderator', [gus.id]);
    for (const [a, b] of [
      ['a-low', 'z-high'],
      ['z-high', 'a-low'],
    ] as const) {
      const j1 = define(
        'erin',
        'moderator',
        [{ cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.poll']] }],
        [hal.id],
        { id: a },
      );
      const j2 = define(
        'gus',
        'moderator',
        [{ cmd: RECORD_DELETE, pol: [['==', '.collection', 'app.chess']] }],
        [hal.id],
        { id: b },
      );
      const h = replayed([erin, gus, hal, j1, j2]);
      assert.ok(!deletesAny(h, 'hal', 'app.poll'));
      assert.ok(!deletesAny(h, 'hal', 'app.chess'));
    }
  });

  test('a rival its author could not write is no rival', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const bob = assign('alice', 'bob', 'member', [erin.id]);
    const hal = assign('alice', 'hal', 'moderator', [bob.id]);
    const j1 = define('erin', 'moderator', [{ cmd: RECORD_DELETE, pol: [] }], [hal.id]);
    const bogus = define('bob', 'moderator', [], [hal.id]);
    const h = replayed([erin, bob, hal, j1, bogus]);
    assert.equal(status(h, bogus), 'dropped');
    assert.ok(deletesAny(h, 'hal'));
  });

  test('rivals can lock a role that defines itself; a founder repairs it', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        {
          name: 'admin',
          grants: [
            { cmd: ROLE_DEFINE, pol: [] },
            { cmd: '/record', pol: [] },
          ],
        },
      ],
    };
    const erin = assign('alice', 'erin', 'admin', []);
    const gus = assign('alice', 'gus', 'admin', [erin.id]);
    const a1 = define(
      'erin',
      'admin',
      [
        { cmd: ROLE_DEFINE, pol: [] },
        { cmd: '/record', pol: [] },
      ],
      [gus.id],
    );
    const a2 = define(
      'gus',
      'admin',
      [
        { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'owner']] },
        { cmd: '/record', pol: [] },
      ],
      [gus.id],
    );
    const h = replayed([erin, gus, a1, a2], g);
    assert.ok(!may(h.current, 'erin', ROLE_DEFINE, { role: 'admin' }));
    const settle = define('erin', 'admin', [{ cmd: ROLE_DEFINE, pol: [] }], [a1.id, a2.id]);
    assert.equal(status(replayed([erin, gus, a1, a2, settle], g), settle), 'dropped');
    const repair = define('alice', 'admin', [{ cmd: ROLE_DEFINE, pol: [] }], [a1.id, a2.id]);
    assert.ok(may(replayed([erin, gus, a1, a2, repair], g).current, 'erin', ROLE_DEFINE, { role: 'admin' }));
  });

  test('nesting: members of the inner role hold what the outer holds, as far as the nester could', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'eng', grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.eng']] }] },
        {
          name: 'web',
          grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.web']] }],
          nests: ['eng'],
        },
        { name: 'hr', grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.hr']] }] },
      ],
    };
    const wes = assign('alice', 'wes', 'web', []);
    const h = replayed([wes], g);
    assert.ok(may(h.current, 'wes', RECORD_WRITE, writes('app.web')));
    assert.ok(may(h.current, 'wes', RECORD_WRITE, writes('app.eng')));
    assert.ok(!may(h.current, 'wes', RECORD_WRITE, writes('app.hr')));
    // Ann, an admin who holds no hr grants of her own... does: admin holds /record. So use a narrow definer.
    const ann = assign('alice', 'ann', 'moderator', [wes.id]);
    const definer = define(
      'alice',
      'moderator',
      [{ cmd: ROLE_DEFINE, pol: [['==', '.role', 'web']] }],
      [ann.id],
    );
    const nests = define('ann', 'web', [], [definer.id], { nests: ['hr'] });
    const h2 = replayed([wes, ann, definer, nests], g);
    assert.equal(status(h2, nests), 'applied');
    assert.ok(!may(h2.current, 'wes', RECORD_WRITE, writes('app.hr')), 'Ann holds nothing hr holds');
  });

  test('a cycle of nestings ends', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        { name: 'a', grants: [], nests: ['b'] },
        { name: 'b', grants: [], nests: ['a'] },
      ],
    };
    const bob = assign('alice', 'bob', 'a', []);
    assert.ok(!writesIn(replayed([bob], g), 'bob'));
  });
});

describe('unassigning and removing', () => {
  const g: AccessGenesis = {
    ...genesis,
    roles: [
      ...genesis.roles,
      { name: 'greeter', grants: [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.welcome']] }] },
    ],
  };

  test('unassigning one role strikes every concurrent action of the account, like a removal', () => {
    const fred = assign('alice', 'fred', 'admin', []);
    const greets = assign('alice', 'fred', 'greeter', [fred.id]);
    const bob = assign('alice', 'bob', 'member', [greets.id]);
    const off = unassign('alice', 'fred', 'greeter', [bob.id]);
    // Fred, apart, as an admin makes Bob a moderator: it needed admin, not greeter, and is struck all the same.
    const mod = assign('fred', 'bob', 'moderator', [bob.id]);
    const h = replayed([fred, greets, bob, off, mod], g);
    assert.equal(status(h, mod), 'dropped');
    assert.deepEqual(rolesOf(h.current, 'fred'), ['admin'], 'he keeps admin');
    const again = assign('fred', 'bob', 'moderator', [off.id]);
    assert.equal(
      status(replayed([fred, greets, bob, off, again], g), again),
      'applied',
      'once he has seen it',
    );
  });

  test('it strikes what needed the role, and so does leaving the role on one’s own (#168)', () => {
    const g2: AccessGenesis = {
      ...g,
      roles: [
        ...g.roles,
        { name: 'host', grants: [{ cmd: ROLE_ASSIGN, pol: [['==', '.role', 'greeter']] }] },
      ],
    };
    const fred = assign('alice', 'fred', 'host', []);
    const off = unassign('alice', 'fred', 'host', [fred.id]);
    const leaves = unassign('fred', 'fred', 'host', [fred.id]);
    const greets = assign('fred', 'bob', 'greeter', [fred.id]);
    for (const reduction of [off, leaves]) {
      const h = replayed([fred, reduction, greets], g2);
      assert.equal(status(h, greets), 'dropped');
    }
  });

  test('removal strikes everything concurrent, and ends assignments that had not seen it', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const erin = assign('alice', 'erin', 'admin', [bob.id]);
    const removed = remove('alice', 'bob', [erin.id]);
    // Erin, apart, makes Bob a moderator; Bob, apart, invites... by assigning nothing he may.
    const promoted = assign('erin', 'bob', 'moderator', [erin.id]);
    const h = replayed([bob, erin, removed, promoted]);
    assert.ok(!isMember(h.current, 'bob'));
    assert.equal(status(h, promoted), 'applied', "Erin's assignment stands, and counts for nothing");
    // After a re-add, only assignments that saw the removal count.
    const readd = assign('alice', 'bob', 'member', [removed.id, promoted.id]);
    const h2 = replayed([bob, erin, removed, promoted, readd]);
    assert.deepEqual(rolesOf(h2.current, 'bob'), ['member']);
    const again = assign('erin', 'bob', 'moderator', [readd.id]);
    assert.deepEqual(rolesOf(replayed([bob, erin, removed, promoted, readd, again]).current, 'bob'), [
      'member',
      'moderator',
    ]);
  });

  test('an unassignment beats a concurrent assignment of the same role', () => {
    const bob = assign('alice', 'bob', 'moderator', []);
    const erin = assign('alice', 'erin', 'admin', [bob.id]);
    const off = unassign('alice', 'bob', 'moderator', [erin.id]);
    const on = assign('erin', 'bob', 'moderator', [erin.id]);
    assert.deepEqual(rolesOf(replayed([bob, erin, off, on]).current, 'bob'), []);
  });

  test('mutual removals both stand', () => {
    const g3: AccessGenesis = {
      ...genesis,
      roles: [{ name: 'admin', grants: [{ cmd: MEMBER_REMOVE, pol: [] }] }],
    };
    const bob = assign('alice', 'bob', 'admin', []);
    const carol = assign('alice', 'carol', 'admin', [bob.id]);
    const a = remove('bob', 'carol', [carol.id]);
    const b = remove('carol', 'bob', [carol.id]);
    const h = replayed([bob, carol, a, b], g3);
    assert.ok(!isMember(h.current, 'bob'));
    assert.ok(!isMember(h.current, 'carol'));
  });

  test('`.roles` protects admins from moderators; it reads the view of the one acting', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const mo = assign('erin', 'mo', 'moderator', [erin.id]);
    const ban = remove('mo', 'erin', [mo.id]);
    assert.equal(status(replayed([erin, mo, ban]), ban), 'dropped');
    // The limit: Mo, acting concurrently with Fred's promotion, isn't stopped by it.
    const fred = assign('alice', 'fred', 'member', [mo.id]);
    const promoted = assign('alice', 'fred', 'admin', [fred.id]);
    const early = remove('mo', 'fred', [fred.id]);
    const h = replayed([erin, mo, fred, promoted, early]);
    assert.equal(status(h, early), 'applied');
    assert.ok(!isMember(h.current, 'fred'), 'the removal ends the concurrent promotion too');
  });
});

describe('what a struck change carries with it', () => {
  test('a definition concurrent with its author’s unassignment gives neither her nor anyone its grants (Q1)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const bob = assign('alice', 'bob', 'member', [erin.id]);
    const off = unassign('alice', 'erin', 'admin', [bob.id]);
    // Erin, apart, gives every member /member/remove, and Bob, having seen it, uses it.
    const parked = define('erin', 'member', [...MEMBER, { cmd: MEMBER_REMOVE, pol: [] }], [bob.id]);
    const carol = assign('alice', 'carol', 'member', [parked.id]);
    const used = remove('bob', 'carol', [carol.id]);
    const h = replayed([erin, bob, off, parked, carol, used]);
    assert.equal(status(h, parked), 'dropped');
    assert.equal(status(h, used), 'dropped', 'what rested on it falls with it');
    assert.ok(isMember(h.current, 'carol'));
    assert.ok(!may(h.current, 'bob', MEMBER_REMOVE, { self: false, roles: [] }));
    // A record resting on it falls too, though it cites the definition and never the unassignment.
    const removes = (state: Parameters<typeof may>[0]) =>
      may(state, 'bob', MEMBER_REMOVE, { self: false, roles: ['member'] });
    const record = h.judge({ id: 'r', root: 'bob', seen: [carol.id] }, removes);
    assert.ok(!record.ok && record.withdrawn);
    assert.ok(!removes(h.at([carol.id])!));
    assert.ok(removes(h.seenAs([carol.id])!), 'as Bob saw it, he could');
  });

  test("a former definer's backdated rival definition is struck by the concurrent unassignment", () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const bob = assign('alice', 'bob', 'member', [erin.id]);
    const m1 = define('alice', 'member', MEMBER, [bob.id]);
    const off = unassign('alice', 'erin', 'admin', [m1.id]);
    // Written after losing admin, naming a view from before it.
    const backdated = define('erin', 'member', [...MEMBER, { cmd: '/record', pol: [] }], [m1.id]);
    const h = replayed([erin, bob, m1, off, backdated]);
    assert.equal(status(h, backdated), 'dropped');
    assert.equal(h.current.roles.get('member')?.length, 1, 'no rival');
    assert.ok(!deletesAny(h, 'bob'));
  });

  test("a definition concurrent with its author's own assignment: an assignment changes no definition", () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'coach', grants: [] },
        { name: 'staffer', grants: [{ cmd: ROLE_ASSIGN, pol: [['==', '.role', 'coach']] }] },
      ],
    };
    const erin = assign('alice', 'erin', 'admin', []);
    const carol = assign('alice', 'carol', 'staffer', [erin.id]);
    const c0 = define('erin', 'coach', [{ cmd: MEMBER_REMOVE, pol: [['==', '.self', false]] }], [carol.id]);
    const dave = assign('carol', 'dave', 'coach', [c0.id]);
    const c1 = define(
      'erin',
      'coach',
      [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.lessons']] }],
      [dave.id],
    );
    const erinCoach = assign('carol', 'erin', 'coach', [dave.id]);
    const h = replayed([erin, carol, c0, dave, c1, erinCoach], g);
    assert.equal(status(h, c1), 'applied');
    assert.ok(!may(h.current, 'dave', MEMBER_REMOVE, { self: false, roles: [] }), 'c1 replaced c0');
  });

  test('whoever may define roles is trusted to: what she wrote into a role she keeps stays (by design)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const member = assign('alice', 'erin', 'member', [erin.id]);
    const parked = define('erin', 'member', [...MEMBER, { cmd: MEMBER_REMOVE, pol: [] }], [member.id]);
    const off = unassign('alice', 'erin', 'admin', [parked.id]);
    const h = replayed([erin, member, parked, off]);
    assert.ok(may(h.current, 'erin', MEMBER_REMOVE, { self: false, roles: [] }));
    // Someone who may define member rewrites it.
    const rewrite = define('alice', 'member', MEMBER, [off.id]);
    assert.ok(
      !may(replayed([erin, member, parked, off, rewrite]).current, 'erin', MEMBER_REMOVE, {
        self: false,
        roles: [],
      }),
    );
  });

  test('unassigning admin strikes her concurrent actions, even one her own earlier definition of member gave', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const member = assign('alice', 'erin', 'member', [erin.id]);
    const m1 = define('erin', 'member', [...MEMBER, { cmd: COLLECTION_DEFINE, pol: [] }], [member.id]);
    const off = unassign('alice', 'erin', 'admin', [m1.id]);
    const defines = collection('erin', 'app.x', [m1.id]);
    const assigns = assign('erin', 'bob', 'member', [m1.id]);
    const h = replayed([erin, member, m1, off, defines, assigns]);
    assert.equal(status(h, defines), 'dropped', 'concurrent with the unassignment');
    assert.equal(status(h, assigns), 'dropped');
    // Having seen it, m1 (judged where it was written) still gives member the grant.
    const later = collection('erin', 'app.x', [off.id]);
    assert.equal(status(replayed([erin, member, m1, off, later]), later), 'applied');
  });
});

describe('invites', () => {
  test('an open invite lets someone assign themselves its role, once', () => {
    const open = invite('alice', 'i1', 'member', []);
    const join = assign('bob', 'bob', 'member', [open.id], { viaInvite: 'i1' });
    const wrong = assign('carol', 'carol', 'admin', [open.id], { viaInvite: 'i1' });
    const h = replayed([open, join, wrong]);
    assert.deepEqual(rolesOf(h.current, 'bob'), ['member']);
    assert.equal(status(h, wrong), 'dropped');
  });

  test('opening an invite takes /role/assign for its role', () => {
    const mo = assign('alice', 'mo', 'moderator', []);
    const g: AccessGenesis = {
      ...genesis,
      roles: genesis.roles.map((role) =>
        role.name === 'moderator'
          ? { ...role, grants: [...role.grants, { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] }] }
          : role,
      ),
    };
    const ok = invite('mo', 'i1', 'member', [mo.id]);
    const no = invite('mo', 'i2', 'admin', [mo.id]);
    const h = replayed([mo, ok, no], g);
    assert.equal(status(h, ok), 'applied');
    assert.equal(status(h, no), 'dropped');
  });

  test('closing strikes joins it had not seen; rival opens for different roles close it', () => {
    const open = invite('alice', 'i1', 'member', []);
    const close = invite('alice', 'i1', 'member', [open.id], false);
    const join = assign('bob', 'bob', 'member', [open.id], { viaInvite: 'i1' });
    assert.ok(!isMember(replayed([open, close, join]).current, 'bob'));
    const erin = assign('alice', 'erin', 'admin', []);
    const a = invite('alice', 'i2', 'member', [erin.id]);
    const b = invite('erin', 'i2', 'moderator', [erin.id]);
    assert.equal(replayed([erin, a, b]).current.invites.get('i2')?.open, false);
  });
});

describe('records against the history', () => {
  const needsWrite =
    (did: string, c = 'app.x', byCreator = true) =>
    (state: Parameters<typeof may>[0]) =>
      may(state, did, RECORD_WRITE, writes(c, byCreator));

  test('a removed member cannot write by claiming an old point in history', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const removed = remove('alice', 'bob', [bob.id]);
    const h = replayed([bob, removed]);
    const verdict = h.judge({ id: 'r', root: 'bob', seen: [bob.id] }, needsWrite('bob'));
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.withdrawn);
  });

  test('an unassignment it had not seen withdraws everything, as a removal does', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'greeter', grants: [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.welcome']] }] },
      ],
    };
    const bob = assign('alice', 'bob', 'member', []);
    const greets = assign('alice', 'bob', 'greeter', [bob.id]);
    const off = unassign('alice', 'bob', 'greeter', [greets.id]);
    const h = replayed([bob, greets, off], g);
    const own = h.judge({ id: 'r1', root: 'bob', seen: [greets.id] }, needsWrite('bob', 'app.x'));
    assert.ok(!own.ok && own.withdrawn, 'member alone allowed it, and it is withdrawn all the same');
    assert.ok(h.judge({ id: 'r3', root: 'bob', seen: [off.id] }, needsWrite('bob', 'app.x')).ok);
    // Editing someone else's welcome: only greeter allows it.
    const welcome = h.judge(
      { id: 'r2', root: 'bob', seen: [greets.id] },
      needsWrite('bob', 'app.welcome', false),
    );
    assert.ok(!welcome.ok && welcome.withdrawn);
  });

  test('a revoked key: what it signed stands up to the cutoff', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const rv = revoke('bob', 'bobLaptop', [bob.id], { cutoff: { bobLaptop: { 'app.x': 3 } } });
    const h = replayed([bob, rv]);
    const at = (line: number) =>
      h.judge(
        { id: `r${line}`, root: 'bob', seen: [bob.id], writer: 'bobLaptop', collection: 'app.x', line },
        needsWrite('bob'),
      ).ok;
    assert.ok(at(3));
    assert.ok(!at(4));
  });

  test('collection definitions: /collection/define to create, its definer or /collection/define to change', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const g: AccessGenesis = {
      ...genesis,
      roles: genesis.roles.map((role) =>
        role.name === 'member'
          ? {
              ...role,
              grants: [...role.grants, { cmd: COLLECTION_DEFINE, pol: [['==', '.collection', 'app.mine']] }],
            }
          : role,
      ),
    };
    const mine = collection('bob', 'app.mine', [bob.id]);
    const other = collection('bob', 'app.other', [bob.id]);
    const h = replayed([bob, mine, other], g);
    assert.equal(status(h, mine), 'applied');
    assert.equal(status(h, other), 'dropped');
    assert.equal(h.current.definitions.get('app.mine')?.definedBy, 'bob');
  });
});

describe('holding what a role gives', () => {
  test('an account holds a role’s grants when its own are as wide: what it may hand a bot', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'bot', grants: [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.x']] }] },
        { name: 'helper', grants: [], nests: ['moderator'] },
      ],
    };
    const ann = assign('alice', 'ann', 'admin', []);
    const bob = assign('alice', 'bob', 'member', [ann.id]);
    const mo = assign('alice', 'mo', 'moderator', [bob.id]);
    const h = replayed([ann, bob, mo], g);
    assert.ok(holdsRole(h.current, 'alice', 'admin'), 'a founder holds every grant');
    assert.ok(holdsRole(h.current, 'ann', 'bot'), '/record covers it, with no policy');
    assert.ok(holdsRole(h.current, 'ann', 'member'));
    assert.ok(!holdsRole(h.current, 'bob', 'bot'), 'his own only is narrower');
    assert.ok(!holdsRole(h.current, 'bob', 'moderator'));
    assert.ok(holdsRole(h.current, 'mo', 'helper'), 'what it nests');
    assert.ok(holdsRole(h.current, 'ann', 'helper'), 'one statement fewer is wider');
    assert.ok(!holdsRole(h.current, 'bob', 'helper'));
    assert.ok(!holdsRole(h.current, 'carol', 'member'), 'a stranger holds nothing');
  });
});

describe('what a policy says, and what it does not', () => {
  test('a missing argument reads as null: a negated statement holds, a positive one doesn’t (03 §2.2)', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        { name: 'helper', grants: [{ cmd: '/', pol: [['!=', '.role', 'admin']] }] },
        { name: 'careful', grants: [{ cmd: '/', pol: [['or', [['==', '.role', 'member']]]] }] },
        { name: 'admin', grants: [] },
      ],
    };
    const hal = assign('alice', 'hal', 'helper', []);
    const cal = assign('alice', 'cal', 'careful', [hal.id]);
    const h = replayed([hal, cal], g);
    // /member/remove has no `role`: "anything but the admin role" holds for removing an admin.
    assert.ok(may(h.current, 'hal', MEMBER_REMOVE, { self: false, roles: ['admin'] }));
    assert.ok(
      !may(h.current, 'cal', MEMBER_REMOVE, { self: false, roles: ['admin'] }),
      'saying what is allowed',
    );
    assert.ok(may(h.current, 'cal', ROLE_ASSIGN, { role: 'member', self: false, roles: [] }));
  });

  test('`community` admins can remove each other by naming a view before the promotion (03 §2.3)', () => {
    const g: AccessGenesis = {
      id: 'space',
      resolver: 'strong-remove/1',
      founders: ['alice'],
      roles: community.roles,
    };
    const erin = assign('alice', 'erin', 'admin', []);
    const zed = assign('alice', 'zed', 'member', [erin.id]);
    const promoted = assign('alice', 'zed', 'admin', [zed.id]);
    const zedWork = assign('zed', 'pat', 'member', [promoted.id]);
    // Seeing the promotion, `.roles` stops her.
    const seen = remove('erin', 'zed', [promoted.id]);
    assert.equal(status(replayed([erin, zed, promoted, seen], g), seen), 'dropped');
    // Naming a view before it, it doesn't: `.roles` binds only a remover whose view holds the role.
    const ban = remove('erin', 'zed', [zed.id]);
    const h = replayed([erin, zed, promoted, zedWork, ban], g);
    assert.equal(status(h, ban), 'applied');
    assert.ok(!isMember(h.current, 'zed'));
    assert.equal(status(h, zedWork), 'dropped', 'and what he did unseen by it is struck');
  });
});
