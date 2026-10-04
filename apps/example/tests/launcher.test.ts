/**
 * The launcher: which apps a space has, in what order, as `launcher.app`
 * records. An agent proposes an app; it stands once someone who may define
 * collections has written it; taking it off keeps what it holds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeRecord, P2PNode } from '@weaveprotocol/core';
import { guide, message, proposeCollections, reaction, type Guide } from '@weaveprotocol/core/schemas';
import {
  addBuiltIn,
  addMade,
  checkLauncherApp,
  copyApp,
  launcherApp,
  moveApp,
  placeBuiltIn,
  prepareLauncher,
  removeApp,
  sortLauncher,
  type LauncherApp,
} from '../src/components/apps/launcher';
import { agentOf, setup, waitFor } from './helpers';

const trip = {
  name: 'carpool.trip',
  title: 'Trip',
  schema: { type: 'object', properties: { when: { type: 'string' } }, required: ['when'] },
} as const;

/** The space's launcher as this node sees it */
async function launcherOf(node: P2PNode, space: string) {
  const [records, collections, access] = await Promise.all([
    node.records.list<LauncherApp>(space, { collection: launcherApp.name }),
    node.collections.list(space),
    node.spaces.access(space),
  ]);
  return sortLauncher(records, collections, access);
}

const titles = (records: ReadonlyArray<NodeRecord<LauncherApp>>) =>
  records.map((record) => record.body?.builtIn ?? record.body?.title);

