/**
 * The scenarios' contracts in SQL, against the same cases and verdicts as the
 * CEL ones (`scenarios/tests/`), on the stand-in host `scenarios/sql/host.ts`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { lineKey, ownedKey } from '../../../packages/core/src/records/key.js';
import { ALICE, BOB, CAROL, game, moves } from '../../communities/chess.js';
import {
  a1,
  a2,
  ballot,
  ballots,
  everything,
  FOUNDING,
  p1,
  removal,
  A,
  B,
  C,
  D,
} from '../../communities/coop.js';
import { version, type Version } from '../../host/space.js';
import { loadEngine } from '../engine.js';
import { chess, coopMember, coopProposal, credit, creditLineInSql, fame, lineInSql } from '../contracts.js';
import { fameContract } from '../kysely-sketch.js';
import { judgeSql, SCHEMA, type SqlCollection, type Verdict } from '../host.js';

const engine = await loadEngine();
const verdicts = (j: { verdict(id: string): Promise<Verdict> }, ...vs: Version[]) =>
  Promise.all(vs.map((v) => j.verdict(v.id)));

describe('sql: chess', () => {
  test('the player whose turn it is moves', async () => {
    const j = judgeSql(
      [game, ...moves],
      { founders: [ALICE], members: [BOB, CAROL], collections: { 'app.chess': chess } },
      engine,
    );
    assert.deepEqual(await verdicts(j, ...moves), ['pass', 'pass', 'fail']);
  });
});

describe('sql: co-op', () => {
  const host = {
    founders: [],
    members: FOUNDING,
    collections: { 'coop.proposal': coopProposal, 'std.member': coopMember },
  };
  test('three yes of five, counted as of the proposal: D is removed', async () => {
    const r = removal('r1', ['bA', 'bB', 'bC']);
    const j = judgeSql([...everything, r], host, engine);
    assert.equal(await j.verdict('p1'), 'pass');
    assert.equal(await j.verdict('r1'), 'pass');
  });
  test('F, added after the proposal, does not count', async () => {
    const j = judgeSql([...everything, removal('r2', ['bA', 'bB', 'bF'])], host, engine);
    assert.equal(await j.verdict('r2'), 'fail');
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
    const j = judgeSql(
      [...everything, short, ...votes, removal('r3', ['v0', 'v1', 'v2'], 'p2')],
      host,
      engine,
    );
    assert.equal(await j.verdict('p2'), 'fail');
    assert.equal(await j.verdict('r3'), 'fail');
  });
  test('a ballot not held yet: the removal waits', async () => {
    const j = judgeSql(
      [a1, p1, a2, ...ballots.filter((b) => b.id !== 'bC'), removal('r1', ['bA', 'bB', 'bC'])],
      host,
      engine,
    );
    assert.equal(await j.verdict('r1'), 'pending');
  });
  test('a ballot of {"yes": 1} is not a yes: true and 1 are one value in SQL, so the contract asks json_type', async () => {
    const ones = ['bA', 'bB', 'bC'].map((id, i) => ({
      ...ballot(id, [A, B, C][i] ?? A, true),
      body: { yes: 1 },
    }));
    const j = judgeSql([a1, p1, a2, ...ones, removal('r1', ['bA', 'bB', 'bC'])], host, engine);
    assert.equal(await j.verdict('r1'), 'fail');
  });
});

describe('sql: hall of fame', () => {
  const ms = [1, 2, 3, 4, 5, 6].map((i) => `did:key:m${i}`);
  const comment = version({
    id: 'c',
    collection: 'app.comment',
    author: 'did:key:alice',
    body: { text: 'gg' },
  });
  const on = [{ rel: 'on', to: 'c' }];
  const reactions = [1, 2, 3, 4, 5].map((i) =>
    version({
      id: `r${i}`,
      collection: 'app.reaction',
      author: ms[i - 1] ?? '',
      body: { emoji: '🙂' },
      links: on,
    }),
  );
  const meh = version({
    id: 'r6',
    collection: 'app.reaction',
    author: ms[5] ?? '',
    body: { emoji: '😐' },
    links: on,
  });
  const claim = (id: string, cites: Version[], seen: string[] = []) =>
    version({
      id,
      collection: 'app.fame',
      author: 'did:key:alice',
      body: { reactions: cites.map((r) => r.id) },
      links: on,
      seen,
    });
  const f1 = claim('f1', reactions);
  const withdraw3 = version({
    id: 'w3',
    key: 'r3',
    collection: 'app.reaction',
    author: ms[2] ?? '',
    seq: 1,
    prev: 'r3',
    deleted: true,
    body: null,
    links: on,
  });
  const remove3 = version({
    id: 'x3',
    collection: 'std.member',
    author: 'did:key:alice',
    body: { op: 'remove', did: ms[2] ?? '' },
  });
  const host = { founders: ['did:key:alice'], members: ms, collections: { 'app.fame': fame } };
  const judged = (...vs: Version[]) => judgeSql([comment, ...vs], host, engine);

  test('five 🙂: the claim passes; one citing the 😐 fails', async () => {
    const f0 = claim('f0', [...reactions.slice(0, 4), meh]);
    const j = judged(...reactions, meh, f1, f0);
    assert.deepEqual(await verdicts(j, f1, f0), ['pass', 'fail']);
  });
  test('withdrawn after the claim, or before it: passes, fixed by what was cited', async () => {
    const late = claim('late', reactions, ['w3']);
    const j = judged(...reactions, meh, f1, withdraw3, late);
    assert.deepEqual(await verdicts(j, f1, late), ['pass', 'pass']);
  });
  test('removed after the claim: passes; a claim that had seen the removal fails', async () => {
    const f3 = claim('f3', reactions, ['x3']);
    const j = judged(...reactions, meh, f1, remove3, f3);
    assert.deepEqual(await verdicts(j, f1, f3), ['pass', 'fail']);
  });
  test('a device holding only some reactions: the claim waits, never false', async () => {
    const [r1, r2, , r4] = reactions;
    assert.equal(await judged(r1!, r2!, r4!, f1).verdict('f1'), 'pending');
    assert.equal(await judged(...reactions, meh, f1).verdict('f1'), 'pass');
  });
});

/** Mutual credit, once with the line rule built in and once with it in SQL: the same verdicts. */
for (const [mode, pay] of [
  ['built-in line', credit],
  ['line in SQL', creditLineInSql],
] as const) {
  describe(`sql: mutual credit (${mode})`, async () => {
    const alice = 'did:key:alice';
    const bob = 'did:key:bob';
    const carol = 'did:key:carol';
    const dave = 'did:key:dave';
    const host = (c: SqlCollection) => ({
      founders: [alice],
      members: [bob, carol, dave],
      collections: { 'app.pay': c },
    });
    const judged = (...vs: Version[]) => judgeSql(vs, host(pay), engine);
    const keys = new Map<string, string>();
    for (const who of [alice, bob, carol, dave]) keys.set(who, await lineKey(who, 'app.pay'));
    const p = (
      id: string,
      by: string,
      after: Version | null,
      to: string,
      amount: number,
      balance: number,
      received: Version[] = [],
    ) =>
      version({
        id,
        collection: 'app.pay',
        author: by,
        key: keys.get(by) ?? '',
        seq: after ? after.seq + 1 : 0,
        prev: after?.id ?? null,
        body: { to, amount, balance, received: received.map((r) => r.id) },
      });
    const a0 = p('a0', alice, null, bob, 30, -30);
    const a1 = p('a1', alice, a0, carol, 50, -80);
    const b0 = p('b0', bob, null, carol, 20, 10, [a0]);
    const a1phone = p('a1phone', alice, a0, dave, 60, -90);

    test('a payment past the limit fails', async () => {
      const over = p('over', alice, a1, bob, 30, -110);
      assert.deepEqual(await verdicts(judged(a0, a1, b0, over), a0, a1, b0, over), [
        'pass',
        'pass',
        'pass',
        'fail',
      ]);
    });
    test('a lying balance fails', async () => {
      const liar = p('liar', alice, a1, bob, 30, -50);
      assert.equal(await judged(a0, a1, liar).verdict('liar'), 'fail');
    });
    test('a payment claimed twice along the line, or in one version, fails (once)', async () => {
      const again = p('again', bob, b0, carol, 0, 40, [a0]);
      const twice = p('twice', bob, null, carol, 0, 60, [a0, a0]);
      assert.equal(await judged(a0, b0, again).verdict('again'), 'fail');
      assert.equal(await judged(a0, twice).verdict('twice'), 'fail');
    });
    test('an amount that is not a number fails (SQL compares text above every number)', async () => {
      const text = version({
        ...a0,
        id: 'text',
        body: { to: bob, amount: 'lots', balance: 0, received: [] },
      });
      assert.equal(await judged(text).verdict('text'), 'fail');
    });
    test('a double spend: neither counts; the one before still does', async () => {
      assert.deepEqual(await verdicts(judged(a0, a1, a1phone), a0, a1, a1phone), ['pass', 'fail', 'fail']);
    });
    test('until the twin arrives, the first counts, and so does what a payee built on it', async () => {
      const c0 = p('c0', carol, null, bob, 0, 50, [a1]);
      assert.equal(await judged(a0, a1, c0).verdict('c0'), 'pass');
      assert.equal(await judged(a0, a1, c0, a1phone).verdict('c0'), 'fail');
    });
    test('a payment arriving before its previous one waits', async () => {
      assert.equal(await judged(a1).verdict('a1'), 'pending');
      assert.equal(await judged(a0, a1).verdict('a1'), 'pass');
    });
    test("Carol can't grief Alice's line, at its first version or after a0", async () => {
      const fake0 = version({
        id: 'fake0',
        collection: 'app.pay',
        author: carol,
        key: keys.get(alice) ?? '',
      });
      const fake1 = version({
        id: 'fake1',
        collection: 'app.pay',
        author: carol,
        key: a0.key,
        seq: 1,
        prev: 'a0',
      });
      assert.deepEqual(await verdicts(judged(a0, a1, fake0, fake1), fake0, fake1, a0, a1), [
        'fail',
        'fail',
        'pass',
        'pass',
      ]);
    });
    test("Bob can't claim one payment twice through a second line", async () => {
      const b0x = version({ ...b0, id: 'b0x', key: await ownedKey(bob, 'other') });
      assert.deepEqual(await verdicts(judged(a0, b0, b0x), b0, b0x), ['pass', 'fail']);
    });
    test('a payee who built on a double spend: what she built falls; no corrections', async () => {
      const c0 = p('c0', carol, null, bob, 10, -10);
      const c1 = p('c1', carol, c0, bob, 0, 40, [a1]);
      const c2 = p('c2', carol, c1, bob, 30, 10);
      assert.equal(await judged(a0, a1, c0, c1, c2).verdict('c2'), 'pass');
      assert.deepEqual(await verdicts(judged(a0, a1, a1phone, c0, c1, c2), c1, c2), ['fail', 'fail']);
      const after = p('after', carol, c0, bob, 0, -10);
      assert.deepEqual(await verdicts(judged(a0, a1, a1phone, c0, c1, c2, after), after, c0), [
        'fail',
        'pass',
      ]);
    });
    test('a delete ends a line, and a delete beside a payment is its twin', async () => {
      const del = version({
        id: 'del',
        collection: 'app.pay',
        author: alice,
        key: a0.key,
        seq: 1,
        prev: 'a0',
        deleted: true,
        body: null,
      });
      const next = p('next', alice, del, bob, 1, -31);
      assert.deepEqual(await verdicts(judged(a0, del, next), del, next), ['pass', 'fail']);
      assert.deepEqual(await verdicts(judged(a0, a1, del), a1, del), ['fail', 'fail']);
    });
  });
}

