/**
 * A node starts from what it holds, whatever the network is doing: Minca must
 * work without hosts. Here the account's host stops answering, and the node
 * must still start at once and list its spaces.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { NodeConfig, P2PNode } from '../src/node/types.js';
import type { StoreFactory } from '../src/node/stores.js';
import type { Version } from '../src/types.js';
import { until } from './helpers/until.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

const open: P2PNode[] = [];
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const node of open.splice(0)) await node.close();
});

const HOST = 'https://host.test';

test('a node starts at once while its account’s host does not answer', async () => {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const stores = memoryStores();
  const hub = createFakeHub({ latencyMs: 1 });
  const network = (reach: NonNullable<NodeConfig['network']>['reach']): NodeConfig['network'] => ({
    transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)],
    reach,
  });

  // While the host answers, the account takes it on, as its host.
  globalThis.fetch = async () =>
    Response.json({ minca: 'host/1', did: (await manager.fromSeed(generateSeed())).did, name: 'Test host' });
  const before = await createNode({ signer, stores, accountKey, network: network(async () => true) });
  await before.hosting.use(HOST);
  await before.close();

  // A space held here that the account's list doesn't name: made by a node without the account key.
  const keyless = await createNode({ signer, stores });
  const space = await keyless.spaces.create({ name: 'Unlisted', visibility: 'private' });
  await keyless.close();

  // The host is gone: asking it never answers.
  const started = Date.now();
  const node = await createNode({
    signer,
    stores,
    accountKey,
    network: network(() => new Promise<boolean>(() => {})),
  });
  open.push(node);
  const took = Date.now() - started;
  assert.ok(took < 1000, `started in ${took} ms, waiting on no host`);
  assert.ok(
    (await node.spaces.list()).some((each) => each.id === space.id),
    'what it holds is there at once',
  );
});

/** Stores that count the account's records of joining, and can be slow to close one space's, as a disk flushing is */
function countingStores() {
  const base = memoryStores();
  const joined = new Map<string, number>();
  let slow: string | null = null;
  const stores: StoreFactory = async (path, options) => {
    const store = await base(path, options);
    return {
      ...store,
      async putVersion(version: Version) {
        if (version.collection === 'sys.joined' && !version.deleted)
          joined.set(version.key, (joined.get(version.key) ?? 0) + 1);
        return store.putVersion(version);
      },
      async close() {
        if (slow && path.includes(slow)) await new Promise((resolve) => setTimeout(resolve, 4000));
        return store.close();
      },
    };
  };
  return { stores, joined, slowToClose: (spaceId: string | null) => (slow = spaceId) };
}

async function account() {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
  return { manager, signer, accountKey: await deriveAccountKey(seed) };
}

test('spaces the list lacks are each recorded once, however many', async () => {
  const { manager, signer, accountKey } = await account();
  const { stores, joined } = countingStores();
  const hub = createFakeHub({ latencyMs: 1 });
  globalThis.fetch = async () =>
    Response.json({ minca: 'host/1', did: (await manager.fromSeed(generateSeed())).did, name: 'Test host' });
  const network: NodeConfig['network'] = {
    transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)],
    reach: async () => true,
  };
  const before = await createNode({ signer, stores, accountKey, network });
  await before.hosting.use(HOST);
  await before.close();
  const keyless = await createNode({ signer, stores });
  for (let i = 0; i < 6; i++) await keyless.spaces.create({ name: `Unlisted ${i}`, visibility: 'private' });
  await keyless.close();
  joined.clear();

  const node = await createNode({ signer, stores, accountKey, network });
  open.push(node);
  await until(() => joined.size === 6, 5000, 'all six recorded');
  // Every write starts a run again: give any extra time to show.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual([...joined.values()], [1, 1, 1, 1, 1, 1], 'one record each, not one per run');
});

test('a space left while it is being recorded stays left', async () => {
  const { manager, signer, accountKey } = await account();
  const { stores, joined, slowToClose } = countingStores();
  const hub = createFakeHub({ latencyMs: 1 });
  globalThis.fetch = async () =>
    Response.json({ minca: 'host/1', did: (await manager.fromSeed(generateSeed())).did, name: 'Test host' });
  let hostAnswers = true;
  const network: NodeConfig['network'] = {
    transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)],
    // Gone for a while, as a host is that the invite waits on.
    reach: () => (hostAnswers ? Promise.resolve(true) : new Promise<boolean>(() => {})),
  };
  const before = await createNode({ signer, stores, accountKey, network });
  await before.hosting.use(HOST);
  await before.close();
  const keyless = await createNode({ signer, stores });
  const space = await keyless.spaces.create({ name: 'Left soon', visibility: 'private' });
  await keyless.close();
  joined.clear();

  hostAnswers = false;
  const node = await createNode({ signer, stores, accountKey, network });
  open.push(node);
  // Leaving takes a while (its store closes slowly), and the invite gives up on the host meanwhile.
  slowToClose(space.id);
  await node.spaces.leave(space.id);
  slowToClose(null);
  assert.equal(joined.size, 0, 'nothing recorded for a space left');
  assert.equal((await node.spaces.list()).length, 0);
});
