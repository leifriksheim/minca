/**
 * This home's Minca setup: the sign-in flow for the account it holds.
 *
 * The home is the one place the seed is ever unlocked. Apps open it to ask for
 * access (`/connect`), and link to it for account settings (`/`).
 */
import { createMincaAuth } from '@minca/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@minca/app-shared/relay';

/** Whether this is the page apps open to ask for access, which closes once they have their answer */
export const isConnectPage = (globalThis.location.pathname.replace(/\/+$/, '') || '/') === '/connect';

export const auth = createMincaAuth({
  // The name a passkey prompt shows; the passkey itself is tied to this site, not to it.
  appName: 'Minca',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // A pod is only kept up to date while the home is open, so it is offered on
  // the account page, not on one that closes.
  offerPod: !isConnectPage,
  // Checking, decrypting and syncing happen there, so the page never stutters; the seed stays here.
  // One worker for every tab, where there are shared workers (not Chrome on Android).
  worker: () =>
    typeof SharedWorker === 'function'
      ? new SharedWorker(new URL('./minca-worker.ts', import.meta.url), {
          type: 'module',
          name: 'minca-node',
        }).port
      : new Worker(new URL('./minca-worker.ts', import.meta.url), { type: 'module' }),
});
