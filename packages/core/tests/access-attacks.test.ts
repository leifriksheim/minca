/**
 * Attacks on the access history (spec 03 §2–§4), each one found by an
 * adversarial review of the old replay or of the plan for grants
 * (spec/drafts/constitution-grants-contracts.md), replayed against the real
 * replay. Pure: just events.
 */
import { test, describe } from 'node:test';
import type { SpaceGrant as Grant } from '../src/types.js';
import assert from 'node:assert/strict';

import {
  isMember,
  may,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
} from '../src/space/roles.js';
import {
  MEMBER_REMOVE,
  readDefinition,
  RECORD_DELETE,
  RECORD_WRITE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
} from '../src/space/grants.js';
import { assign, define, invite, remove, revoke, unassign } from './helpers/access.js';

const OWNER: ReadonlyArray<Grant> = [
  { cmd: '/record', pol: [] },
  { cmd: ROLE_ASSIGN, pol: [] },
  { cmd: ROLE_UNASSIGN, pol: [] },
  { cmd: MEMBER_REMOVE, pol: [] },
  { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'owner']] },
];
const genesis: AccessGenesis = {
  id: 'space',
  creator: 'alice',
  roles: [
    { name: 'owner', grants: OWNER },
    {
      name: 'mod',
      grants: [
        { cmd: ROLE_ASSIGN, pol: [] },
        { cmd: MEMBER_REMOVE, pol: [] },
      ],
    },
    { name: 'member', grants: [{ cmd: RECORD_WRITE, pol: [] }] },
  ],
};
const status = (history: AccessHistory, event: AccessEvent) => history.status(event.id)?.status;

describe('attacks on the access history', () => {
  test('a grant struck by a removal gives no power downstream, even to a change that saw both', () => {
    const made = assign('alice', 'mallory', 'mod', []);
    const removed = remove('alice', 'mallory', [made.id]);
    // Mallory, not having seen her removal, makes a sock a moderator; the sock then acts.
    const sock = assign('mallory', 'eve', 'mod', [made.id]);
    const proxy = assign('eve', 'frank', 'mod', [removed.id, sock.id]);
    const history = replayAccess(genesis, [made, removed, sock, proxy]);
    assert.equal(status(history, sock), 'dropped');
    assert.equal(status(history, proxy), 'dropped', 'in its own view the grant was struck');
    assert.equal(isMember(history.current, 'frank'), false);
    assert.equal(
      history.judge({ id: 'x', root: 'eve', seen: [removed.id, sock.id] }, (state) => isMember(state, 'eve'))
        .ok,
      false,
    );
  });

  test('a struck grant gives no power downstream, even to a change that never cites the removal', () => {
    const made = assign('alice', 'mallory', 'mod', []);
    const removed = remove('alice', 'mallory', [made.id]);
    const sock = assign('mallory', 'eve', 'mod', [made.id]);
    const proxy = assign('eve', 'frank', 'mod', [sock.id]);
    const history = replayAccess(genesis, [made, removed, sock, proxy]);
    assert.equal(status(history, proxy), 'dropped', 'it rested on a struck grant');
    assert.equal(isMember(history.current, 'frank'), false);
  });

  test('a revoke or a fork proof undoes a thief’s change to who may do what, whatever it saw', () => {
    const theft = assign('alice', 'eve', 'owner', [], { author: 'aliceLaptop', line: 5 });
    const revoked = replayAccess(genesis, [
      theft,
      revoke('alice', 'aliceLaptop', [theft.id], { author: 'alicePhone' }),
    ]);
    assert.equal(status(revoked, theft), 'dropped');
    assert.equal(isMember(revoked.current, 'eve'), false);
    const fork: AccessEvent = {
      id: 'fk',
      key: 'fork:x',
      kind: 'fork',
      root: 'alice',
      author: 'alicePhone',
      writer: 'aliceLaptop',
      collection: 'sys.assign',
      from: 0,
      seen: [theft.id],
      cutoff: new Map(),
      line: 0,
    };
    const forked = replayAccess(genesis, [theft, fork]);
    assert.equal(status(forked, theft), 'dropped');
    // The thief's sock, made through the struck grant, gets nothing either.
    const proxy = assign('eve', 'frank', 'owner', [theft.id]);
    assert.equal(isMember(replayAccess(genesis, [theft, fork, proxy]).current, 'frank'), false);
  });

  test('a key change is due when someone who held the key reads no more, however it came about', () => {
    const space: AccessGenesis = { ...genesis, key: { keyId: 'k0', readKey: 'rk0' } };
    const bob = assign('alice', 'bob', 'member', []);
    // Apart: Bob is given mod, and his member role is taken. Neither alone took his reading.
    const mod = assign('alice', 'bob', 'mod', [bob.id]);
    const off = unassign('alice', 'bob', 'member', [bob.id]);
    const offMod = unassign('alice', 'bob', 'mod', [mod.id]);
    const history = replayAccess(space, [bob, mod, off, offMod]);
    assert.deepEqual(rolesOf(history.current, 'bob'), []);
    assert.equal(history.current.keyDue, true);
  });

  test('cost: a plain member’s braided revokes stay cheap', () => {
    const events: AccessEvent[] = [assign('alice', 'mallory', 'member', [])];
    for (let i = 0; i < 1500; i++)
      events.push(
        revoke(
          'mallory',
          'did:key:zJunk',
          events.slice(-2).map((event) => event.id),
        ),
      );
    const started = Date.now();
    replayAccess(genesis, events);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });

  test('cost: a long chain of definitions, each judged where it was written, stays cheap', () => {
    const steward = assign('alice', 'sam', 'owner', []);
    const events: AccessEvent[] = [steward];
    // Each definer's power comes through the definition before: attenuation walks back.
    for (let i = 0; i < 400; i++)
      events.push(
        define(
          'sam',
          'mod',
          [
            { cmd: MEMBER_REMOVE, pol: [] },
            { cmd: ROLE_ASSIGN, pol: [] },
          ],
          [events.at(-1)!.id],
        ),
      );
    events.push(assign('sam', 'mo', 'mod', [events.at(-1)!.id]));
    const started = Date.now();
    const history = replayAccess(genesis, events);
    for (let i = 0; i < 200; i++)
      may(history.current, 'mo', MEMBER_REMOVE, { self: false, roles: [String(i)] });
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });
});