describe('the launcher', () => {
  test('an agent proposes an app; it stays a proposal waitFor someone who may define collections adds it', async () => {
    const { alice, bob, space } = await setup();
    await prepareLauncher(alice.node, space);
    const agent = await agentOf(alice, [space]);

    const plan = await proposeCollections(agent, space, { title: 'Carpool', collections: [trip] });
    const proposal = await agent.records.put(
      space,
      launcherApp,
      {
        title: 'Carpool',
        collections: ['carpool.trip'],
        screen: '<p>Who drives</p>',
        notify: [{ label: 'New trip', collection: 'carpool.trip' }],
      },
      { links: [{ rel: 'blueprint', to: plan.key }] },
    );
    assert.equal(proposal.recordsOnly, true, "an agent's note grants records only");
    await waitFor(async () => (await bob.node.records.get(space, proposal.key)) !== null, 'the proposal');

    // Even once its collections are there, an agent's record is only a proposal: its screen never runs.
    await alice.node.collections.define(space, trip);
    const before = await launcherOf(bob.node, space);
    assert.deepEqual(titles(before.proposed), ['Carpool']);
    assert.deepEqual(before.placed, []);

    // Bob, an editor, adds it: the record is now his, and it stands.
    await addMade(bob.node, space, before.proposed[0]!, before.placed);
    const after = await launcherOf(bob.node, space);
    assert.deepEqual(titles(after.placed), ['Carpool']);
    assert.equal(after.placed[0]?.root, bob.node.did);

    // The agent writing it again makes it a proposal again.
    await waitFor(
      async () => (await launcherOf(alice.node, space)).placed.length === 1,
      "Bob's version to reach Alice",
    );
    await agent.records.update<LauncherApp>(space, proposal.key, {
      ...after.placed[0]?.body,
      title: 'Rides',
    });
    await waitFor(
      async () => (await launcherOf(bob.node, space)).proposed.length === 1,
      "the agent's change to reach Bob",
    );
    assert.deepEqual((await launcherOf(bob.node, space)).placed, []);
  });

  test('adding applies the blueprint it points at, and a change goes into the app it updates, in its place', async () => {
    const { alice, space } = await setup();
    await placeBuiltIn(alice.node, space, 'chat', []);
    const plan = await proposeCollections(alice.node, space, { title: 'Carpool', collections: [trip] });
    const first = await alice.node.records.put(
      space,
      launcherApp,
      { title: 'Carpool', collections: ['carpool.trip'] },
      { links: [{ rel: 'blueprint', to: plan.key }] },
    );
    let launcher = await launcherOf(alice.node, space);
    // Alice wrote it, but its collections weren't there yet: a proposal waitFor added.
    assert.deepEqual(titles(launcher.proposed), ['Carpool']);
    await addMade(alice.node, space, launcher.proposed[0]!, launcher.placed);
    assert.ok((await alice.node.collections.list(space)).some((c) => c.name === 'carpool.trip'));
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), ['chat', 'Carpool']);

    await moveApp(alice.node, space, launcher.placed, first.key, 0);
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), ['Carpool', 'chat']);

    const change = await alice.node.records.put(space, launcherApp, {
      title: 'Rides',
      collections: ['carpool.trip'],
      updates: first.key,
    });
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.proposed), ['Rides'], 'a change is a proposal waitFor added');
    assert.equal(await addMade(alice.node, space, launcher.proposed[0]!, launcher.placed), first.key);
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), ['Rides', 'chat'], 'in the place of the one it changed');
    assert.equal(await alice.node.records.get(space, change.key), null, 'the proposal goes');
  });

  test('adding a built-in app defines every collection it can use at once, not when it first writes one', async () => {
    const { alice, bob, space } = await setup();
    const chat = { id: 'chat', needs: [message], uses: [reaction] };
    await addBuiltIn(alice.node, space, chat, []);
    await addBuiltIn(alice.node, space, chat, (await launcherOf(alice.node, space)).placed);
    // Bob, or an agent of his, finds them before anyone has written a reaction.
    const definedFor = async (node: P2PNode) =>
      (await node.collections.list(space)).filter((c) => c.version !== null).map((c) => c.name);
    await waitFor(
      async () => (await definedFor(bob.node)).includes(reaction.name),
      'the definitions to reach Bob',
    );
    assert.ok((await definedFor(bob.node)).includes(message.name));
    assert.deepEqual(titles((await launcherOf(alice.node, space)).placed), ['chat'], 'placed once');
  });

  test('taking an app off keeps its collections and records', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, message);
    await placeBuiltIn(alice.node, space, 'chat', []);
    const said = await alice.node.records.put(space, message.name, { text: 'Bring chalk' });
    const [chat] = (await launcherOf(alice.node, space)).placed;
    await removeApp(alice.node, space, chat!.key);

    assert.deepEqual((await launcherOf(alice.node, space)).placed, []);
    assert.ok((await alice.node.collections.list(space)).some((c) => c.name === message.name));
    assert.equal(
      (await alice.node.records.get<{ text: string }>(space, said.key))?.body?.text,
      'Bring chalk',
    );
    await waitFor(async () => (await launcherOf(bob.node, space)).placed.length === 0, 'Bob to see it gone');
  });

  test('the guide agents read is in the space, on the collections it is about', async () => {
    const { alice, space } = await setup();
    await prepareLauncher(alice.node, space);
    await prepareLauncher(alice.node, space);
    const guides = await alice.node.records.list<Guide>(space, { collection: guide.name });
    assert.equal(guides.length, 1, 'written once');
    assert.deepEqual(guides[0]?.body?.collections, ['launcher.app', 'std.blueprint']);
    assert.match(guides[0]?.body?.text ?? '', /collections_propose/);
    assert.match(guides[0]?.body?.text ?? '', /window\.weave/);
  });

  test('copying an app proposes it in another space, with its collections as a blueprint', async () => {
    const { alice, space } = await setup();
    await alice.node.collections.define(space, trip);
    const app = await alice.node.records.put(space, launcherApp, {
      title: 'Carpool',
      collections: ['carpool.trip'],
    });
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    await copyApp(alice.node, space, app, other);
    const there = await launcherOf(alice.node, other);
    assert.deepEqual(titles(there.proposed), ['Carpool']);
    await addMade(alice.node, other, there.proposed[0]!, there.placed);
    assert.ok((await alice.node.collections.list(other)).some((c) => c.name === 'carpool.trip'));
  });

  test('a made app names its collections, and notifies only about those', () => {
    const app = { title: 'Carpool', collections: ['carpool.trip'] };
    assert.equal(checkLauncherApp(app), null);
    assert.equal(checkLauncherApp({ builtIn: 'chat' }), null);
    assert.match(checkLauncherApp({ title: 'x' }) ?? '', /collections/);
    assert.match(
      checkLauncherApp({ ...app, notify: [{ label: 'Any message', collection: message.name }] }) ?? '',
      /not one of its collections/,
    );
    assert.match(checkLauncherApp({ ...app, network: ['https://api.example.com'] }) ?? '', /no screen/);
    assert.match(checkLauncherApp({ ...app, screen: 'x'.repeat(49 * 1024) }) ?? '', /at most 48 KB/);
    // Reactions are standard, so another app's records of them are the same records.
    assert.equal(checkLauncherApp({ ...app, collections: ['carpool.trip', reaction.name] }), null);
  });
});
