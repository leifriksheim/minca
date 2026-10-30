/**
 * The launcher: which apps a space has, in what order, as `launcher.app`
 * records. An agent proposes an app; it stands once someone who may define
 * collections has written it; taking it off keeps what it holds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';

import type { NodeRecord, P2PNode } from '@minca/core';
import {
  file,
  column,
  guide,
  message,
  notifyOn,
  proposeCollections,
  reaction,
  task,
  type Guide,
} from '@minca/core/schemas';
import {
  addMade,
  addTemplate,
  checkLauncherApp,
  copyApp,
  EXAMPLE_APP,
  firstApp,
  launcherApp,
  moveApp,
  prepareLauncher,
  removeApp,
  sortLauncher,
  type LauncherApp,
  type Template,
} from '../src/components/apps/launcher';
import { agentOf, setup, waitFor } from './helpers';

const trip = {
  name: 'carpool.trip',
  title: 'Trip',
  schema: { type: 'object', properties: { when: { type: 'string' } }, required: ['when'] },
} as const;

/** A ready-made app these tests add: a room of messages, which can be reacted to */
const CHAT: Template = {
  app: { template: 'chat', title: 'chat', description: 'Talk', collections: [message.name] },
  needs: [message],
  uses: [reaction],
};

/** The space's launcher as this node sees it, and every record behind it */
async function launcherOf(node: P2PNode, space: string) {
  const [records, collections, access] = await Promise.all([
    node.records.list<LauncherApp>(space, { collection: launcherApp.name }),
    node.collections.list(space),
    node.spaces.access(space),
  ]);
  return { ...sortLauncher(records, collections, access), records };
}

