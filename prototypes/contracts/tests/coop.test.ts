/** 2. Co-op, in both languages. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, fact, parse, type Fact } from '../src/datalog.js';
import { may } from '../src/grants.js';
import { judge, type Host } from '../src/cel-host.js';
import { factsOf, version, type Version } from '../src/space.js';
import {
  CONSTITUTION,
  datalog,
  datalogWhole,
  grants,
  memberContract,
  proposalContract,
} from '../src/examples/coop.js';
import { shuffles } from './helpers.js';

const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `did:key:${n}`);
const did = (x: string | undefined) => x ?? '';
const FOUNDING = [A, B, C, D].map(did);

const add = (id: string, by: string | undefined, who: string | undefined, seen: string[] = []) =>
  version({ id, collection: 'std.member', author: did(by), body: { op: 'add', did: did(who) }, seen });
const ballot = (id: string, by: string | undefined, yes: boolean, seen = ['p1']) =>
  version({
    id,
    collection: 'coop.ballot',
    author: did(by),
    body: { yes },
    links: [{ rel: 'on', to: 'p1' }],
    seen,
  });

// A adds E. B proposes removing D, as of five members. A adds F after. Ballots. B removes D.
const a1 = add('a1', A, E);
const p1 = version({
  id: 'p1',
  collection: 'coop.proposal',
  author: did(B),
  body: { member: did(D), members: [A, B, C, D, E].map(did) },
  seen: ['a1'],
});
const a2 = add('a2', A, F, ['p1']);
const ballots = [ballot('bA', A, true), ballot('bB', B, true), ballot('bC', C, true), ballot('bD', D, false)];
const bF = ballot('bF', F, true, ['p1', 'a2']);
const removal = (id: string, cites: string[], proposal = 'p1') =>
  version({
    id,
    collection: 'std.member',
    author: did(B),
    body: { op: 'remove', did: did(D), proposal, ballots: cites },
    seen: [...cites, proposal, 'a2'],
  });
const everything = [a1, p1, a2, ...ballots, bF];

const host: Host = {
  founders: [],
  members: FOUNDING,
  contracts: { 'coop.proposal': proposalContract, 'std.member': memberContract },
  values: (_, members) => ({ memberCount: members.size }),
};

describe('co-op (A): UCAN grants', () => {
  const auth = {
    founders: [CONSTITUTION],
    delegations: grants,
    assignments: [
      ...FOUNDING.map((to) => ({ by: CONSTITUTION, to, role: 'member' })),
      { by: did(A), to: did(E), role: 'member' },
    ],
  };
  test('members add members; others cannot', () => {
    assert.ok(may(auth, did(E), '/role/assign', { role: 'member', to: did(F) }), 'E, added by A, adds F');
    assert.ok(!may(auth, did(F), '/role/assign', { role: 'member', to: 'did:key:g' }));
  });
});

describe('co-op (A): CEL contracts', () => {
  test('three yes of five, counted as of the proposal: D is removed', async () => {
    const r = removal('r1', ['bA', 'bB', 'bC']);
    const j = judge([...everything, r], host);
    assert.equal(await j.verdict('p1'), 'pass');
    assert.equal(await j.verdict('r1'), 'pass');
    const after = judge([...everything, r, ballot('later', A, true, ['r1'])], host);
    assert.ok(!(await after.membersAsOf('later'))?.has(did(D)));
  });

  test('F, added after the proposal, does not count', async () => {
    const j = judge([...everything, removal('r2', ['bA', 'bB', 'bF'])], host);
    assert.equal(await j.verdict('r2'), 'fail', 'two of five');
  });

  test('a proposal that leaves a member out of its count fails, and so does a removal citing it', async () => {
    const short = version({
      id: 'p2',
      collection: 'coop.proposal',
      author: did(B),
      body: { member: did(D), members: [A, B, C, D].map(did) },
      seen: ['a1'],
    });
    const votes = [A, B, C].map((m, i) =>
      version({
        id: `v${i}`,
        collection: 'coop.ballot',
        author: did(m),
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

describe('co-op (C): Datalog', () => {
  const program = parse(datalog);
  /** member_at facts for each proposal, from the host's replay */
  const memberAt = async (held: Version[]): Promise<Fact[]> => {
    const j = judge(held, host);
    const out: Fact[] = [];
    for (const v of held)
      if (v.collection === 'coop.proposal')
        for (const m of (await j.membersAsOf(v.id)) ?? []) out.push(fact('member_at', v.id, m));
    return out;
  };
  const removed = (fs: Fact[]) => evaluate(program, fs).query('removed');

  test('D is removed: every held ballot is counted, none cited', async () => {
    const held = [...everything, removal('r1', [])];
    assert.deepEqual(removed([...factsOf(held), ...(await memberAt(held))]), [[did(D)]]);
  });

  test("a device without C's ballot says no, not 'wait'", async () => {
    const held = [...everything.filter((v) => v.id !== 'bC'), removal('r1', [])];
    assert.deepEqual(removed([...factsOf(held), ...(await memberAt(held))]), []);
  });

  test('in any order', async () => {
    const held = [...everything, removal('r1', [])];
    const facts = [...factsOf(held), ...(await memberAt(held))];
    for (const order of shuffles(facts, 30)) assert.deepEqual(removed(order), [[did(D)]]);
  });

  test('membership as of a version, derived in Datalog too, is refused: it recurses through count', () => {
    assert.throws(() => parse(datalogWhole), /can't be stratified/);
  });
});
