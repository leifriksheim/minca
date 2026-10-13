/**
 * Checks: conditions over a version, the version before it and versions it
 * cites, judged by every peer that can read them (02 §7.6).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bodyHashOf } from '../src/schema/version.js';
import { checkRules } from '../src/records/rules.js';
import {
  checkContracts,
  contractCostHints,
  runContracts,
  MAX_CONTRACT_STEPS,
  type Contract,
  type ContractScope,
  type CitedVersion,
  type Condition,
} from '../src/records/contracts.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { useSchemas } from '../src/schemas/index.js';
import { ballot, decision, goal, goalReached, pledge, proposal } from '../src/schemas/library/community.js';
import { forge, person, type Person } from './helpers/person.js';

// ─── The language, alone ───────────────────────────────────────────

const ALICE = 'did:key:zAlice';
const BOB = 'did:key:zBob';

function version(id: string, fields: Partial<CitedVersion> = {}): CitedVersion {
  return {
    id,
    key: `k-${id}`,
    collection: 'app.vote',
    seq: 0,
    author: ALICE,
    createdAt: '2026-09-28T12:00:00.000Z',
    deleted: false,
    body: null,
    links: [],
    ...fields,
  };
}

function scope(values: Record<string, unknown> = {}, held: ReadonlyArray<CitedVersion> = []): ContractScope {
  return {
    values: { body: null, links: [], author: ALICE, prev: null, ...values },
    cite: async (id) => held.find((v) => v.id === id) ?? { later: true },
    member: (did) => did === ALICE || did === BOB,
  };
}

/** Why a version was refused, or '' when it wasn't */
const passed = (outcome: Awaited<ReturnType<typeof runContracts>>) => 'passed' in outcome && outcome.passed;
const why = (outcome: Awaited<ReturnType<typeof runContracts>>) =>
  'passed' in outcome && !outcome.passed ? outcome.reason : '';

const run = (that: Condition, values?: Record<string, unknown>, held?: ReadonlyArray<CitedVersion>) =>
  runContracts([{ that, else: 'No' }], scope(values, held));

describe('checks: a definition', () => {
  test('takes a list of { that, else }, each a CEL expression', () => {
    assert.equal(checkContracts([{ that: 'body.amount > 0', else: 'Give something' }]), null);
    assert.match(
      checkRules({ check: [{ that: 'true', else: 'Always' }] }) ?? '',
      /contract\.check/,
      'a contract is not a rule (contracts-shape.test.ts)',
    );
    assert.match(checkContracts([]) ?? '', /1 to 16 checks/);
    assert.match(checkContracts([{ that: 'true' }]) ?? '', /else says why/);
    assert.match(checkContracts([{ that: 'true', else: 'x', also: 1 }]) ?? '', /only "that" and "else"/);
    assert.match(checkContracts([{ that: true, else: 'x' }]) ?? '', /CEL expression/);
  });

  test('refuses what no peer could judge the same way', () => {
    const problem = (that: string) => checkContracts([{ that, else: 'x' }], 'contract.check') ?? '';
    assert.match(problem('eval(1)'), /eval\(\) is not in the subset/);
    assert.match(problem('size(1, 2)'), /takes 1 arguments/);
    assert.match(problem('body.x =='), /unexpected end/);
    assert.match(problem('window.location'), /"window" is not something it can read/);
    assert.match(problem('it.body'), /"it" is not something/, '`it` only inside a macro that binds it');
    assert.equal(problem('body.items.all(it, it.price > 0)'), '');
    assert.match(
      problem('body.name.matches("a+")'),
      /matches\(\) is not in the subset/,
      'regular expressions differ',
    );
    assert.match(problem('b"bytes" == b"bytes"'), /bytes/);
    assert.match(problem('type(1) == int'), /type\(\) is not in the subset/);
    assert.match(
      problem('can("approve")'),
      /can\(\) is not in the subset/,
      'what a role may do is its grants, not a check’s',
    );
    assert.match(problem('link(body.rel) == ""'), /literal link role/);
    assert.match(problem(`${'['.repeat(70)}1${']'.repeat(70)} == 1`), /nested more than 64 deep/);
  });
});

