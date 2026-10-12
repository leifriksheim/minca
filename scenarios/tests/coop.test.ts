/** 2. Co-op. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { may } from '../host/grants.js';
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
    assert.ok(may(auth, E, '/role/assign', { role: 'member', self: false }), 'E, added by A, adds F');
    assert.ok(!may(auth, F, '/role/assign', { role: 'member', self: false }));
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
