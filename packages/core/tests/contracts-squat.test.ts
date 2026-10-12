/** Contracts are judged by readers: a version that fails them is kept and synced, and counted on no read path (spec/09-contracts.md). */
import { test } from 'node:test';
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

test('a failing decision squats its onePer key: the real one can never be written', async () => {
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
  // As std.decision: one per proposal, only its creator edits.
  await alice.node.collections.define(space, {
    name: 'app.proposal.passed',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { onePer: ['link:about'], check: [TWO_YES] },
  });
  await hold(alice.node, space);
  await hold(bob.node, space);
  await joined(bob.node, space);
  await until(
    async () => (await bob.node.collections.list(space)).filter((c) => c.version !== null).length === 3,
    4000,
    'defs',
  );

  const proposal = await alice.node.records.put(space, 'app.proposal', { title: 'Logo' });
  const about = [{ rel: 'about', to: proposal.key }];
  await until(async () => (await bob.node.records.get(space, proposal.key)) !== null, 4000, 'p');
  const theirs = await bob.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });
  const key = (await bob.node.records.onePerKey(space, 'app.proposal.passed', {}, { links: about }))!;
  // Bob, who opposes it, signs a decision with no evidence first.
  await letGo(bob.node, space);
  await forge(bob, space, {
    author: '',
    collection: 'app.proposal.passed',
    body: { votes: [] },
    links: about,
    retain: true,
    version: { key, seq: 0 },
  });
  await hold(bob.node, space);
  await until(
    async () => (await alice.node.records.contracts(space, key))?.passes === false,
    4000,
    'squat at alice',
  );
  await until(async () => (await alice.node.records.get(space, theirs.key)) !== null, 4000, 'bob vote');
  const mine = await alice.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });

  // Alice now has two real yes votes and tries to record the decision.
  let error = '';
  try {
    await alice.node.records.put(
      space,
      'app.proposal.passed',
      { votes: [mine.version, theirs.version] },
      { links: about },
    );
  } catch (e) {
    error = String(e);
  }
  assert.equal(error, '', 'the honest decision cannot be written');
  assert.ok(await alice.node.records.get(space, key));
});
