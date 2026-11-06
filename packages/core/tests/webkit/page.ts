/**
 * A tab of an app, in WebKit: its account's signer and its app key stay
 * here, and its node runs in the site's one shared worker (`worker.ts`).
 */
import { startNodeInWorker } from '../../src/node/worker.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { team } from '../../src/space/presets.js';
import type { P2PNode } from '../../src/node/types.js';

declare global {
  interface Window {
    tab: {
      start(seed: number[]): Promise<string>;
      createSpace(): Promise<string>;
      write(space: string, text: string): Promise<{ author: string; ms: number }>;
      texts(space: string): Promise<string[]>;
      close(): Promise<void>;
    };
  }
}

let node: P2PNode | null = null;
/** Kept as the page keeps the app's key: in IndexedDB, never extractable */
async function appKey(): Promise<CryptoKeyPair> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('test-app-key', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error('The key store would not open'));
  });
  const read = () =>
    new Promise<unknown>((resolve) => {
      const request = db.transaction('keys').objectStore('keys').get('app');
      request.onsuccess = () => resolve(request.result);
    });
  const held = await read();
  if (isKeyPair(held)) return held;
  const made = await createP256Provider().generateKeyPair();
  await new Promise<void>((resolve) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(made, 'app');
    tx.oncomplete = () => resolve();
  });
  const kept = await read();
  if (!isKeyPair(kept)) throw new Error('The key was not kept');
  return kept;
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    'publicKey' in value &&
    value.publicKey instanceof CryptoKey &&
    'privateKey' in value &&
    value.privateKey instanceof CryptoKey
  );
}

window.tab = {
  async start(seed) {
    const manager = createIdentityManager();
    const signer = createLocalRootSigner(await manager.fromSeed(new Uint8Array(seed)), manager.getProvider());
    const shared = new SharedWorker('/worker.js', { name: 'minca-node' });
    node = await startNodeInWorker(
      {
        postMessage: (message, transfer) => shared.port.postMessage(message, transfer),
        addEventListener: (type, listener) => shared.addEventListener(type, listener),
      },
      { signer, sessionKey: await appKey(), stores: { indexedDB: 'minca-app:webkit-test' } },
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