/** The plan's reviews (spec/drafts/constitution-grants-contracts.md §2, §4, §9), against the real replay */
describe('attacks on grants', () => {
  const company: AccessGenesis = {
    id: 'company',
    creator: 'ceo',
    roles: [
      { name: 'hr', grants: [{ cmd: '/record', pol: [['==', '.collection', 'app.hr']] }] },
      {
        name: 'admin',
        grants: [
          {
            cmd: ROLE_ASSIGN,
            pol: [
              ['==', '.role', 'hr'],
              ['==', '.self', false],
            ],
          },
          { cmd: RECORD_WRITE, pol: [['!=', '.collection', 'app.hr']] },
        ],
      },
    ],
  };
  // Writing, which peers check. A grant of /record/read keeps no one out: the space key opens every collection.
  const writesHr = (h: AccessHistory, did: string) =>
    may(h.current, did, RECORD_WRITE, { collection: 'app.hr', byCreator: true });

  test('`self` through a role: assigning hr to the role admin is refused', () => {
    const ann = assign('ceo', 'ann', 'admin', []);
    const intoRole = assign('ann', 'role:admin', 'hr', [ann.id]);
    const h = replayAccess(company, [ann, intoRole]);
    assert.equal(status(h, intoRole), 'dropped');
    assert.ok(!writesHr(h, 'ann'));
  });

  test('`self` through nesting: nesting is defining, and Ann may not define admin', () => {
    const ann = assign('ceo', 'ann', 'admin', []);
    const nests = define('ann', 'admin', [], [ann.id], { nests: ['hr'] });
    const h = replayAccess(company, [ann, nests]);
    assert.equal(status(h, nests), 'dropped');
    assert.ok(!writesHr(h, 'ann'));
  });

  test('a nesting holds only what its writer could do: a definer who holds no hr grants nests nothing', () => {
    const g: AccessGenesis = {
      ...company,
      roles: [
        ...company.roles,
        {
          name: 'steward',
          grants: [
            { cmd: ROLE_DEFINE, pol: [['==', '.role', 'admin']] },
            { cmd: RECORD_WRITE, pol: [['!=', '.collection', 'app.hr']] },
          ],
        },
      ],
    };
    const ann = assign('ceo', 'ann', 'admin', []);
    const sam = assign('ceo', 'sam', 'steward', [ann.id]);
    const nests = define('sam', 'admin', company.roles[1]!.grants, [sam.id], { nests: ['hr'] });
    const h = replayAccess(g, [ann, sam, nests]);
    assert.equal(status(h, nests), 'applied');
    assert.ok(!writesHr(h, 'ann'), 'Sam can write no hr, so the nesting carries none');
    assert.ok(
      may(h.current, 'ann', RECORD_WRITE, { collection: 'app.eng', byCreator: true }),
      'what Sam could give, he gave',
    );
  });

  test('a fresh key outliving its issuer: a grant to anything but its role counts for nothing', () => {
    const body = (payload: Record<string, unknown>) => ({ name: 'member', grants: [payload], nests: [] });
    const good = {
      iss: 'did:key:zDave',
      aud: 'role:member',
      sub: 'space:s1',
      cmd: RECORD_DELETE,
      pol: [],
      nonce: 'n',
    };
    const context = { root: 'did:key:zDave', spaceId: 's1' };
    assert.ok(readDefinition(body(good), context));
    assert.equal(readDefinition(body({ ...good, aud: 'did:key:zFresh' }), context), null, 'to a key');
    assert.equal(readDefinition(body({ ...good, aud: 'role:admin' }), context), null, 'to another role');
    assert.equal(
      readDefinition(body({ ...good, iss: 'did:key:zOther' }), context),
      null,
      'issued by another',
    );
    assert.equal(readDefinition(body({ ...good, sub: 'space:s2' }), context), null, 'about another space');
    assert.equal(readDefinition(body({ ...good, exp: 9999999999 }), context), null, 'time ends no grant');
    assert.equal(readDefinition(body({ ...good, nbf: 0 }), context), null);
  });

  test('a referee unassigned keeps nothing: power only ever came through the role', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [...genesis.roles, { name: 'referee', grants: [{ cmd: RECORD_DELETE, pol: [] }] }],
    };
    const dave = assign('alice', 'dave', 'referee', []);
    const off = unassign('alice', 'dave', 'referee', [dave.id]);
    const h = replayAccess(g, [dave, off]);
    assert.ok(!may(h.current, 'dave', RECORD_DELETE, { collection: 'app.x', byCreator: false }));
    assert.equal(isMember(h.current, 'dave'), false, 'with no role he is no member, and invokes nothing');
  });

  test('parking power in a role the definer keeps stays until the role is rewritten (by design)', () => {
    const erin = assign('alice', 'erin', 'owner', []);
    const member = assign('alice', 'erin', 'member', [erin.id]);
    const parked = define(
      'erin',
      'member',
      [
        { cmd: RECORD_WRITE, pol: [] },
        { cmd: MEMBER_REMOVE, pol: [] },
      ],
      [member.id],
    );
    const off = unassign('alice', 'erin', 'owner', [parked.id]);
    const h = replayAccess(genesis, [erin, member, parked, off]);
    assert.ok(may(h.current, 'erin', MEMBER_REMOVE, { self: false, roles: [] }));
    const rewrite = define('alice', 'member', [{ cmd: RECORD_WRITE, pol: [] }], [off.id]);
    const after = replayAccess(genesis, [erin, member, parked, off, rewrite]);
    assert.ok(!may(after.current, 'erin', MEMBER_REMOVE, { self: false, roles: [] }));
  });

  test('a rival definition can only narrow: written apart, it leaves the intersection, never more', () => {
    const erin = assign('alice', 'erin', 'owner', []);
    const gus = assign('alice', 'gus', 'owner', [erin.id]);
    const bob = assign('alice', 'bob', 'member', [gus.id]);
    // Erin's rival adds a grant Gus's lacks: the role gains nothing from it.
    const wide = define(
      'erin',
      'member',
      [
        { cmd: RECORD_WRITE, pol: [] },
        { cmd: MEMBER_REMOVE, pol: [] },
      ],
      [bob.id],
    );
    const plain = define('gus', 'member', [{ cmd: RECORD_WRITE, pol: [] }], [bob.id]);
    const h = replayAccess(genesis, [erin, gus, bob, wide, plain]);
    assert.ok(!may(h.current, 'bob', MEMBER_REMOVE, { self: false, roles: [] }));
    assert.ok(may(h.current, 'bob', RECORD_WRITE, { collection: 'app.x', byCreator: false }));
  });

  test('taking one role strikes every concurrent action of the account, not only what needed it', () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'greeter', grants: [{ cmd: RECORD_WRITE, pol: [['==', '.collection', 'app.welcome']] }] },
      ],
    };
    const fred = assign('alice', 'fred', 'mod', []);
    const greets = assign('alice', 'fred', 'greeter', [fred.id]);
    const off = unassign('alice', 'fred', 'greeter', [greets.id]);
    const act = assign('fred', 'bob', 'member', [greets.id]);
    const h = replayAccess(g, [fred, greets, off, act]);
    assert.equal(status(h, act), 'dropped', 'concurrent with the unassignment: struck');
    // Once he has seen it, what his other role gives stands.
    const after = assign('fred', 'bob', 'member', [off.id]);
    assert.equal(status(replayAccess(g, [fred, greets, off, after]), after), 'applied');
  });
  test('removal against re-add: an assignment concurrent with the removal stays dead after the re-add', () => {
    const bob = assign('alice', 'bob', 'member', []);
    const erin = assign('alice', 'erin', 'owner', [bob.id]);
    const removed = remove('alice', 'bob', [erin.id]);
    const sneaky = assign('erin', 'bob', 'mod', [erin.id]);
    const readd = assign('alice', 'bob', 'member', [removed.id]);
    const h = replayAccess(genesis, [bob, erin, removed, sneaky, readd]);
    assert.deepEqual(rolesOf(h.current, 'bob'), ['member']);
  });

  test("a former definer's backdated rival definition is struck by the reduction it hid from", () => {
    const g: AccessGenesis = {
      ...genesis,
      roles: [
        ...genesis.roles,
        { name: 'steward', grants: [{ cmd: ROLE_DEFINE, pol: [['==', '.role', 'member']] }] },
      ],
    };
    const erin = assign('alice', 'erin', 'steward', []);
    const bob = assign('alice', 'bob', 'member', [erin.id]);
    const off = unassign('alice', 'erin', 'steward', [bob.id]);
    // After losing steward, Erin writes a definition that names a view from before it: a rival
    // with the empty set would empty member for everyone.
    const backdated = define('erin', 'member', [], [bob.id]);
    const later = define('alice', 'member', [{ cmd: RECORD_WRITE, pol: [] }], [off.id]);
    const h = replayAccess(g, [erin, bob, off, backdated, later]);
    assert.equal(status(h, backdated), 'dropped');
    assert.equal(h.current.roles.get('member')?.length, 1);
    assert.ok(may(h.current, 'bob', RECORD_WRITE, { collection: 'app.x', byCreator: false }));
  });

  test('no id decides between accounts: the same rivals with their ids swapped give the same role', () => {
    const erin = assign('alice', 'erin', 'owner', []);
    const gus = assign('alice', 'gus', 'owner', [erin.id]);
    const bob = assign('alice', 'bob', 'member', [gus.id]);
    const run = (a: string, b: string) => {
      const one = define('erin', 'member', [{ cmd: RECORD_WRITE, pol: [] }], [bob.id], { id: a });
      const two = define('gus', 'member', [{ cmd: RECORD_DELETE, pol: [] }], [bob.id], { id: b });
      const h = replayAccess(genesis, [erin, gus, bob, one, two]);
      return [RECORD_WRITE, RECORD_DELETE].map((cmd) =>
        may(h.current, 'bob', cmd, { collection: 'c', byCreator: false }),
      );
    };
    assert.deepEqual(run('aaa', 'zzz'), run('zzz', 'aaa'));
    assert.deepEqual(run('aaa', 'zzz'), [false, false]);
  });
});

