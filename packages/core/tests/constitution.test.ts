/**
 * The space's constitution (spec 03 §1, §2.1, §4): its format and id, who
 * sits at the top, founders stepping down, `top: "none"`, successors, and a
 * resolver a peer doesn't know. Its hash is the space id, so nobody who hands
 * a space on can change any of it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assignKey, removalKey, stepDownKey, succeedKey } from '../src/space/space-access.js';
import { deriveReadKey } from '../src/space/space-access.js';
import {
  checkSpace,
  constitutionOf,
  constitutionProblem,
  CONSTITUTION,
  spaceIdOf,
  type Constitution,
} from '../src/space/constitution.js';
import { spaceKeyFromRaw } from '../src/privacy/space-encryption.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { canonicalize } from '../src/schema/version.js';
import {
  checkFoundingRoles,
  COLLECTION_DEFINE,
  MEMBER_REMOVE,
  ROLE_ASSIGN,
  SPACE_SUCCEED,
} from '../src/space/grants.js';
import { community, coop, solo, team } from '../src/space/presets.js';
import {
  headless,
  isMember,
  may,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
} from '../src/space/roles.js';
import { assign, remove, stepDown, succeed, unassign, writes } from './helpers/access.js';
import { createSpaceManager } from '../src/space/space-manager.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { forge, person, settle } from './helpers/person.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { stored } from './helpers/stored.js';
import type { Space, SpaceRole, Version } from '../src/types.js';

const CREATOR = 'did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg';
const EDITOR: SpaceRole = {
  name: 'editor',
  title: 'Editor',
  grants: [
    { cmd: '/record', pol: [] },
    { cmd: COLLECTION_DEFINE, pol: [] },
    { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'editor']] },
  ],
};

const CHESS: Constitution = {
  weave: CONSTITUTION,
  name: 'Chess club',
  visibility: 'public',
  resolver: 'strong-remove/1',
  top: { founders: [CREATOR] },
  roles: [EDITOR],
  createdAt: '2026-01-01T00:00:00.000Z',
  nonce: 'AAECAwQFBgcICQoL',
};

describe('the constitution examples (03 §1.2)', () => {
  test('public, with one founder', async () => {
    assert.equal(
      canonicalize(constitutionOf(CHESS)),
      '{"createdAt":"2026-01-01T00:00:00.000Z","name":"Chess club","nonce":"AAECAwQFBgcICQoL","resolver":"strong-remove/1","roles":[{"grants":[{"cmd":"/record","pol":[]},{"cmd":"/collection/define","pol":[]},{"cmd":"/role/assign","pol":[["==",".role","editor"]]}],"name":"editor","title":"Editor"}],"top":{"founders":["did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg"]},"visibility":"public","weave":"constitution/1"}',
    );
    assert.equal(await spaceIdOf(CHESS), 'bnh2nnn6pz44e565k6nqd757fduqngajepmca3cgys357agshsgra');
    assert.equal(constitutionProblem(CHESS), null);
  });

  test('private, with the key of 03 §8.1', async () => {
    const key = await spaceKeyFromRaw(
      new Uint8Array(32).map((_, i) => 0xff - i),
      CHESS.createdAt,
    );
    const readKey = (await deriveReadKey(key, createP256Provider())).did;
    const constitution: Constitution = { ...CHESS, visibility: 'private', readKey, encryptionKeyId: key.id };
    assert.equal(key.id, 'aLhvw5pkV65_lcQHEcUOug');
    assert.equal(await spaceIdOf(constitution), 'bsm42rv73g4colmj3ozemoklaew2hpmoemcuxqhifc7733hyxftvq');
  });

  test('no one at the top, a steward assigned, succeeding the chess club', async () => {
    const coopSpace: Constitution = {
      weave: CONSTITUTION,
      name: 'Bike co-op',
      visibility: 'public',
      resolver: 'strong-remove/1',
      top: 'none',
      roles: [{ name: 'steward', grants: [{ cmd: '/', pol: [] }] }],
      assigned: { [CREATOR]: ['steward'] },
      succeeds: 'bnh2nnn6pz44e565k6nqd757fduqngajepmca3cgys357agshsgra',
      createdAt: '2026-01-01T00:00:00.000Z',
      nonce: 'AAECAwQFBgcICQoL',
    };
    assert.equal(
      canonicalize(constitutionOf(coopSpace)),
      '{"assigned":{"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg":["steward"]},"createdAt":"2026-01-01T00:00:00.000Z","name":"Bike co-op","nonce":"AAECAwQFBgcICQoL","resolver":"strong-remove/1","roles":[{"grants":[{"cmd":"/","pol":[]}],"name":"steward"}],"succeeds":"bnh2nnn6pz44e565k6nqd757fduqngajepmca3cgys357agshsgra","top":"none","visibility":"public","weave":"constitution/1"}',
    );
    assert.equal(await spaceIdOf(coopSpace), 'bfr56qir3ofkfn6rawax6zkp7uqvwigxqoybta7mrey7u45red3ra');
  });
});

describe('what a constitution may say', () => {
  const problem = (change: Record<string, unknown>) => constitutionProblem({ ...CHESS, ...change });

  test('the templates are well formed', () => {
    for (const preset of [solo, team, community, coop]) assert.equal(checkFoundingRoles(preset.roles), null);
  });

  test('a malformed role, grant or nesting is refused', () => {
    const bad = (role: unknown) => checkFoundingRoles([role]);
    assert.match(String(bad({ ...EDITOR, rank: 3 })), /no field rank/);
    assert.match(String(bad({ ...EDITOR, name: 'Editor' })), /role name/);
    assert.match(String(bad({ ...EDITOR, grants: [{ cmd: 'record', pol: [] }] })), /command path/);
    assert.match(String(bad({ ...EDITOR, grants: [{ cmd: '/record', pol: [['??']] }] })), /operator/i);
    assert.match(
      String(bad({ ...EDITOR, grants: [{ cmd: '/record', pol: [], exp: 1 }] })),
      /only cmd and pol/,
    );
    assert.match(String(bad({ ...EDITOR, nests: ['editor'] })), /nests other roles/);
    assert.match(String(checkFoundingRoles([EDITOR, EDITOR])), /share a name/);
  });

  test('founders: one to sixteen, each a did:key, none twice', () => {
    assert.match(String(problem({ top: { founders: [] } })), /1 to 16 founders/);
    const many = Array.from({ length: 17 }, (_, i) => `did:key:z${i}`);
    assert.match(String(problem({ top: { founders: many } })), /1 to 16 founders/);
    assert.match(String(problem({ top: { founders: ['alice'] } })), /did:key/);
    assert.match(String(problem({ top: { founders: [CREATOR, CREATOR] } })), /named twice/);
    assert.match(String(problem({ top: { founders: [CREATOR], extra: 1 } })), /"none" or \{ founders \}/);
    assert.match(String(problem({ top: 'nobody' })), /"none" or \{ founders \}/);
  });

  test('with no one at the top, it must assign someone a founding role', () => {
    assert.match(String(problem({ top: 'none' })), /must assign someone/);
    assert.equal(problem({ top: 'none', assigned: { [CREATOR]: ['editor'] } }), null);
    assert.match(
      String(problem({ top: 'none', assigned: { [CREATOR]: ['admin'] } })),
      /only roles it founds/,
    );
    assert.match(String(problem({ top: 'none', assigned: { [CREATOR]: [] } })), /1 to 16 roles/);
    assert.match(String(problem({ top: 'none', assigned: {} })), /1 to 64 accounts/);
    assert.match(String(problem({ top: 'none', assigned: { alice: ['editor'] } })), /did:key/);
  });

  test('it succeeds a space named by its id', () => {
    assert.match(String(problem({ succeeds: 'chess club' })), /named by its id/);
    assert.match(
      String(problem({ succeeds: 'BNH2NNN6PZ44E565K6NQD757FDUQNGAJEPMCA3CGYS357AGSHSGRA' })),
      /by its id/,
    );
  });

  test('changing a founding grant, a founder or the name changes the id', async () => {
    const id = await spaceIdOf(CHESS);
    const real: Space = { id, ...CHESS };
    assert.equal(await checkSpace(real), null);
    const widened = { ...real, roles: [{ ...EDITOR, grants: [{ cmd: '/', pol: [] }] }] };
    assert.match(String(await checkSpace(widened)), /id does not match/);
    assert.match(
      String(await checkSpace({ ...real, top: 'none', assigned: { [CREATOR]: ['editor'] } })),
      /id does not match/,
    );
    assert.match(String(await checkSpace({ ...real, name: 'Checkers club' })), /id does not match/);
  });
});

describe('a constitution a peer does not know is not judged (03 §1.2)', () => {
  test('an unknown resolver: the space is refused, and the replay will not judge it', async () => {
    const other = { ...CHESS, resolver: 'majority/1' };
    const space = { id: await spaceIdOf(other), ...other };
    assert.match(String(await checkSpace(space)), /resolver this peer doesn.t know/);
    assert.throws(
      () => replayAccess({ id: space.id, resolver: 'majority/1', founders: [CREATOR], roles: [] }, []),
      /doesn't know the resolver majority\/1/,
    );
  });

  test('an unknown format or field is refused the same way', async () => {
    const later = { ...CHESS, weave: 'constitution/2' };
    assert.match(String(await checkSpace({ id: await spaceIdOf(CHESS), ...later })), /not a constitution\/1/);
    const clauses = { ...CHESS, clauses: {} };
    assert.match(String(await checkSpace({ id: 'x', ...clauses })), /field this peer doesn.t know, clauses/);
  });

  test('a space kept in an older format is not opened', async () => {
    const adapter = createMemoryAdapter();
    const manager = createSpaceManager(adapter, createP256Provider());
    const { space } = await manager.create({ name: 'Old', visibility: 'public', creator: CREATOR });
    const old = { id: space.id, name: 'Old', visibility: 'public', creator: CREATOR, roles: [], v: 3 };
    await adapter.put(`space:${space.id}`, new TextEncoder().encode(JSON.stringify(old)));
    assert.equal(await manager.get(space.id), null);
    assert.deepEqual(await manager.list(), []);
  });
});

describe('access record keys (03 §3.1)', () => {
  test('an assignment names the account and the role; a removal, a stepping down, the account', async () => {
    assert.equal(await assignKey(CREATOR, 'editor'), 'assign:0ce7d5918bd19e9cbf36c04809fd02ff2b61e3af');
    assert.equal(await removalKey(CREATOR), 'remove:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab');
    assert.equal(await stepDownKey(CREATOR), 'stepdown:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab');
    assert.equal(
      await succeedKey('bnh2nnn6pz44e565k6nqd757fduqngajepmca3cgys357agshsgra'),
      'succeed:1f15c8f3f09a977a46d6db200f2bd93a33a724f3',
    );
  });
});

// ─── The replay: founders, the top, stepping down, successors ─────────

const EVERYTHING = [{ cmd: '/', pol: [] }] as const;
const founders = (...dids: string[]): AccessGenesis => ({
  id: 'space',
  resolver: 'strong-remove/1',
  founders: dids,
  roles: [
    { name: 'admin', grants: EVERYTHING },
    { name: 'member', grants: [{ cmd: '/record', pol: [['==', '.byCreator', true]] }] },
  ],
});

/** Replays in several orders, checks each reaches the same state, and gives the first */
function replayed(g: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  const orders = [events, [...events].reverse(), [...events].sort((a, b) => b.id.localeCompare(a.id))];
  const results = orders.map((order) => replayAccess(g, order));
  const shape = (h: AccessHistory) =>
    JSON.stringify({
      founders: [...h.current.founders].sort(),
      assigned: [...h.current.assigned].map(([did, roles]) => [did, [...roles.keys()].sort()]).sort(),
      successors: [...h.current.successors].sort(),
      statuses: events.map((e) => h.status(e.id)),
    });
  for (const result of results) assert.equal(shape(result), shape(results[0]!), 'every order agrees');
  return results[0]!;
}
const status = (h: AccessHistory, e: AccessEvent) => h.status(e.id)?.status;

