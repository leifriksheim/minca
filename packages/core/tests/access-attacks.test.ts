/**
 * Attacks on the convergent access history (spec 03 §4), each one found by
 * an adversarial review and replayed against the fix. Pure: just events.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replayAccess, MANAGE, type AccessEvent, type AccessGenesis, type Role } from '../src/space/roles.js';

const ROLES: Role[] = [
  { name: 'owner', rank: 100, permissions: ['*'] },
  { name: 'mod', rank: 50, permissions: [MANAGE] },
  { name: 'member', rank: 10, permissions: ['write'] },
];
const genesis: AccessGenesis = { id: 'space', creator: 'alice', roles: ROLES, creatorRole: 'owner' };

let n = 0;
function member(
  id: string,
  root: string,
  did: string,
  role: string | null,
  seen: string[],
  extra: { author?: string; at?: number; line?: number } = {},
): AccessEvent {
  const place = n++;
  return {
    id,
    key: `member:${did}`,
    kind: 'member',
    root,
    author: extra.author ?? root,
    did,
    role,
    seen,
    cutoff: new Map(),
    at: extra.at ?? place,
    line: extra.line ?? place,
  };
}
const status = (history: ReturnType<typeof replayAccess>, id: string) => history.status(id)?.status;

describe('attacks on the access history', () => {
  test('a grant struck by a removal gives no power downstream, even to a change that saw both', () => {
    const made = member('a1', 'alice', 'mallory', 'mod', ['space']);
    const removed = member('r', 'alice', 'mallory', null, ['a1']);
    // Mallory, not having seen her removal, makes a sock a moderator; the sock then acts.
    const sock = member('m1', 'mallory', 'eve', 'mod', ['a1']);
    const proxy = member('m3', 'eve', 'frank', 'mod', ['r', 'm1']);
    const history = replayAccess(genesis, [made, removed, sock, proxy]);
    assert.equal(status(history, 'm1'), 'dropped');
    assert.equal(status(history, 'm3'), 'dropped', 'in its own view the grant was struck');
    assert.equal(history.current.members.has('frank'), false);
    assert.equal(
      history.judge({ id: 'x', root: 'eve', seen: ['r', 'm1'] }, (role) => role !== null).ok,
      false,
    );
  });

  test('a struck grant gives no power downstream, even to a change that never cites the removal', () => {
    const made = member('b1', 'alice', 'mallory', 'mod', ['space']);
    const removed = member('br', 'alice', 'mallory', null, ['b1']);
    // Mallory backdates a grant to a sock; the sock cites only that grant.
    const sock = member('bm1', 'mallory', 'eve', 'mod', ['b1']);
    const proxy = member('bm3', 'eve', 'frank', 'mod', ['bm1']);
    const history = replayAccess(genesis, [made, removed, sock, proxy]);
    assert.equal(status(history, 'bm1'), 'dropped');
    assert.equal(status(history, 'bm3'), 'dropped', 'it rested on a struck grant');
    assert.equal(history.current.members.has('frank'), false);
  });

  test('a thief’s grant, struck by a revoke, gives the thief’s sock nothing', () => {
    const theft = member('tt1', 'alice', 'eve', 'owner', ['space'], {
      author: 'aliceLaptop',
      at: 5,
      line: 5,
    });
    const revoke: AccessEvent = {
      id: 'trv',
      key: 'revoke:x',
      kind: 'revoke',
      root: 'alice',
      author: 'alicePhone',
      target: 'aliceLaptop',
      seen: ['tt1'],
      cutoff: new Map(),
      at: 0,
      line: 0,
    };
    const proxy = member('tp', 'eve', 'frank', 'owner', ['tt1']);
    const history = replayAccess(genesis, [theft, revoke, proxy]);
    assert.equal(status(history, 'tp'), 'dropped');
    assert.equal(history.current.members.has('frank'), false);
  });

  test('a revoke or a fork proof undoes a thief’s change to who may do what, whatever it saw', () => {
    const theft = member('t1', 'alice', 'eve', 'owner', ['space'], { author: 'aliceLaptop', at: 5, line: 5 });
    const revoke: AccessEvent = {
      id: 'rv',
      key: 'revoke:x',
      kind: 'revoke',
      root: 'alice',
      author: 'alicePhone',
      target: 'aliceLaptop',
      seen: ['t1'],
      cutoff: new Map(),
      at: 0,
      line: 0,
    };
    const revoked = replayAccess(genesis, [theft, revoke]);
    assert.equal(status(revoked, 't1'), 'dropped');
    assert.equal(revoked.current.members.has('eve'), false);
    const fork: AccessEvent = {
      id: 'fk',
      key: 'fork:x',
      kind: 'fork',
      root: 'alice',
      author: 'alicePhone',
      writer: 'aliceLaptop',
      from: 0,
      seen: ['t1'],
      cutoff: new Map(),
      at: 1,
      line: 0,
    };
    const forked = replayAccess(genesis, [theft, fork]);
    assert.equal(status(forked, 't1'), 'dropped');
    assert.equal(forked.current.members.has('eve'), false);
  });

  test('least power by what roles cover, not by how many permissions they list', () => {
    const roles: Role[] = [
      { name: 'owner', rank: 100, permissions: ['*'] },
      { name: 'super', rank: 40, permissions: ['*'] },
      { name: 'limited', rank: 40, permissions: ['read', 'comment'] },
      { name: 'admin2', rank: 90, permissions: ['*'] },
    ];
    const space: AccessGenesis = { id: 'space', creator: 'alice', roles, creatorRole: 'owner' };
    const dave = member('d1', 'alice', 'dave', 'admin2', ['space']);
    const bob = member('b1', 'alice', 'bob', 'super', ['d1']);
    const restrict = member('rs', 'alice', 'bob', 'limited', ['b1']);
    const regrant = member('rg', 'dave', 'bob', 'super', ['b1']);
    assert.equal(replayAccess(space, [dave, bob, restrict, regrant]).current.members.get('bob'), 'limited');
  });

  test('a key change is due when someone who held the key reads no more, however it came about', () => {
    const roles: Role[] = [...ROLES, { name: 'x', rank: 5, permissions: [] }];
    const space: AccessGenesis = {
      id: 'space',
      creator: 'alice',
      roles,
      creatorRole: 'owner',
      key: { keyId: 'k0', readKey: 'rk0' },
    };
    const bob = member('b', 'alice', 'bob', 'member', ['space']);
    // Apart: Bob moved to role x, and x deleted. Neither alone took his reading.
    const moved = member('mv', 'alice', 'bob', 'x', ['b']);
    const deleted: AccessEvent = {
      id: 'del',
      key: 'role:x',
      kind: 'role',
      name: 'x',
      role: null,
      root: 'alice',
      author: 'alice',
      seen: ['b'],
      cutoff: new Map(),
    };
    const history = replayAccess(space, [bob, moved, deleted]);
    assert.equal(history.current.roles.has('x'), false);
    assert.equal(history.current.keyDue, true);
    // Extending gives what replaying whole does.
    const back = member('back', 'alice', 'bob', 'member', ['mv', 'del']);
    const extended = history.extend(back) ?? replayAccess(space, [bob, moved, deleted, back]);
    assert.equal(extended.current.keyDue, replayAccess(space, [bob, moved, deleted, back]).current.keyDue);
  });

  test('cost: a plain member’s braided revokes, of any key or its own, stay cheap', () => {
    const events: AccessEvent[] = [member('m', 'alice', 'mallory', 'member', ['space'])];
    // Each revoke names the two before it, so branches meet at every one.
    for (let i = 0; i < 1500; i++) {
      const seen = events.slice(-2).map((event) => event.id);
      events.push({
        id: `rv${String(i).padStart(5, '0')}`,
        key: 'revoke:junk|mallory',
        kind: 'revoke',
        root: 'mallory',
        author: 'mallory',
        target: 'did:key:zJunk',
        seen,
        cutoff: new Map(),
      });
    }
    // And a member revoking the very key that signs it, over and over: revokes strike no revoke.
    const self: AccessEvent[] = [events[0]!];
    for (let i = 0; i < 1500; i++)
      self.push({
        id: `sv${String(i).padStart(5, '0')}`,
        key: 'revoke:self|mallory',
        kind: 'revoke',
        root: 'mallory',
        author: 'did:key:zMal',
        target: 'did:key:zMal',
        seen: self.slice(-2).map((event) => event.id),
        cutoff: new Map(),
        at: i,
        line: i,
      });
    const started = Date.now();
    replayAccess(genesis, events);
    replayAccess(genesis, self);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });
});
