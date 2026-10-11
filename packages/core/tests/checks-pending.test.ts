/** Checks are read by the library: a version that fails them is kept and synced, and counted on no read path (packages/core/docs/checks.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { team } from '../src/space/presets.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { forge, person, settle } from './helpers/person.js';
import { onePerKey } from '../src/records/rules.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';

const TWO_YES = {
  that: 'versions(body.votes).filter(it, it.collection == "app.proposal.vote" && it.link("about") == link("about") && it.body.choice == "yes").map(it, it.author).distinct().size() >= 2',
  else: 'A proposal passes with yes votes from at least two members',
};

test('a pending decision becomes visible in list once its cited vote arrives', async () => {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await alice.node.collections.define(space, { name: 'app.proposal', schema: { type: 'object' } });
  await alice.node.collections.define(space, {
    name: 'app.proposal.vote',
    schema: { type: 'object' },
    links: { about: { to: ['app.proposal'], cardinality: 'one' } },
    rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
  });
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
  const mine = await alice.node.records.put(space, 'app.proposal.vote', { choice: 'yes' }, { links: about });
  await until(async () => (await bob.node.records.get(space, mine.key)) !== null, 4000, 'vote to bob');
  const bobRoot = (await bob.node.records.put(space, 'app.proposal', { title: 'mine' })).root!;
  const voteKey = (await onePerKey('app.proposal.vote', ['@author', 'link:about'], {
    root: bobRoot,
    links: about,
    body: { choice: 'yes' },
  }))!;
  const passedKey = (await onePerKey('app.proposal.passed', ['link:about'], {
    root: '',
    links: about,
    body: {},
  }))!;

  await letGo(bob.node, space);
  const vote = await forge(
    bob,
    space,
    {
      author: '',
      collection: 'app.proposal.vote',
      body: { choice: 'yes' },
      links: about,
      retain: true,
      version: { key: voteKey, seq: 0 },
    },
    { keep: false },
  );
  await forge(bob, space, {
    author: '',
    collection: 'app.proposal.passed',
    body: { votes: [mine.version, vote.id] },
    links: about,
    retain: true,
    version: { key: passedKey, seq: 0 },
    log: { n: 0 },
  });
  await hold(bob.node, space);
  await until(
    async () => (await alice.node.records.checks(space, passedKey))?.pending === true,
    4000,
    'pending at alice',
  );
  assert.equal((await alice.node.records.list(space, { collection: 'app.proposal.passed' })).length, 0);

  await letGo(bob.node, space);
  await createStorageProvider(await bob.stores(`spaces/${space}`)).addVersion(vote);
  await hold(bob.node, space);
  await until(async () => (await alice.node.records.get(space, voteKey)) !== null, 4000, 'vote at alice');
  await settle(300);
  const listed = await alice.node.records.list(space, { collection: 'app.proposal.passed' });
  assert.ok(await alice.node.records.get(space, passedKey), 'get shows it');
  assert.equal(listed.length, 1, 'list still hides the decision after its vote arrived');
});
