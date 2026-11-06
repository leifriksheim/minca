/**
 * Debug mode's probe of workers (`debugProbeWorker.ts`): a shared worker and a
 * dedicated one, each started only for the report, each asked what it sees
 * of this origin's IndexedDB and the app's key, and handed a fresh key to see
 * whether it arrives. Some browsers (WebKit) treat shared workers differently.
 */

const WAIT_MS = 4000;

type Answer = Record<string, unknown> | string;

function ask(
  port: { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null },
  key: CryptoKey | null,
): Promise<Answer> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(`no answer in ${WAIT_MS} ms`), WAIT_MS);
    port.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data: unknown = event.data;
      resolve(
        typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : String(data),
      );
    };
    try {
      port.postMessage({ key });
    } catch (error) {
      clearTimeout(timer);
      resolve(`posting failed: ${String(error)}`);
    }
  });
}

async function freshKey(): Promise<CryptoKey | null> {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    return pair.privateKey;
  } catch {
    return null;
  }
}

/** What each kind of worker saw, by heading */
export async function probeWorkers(): Promise<Record<string, Answer>> {
  const key = await freshKey();
  const found: Record<string, Answer> = {};
  try {
    const shared = new SharedWorker(new URL('./debugProbeWorker.ts', import.meta.url), {
      type: 'module',
      name: `minca-debug-probe-${Date.now()}`,
    });
    shared.port.start();
    found['Shared worker'] = await ask(shared.port, key);
  } catch (error) {
    found['Shared worker'] = `could not start: ${String(error)}`;
  }
  try {
    const dedicated = new Worker(new URL('./debugProbeWorker.ts', import.meta.url), { type: 'module' });
    found['Dedicated worker'] = await ask(dedicated, key);
    dedicated.terminate();
  } catch (error) {
    found['Dedicated worker'] = `could not start: ${String(error)}`;
  }
  return found;
}