describe('checks: cost hints, for whoever writes them', () => {
  test('flag macros three deep, and citing inside a loop; plain checks get none', () => {
    assert.deepEqual(contractCostHints([{ that: 'body.items.all(it, it.price > 0)', else: 'x' }]), []);
    const [deep] = contractCostHints([
      { that: 'body.a.all(x, body.b.all(y, body.c.all(z, x == y)))', else: 'x' },
    ]);
    assert.match(deep ?? '', /nest 3 deep/);
    const [cites] = contractCostHints([{ that: 'body.ids.all(i, versions([i])[0].seq == 0)', else: 'x' }]);
    assert.match(cites ?? '', /versions\(\) inside a macro/);
  });
});

describe('checks: judging', () => {
  test('reads the version: its body, the version before, who wrote it', async () => {
    assert.deepEqual(await run('body.n == 2', { body: { n: 2 } }), { passed: true });
    assert.deepEqual(await run('body.n == 3', { body: { n: 2 } }), { passed: false, reason: 'No' });
    const next = 'body.n == prev.body.n + 1.0';
    assert.deepEqual(await run(next, { body: { n: 3 }, prev: version('p', { body: { n: 2 } }) }), {
      passed: true,
    });
    assert.deepEqual(await run(`author == "${ALICE}"`), { passed: true });
    assert.deepEqual(await run('seq == 0 && prev == null', { seq: 0 }), { passed: true });
    // A missing field is an error, not null: has() asks.
    assert.equal(passed(await run('body.nothing == null', { body: {} })), false);
    assert.deepEqual(await run('!has(body.nothing)', { body: {} }), { passed: true });
    assert.deepEqual(await run('body.list[1] == "b"', { body: { list: ['a', 'b'] } }), { passed: true });
    // Only a body's own members: nothing JavaScript adds to every object.
    assert.deepEqual(await run('!has(body.constructor)', { body: {} }), { passed: true });
  });

  test('no truthiness: a condition is true, or the version is refused', async () => {
    assert.equal(passed(await run('1')), false);
    assert.equal(passed(await run('"yes"')), false);
    assert.equal(passed(await run('true && 1')), false);
    assert.equal(passed(await run('1 < "two"')), false);
    assert.equal(passed(await run('1 / 0 == 0')), false);
    // JSON numbers are doubles: add a double, or convert.
    assert.equal(passed(await run('body.n + 1 == 2.0', { body: { n: 1 } })), false);
    assert.deepEqual(await run('body.n + 1.0 == 2.0 && int(body.n) + 1 == 2', { body: { n: 1 } }), {
      passed: true,
    });
    // An error gives way where the other side decides, as in CEL.
    assert.deepEqual(await run('body.missing || true', { body: {} }), { passed: true });
  });

  test('lists: all, exists, filter, map, distinct, sum, in, math', async () => {
    const body = {
      items: [
        { price: 3, by: ALICE },
        { price: 4, by: BOB },
        { price: 5, by: ALICE },
      ],
      a: { x: 1, y: [2, 3] },
      b: { y: [2, 3], x: 1 },
    };
    const yes = async (that: Condition) =>
      assert.deepEqual(await run(that, { body }), { passed: true }, that);
    await yes('body.items.all(it, it.price > 0)');
    await yes('body.items.exists(it, it.price == 4)');
    await yes(`body.items.filter(it, it.by == "${ALICE}").size() == 2`);
    await yes('sum(body.items.map(it, it.price)) == 12.0');
    // Every number in a body is a double, so an empty sum is one too.
    await yes('sum([]) == 0.0 && sum([]) + 1.5 == 1.5');
    await yes('body.items.map(it, it.by).distinct().size() == 2');
    await yes(`"${BOB}" in body.items.map(it, it.by)`);
    await yes('[].all(it, false) && ![].exists(it, true)');
    await yes('math.greatest([1, 7, 3]) == 7 && 7 % 3 == 1 && -(3) == -3');
    await yes('body.items[2].price == 5');
    // Maps are equal by content, whatever the order.
    await yes('body.a == body.b');
  });

  test('always ends: a check that takes too many steps is refused', async () => {
    const ten = '[0,1,2,3,4,5,6,7,8,9]';
    const outcome = await run(
      `${ten}.all(a, ${ten}.all(b, ${ten}.all(c, ${ten}.all(d, ${ten}.all(e, true)))))`,
    );
    assert.equal(passed(outcome), false);
    assert.match(why(outcome), /too many steps/);
    assert.equal(MAX_CONTRACT_STEPS, 100_000);
  });

  test('costs what it builds: a list or text grown by reuse runs out of steps, not memory', async () => {
    // Each level makes a list eight times the last: without charging for size, 8^10 elements.
    let grow = '[[1]]';
    for (let i = 0; i < 10; i++) grow = `${grow}.map(a${i}, ${Array(8).fill(`a${i}`).join(' + ')})`;
    assert.equal(checkContracts([{ that: `size(${grow}) > 0`, else: 'x' }]), null);
    assert.match(why(await run(`size(${grow}) > 0`)), /too much/);
    let text = `"${'a'.repeat(1000)}"`;
    for (let i = 0; i < 13; i++) text = `[${text}].map(s${i}, s${i} + s${i})[0]`;
    assert.match(why(await run(`size(${text}) > 0`)), /too much/);
    // distinct is linear: 20,000 numbers in a body is quick, and within the steps.
    const xs = Array.from({ length: 20_000 }, (_, i) => i);
    const started = Date.now();
    assert.equal(passed(await run('body.xs.distinct().size() == size(body.xs)', { body: { xs } })), true);
    assert.ok(Date.now() - started < 2000);
  });

  test('a macro over a map, a lookup and a map literal pay for the keys they go through', async () => {
    const forty = `[${Array.from({ length: 40 }, (_, i) => i).join(',')}]`;
    const m = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]));
    let started = Date.now();
    const sorted = await run(`[body.m].all(m, ${forty}.all(i, ${forty}.all(j, m.exists(x, true))))`, {
      body: { m },
    });
    assert.match(why(sorted), /too much/);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    let text = `"${'a'.repeat(1000)}"`;
    for (let i = 0; i < 10; i++) text = `[${text}].map(s${i}, s${i} + s${i})[0]`;
    started = Date.now();
    assert.match(
      why(await run(`[${text}].all(s, ${forty}.all(i, ${forty}.all(j, {s: true}[s])))`)),
      /too much/,
    );
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    // contains is linear: text made to slow a naive search costs no more than it is charged.
    const t = 'a'.repeat(1_200_000);
    const pattern = `${'a'.repeat(50_000)}b${'a'.repeat(50_000)}`;
    started = Date.now();
    assert.deepEqual(await run('!body.t.contains(body.p)', { body: { t, p: pattern } }), { passed: true });
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
    // distinct compares numbers exactly, so every peer keeps the same elements.
    assert.deepEqual(await run('[9007199254740993, 9007199254740992.0].distinct().size() == 2'), {
      passed: true,
    });
  });

  test('never throws instead of judging: depth is bounded, whatever the chain', async () => {
    for (const deep of ['!'.repeat(3994) + 'true', `has(body${'.a'.repeat(1990)})`, '1' + ' + 1'.repeat(900)])
      assert.match(checkContracts([{ that: deep, else: 'x' }]) ?? '', /nested more than 64 deep/);
    // A chain of && is one part, however long.
    assert.equal(checkContracts([{ that: Array(200).fill('true').join(' && '), else: 'x' }]), null);
    let body: unknown = 1;
    for (let i = 0; i < 100; i++) body = [body];
    assert.equal(passed(await run('body == body', { body })), false, 'JSON nested past 64 reads as an error');
  });

  test('syntax: quoted and reserved field names; a lone surrogate reads as U+FFFD', async () => {
    for (const that of ['has(body.`content-type`)', 'has(body.as)', 'body.namespace == "x"'])
      assert.equal(checkContracts([{ that, else: 'x' }]), null, that);
    assert.deepEqual(await run('body.`content-type` == "a"', { body: { 'content-type': 'a' } }), {
      passed: true,
    });
    const split = 'body.a.contains(body.b) || size(body.b) != 1 || body.b != "\\uFFFD"';
    assert.equal(passed(await run(split, { body: { a: '\u{1F600}', b: '\ud83d' } })), false);
    assert.deepEqual(await run('body.b == "\\uFFFD"', { body: { b: '\ud83d' } }), { passed: true });
  });

  test('hash is the content id of canonical JSON, the same as a body hash: commit, then reveal', async () => {
    const secret = { roll: 4, salt: 'k3j9x' };
    const commitment = await bodyHashOf(secret);
    assert.deepEqual(
      await run(`hash(body.reveal) == "${commitment}"`, { body: { reveal: { salt: 'k3j9x', roll: 4 } } }),
      { passed: true },
    );
  });

  test('cited versions: read by id; one not here yet makes the version wait', async () => {
    const held = [
      version('v1', { author: ALICE, body: { choice: 'yes' }, links: [{ rel: 'about', to: 'prop' }] }),
      version('v2', { author: BOB, body: { choice: 'yes' }, links: [{ rel: 'about', to: 'prop' }] }),
    ];
    const enough =
      'versions(body.votes).filter(it, it.link("about") == link("about") && it.body.choice == "yes").map(it, it.author).distinct().size() >= 2';
    const links = [{ rel: 'about', to: 'prop' }];
    assert.deepEqual(await run(enough, { body: { votes: ['v1', 'v2'] }, links }, held), { passed: true });
    assert.equal(passed(await run(enough, { body: { votes: ['v1', 'v1'] }, links }, held)), false);
    assert.deepEqual(await run(enough, { body: { votes: ['v1', 'v3'] }, links }, held), { later: true });
  });

  test('member: a place as of what the version saw', async () => {
    assert.deepEqual(await run(`member("${BOB}")`), { passed: true });
    assert.equal(passed(await run('member("not a did")')), false);
  });

  test('the first check that is not true decides', async () => {
    const checks: Contract[] = [
      { that: 'true', else: 'First' },
      { that: 'false', else: 'Second' },
      { that: 'false', else: 'Third' },
    ];
    assert.deepEqual(await runContracts(checks, scope()), { passed: false, reason: 'Second' });
  });
});

