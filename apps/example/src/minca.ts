// This app's Minca setup: it never holds a seed, and connects to the person's account home instead.
import { createMincaConnection } from '@minca/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@minca/app-shared/relay';

/** The account home's connect page — ours by default; anyone can run their own */
const HOME = import.meta.env.VITE_MINCA_HOME ?? 'https://weave-home.netlify.app/connect';

export const connection = createMincaConnection({
  home: HOME,
  // A browser for every space in the account, so it asks for the whole account.
  // An app that needs less asks for less: `scope: 'spaces'`, or `create` a space of its own.
  request: {
    name: 'Minca',
    access: 'write',
    scope: 'account',
    // No notifications here: connecting asks for none. The person turns them on later (notifications.ts).
  },
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // Checking, decrypting and syncing happen there, so the page never stutters. One worker for
  // every tab where there are shared workers (not Chrome on Android): the tabs share one node.
  // A worker that fails to load says so, and the node runs in the page instead.
  worker: () => {
    if (typeof SharedWorker !== 'function')
      return new Worker(new URL('./minca-worker.ts', import.meta.url), { type: 'module' });
    const shared = new SharedWorker(new URL('./minca-worker.ts', import.meta.url), {
      type: 'module',
      name: 'minca-node',
    });
    return {
      postMessage: (message: unknown, transfer: Transferable[]) => shared.port.postMessage(message, transfer),
      addEventListener: (type: 'error', listener: () => void) => shared.addEventListener(type, listener),
    };
  },
});

/** The node acting for the account, for code outside React (the WebMCP tools). Null before connecting. */
export function getNode() {
  return connection.getState().node;
}