const titles = (records: ReadonlyArray<NodeRecord<LauncherApp>>) =>
  records.map((record) => record.body?.title);

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
        shows: ['carpool.trip'],
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
    assert.deepEqual(after.placed[0]?.body?.shows, ['carpool.trip'], 'where its trips open stays with it');

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
    await addTemplate(alice.node, space, CHAT, []);
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

  test('adding a ready-made app defines every collection it can use at once, not when it first writes one', async () => {
    const { alice, bob, space } = await setup();
    await addTemplate(alice.node, space, CHAT, []);
    await addTemplate(alice.node, space, CHAT, (await launcherOf(alice.node, space)).placed);
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

  test('adding a ready-made app copies it into the space once, with its collections and first records', async () => {
    const { alice, bob, space } = await setup();
    // The board as it ships, screen and all: what the browser imports with ?raw.
    const screen = await readFile(
      new URL('../src/components/apps/templates/kanban.html', import.meta.url),
      'utf8',
    );
    const kanban: Template = {
      app: {
        template: 'kanban',
        title: 'Kanban',
        description: 'Tasks on a board',
        collections: [task.name, column.name],
        screen,
      },
      needs: [task, column],
      uses: [file],
      setup: async (node, spaceId) => {
        await node.records.put(spaceId, column.name, { name: 'To do', position: 'a' });
      },
    };
    assert.equal(checkLauncherApp(kanban.app), null, 'its screen fits');

    const key = await addTemplate(alice.node, space, kanban, []);
    assert.equal(
      await addTemplate(alice.node, space, kanban, (await launcherOf(alice.node, space)).placed),
      key,
    );
    await waitFor(
      async () => (await launcherOf(bob.node, space)).placed.some((record) => record.key === key),
      'the app to stand for Bob',
    );
    const placed = (await launcherOf(bob.node, space)).placed;
    assert.equal(placed.length, 1, 'added once');
    assert.equal(placed[0]!.body?.template, 'kanban');
    assert.equal(placed[0]!.body?.screen, screen, 'an ordinary app, with the screen it shipped with');
    assert.ok((await bob.node.collections.list(space)).some((c) => c.name === file.name));
    assert.equal((await bob.node.records.list(space, { collection: column.name })).length, 1);
  });

  test('every ready-made screen fits on a launcher record', async () => {
    const folder = new URL('../src/components/apps/templates/', import.meta.url);
    const screens = (await readdir(folder)).filter((file) => file.endsWith('.html'));
    assert.ok(screens.length >= 3);
    for (const file of screens) {
      const screen = await readFile(new URL(file, folder), 'utf8');
      assert.equal(checkLauncherApp({ title: file, collections: ['std.task'], screen }), null, file);
      // Its scripts at least parse: a name declared twice stops the whole screen.
      for (const [, script] of screen.matchAll(/<script>([\s\S]*?)<\/script>/g))
        assert.doesNotThrow(() => compileFunction(script ?? '', ['ui', 'minca']), file);
    }
  });

  test('taking an app off keeps its collections and records', async () => {
    const { alice, bob, space } = await setup();
    await addTemplate(alice.node, space, CHAT, []);
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

  test('two copies of a ready-made app, added at once, both go when it is taken off', async () => {
    const { alice, bob, space } = await setup();
    await addTemplate(alice.node, space, CHAT, []);
    await waitFor(async () => (await launcherOf(bob.node, space)).placed.length === 1, 'chat to reach Bob');
    await bob.node.records.put(space, launcherApp, { ...CHAT.app, position: 'c' });
    await waitFor(
      async () =>
        (await launcherOf(alice.node, space)).records.filter((r) => r.body?.template === 'chat').length === 2,
      "Bob's chat to reach Alice",
    );
    const launcher = await launcherOf(alice.node, space);
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

  test('a space opens with the first app on its launcher, the same for everyone in it, and moving one changes it', async () => {
    const { alice, bob, space } = await setup();
    assert.equal(await firstApp(alice.node, space), undefined, 'with no apps, it opens on its apps');
    await addTemplate(alice.node, space, CHAT, []);
    assert.equal((await firstApp(alice.node, space))?.body?.template, 'chat');
    await alice.node.collections.define(space, trip);
    await alice.node.records.put(space, launcherApp, { title: 'Carpool', collections: ['carpool.trip'] });
    assert.equal(
      (await firstApp(alice.node, space))?.body?.template,
      'chat',
      'an app added later goes after it',
    );
    const carpool = (await launcherOf(alice.node, space)).placed.find((r) => r.body?.title === 'Carpool')!;
    await moveApp(alice.node, space, (await launcherOf(alice.node, space)).placed, carpool.key, 0);
    assert.equal((await firstApp(alice.node, space))?.key, carpool.key);
    await waitFor(
      async () => (await firstApp(bob.node, space))?.key === carpool.key,
      'Bob opens it into Carpool too',
    );
  });

  test('someone without define only proposes', async () => {
    const { alice, bob, space } = await setup();
    await prepareLauncher(alice.node, space);
    await alice.node.collections.define(space, trip);

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
    assert.match(guides[0]?.body?.text ?? '', /window\.minca/);
    // The guide prints this app as its example, so what it teaches is what the launcher takes.
    assert.equal(checkLauncherApp(EXAMPLE_APP), null);
  });

  test("a proposal the launcher can't take stays in sight, with why, rather than vanishing", async () => {
    const { alice, space } = await setup();
    await prepareLauncher(alice.node, space);
    await alice.node.collections.define(space, trip);
    // Notify in a shape the launcher doesn't read, as an older guide taught agents to write it.
    const broken = await alice.node.records.put(space, launcherApp.name, {
      title: 'Carpool',
      collections: ['carpool.trip'],
      notify: [{ label: 'New trip', collection: 'carpool.trip' }],
    });
    const launcher = await launcherOf(alice.node, space);
    assert.deepEqual(
      launcher.proposed.map((r) => r.key),
      [broken.key],
    );
    assert.deepEqual(launcher.placed, []);
    await assert.rejects(addMade(alice.node, space, launcher.proposed[0]!, launcher.placed), /notify\[0\]/);
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

  test('a copied app keeps its contract, so a cheat counts no more there than here', async () => {
    const { alice, space } = await setup();
    const check = [
      { that: 'prev == null ? body.n == 0.0 : body.n == prev.body.n + 1.0', else: 'Counts up by one' },
    ];
    await alice.node.collections.define(space, {
      name: 'app.counter',
      schema: { type: 'object' },
      contract: { check },
    });
    const app = await alice.node.records.put(space, launcherApp, {
      title: 'Counter',
      collections: ['app.counter'],
    });
    const { id: other } = await alice.node.spaces.create({ name: 'Other gym', visibility: 'public' });
    await copyApp(alice.node, space, app, other);
    const there = await launcherOf(alice.node, other);
    await addMade(alice.node, other, there.proposed[0]!, there.placed);
    const copied = (await alice.node.collections.list(other)).find((c) => c.name === 'app.counter');
    assert.deepEqual(copied?.contract?.check, check);
  });

  test('a made app names its collections, and notifies only about those', () => {
    const app = { title: 'Carpool', collections: ['carpool.trip'] };
    assert.equal(checkLauncherApp(app), null);
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
