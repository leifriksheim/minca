/** Contracts are judged by readers: a version that fails them is kept and synced, and counted on no read path (spec/09-contracts.md). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { ownRecords } from './helpers/own-records.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person } from './helpers/person.js';

const TWO_YES = {
  that: 'versions(body.votes).filter(it, it.collection == "app.proposal.vote" && it.link("about") == link("about") && it.body.choice == "yes").map(it, it.author).distinct().size() >= 2',
  else: 'A proposal passes with yes votes from at least two members',
};
const BY_ONE = {
  that: 'prev == null ? body.n == 0.0 : body.n == prev.body.n + 1.0',
  else: 'A counter starts at 0 and counts up by one',
};

async function proposalSpace() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...ownRecords, visibility: 'public' });
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
    'defs',
  );
  return { hub, alice, bob, space };
}

describe('probe: failing versions on read paths', () => {
  test('a forged decision that fails its check shows in list', async () => {
    const { alice, bob, space } = await proposalSpace();
    const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'Logo' });
    const about = [{ rel: 'about', to: proposal.key }];
    await until(async () => (await bob.node.records.get(space, proposal.key)) !== null, 4000, 'p');
    const own = await bob.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });
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
    await until(async () => (await alice.node.records.contracts(space, key))?.passes === false, 4000, 'held');
    assert.equal(await alice.node.records.get(space, key), null, 'get hides it');
    assert.equal(
      (await alice.node.records.list(space, { collection: 'app.proposal.passed' })).length,
      0,
      'hidden while the index is updated key by key',
    );
    // Any change to the space's own records (a definition, a member) rebuilds the index from scratch.
    await alice.node.collections.define(space, { name: 'app.other', schema: { type: 'object' } });
    const listed = await alice.node.records.list(space, { collection: 'app.proposal.passed' });
    const linked = await alice.node.records.linked(space, proposal.key, {
      collection: 'app.proposal.passed',
    });
    assert.equal(linked.length, 0, 'linked shows a version that fails its check');
    assert.equal(listed.length, 0, 'list shows a version that fails its check');
  });

  test('a failing version laundered by the next edit, whose check reads only prev', async () => {
    const { alice, bob, space } = await proposalSpace();
    const c = await bob.node.records.put(space, 'app.counter', { n: 0 });
    await until(async () => (await alice.node.records.get(space, c.key)) !== null, 4000, 'c');
    await letGo(bob.node, space);
    const bad = await forge(bob, space, {
      author: '',
      collection: 'app.counter',
      body: { n: 100 },
      retain: true,
      version: { key: c.key, seq: 1, prev: c.version, genesis: c.version },
    });
    const last = await forge(bob, space, {
      author: '',
      collection: 'app.counter',
      body: { n: 101 },
      retain: true,
      version: { key: c.key, seq: 2, prev: bad.id, genesis: c.version },
    });
    await hold(bob.node, space);
    await until(
      async () => {
        const held = new Set((await alice.node.records.history(space, c.key)).map((r) => r.version));
        return held.has(bad.id) && held.has(last.id);
      },
      3000,
      'the forged versions at alice',
    );
    const got = await alice.node.records.get<{ n: number }>(space, c.key);
    assert.notEqual(got?.body?.n, 101, 'counter jumped 0 -> 101 by way of a failing 100');
  });
});
