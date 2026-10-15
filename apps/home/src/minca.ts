/**
 * This home's Minca setup: the sign-in flow for the account it holds.
 *
 * The home is the one place the seed is ever unlocked. Apps open it to ask for
 * access (`/connect`), and link to it for account settings (`/`).
 */
import { createMincaAuth } from '@minca/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@minca/app-shared/relay';

export const auth = createMincaAuth({
  // The name a passkey prompt shows; the passkey itself is tied to this site, not to it.
  appName: 'Minca',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // `/connect` closes once the app has its answer, and a pod is only kept up to
  // date while the home is open, so a pod is offered on the account page instead.
  offerPod: globalThis.location.pathname.replace(/\/+$/, '') !== '/connect',
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
