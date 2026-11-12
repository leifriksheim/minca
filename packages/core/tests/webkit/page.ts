/**
 * A tab of an app, in WebKit: its account's signer stays here, and its node
 * runs in the site's one shared worker (`worker.ts`), signing with the app key.
 */
import { startNodeInWorker } from '../../src/node/worker.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { appKey } from '../../src/session/connect.js';
import { team } from '../../src/space/presets.js';
import type { P2PNode } from '../../src/node/types.js';

declare global {
  interface Window {
    tab: {
      start(seed: number[], signsWith?: 'app key' | 'writer key'): Promise<string>;
      createSpace(): Promise<string>;
      write(space: string, text: string): Promise<{ author: string; ms: number }>;
      texts(space: string): Promise<string[]>;
      close(): Promise<void>;
    };
  }
}

let node: P2PNode | null = null;
window.tab = {
  async start(seed, signsWith = 'app key') {
    const manager = createIdentityManager();
    const signer = createLocalRootSigner(await manager.fromSeed(new Uint8Array(seed)), manager.getProvider());
    const shared = new SharedWorker('/worker.js', { name: 'minca-node' });
    node = await startNodeInWorker(
      {
        postMessage: (message, transfer) => shared.port.postMessage(message, transfer),
        addEventListener: (type, listener) => shared.addEventListener(type, listener),
      },
      signsWith === 'app key'
        ? {
            signer,
            sessionKeySeed: (await appKey('webkit-test')).seed,
            stores: { indexedDB: 'minca-app:webkit-test' },
          }
        : // As an account home starts one: the worker claims a lasting writer key beside the stores.
          { signer, stores: { indexedDB: 'minca:webkit-test' } },
      10_000,
    );
    return node.sessionDid;
  },
  async createSpace() {
    return (await node!.spaces.create({ name: 'Groceries', ...team, visibility: 'private' })).id;
  },
  async write(space, text) {
    const t = performance.now();
    const written = await node!.records.put(space, 'app.note', { text });
    return { author: written.author, ms: Math.round(performance.now() - t) };
  },
  async texts(space) {
    const records = await node!.records.list<{ text: string }>(space, { collection: 'app.note' });
    return records.map((record) => record.body?.text ?? '').sort();
  },
  async close() {
    await node?.close();
  },
};