describe('top: founders (03 §2.1)', () => {
  test('every founder holds every command; a space may have several', () => {
    const h = replayed(founders('alice', 'bob'), []);
    for (const did of ['alice', 'bob']) {
      assert.ok(isMember(h.current, did));
      assert.ok(may(h.current, did, '/anything/at/all', {}));
    }
  });

  test('no one else removes, unassigns or demotes a founder: not an admin, not another founder', () => {
    const g = founders('alice', 'bob');
    const admin = assign('alice', 'carol', 'admin', []);
    const aliceAdmin = assign('alice', 'alice', 'admin', [admin.id]);
    const attempts = [
      remove('carol', 'alice', [aliceAdmin.id]),
      remove('bob', 'alice', [aliceAdmin.id]),
      unassign('carol', 'alice', 'admin', [aliceAdmin.id]),
      unassign('bob', 'alice', 'admin', [aliceAdmin.id]),
      assign('carol', 'alice', 'member', [aliceAdmin.id]),
      stepDown('bob', 'alice', [aliceAdmin.id]),
      stepDown('carol', 'alice', [aliceAdmin.id]),
    ];
    const h = replayed(g, [admin, aliceAdmin, ...attempts]);
    for (const attempt of attempts) assert.equal(status(h, attempt), 'dropped', attempt.id);
    assert.deepEqual([...h.current.founders].sort(), ['alice', 'bob']);
    assert.deepEqual(rolesOf(h.current, 'alice'), ['admin']);
  });

  test('backdated or concurrent, the attempt is refused all the same: a founder is one in every view', () => {
    const g = founders('alice');
    const admin = assign('alice', 'carol', 'admin', []);
    const later = assign('alice', 'dave', 'member', [admin.id]);
    // Naming nothing (the constitution alone), or a view from before anything: Alice is a founder there.
    const backdated = remove('carol', 'alice', [admin.id]);
    const genesisOnly = remove('dave', 'alice', []);
    const concurrent = unassign('carol', 'alice', 'admin', [admin.id]);
    const h = replayed(g, [admin, later, backdated, genesisOnly, concurrent]);
    for (const attempt of [backdated, genesisOnly, concurrent]) assert.equal(status(h, attempt), 'dropped');
    assert.ok(h.current.founders.has('alice'));
  });

  test('founders are equals under strong-remove: what each does to others stands as anyone’s would', () => {
    const g = founders('alice', 'bob');
    const carol = assign('alice', 'carol', 'admin', []);
    // Apart: Alice removes Carol; Bob, not having seen it, makes Carol a member too.
    const removes = remove('alice', 'carol', [carol.id]);
    const member = assign('bob', 'carol', 'member', [carol.id]);
    // And Carol, apart from both, assigns Dave.
    const dave = assign('carol', 'dave', 'member', [carol.id]);
    const h = replayed(g, [carol, removes, member, dave]);
    assert.equal(status(h, removes), 'applied');
    assert.ok(!isMember(h.current, 'carol'), 'an assignment that had not seen the removal does not count');
    assert.equal(status(h, dave), 'dropped', 'the removal strikes what Carol did unseen');
    // Bob settles it afterwards, having seen the removal.
    const again = assign('bob', 'carol', 'member', [removes.id, member.id]);
    assert.ok(isMember(replayed(g, [carol, removes, member, dave, again]).current, 'carol'));
  });
});

