/**
 * A node closed while it records an unlisted space in the background, its
 * invite still waiting on the hosts, signs nothing after: it has let go of its
 * lasting key's slot, which another node may hold now, and a key in two places
 * at once forks its line (spec 02 §4.10).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/node.js';
import type { NodeConfig } from '../src/node/types.js';
import type { StoreFactory } from '../src/node/stores.js';
import type { WriterKeySource, HeadStore } from '../src/node/writer-keys.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a closed node signs nothing with a key it has let go of', async () => {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const signer = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const base = memoryStores();
  const events: string[] = [];
  let released = false;
  const stores: StoreFactory = async (path, options) => {
    const store = await base(path, options);
    return {
      ...store,
      async putVersion(v) {
        if (v.collection === 'sys.joined') events.push(`sys.joined stored, released=${released}`);
        return store.putVersion(v);
      },
    };
  };
  const keys = await createP256Provider().generateKeyPair();
  const headMap = new Map<string, Uint8Array>();
  const heads: HeadStore = {
    async get(k) {
      return headMap.get(k) ?? null;
    },
    async put(k, v) {
      if (released) events.push(`head put after release: ${k}`);
      headMap.set(k, v);
    },
  };
  const writerKey: WriterKeySource = {
    async claim() {
      released = false;
      return {
        keys,
        heads,
        async release() {
          released = true;
        },
        async forget() {},
      };
    },
  };

  const hub = createFakeHub({ latencyMs: 1 });
  const hostDid = (await manager.fromSeed(generateSeed())).did;
  let slow = false;
  globalThis.fetch = async () => {
    if (slow) await new Promise((r) => setTimeout(r, 1500));
    return Response.json({ minca: 'host/1', did: hostDid, name: 'Test host' });
  };
  const network: NodeConfig['network'] = {
    transports: (s, d) => [hub.transport(d, s)],
    reach: async () => true,
  };
  const before = await createNode({ signer, stores, accountKey, network });
  await before.hosting.use('https://host.test');
  await before.close();
  const keyless = await createNode({ signer, stores });
  await keyless.spaces.create({ name: 'Unlisted', visibility: 'private' });
  await keyless.close();
  events.length = 0;

  slow = true; // the host answers slowly: the invite waits on it
  const node = await createNode({ signer, stores, accountKey, network, writerKey });
  events.push('started');
  await new Promise((r) => setTimeout(r, 300));
  await node.close();
  events.push('closed and released');
  await new Promise((r) => setTimeout(r, 4500));
  const after = events.slice(events.indexOf('closed and released') + 1);
  assert.deepEqual(after, [], 'nothing signed or stored after the key was released');
});
