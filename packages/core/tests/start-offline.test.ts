/**
 * A node starts from what it holds, whatever the network is doing: Minca must
 * work without hosts. Here the account's host stops answering, and the node
 * must still start at once and list its spaces.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import type { NodeConfig, P2PNode } from '../src/node/types.js';
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