describe('sql: the lockdown accepts every contract here', () => {
  test('each prepares and runs over empty tables without a refusal or an error', () => {
    const empty = Object.fromEntries(
      Object.entries(SCHEMA).map(([n, columns]) => [n, { columns, rows: [] }]),
    );
    for (const c of [chess, coopProposal, coopMember, fame, credit])
      for (const k of [...(c.check ?? []), ...lineInSql])
        assert.ok('passed' in engine.evaluate(k.that, empty), k.that);
  });
});

describe('sql: a contract written with Kysely', () => {
  test('compiles to SQL that judges the hall of fame as the hand-written one does', async () => {
    const params = [...fameContract.parameters];
    const inlined = fameContract.sql.replace(/\?/g, () => {
      const v = params.shift();
      return typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : String(v);
    });
    const ms = [1, 2, 3, 4, 5].map((i) => `did:key:m${i}`);
    const on = [{ rel: 'on', to: 'c' }];
    const rs = ms.map((m, i) =>
      version({
        id: `r${i}`,
        collection: 'app.reaction',
        author: m,
        body: { emoji: i === 4 ? '😐' : '🙂' },
        links: on,
      }),
    );
    const claim = (id: string, cites: Version[]) =>
      version({
        id,
        collection: 'app.fame',
        author: 'did:key:alice',
        body: { reactions: cites.map((r) => r.id) },
        links: on,
      });
    const r5 = version({
      id: 'r5',
      collection: 'app.reaction',
      author: ms[4] ?? '',
      body: { emoji: '🙂' },
      links: on,
    });
    for (const that of [inlined, fame.check?.[0]?.that ?? '']) {
      const host = {
        founders: ['did:key:alice'],
        members: ms,
        collections: { 'app.fame': { cites: ['reactions'], check: [{ that, else: '' }] } },
      };
      const good = claim('good', [...rs.slice(0, 4), r5]);
      const bad = claim('bad', rs);
      assert.deepEqual(await verdicts(judgeSql([...rs, r5, good, bad], host, engine), good, bad), [
        'pass',
        'fail',
      ]);
    }
  });
});