// Found by the adversarial review of grants: a scoped strike (only what needed the role taken)
// was judged in a view the demoted account chose, so it could hide the need.
describe('backdating past an unassignment', () => {
  const ADMIN: ReadonlyArray<Grant> = [
    { cmd: '/record', pol: [] },
    { cmd: ROLE_ASSIGN, pol: [] },
    { cmd: ROLE_UNASSIGN, pol: [['not', ['any', '.roles', ['==', '.', 'admin']]]] },
    { cmd: MEMBER_REMOVE, pol: [['not', ['any', '.roles', ['==', '.', 'admin']]]] },
    { cmd: ROLE_DEFINE, pol: [['!=', '.role', 'admin']] },
  ];
  const MEMBER: ReadonlyArray<Grant> = [
    { cmd: RECORD_WRITE, pol: [['==', '.byCreator', true]] },
    { cmd: RECORD_DELETE, pol: [['==', '.byCreator', true]] },
  ];
  const MOD: ReadonlyArray<Grant> = [
    { cmd: MEMBER_REMOVE, pol: [['==', '.self', false]] },
    { cmd: RECORD_DELETE, pol: [] },
  ];
  const g: AccessGenesis = {
    id: 'space',
    creator: 'alice',
    roles: [
      { name: 'admin', grants: ADMIN },
      { name: 'member', grants: MEMBER },
      { name: 'mod', grants: MOD },
      { name: 'mod2', grants: MOD },
      { name: 'host', grants: [{ cmd: ROLE_ASSIGN, pol: [['==', '.role', 'member']] }] },
    ],
  };
  /** Every history, in two arrival orders */
  const orders = (events: AccessEvent[]) => [events, [...events].reverse()].map((o) => replayAccess(g, o));
  const deletesOthers = (did: string) => (state: Parameters<typeof may>[0]) =>
    may(state, did, RECORD_DELETE, { collection: 'app.x', byCreator: false });

  test('a backdated self-assignment of a second role hides no need: the removal it rests on is struck (B3)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const carol = assign('alice', 'carol', 'host', [erin.id]);
    const off = unassign('alice', 'erin', 'admin', [carol.id]);
    // After `off` Erin holds nothing. Naming a view from before it, she assigns herself mod2, then removes Carol.
    const self = assign('erin', 'erin', 'mod2', [carol.id]);
    const ban = remove('erin', 'carol', [self.id]);
    for (const h of orders([erin, carol, off, self, ban])) {
      assert.ok(!isMember(h.current, 'erin'));
      assert.equal(status(h, self), 'dropped');
      assert.equal(status(h, ban), 'dropped');
      assert.ok(isMember(h.current, 'carol'));
      const record = h.judge({ id: 'r', root: 'erin', seen: [self.id] }, deletesOthers('erin'));
      assert.ok(!record.ok && record.withdrawn, 'and her backdated records are withdrawn');
    }
  });

  test('a demoted admin who keeps another role can’t backdate through a definition of it (B)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const erinMember = assign('alice', 'erin', 'member', [erin.id]);
    const carol = assign('alice', 'carol', 'host', [erinMember.id]);
    const off = unassign('alice', 'erin', 'admin', [carol.id]);
    const parked = define('erin', 'member', [...MEMBER, { cmd: MEMBER_REMOVE, pol: [] }], [carol.id]);
    const ban = remove('erin', 'carol', [parked.id]);
    for (const h of orders([erin, erinMember, carol, off, parked, ban])) {
      assert.deepEqual(rolesOf(h.current, 'erin'), ['member']);
      assert.equal(status(h, parked), 'dropped');
      assert.equal(status(h, ban), 'dropped');
      assert.ok(isMember(h.current, 'carol'));
    }
  });

  test('two unassignments of redundant roles leave nothing to backdate with (C)', () => {
    const mal = assign('alice', 'mal', 'mod', []);
    const mal2 = assign('alice', 'mal', 'mod2', [mal.id]);
    const carol = assign('alice', 'carol', 'member', [mal2.id]);
    const off1 = unassign('alice', 'mal', 'mod', [carol.id]);
    const off2 = unassign('alice', 'mal', 'mod2', [off1.id]);
    const ban = remove('mal', 'carol', [carol.id]);
    for (const h of orders([mal, mal2, carol, off1, off2, ban])) {
      assert.ok(!isMember(h.current, 'mal'));
      assert.equal(status(h, ban), 'dropped');
      assert.ok(isMember(h.current, 'carol'));
      const record = h.judge({ id: 'r', root: 'mal', seen: [carol.id] }, deletesOthers('mal'));
      assert.ok(!record.ok && record.withdrawn);
    }
  });

  test('a record citing a struck definition gets nothing from it, the definer’s or anyone’s (A)', () => {
    const erin = assign('alice', 'erin', 'admin', []);
    const erinMember = assign('alice', 'erin', 'member', [erin.id]);
    const bob = assign('alice', 'bob', 'member', [erinMember.id]);
    const off = unassign('alice', 'erin', 'admin', [bob.id]);
    // Written after `off`, naming a view from before it.
    const parked = define('erin', 'member', [...MEMBER, { cmd: RECORD_DELETE, pol: [] }], [bob.id]);
    for (const h of orders([erin, erinMember, bob, off, parked])) {
      assert.equal(status(h, parked), 'dropped');
      for (const did of ['bob', 'erin']) {
        const record = h.judge({ id: `r-${did}`, root: did, seen: [parked.id] }, deletesOthers(did));
        assert.ok(!record.ok && record.withdrawn, `${did}'s record is withdrawn`);
      }
      // Bob's only power to delete came from the struck definition: the state he is judged by lacks it.
      assert.ok(deletesOthers('bob')(h.seenAs([parked.id])!), 'as he saw it, he could');
      assert.ok(!deletesOthers('bob')(h.at([parked.id])!), 'as it stands, he can’t');
    }
  });

  test('an invite is the assignment its opener makes: `.self` holds for whoever joins', () => {
    const g2: AccessGenesis = {
      id: 'space',
      creator: 'alice',
      roles: [
        {
          name: 'admin',
          grants: [
            {
              cmd: ROLE_ASSIGN,
              pol: [
                ['==', '.role', 'treasurer'],
                ['==', '.self', false],
              ],
            },
          ],
        },
        { name: 'treasurer', grants: [{ cmd: '/record', pol: [] }] },
      ],
    };
    const erin = assign('alice', 'erin', 'admin', []);
    const direct = assign('erin', 'erin', 'treasurer', [erin.id]);
    assert.equal(status(replayAccess(g2, [erin, direct]), direct), 'dropped');
    // Opening is allowed (it assigns someone else), but joining it herself is assigning herself.
    const open = invite('erin', 'did:key:zInviteK', 'treasurer', [erin.id]);
    const join = assign('erin', 'erin', 'treasurer', [open.id], { viaInvite: 'did:key:zInviteK' });
    const h = replayAccess(g2, [erin, open, join]);
    assert.equal(status(h, open), 'applied');
    assert.equal(status(h, join), 'dropped');
    assert.deepEqual(rolesOf(h.current, 'erin'), ['admin']);
    // Anyone else joins it.
    const bob = assign('bob', 'bob', 'treasurer', [open.id], { viaInvite: 'did:key:zInviteK' });
    assert.deepEqual(rolesOf(replayAccess(g2, [erin, open, bob]).current, 'bob'), ['treasurer']);
  });

  test('an invite’s opener’s `.roles` policy reads the joiner’s roles', () => {
    const g2: AccessGenesis = {
      id: 'space',
      creator: 'alice',
      roles: [
        {
          name: 'host',
          grants: [
            {
              cmd: ROLE_ASSIGN,
              pol: [
                ['==', '.role', 'guest'],
                ['not', ['any', '.roles', ['==', '.', 'banned']]],
              ],
            },
          ],
        },
        { name: 'guest', grants: [] },
        { name: 'banned', grants: [] },
      ],
    };
    const hal = assign('alice', 'hal', 'host', []);
    const tagged = assign('alice', 'eve', 'banned', [hal.id]);
    const open = invite('hal', 'did:key:zInviteG', 'guest', [tagged.id]);
    const join = assign('eve', 'eve', 'guest', [open.id], { viaInvite: 'did:key:zInviteG' });
    assert.equal(status(replayAccess(g2, [hal, tagged, open, join]), join), 'dropped');
  });
});