// ─── Between peers ─────────────────────────────────────────────────

/** "Passed" cites at least two distinct members' yes votes on the same proposal */
const TWO_YES: Contract = {
  that: 'versions(body.votes).filter(it, it.collection == "app.proposal.vote" && it.link("about") == link("about") && it.body.choice == "yes").map(it, it.author).distinct().size() >= 2',
  else: 'A proposal passes with yes votes from at least two members',
};

/** A counter counts up by one: the version before decides what comes next */
const BY_ONE: Contract = {
  that: 'prev == null ? body.n == 0.0 : body.n == prev.body.n + 1.0',
  else: 'A counter starts at 0 and counts up by one',
};

async function proposalSpace(visibility: 'public' | 'private' = 'public') {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, { name: 'app.proposal', schema: { type: 'object' } });
  await alice.node.collections.define(space, {
    name: 'app.proposal.vote',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { onePer: ['@author', 'link:about'] },
  });
  await alice.node.collections.define(space, {
    name: 'app.proposal.passed',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { onePer: ['link:about'] },
    contract: { check: [TWO_YES] },
  });
  await alice.node.collections.define(space, {
    name: 'app.counter',
    schema: { type: 'object' },
    contract: { check: [BY_ONE] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () => (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === 4,
    4000,
    'definitions to reach Bob',
  );
  return { hub, alice, bob, space };
}

describe('checks: between peers', () => {
  for (const visibility of ['public', 'private'] as const) {
    test(`a proposal passes once two members have voted yes, and every peer agrees (${visibility} space)`, async () => {
      const { alice, bob, space } = await proposalSpace(visibility);
      const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
      const about = [{ rel: 'about', to: proposal.key }];
      const mine = await alice.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: about },
      );
      await until(
        async () => (await bob.node.records.get(space, proposal.key)) !== null,
        4000,
        'the proposal',
      );
      const theirs = await bob.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: about },
      );
      await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s vote');

      // One vote, cited twice, is still one member.
      await assert.rejects(
        alice.node.records.put(
          space,
          'app.proposal.passed',
          { votes: [mine.version, mine.version] },
          { links: about },
        ),
        /at least two members/,
      );
      const passed = await alice.node.records.put(
        space,
        'app.proposal.passed',
        { votes: [mine.version, theirs.version] },
        { links: about },
      );
      await until(
        async () => (await bob.node.records.get(space, passed.key)) !== null,
        4000,
        'Bob to accept it',
      );
    });
  }

  test('a claim with too little evidence, signed anyway, reaches every peer and counts for no reader', async () => {
    const { alice, bob, space } = await proposalSpace();
    const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
    const about = [{ rel: 'about', to: proposal.key }];
    await until(async () => (await bob.node.records.get(space, proposal.key)) !== null, 4000, 'the proposal');
    const own = await bob.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });

    // One "passed" per proposal: the key is derived from what it is about.
    const key = (await bob.node.records.onePerKey(space, 'app.proposal.passed', {}, { links: about }))!;
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: 'app.proposal.passed',
      body: { votes: [own.version] },
      links: about,
      retain: true,
      version: { key, seq: 0 },
    });
    await hold(bob.node, space);
    // Kept and synced, as any version that stands; failing its check, shown as such and counted by no one.
    await until(
      async () => (await alice.node.records.contracts(space, key))?.passes === false,
      4000,
      'Alice to hold it, failing its check',
    );
    assert.match((await alice.node.records.contracts(space, key))?.reason ?? '', /at least two members/);
    assert.equal(await alice.node.records.get(space, key), null);
  });

  test('keeping versions under a check whole is the writer’s part: peers take one that isn’t', async () => {
    const { alice, bob, space } = await proposalSpace();
    await letGo(bob.node, space);
    const forgotten = await forge(bob, space, {
      author: '',
      collection: 'app.counter',
      body: { n: 0 },
    });
    await hold(bob.node, space);
    await until(
      async () => (await alice.node.records.get(space, forgotten.key)) !== null,
      4000,
      'Alice to take it',
    );
  });

  test('a record whose versions are checked against the one before is a state machine', async () => {
    const { alice, bob, space } = await proposalSpace();
    const counter = await alice.node.records.put(space, 'app.counter', { n: 0 });
    await alice.node.records.update(space, counter.key, { n: 1 });
    await assert.rejects(alice.node.records.update(space, counter.key, { n: 5 }), /counts up by one/);
    await until(
      async () => (await bob.node.records.get<{ n: number }>(space, counter.key))?.body?.n === 1,
      4000,
      'Bob to follow',
    );
    await bob.node.records.update(space, counter.key, { n: 2 });
    await assert.rejects(alice.node.records.put(space, 'app.counter', { n: 3 }), /starts at 0/);
  });

  test('a proof stays a proof: removing a voter it counted, later, does not undo it', async () => {
    const { hub, alice, bob, space } = await proposalSpace();
    const carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    await hold(carol.node, space);
    await joined(carol.node, space);
    const first = await alice.node.records.put(space, 'app.proposal', { title: 'A new logo' });
    const second = await alice.node.records.put(space, 'app.proposal', { title: 'A new name' });
    const yes = (who: Person, about: string) =>
      who.node.records.put(
        space,
        'app.proposal.vote',
        { choice: 'yes' },
        { links: [{ rel: 'about', to: about }] },
      );
    await until(
      async () =>
        (await bob.node.records.get(space, second.key)) !== null &&
        (await carol.node.records.get(space, second.key)) !== null &&
        (await carol.node.collections.list(space)).filter((c) => c.version !== null).length === 4,
      4000,
      'the proposals to reach Bob and Carol',
    );

    // Alice goes offline. Bob votes on both, Carol on the first, and Carol proves the first passed.
    await letGo(alice.node, space);
    const bobFirst = await yes(bob, first.key);
    const bobSecond = await yes(bob, second.key);
    const carolFirst = await yes(carol, first.key);
    await until(
      async () => (await carol.node.records.get(space, bobSecond.key)) !== null,
      4000,
      'Bob’s votes to reach Carol',
    );
    const passed = await carol.node.records.put(
      space,
      'app.proposal.passed',
      { votes: [bobFirst.version, carolFirst.version] },
      { links: [{ rel: 'about', to: first.key }] },
    );

    // Offline, Alice removes Bob, without having seen his votes, so the removal keeps none.
    await alice.node.spaces.removeMember(space, bob.node.did);
    await hold(alice.node, space);
    await until(
      async () => (await carol.node.spaces.access(space)).members.every((m) => m.did !== bob.node.did),
      4000,
      'the removal to reach Carol',
    );
    await until(
      async () => (await carol.node.records.get(space, bobFirst.key)) === null,
      4000,
      'Bob’s vote to stop counting for Carol',
    );

    // Carol's proof had not seen the removal: it stands for her, and for Alice, who joins in late.
    assert.notEqual(await carol.node.records.get(space, passed.key), null);
    await until(
      async () => (await alice.node.records.get(space, passed.key)) !== null,
      4000,
      'Alice to accept the proof',
    );
    assert.equal(await alice.node.records.get(space, bobFirst.key), null, 'Bob’s vote counts for no one now');

    // A proof made after seeing the removal can't count him.
    const carolSecond = await yes(carol, second.key);
    await assert.rejects(
      carol.node.records.put(
        space,
        'app.proposal.passed',
        { votes: [bobSecond.version, carolSecond.version] },
        { links: [{ rel: 'about', to: second.key }] },
      ),
      /does not stand/,
    );
  });
});