describe('stepping down (03 §2.5)', () => {
  test('a founder steps down and stays, with its roles; then it may be removed like anyone', () => {
    const g = founders('alice', 'bob');
    const keep = assign('alice', 'alice', 'member', []);
    const down = stepDown('alice', 'alice', [keep.id]);
    const h = replayed(g, [keep, down]);
    assert.ok(!h.current.founders.has('alice'));
    assert.ok(isMember(h.current, 'alice'));
    assert.deepEqual(rolesOf(h.current, 'alice'), ['member']);
    assert.ok(!may(h.current, 'alice', ROLE_ASSIGN, { role: 'admin', self: false, roles: [] }));
    const removed = remove('bob', 'alice', [down.id]);
    assert.equal(status(replayed(g, [keep, down, removed]), removed), 'applied');
  });

  test('a removal that had not seen the stepping down is refused: there she was a founder', () => {
    const g = founders('alice', 'bob');
    const carol = assign('alice', 'carol', 'admin', []);
    const keep = assign('alice', 'alice', 'member', [carol.id]);
    const down = stepDown('alice', 'alice', [keep.id]);
    const early = remove('carol', 'alice', [keep.id]);
    const h = replayed(g, [carol, keep, down, early]);
    assert.equal(status(h, early), 'dropped');
    assert.ok(isMember(h.current, 'alice'));
  });

  test('stepping down strikes what the founder did that had not seen it, backdated or apart', () => {
    const g = founders('alice');
    const keep = assign('alice', 'alice', 'member', []);
    const down = stepDown('alice', 'alice', [keep.id]);
    // Founder power used after stepping down, naming a view from before it.
    const backdated = assign('alice', 'mallory', 'admin', [keep.id]);
    const h = replayed(g, [keep, down, backdated]);
    assert.equal(status(h, backdated), 'dropped');
    assert.ok(!isMember(h.current, 'mallory'));
    assert.equal(
      h.judge({ id: 'w', root: 'alice', seen: [keep.id] }, (s) =>
        may(s, 'alice', '/record/write', writes('app.x', false)),
      ).ok,
      false,
      'nor does a record she writes as a founder, naming that view',
    );
  });

  test('only a founder steps down: anyone else’s is refused', () => {
    const g = founders('alice');
    const bob = assign('alice', 'bob', 'admin', []);
    const own = stepDown('bob', 'bob', [bob.id]);
    assert.equal(status(replayed(g, [bob, own]), own), 'dropped');
  });

  test('leaving is the other way down: a founder who removes itself is gone, founder and member', () => {
    const g = founders('alice', 'bob');
    const leaves = remove('alice', 'alice', []);
    const h = replayed(g, [leaves]);
    assert.ok(!isMember(h.current, 'alice'));
    assert.deepEqual([...h.current.founders], ['bob']);
  });

  test('the last founder steps down, and nobody may change roles: the space is headless', () => {
    const g = founders('alice');
    const bob = assign('alice', 'bob', 'member', []);
    const keep = assign('alice', 'alice', 'member', [bob.id]);
    const down = stepDown('alice', 'alice', [keep.id]);
    assert.ok(!headless(replayed(g, [bob, keep]).current));
    const h = replayed(g, [bob, keep, down]);
    assert.ok(headless(h.current));
    // Members keep what their roles allow.
    assert.ok(may(h.current, 'bob', '/record/write', writes('app.x')));
    // An admin left behind keeps it from being headless.
    const admin = assign('alice', 'carol', 'admin', [bob.id]);
    const keeps = assign('alice', 'alice', 'member', [admin.id]);
    const steps = stepDown('alice', 'alice', [keeps.id]);
    assert.ok(!headless(replayed(g, [bob, admin, keeps, steps]).current));
    // Made apart from her stepping down, the admin is struck with everything else she did unseen.
    assert.ok(headless(replayed(g, [bob, admin, keep, down]).current));
  });
});

