/**
 * The launcher: which apps a space has, in what order, as `launcher.app`
 * records. An agent proposes an app; it stands once someone who may define
 * collections has written it; taking it off keeps what it holds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeRecord, P2PNode } from '@weaveprotocol/core';
import {
  guide,
  message,
  notifyOn,
  proposeCollections,
  reaction,
  type Guide,
} from '@weaveprotocol/core/schemas';
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

/** The built-in apps these tests know, and the collections each needs */
const NEEDS: Readonly<Record<string, ReadonlyArray<string>>> = { chat: [message.name], polls: [] };
const needsOf = (id: string) => NEEDS[id];

/** The space's launcher as this node sees it, and every record behind it */
async function launcherOf(node: P2PNode, space: string) {
  const [records, collections, access] = await Promise.all([
    node.records.list<LauncherApp>(space, { collection: launcherApp.name }),
    node.collections.list(space),
    node.spaces.access(space),
  ]);
  return { ...sortLauncher(records, collections, access, needsOf), records };
}

const titles = (records: ReadonlyArray<NodeRecord<LauncherApp>>) =>
  records.map((record) => record.body?.builtIn ?? record.body?.title);

describe('the launcher', () => {
  test('an agent proposes an app; it stays a proposal until someone who may define collections adds it', async () => {
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
        notify: [notifyOn('New trip', 'carpool.trip')],
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
    await alice.node.collections.define(space, message);
    await placeBuiltIn(alice.node, space, 'chat', []);
    const plan = await proposeCollections(alice.node, space, { title: 'Carpool', collections: [trip] });
    const first = await alice.node.records.put(
      space,
      launcherApp,
      { title: 'Carpool', collections: ['carpool.trip'] },
      { links: [{ rel: 'blueprint', to: plan.key }] },
    );
    let launcher = await launcherOf(alice.node, space);
    // Alice wrote it, but its collections weren't there yet: a proposal until added.
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
    assert.deepEqual(titles(launcher.proposed), ['Rides'], 'a change is a proposal until added');
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
    const before = await launcherOf(alice.node, space);
    await removeApp(alice.node, space, before.placed[0]!, before.records);

    assert.deepEqual((await launcherOf(alice.node, space)).placed, []);
    assert.ok((await alice.node.collections.list(space)).some((c) => c.name === message.name));
    assert.equal(
      (await alice.node.records.get<{ text: string }>(space, said.key))?.body?.text,
      'Bring chalk',
    );
    await waitFor(async () => (await launcherOf(bob.node, space)).placed.length === 0, 'Bob to see it gone');
  });

  test('a built-in app counts only when someone who may define put it there, and its collections are here', async () => {
    const { alice, bob, space } = await setup();
    await prepareLauncher(alice.node, space);
    const agent = await agentOf(alice, [space]);
    // An agent naming one: ignored, not proposed. So is one whose collections the space lacks.
    await agent.records.put(space, launcherApp, { builtIn: 'polls', position: 'a' });
    await alice.node.records.put(space, launcherApp, { builtIn: 'chat', position: 'b' });
    let launcher = await launcherOf(alice.node, space);
    assert.deepEqual(launcher.placed, []);
    assert.deepEqual(launcher.proposed, []);
    // Once chat's collection is here it counts; the agent's polls still don't.
    await alice.node.collections.define(space, message);
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), ['chat']);

    // Two people adding it at once: one shows, and taking it off takes both.
    await bob.node.collections.define(space, message).catch(() => {});
    await waitFor(async () => (await launcherOf(bob.node, space)).placed.length === 1, 'chat to reach Bob');
    await bob.node.records.put(space, launcherApp, { builtIn: 'chat', position: 'c' });
    await waitFor(
      async () =>
        (await launcherOf(alice.node, space)).records.filter((r) => r.body?.builtIn === 'chat').length === 2,
      "Bob's chat to reach Alice",
    );
    launcher = await launcherOf(alice.node, space);
    assert.equal(launcher.placed.length, 1);
    await removeApp(alice.node, space, launcher.placed[0]!, launcher.records);
    assert.deepEqual((await launcherOf(alice.node, space)).placed, []);
  });

  test('moving puts an app where it is shown, past apps with no position or the same one', async () => {
    const { alice, space } = await setup();
    await prepareLauncher(alice.node, space);
    await alice.node.collections.define(space, trip);
    const put = (title: string, position?: string) =>
      alice.node.records.put(space, launcherApp, {
        title,
        collections: ['carpool.trip'],
        ...(position ? { position } : {}),
      });
    await put('A', 'b');
    await put('B', 'b');
    await put('C');
    const d = await put('D', 'c');
    let launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed).sort(), ['A', 'B', 'C', 'D']);
    await moveApp(alice.node, space, launcher.placed, d.key, launcher.placed.length - 1);
    launcher = await launcherOf(alice.node, space);
    assert.equal(titles(launcher.placed).at(-1), 'D', 'last, past the one with no position');
    const order = titles(launcher.placed);
    await moveApp(alice.node, space, launcher.placed, launcher.placed[1]!.key, 0);
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), [order[1], order[0], ...order.slice(2)]);
    const positions = launcher.placed.map((r) => r.body?.position ?? '');
    assert.deepEqual([...positions].sort(), positions, 'every position sorts in the order shown');
    assert.equal(new Set(positions).size, positions.length, 'no two the same');
  });

  test('a change may update a made app, never a built-in one, and someone without define only proposes', async () => {
    const { alice, bob, space } = await setup();
    await alice.node.collections.define(space, message);
    await placeBuiltIn(alice.node, space, 'chat', []);
    await alice.node.collections.define(space, trip);
    let launcher = await launcherOf(alice.node, space);
    const chat = launcher.placed[0]!;
    const takeover = await alice.node.records.put(space, launcherApp, {
      title: 'Not chat',
      collections: ['carpool.trip'],
      updates: chat.key,
    });
    launcher = await launcherOf(alice.node, space);
    const proposal = launcher.proposed.find((r) => r.key === takeover.key)!;
    assert.equal(
      await addMade(alice.node, space, proposal, launcher.placed),
      takeover.key,
      'added as its own',
    );
    launcher = await launcherOf(alice.node, space);
    assert.deepEqual(titles(launcher.placed), ['chat', 'Not chat']);

    // Bob loses define: what he writes now stays a proposal.
    await alice.node.spaces.defineRole(space, {
      name: 'guest',
      title: 'Guest',
      grants: [{ cmd: '/record/write', pol: [['==', '.byCreator', true]] }],
    });
    await alice.node.spaces.assign(space, bob.node.did, 'guest');
    await alice.node.spaces.unassign(space, bob.node.did, 'editor');
    await waitFor(
      async () => (await bob.node.spaces.access(space)).mine.join() === 'guest',
      'Bob to be a guest',
    );
    const his = await bob.node.records.put(space, launcherApp, {
      title: 'Rides',
      collections: ['carpool.trip'],
    });
    await waitFor(async () => (await alice.node.records.get(space, his.key)) !== null, "Bob's app");
    assert.ok((await launcherOf(alice.node, space)).proposed.some((r) => r.key === his.key));
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
      checkLauncherApp({ ...app, notify: [notifyOn('Any message', message.name)] }) ?? '',
      /not one of its collections/,
    );
    assert.match(checkLauncherApp({ ...app, network: ['https://api.example.com'] }) ?? '', /no screen/);
    // The launcher's own collections: a screen writing them as someone who may define could add apps.
    for (const own of ['launcher.app', 'std.blueprint', 'std.guide', 'sys.role'])
      assert.match(checkLauncherApp({ ...app, collections: ['carpool.trip', own] }) ?? '', /space's own/);
    assert.match(checkLauncherApp({ ...app, screen: 'x'.repeat(49 * 1024) }) ?? '', /at most 48 KB/);
    // Reactions are standard, so another app's records of them are the same records.
    assert.equal(checkLauncherApp({ ...app, collections: ['carpool.trip', reaction.name] }), null);
  });
});