// ─── The standard library's proven outcomes ────────────────────────

async function governedSpace() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  const library = [proposal, ballot, decision, goal, pledge, goalReached];
  await useSchemas(alice.node, space, library);
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () =>
      (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === library.length,
    4000,
    'definitions to reach Bob',
  );
  return { alice, bob, space };
}

describe('checks: std.decision and std.goal-reached', () => {
  test('a proposal is decided once its quorum of ballots for one option is cited', async () => {
    const { alice, bob, space } = await governedSpace();
    const put = await alice.node.records.put(space, proposal, {
      title: 'Where do we meet?',
      options: ['Café', 'Library'],
      quorum: 2,
    });
    const about = [{ rel: 'about', to: put.key }];
    const mine = await alice.node.records.put(space, ballot, { choice: 1 }, { links: about });
    // A ballot is final.
    await assert.rejects(alice.node.records.update(space, mine.key, { choice: 0 }), /"choice" is fixed/);
    await until(async () => (await bob.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const theirs = await bob.node.records.put(space, ballot, { choice: 1 }, { links: about });
    await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s ballot');

    const decide = (outcome: number, ballots: string[]) =>
      alice.node.records.put(space, decision, { outcome, proposal: put.version, ballots }, { links: about });
    await assert.rejects(decide(1, [mine.version]), /as many people as the proposal’s quorum/);
    await assert.rejects(
      decide(0, [mine.version, theirs.version]),
      /as many people as the proposal’s quorum/,
    );
    await assert.rejects(decide(2, [mine.version, theirs.version]), /one of the proposal’s options/);
    const decided = await decide(1, [mine.version, theirs.version]);
    await until(
      async () => (await bob.node.records.get(space, decided.key)) !== null,
      4000,
      'Bob to accept it',
    );
  });

  test('a goal is reached once the pledges cited add up to its target, each person once', async () => {
    const { alice, bob, space } = await governedSpace();
    const set = await alice.node.records.put(space, goal, { title: 'A new roof', target: 10, unit: 'NOK' });
    const about = [{ rel: 'about', to: set.key }];
    const mine = await alice.node.records.put(space, pledge, { amount: 4 }, { links: about });
    await until(async () => (await bob.node.records.get(space, set.key)) !== null, 4000, 'the goal');
    const theirs = await bob.node.records.put(space, pledge, { amount: 7 }, { links: about });
    await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'Bob’s pledge');

    const reach = (pledges: string[]) =>
      alice.node.records.put(space, goalReached, { goal: set.version, pledges }, { links: about });
    await assert.rejects(reach([mine.version, mine.version, mine.version]), /add up to the goal’s target/);
    const reached = await reach([mine.version, theirs.version]);
    await until(
      async () => (await bob.node.records.get(space, reached.key)) !== null,
      4000,
      'Bob to accept it',
    );
  });

  test('a decision without its quorum, signed anyway, reaches every peer and counts for no reader', async () => {
    const { alice, bob, space } = await governedSpace();
    const put = await alice.node.records.put(space, proposal, {
      title: 'Paint it red?',
      options: ['Yes', 'No'],
      quorum: 2,
    });
    const about = [{ rel: 'about', to: put.key }];
    await until(async () => (await bob.node.records.get(space, put.key)) !== null, 4000, 'the proposal');
    const own = await bob.node.records.put(space, ballot, { choice: 0 }, { links: about });

    const key = (await bob.node.records.onePerKey(space, decision.name, {}, { links: about }))!;
    await letGo(bob.node, space);
    await forge(bob, space, {
      author: '',
      collection: decision.name,
      body: { outcome: 0, proposal: put.version, ballots: [own.version] },
      links: about,
      retain: true,
      version: { key, seq: 0 },
    });
    await hold(bob.node, space);
    await until(
      async () => (await alice.node.records.contracts(space, key))?.passes === false,
      4000,
      'Alice to hold it, failing its check',
    );
    assert.match((await alice.node.records.contracts(space, key))?.reason ?? '', /quorum/);
    assert.equal(await alice.node.records.get(space, key), null);
  });
});