describe('top: none (03 §2.1)', () => {
  const g: AccessGenesis = {
    id: 'space',
    resolver: 'strong-remove/1',
    founders: [],
    roles: coop.roles,
    assigned: { alice: ['steward'] },
  };

  test('the creator holds only the roles the constitution gives it', () => {
    const h = replayed(g, []);
    assert.equal(h.current.founders.size, 0);
    assert.deepEqual(rolesOf(h.current, 'alice'), ['steward']);
    assert.ok(may(h.current, 'alice', MEMBER_REMOVE, { self: false, roles: ['steward'] }));
    assert.ok(!may(h.current, 'alice', '/role/define', { role: 'steward' }), 'nobody defines steward');
    assert.ok(h.named('alice'));
  });

  test('anyone may be removed by whoever holds the grant: the creator too', () => {
    const bob = assign('alice', 'bob', 'steward', []);
    const out = remove('bob', 'alice', [bob.id]);
    const h = replayed(g, [bob, out]);
    assert.equal(status(h, out), 'applied');
    assert.ok(!isMember(h.current, 'alice'));
    // Assigned again, having seen the removal, she is back.
    const back = assign('bob', 'alice', 'member', [out.id]);
    assert.deepEqual(rolesOf(replayed(g, [bob, out, back]).current, 'alice'), ['member']);
  });

  test('the constitution’s assignment is undone by an unassignment, and by leaving it', () => {
    const bob = assign('alice', 'bob', 'steward', []);
    const takes = unassign('bob', 'alice', 'steward', [bob.id]);
    assert.ok(!isMember(replayed(g, [bob, takes]).current, 'alice'));
    const leaves = unassign('alice', 'alice', 'steward', []);
    assert.ok(!isMember(replayed(g, [leaves]).current, 'alice'));
  });

  test('two stewards who remove each other apart both stand removed: it may end headless', () => {
    const bob = assign('alice', 'bob', 'steward', []);
    const carol = assign('alice', 'carol', 'member', [bob.id]);
    const a = remove('alice', 'bob', [carol.id]);
    const b = remove('bob', 'alice', [carol.id]);
    const h = replayed(g, [bob, carol, a, b]);
    assert.equal(status(h, a), 'applied');
    assert.equal(status(h, b), 'applied');
    assert.ok(!isMember(h.current, 'alice') && !isMember(h.current, 'bob'));
    assert.ok(headless(h.current));
    assert.ok(isMember(h.current, 'carol'), 'members keep what their roles allow');
  });
});

