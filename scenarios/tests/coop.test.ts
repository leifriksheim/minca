/** 2. Co-op. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mayIn } from '../host/library.js';
import { judge } from '../host/cel-host.js';
import { version } from '../host/space.js';
import {
  A,
  B,
  C,
  D,
  E,
  F,
  CONSTITUTION,
  FOUNDING,
  a1,
  a2,
  ballot,
  ballots,
  everything,
  grants,
  host,
  p1,
  removal,
} from '../communities/coop.js';

describe('co-op: grants', () => {
  const auth = {
    founders: [CONSTITUTION],
    delegations: grants,
    assignments: [
      ...FOUNDING.map((to) => ({ by: CONSTITUTION, to, role: 'member' })),
      { by: A, to: E, role: 'member' },
    ],
  };
  test('members add members; others cannot', () => {
    assert.ok(mayIn(auth, E, '/role/assign', { role: 'member', self: false }), 'E, added by A, adds F');
    assert.ok(!mayIn(auth, F, '/role/assign', { role: 'member', self: false }));
  });
});

describe('co-op: contracts', () => {
  test('three yes of five, counted as of the proposal: D is removed', async () => {
    const r = removal('r1', ['bA', 'bB', 'bC']);
    const j = judge([...everything, r], host);
    assert.equal(await j.verdict('p1'), 'pass');
    assert.equal(await j.verdict('r1'), 'pass');
    const after = judge([...everything, r, ballot('later', A, true, ['r1'])], host);
    assert.ok(!(await after.membersAsOf('later'))?.has(D));
  });

  test('F, added after the proposal, does not count', async () => {
    const j = judge([...everything, removal('r2', ['bA', 'bB', 'bF'])], host);
    assert.equal(await j.verdict('r2'), 'fail', 'two of five');
  });

  test('a proposal that leaves a member out of its count fails, and so does a removal citing it', async () => {
    const short = version({
      id: 'p2',
      collection: 'coop.proposal',
      author: B,
      body: { member: D, members: [A, B, C, D] },
      seen: ['a1'],
    });
    const votes = [A, B, C].map((m, i) =>
      version({
        id: `v${i}`,
        collection: 'coop.ballot',
        author: m,
        body: { yes: true },
        links: [{ rel: 'on', to: 'p2' }],
        seen: ['p2'],
      }),
    );
    const j = judge([...everything, short, ...votes, removal('r3', ['v0', 'v1', 'v2'], 'p2')], host);
    assert.equal(await j.verdict('p2'), 'fail');
    assert.equal(await j.verdict('r3'), 'fail');
  });

  test('a ballot not held yet: the removal waits', async () => {
    const j = judge(
      [a1, p1, a2, ...ballots.filter((b) => b.id !== 'bC'), removal('r1', ['bA', 'bB', 'bC'])],
      host,
    );
    assert.equal(await j.verdict('r1'), 'pending');
  });
});

/**
 * Attacks the stand-in can't refuse yet: they need quorum as the plan has it
 * (§5, a later step). Skipped, not passing: each asserts what quorum must
 * do, and runs when it lands.
 */
describe('co-op: attacks that need quorum', () => {
  const add = (id: string, by: string, who: string, seen: string[] = []) =>
    version({ id, collection: 'std.member', author: by, body: { op: 'add', did: who }, seen });
  const vote = (id: string, by: string, on: string, seen: string[]) =>
    version({
      id,
      collection: 'coop.ballot',
      author: by,
      body: { yes: true },
      links: [{ rel: 'on', to: on }],
      seen,
    });
  const propose = (id: string, members: string[], seen: string[]) =>
    version({ id, collection: 'coop.proposal', author: B, body: { member: D, members }, seen });
  const remove = (id: string, p: string, cites: string[], seen: string[]) =>
    version({
      id,
      collection: 'std.member',
      author: B,
      body: { op: 'remove', did: D, proposal: p, ballots: cites },
      seen: [...cites, p, ...seen],
    });

  test.skip('needs quorum: B alone adds three accounts of his, then four of seven vote D out', async () => {
    // Refused when adding a member falls under a quorum clause keyed by command and policy.
    const socks = ['did:key:s1', 'did:key:s2', 'did:key:s3'];
    const adds = socks.map((s, i) => add(`s${i}`, B, s));
    const p = propose('p', [A, B, C, D, ...socks], ['s0', 's1', 's2']);
    const votes = [B, ...socks].map((m, i) => vote(`v${i}`, m, 'p', ['p']));
    const r = remove(
      'r',
      'p',
      votes.map((v) => v.id),
      [],
    );
    assert.equal(await judge([...adds, p, ...votes, r], host).verdict('r'), 'fail');
  });

  test.skip('needs quorum: a proposal naming an older point, with ballots that saw three new members', async () => {
    // Refused when the electorate counts every member addition a cited ballot or the change had seen.
    const added = ['did:key:n1', 'did:key:n2', 'did:key:n3'].map((n, i) => add(`n${i}`, D, n));
    const old = propose('po', [A, B, C, D], []);
    const votes = [A, B, C].map((m, i) => vote(`o${i}`, m, 'po', ['po', 'n0', 'n1', 'n2']));
    const r = remove(
      'ro',
      'po',
      votes.map((v) => v.id),
      ['n0', 'n1', 'n2'],
    );
    assert.equal(await judge([...added, old, ...votes, r], host).verdict('ro'), 'fail', 'three of seven');
  });
});
