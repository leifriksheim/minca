/**
 * Debug mode's probe, run as a shared worker and as a dedicated one: what a
 * worker of this origin sees of the page's storage and keys. It touches
 * nothing the app uses: it reads, and signs a throwaway byte.
 */

const KEY_DB = 'minca-app-key';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function readKeys(): Promise<Record<string, unknown>> {
  const listed = (await indexedDB.databases?.()) ?? [];
  if (!listed.some((db) => db.name === KEY_DB)) return { 'App key database': 'not listed here' };
  const open = indexedDB.open(KEY_DB);
  const db = await request(open);
  try {
    if (!db.objectStoreNames.contains('keys')) return { 'App key database': 'listed, no keys store' };
    const store = db.transaction('keys', 'readonly').objectStore('keys');
    const names = await request(store.getAllKeys());
    const first = names[0];
    if (first === undefined) return { 'App keys': 0 };
    const value: unknown = await request(store.get(first));
    const pair = typeof value === 'object' && value !== null ? value : null;
    const privateKey: unknown = pair ? Reflect.get(pair, 'privateKey') : null;
    let signs = 'not tried';
    if (privateKey instanceof CryptoKey)
      signs = await crypto.subtle
        .sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new Uint8Array([1]))
        .then(
          () => 'yes',
          (error: unknown) => `no: ${String(error)}`,
        );
    return {
      'App keys': names.length,
      'First is':
        pair === null ? typeof value : `object with ${Object.keys(pair).join(', ') || 'no own keys'}`,
      'Its private key is a CryptoKey': privateKey instanceof CryptoKey,
      'It signs': signs,
    };
  } finally {
    db.close();
  }
}

async function probe(sent: unknown): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  try {
    const listed = (await indexedDB.databases?.()) ?? [];
    result['IndexedDB databases seen'] = listed.length;
  } catch (error) {
    result['IndexedDB databases seen'] = `failed: ${String(error)}`;
  }
  try {
    Object.assign(result, await readKeys());
  } catch (error) {
    result['Reading the app key'] = `failed: ${String(error)}`;
  }
  const posted: unknown = typeof sent === 'object' && sent !== null ? Reflect.get(sent, 'key') : undefined;
  result['A CryptoKey posted here arrived as one'] = posted instanceof CryptoKey;
  return result;
}

const scope: unknown = globalThis;
const answer = (port: { postMessage(message: unknown): void }) => (event: MessageEvent) =>
  void probe(event.data).then((result) => port.postMessage(result));
if ('SharedWorkerGlobalScope' in globalThis)
  globalThis.addEventListener('connect', (event: Event) => {
    const port = event instanceof MessageEvent ? event.ports[0] : undefined;
    if (!port) return;
    port.onmessage = answer(port);
  });
else if (typeof scope === 'object' && scope !== null && 'postMessage' in scope) {
  const self = { postMessage: (message: unknown) => globalThis.postMessage(message) };
  globalThis.addEventListener('message', (event: Event) => {
    if (event instanceof MessageEvent) answer(self)(event);
  });
}
