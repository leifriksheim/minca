/**
 * This home's Minca setup: the sign-in flow for the account it holds.
 *
 * The home is the one place the seed is ever unlocked. Apps open it to ask for
 * access (`/connect`), and link to it for account settings (`/`).
 */
import {
  clearAccountHint,
  clearPairingTicket,
  connectCodeIn,
  createMincaAuth,
  readAccountHint,
} from '@minca/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@minca/app-shared/relay';

/** Whether this is the page apps open to ask for access, which closes once they have their answer */
export const isConnectPage = (globalThis.location.pathname.replace(/\/+$/, '') || '/') === '/connect';

/** The account the app that opened this page acts for (`#account=`), if it said. Only a hint: any page can say any. */
export const wantedAccount = isConnectPage ? null : readAccountHint();
/** The code a program opened the connect page at (`#mc_…`), read before the hash is cleared */
export const connectCode = isConnectPage ? connectCodeIn(globalThis.location.hash) : null;
clearAccountHint();
// An app opens the connect page; a pairing link there is someone else's doing. This also
// keeps the connect code out of the address bar, history and anything shared from it.
if (isConnectPage) clearPairingTicket();

export const auth = createMincaAuth({
  // The name a passkey prompt shows; the passkey itself is tied to this site, not to it.
  appName: 'Minca',
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
  // A new account picks its username as it is made.
  usernames: import.meta.env.VITE_NAMES_DOMAIN || 'minca.social',
  // A pod is only kept up to date while the home is open, so it is offered on
  // the account page, not on one that closes.
  offerPod: !isConnectPage,
  // Checking, decrypting and syncing happen there, so the page never stutters; the seed stays here.
  // One worker for every tab, where shared workers work: not Chrome on Android, nor WebKit
  // (Safari, every browser on an iPhone), which drops a message to one that holds a CryptoKey.
  worker: () =>
    typeof SharedWorker === 'function' && navigator.vendor !== 'Apple Computer, Inc.'
      ? new SharedWorker(new URL('./minca-worker.ts', import.meta.url), {
          type: 'module',
          name: 'minca-node',
        }).port
      : new Worker(new URL('./minca-worker.ts', import.meta.url), { type: 'module' }),
});