describe('/space/succeed (03 §2.7)', () => {
  const NEXT = 'bnext';
  const OTHER = 'bother';

  test('a founder names a successor; it changes nothing else in the old space', () => {
    const g = founders('alice');
    const bob = assign('alice', 'bob', 'member', []);
    const before = replayed(g, [bob]);
    const named = succeed('alice', NEXT, [bob.id]);
    const after = replayed(g, [bob, named]);
    assert.equal(status(after, named), 'applied');
    assert.deepEqual([...after.current.successors], [[NEXT, ['alice']]]);
    assert.deepEqual([...after.current.founders], [...before.current.founders]);
    assert.deepEqual([...after.current.assigned], [...before.current.assigned]);
    assert.deepEqual([...after.current.roles.keys()], [...before.current.roles.keys()]);
    // A member goes on writing there, whether or not it saw the successor.
    const write = (seen: string[]) =>
      after.judge({ id: 'w', root: 'bob', seen }, (s) => may(s, 'bob', '/record/write', writes('app.x'))).ok;
    assert.ok(write([bob.id]) && write([named.id]));
  });

  test('a member without the grant may not, while someone holds it', () => {
    const g = founders('alice');
    const bob = assign('alice', 'bob', 'member', []);
    const named = succeed('bob', NEXT, [bob.id]);
    assert.equal(status(replayed(g, [bob, named]), named), 'dropped');
  });

  test('a role granted /space/succeed may', () => {
    const g: AccessGenesis = {
      ...founders('alice'),
      roles: [{ name: 'herald', grants: [{ cmd: SPACE_SUCCEED, pol: [] }] }],
    };
    const bob = assign('alice', 'bob', 'herald', []);
    const named = succeed('bob', NEXT, [bob.id]);
    assert.equal(status(replayed(g, [bob, named]), named), 'applied');
  });

  test('where no one holds it, any member may; a stranger never', () => {
    const g = founders('alice');
    const bob = assign('alice', 'bob', 'member', []);
    const keep = assign('alice', 'alice', 'member', [bob.id]);
    const down = stepDown('alice', 'alice', [keep.id]);
    const named = succeed('bob', NEXT, [down.id]);
    const stranger = succeed('mallory', OTHER, [down.id]);
    const h = replayed(g, [bob, keep, down, named, stranger]);
    assert.equal(status(h, named), 'applied');
    assert.equal(status(h, stranger), 'dropped');
    // A constitution that never granted it, with no founders: any member.
    const none: AccessGenesis = { ...founders(), assigned: { carol: ['member'] } };
    const carol = succeed('carol', NEXT, []);
    assert.equal(status(replayed(none, [carol]), carol), 'applied');
  });

  test('rival successors both stand, with no order between them; a later one replaces neither', () => {
    const g = founders('alice', 'bob');
    const a = succeed('alice', NEXT, []);
    const b = succeed('bob', OTHER, []);
    const c = succeed('bob', NEXT, [a.id, b.id]);
    const h = replayed(g, [a, b, c]);
    assert.deepEqual([...h.current.successors].sort(), [
      [NEXT, ['alice', 'bob']],
      [OTHER, ['bob']],
    ]);
  });

  test('a succeed its author’s removal had not seen is struck, as anything they did', () => {
    const g = founders('alice');
    const herald: AccessGenesis = {
      ...g,
      roles: [{ name: 'herald', grants: [{ cmd: SPACE_SUCCEED, pol: [] }] }],
    };
    const bob = assign('alice', 'bob', 'herald', []);
    const out = remove('alice', 'bob', [bob.id]);
    const named = succeed('bob', NEXT, [bob.id]);
    const h = replayed(herald, [bob, out, named]);
    assert.equal(status(h, named), 'dropped');
    assert.equal(h.current.successors.size, 0);
  });
});

