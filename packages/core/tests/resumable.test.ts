/**
 * A node that lets go and comes back as one object: what a tab put away does
 * with a node of its own, so a browser that freezes it never freezes one
 * holding the stores another tab's node waits on.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { resumableNode, type ResumableNode } from '../src/node/resumable.js';
import type { NodeEvent, P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { memoryStores } from './helpers/memory-stores.js';
import { until } from './helpers/until.js';
import { team } from '../src/space/presets.js';

const open: ResumableNode[] = [];
afterEach(async () => {
  for (const each of open.splice(0)) await each.node.close();
});

/** A resumable node on one set of stores, and how many nodes it has started under it */
async function resumable() {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const stores = memoryStores();
  let started = 0;
  const made = await resumableNode(async () => {
    started++;
    const node = await createNode({ signer, stores, accountKey, watchIntervalMs: 0 });
    return { node, end: () => void node.close() };
  });
  open.push(made);
  return { made, started: () => started };
}

const names = async (node: P2PNode) => (await node.spaces.list()).map((space) => space.name);

describe('a node that lets go and comes back', () => {
  test('a call while paused waits, and is answered by the next node', async () => {
    const { made, started } = await resumable();
    await made.node.spaces.create({ name: 'Diary', visibility: 'private' });
    made.pause();
    assert.equal(made.running, false);
    let answered: string[] | null = null;
    const asked = names(made.node).then((list) => (answered = list));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answered, null, 'nothing answers while paused');
    await made.resume();
    assert.deepEqual(await asked, ['Diary'], 'the next node, on the same stores, answers');
    assert.equal(started(), 2);
  });

  test('the same object throughout: listeners, watches and holds carry over', async () => {
    const { made } = await resumable();
    const node = made.node;
    const space = await node.spaces.create({ name: 'Notes', ...team, visibility: 'private' });
    const events: NodeEvent[] = [];
    node.subscribe((event) => events.push(event));
    const seen: number[] = [];
    node.records.watch(space.id, { collection: 'app.todo.item' }, (result) =>
      seen.push(result.records.length),
    );
    const release = await node.spaces.hold(space.id);

    made.pause();
    await made.resume();
    await node.records.put(space.id, 'app.todo.item', { text: 'after coming back', done: false });
    await until(async () => seen.at(-1) === 1, 3000, 'the watch to see the record');
    assert.ok(events.length > 0, 'events from the new node reach the old listener');
    await release();
  });

  test('pausing again while it starts ends what it started', async () => {
    const { made, started } = await resumable();
    made.pause();
    const resuming = made.resume();
    made.pause();
    await resuming;
    assert.equal(made.running, false, 'put away again: not running');
    await made.resume();
    assert.equal(made.running, true);
    assert.equal(started(), 3);
  });

  test('a write running when it is put away finishes, and says so: never "failed" when it was stored', async () => {
    const { made } = await resumable();
    const space = await made.node.spaces.create({ name: 'Pay', ...team, visibility: 'private' });
    for (const ms of [0, 1, 2, 5]) {
      const writing = made.node.records.put(space.id, 'app.todo.item', {
        text: `after ${ms} ms`,
        done: false,
      });
      await new Promise((resolve) => setTimeout(resolve, ms));
      made.pause();
      const record = await writing;
      await made.resume();
      assert.ok(await made.node.records.get(space.id, record.key), 'what it said it stored is there');
    }
  });

  test('closed while put away, the calls waiting for a node fail', async () => {
    const { made } = await resumable();
    made.pause();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = made.node.spaces.list();
    await made.node.close();
    await assert.rejects(waiting, /closed/);
  });

  test('closed, calls fail rather than wait', async () => {
    const { made } = await resumable();
    made.pause();
    await made.node.close();
    await assert.rejects(made.node.spaces.list(), /closed/);
  });
});