// ─── On nodes: the library and every peer ─────────────────────────────

describe('the constitution on nodes', () => {
  test('a removal of a founder, even backdated, is refused by every peer', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const carol = await person(hub);
    const { id: space } = await alice.node.spaces.create({
      name: 'Club',
      ...community,
      visibility: 'public',
    });
    await bob.node.spaces.join(await alice.node.spaces.invite(space, { role: 'admin' }));
    await carol.node.spaces.join(await alice.node.spaces.invite(space, { role: 'member' }));
    await hold(alice.node, space);
    await joined(bob.node, space);
    await joined(carol.node, space);
    await assert.rejects(bob.node.spaces.removeMember(space, alice.node.did), /founder/);
    await letGo(bob.node, space);
    // By hand: naming the constitution alone, and naming what Bob saw.
    const forged: Version[] = [];
    for (const seen of [[], undefined]) {
      forged.push(
        await forge(bob, space, {
          collection: 'sys.remove',
          body: { did: alice.node.did },
          retain: true,
          ...(seen ? { seen } : {}),
          version: { key: await removalKey(alice.node.did), seq: 0 },
        }),
      );
    }
    await hold(bob.node, space);
    // It arrives, is stored as Bob's change, and changes nothing.
    for (const who of [alice, carol])
      await until(
        async () =>
          (
            await Promise.all(forged.map(async (v) => (await stored(who.stores, space)).getVersion(v.id)))
          ).every(Boolean),
        4000,
        'the forged removals to arrive',
      );
    await settle();
    for (const who of [alice, bob, carol]) {
      const access = await who.node.spaces.access(space);
      const founder = access.members.find((m) => m.did === alice.node.did);
      assert.equal(founder?.founder, true, 'Alice is a founder still');
    }
  });

  test('a founder steps down, keeping a role; the space says who is at the top', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({
      name: 'Club',
      ...community,
      visibility: 'public',
    });
    assert.equal((await alice.node.spaces.access(space)).top, 'founders');
    await assert.rejects(alice.node.spaces.stepDown(space), /hold no role/);
    await alice.node.spaces.stepDown(space, { keep: 'admin' });
    const access = await alice.node.spaces.access(space);
    assert.equal(access.founder, false);
    assert.deepEqual(access.mine, ['admin']);
    assert.equal(access.headless, false, 'an admin may still change roles');
    await assert.rejects(alice.node.spaces.stepDown(space), /not a founder/);
  });

  test('a co-op: no founders, the creator a steward another steward can remove', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const created = await alice.node.spaces.create({ name: 'Co-op', ...coop, visibility: 'public' });
    assert.deepEqual(created.founders, []);
    assert.equal(created.role, 'steward');
    const space = created.id;
    const before = await alice.node.spaces.access(space);
    assert.equal(before.top, 'none');
    assert.deepEqual(before.mine, ['steward']);
    await bob.node.spaces.join(await alice.node.spaces.invite(space, { role: 'steward' }));
    await hold(alice.node, space);
    await joined(bob.node, space);
    await bob.node.spaces.removeMember(space, alice.node.did);
    await until(
      async () => (await alice.node.spaces.access(space)).mine.length === 0,
      4000,
      'Alice to see she was removed',
    );
  });

  test('a successor: made with succeeds, named in the old space, shown with who named it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id: old } = await alice.node.spaces.create({ name: 'Club', ...community, visibility: 'public' });
    await bob.node.spaces.join(await alice.node.spaces.invite(old, { role: 'member' }));
    await hold(alice.node, old);
    await joined(bob.node, old);
    const copy = await alice.node.spaces.create({ name: 'Club 2', ...community, visibility: 'public' });
    await assert.rejects(alice.node.spaces.succeed(old, copy.id), /does not say it succeeds/);
    const next = await alice.node.spaces.create({
      name: 'Club 2',
      ...community,
      visibility: 'public',
      succeeds: old,
    });
    assert.equal(next.succeeds, old);
    await assert.rejects(bob.node.spaces.succeed(old, next.id), /may not name a successor/);
    await alice.node.spaces.succeed(old, next.id);
    assert.equal(
      alice.node.spaces.preview(await alice.node.spaces.invite(next.id)).space.succeeds,
      old,
      'an invite to it says what it succeeds',
    );
    await until(
      async () => (await bob.node.spaces.access(old)).successors.length === 1,
      4000,
      'the successor to reach Bob',
    );
    const { successors, mine } = await bob.node.spaces.access(old);
    assert.deepEqual(successors, [{ space: next.id, by: [alice.node.did] }]);
    assert.deepEqual(mine, ['member'], 'nothing changed for Bob in the old space');
    await bob.node.records.put(old, 'app.note', { text: 'still here' });
  });
});
