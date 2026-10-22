// Liquid's Minca setup: it never holds a seed, and connects to the person's account home instead.
import { createMincaConnection } from '@minca/core/session';
import { CONFIGURED_HOSTS, CONFIGURED_NODES, relayUrls } from '@minca/app-shared/relay';

/** The account home's connect page — ours by default; anyone can run their own */
const HOME = import.meta.env.VITE_MINCA_HOME ?? 'https://home.minca.social/connect';

// Only the spaces the person chooses to run an assembly in, not the whole account.
export const connection = createMincaConnection({
  home: HOME,
  request: { name: 'Liquid', access: 'write', scope: 'spaces' },
  network: { relays: relayUrls(), nodes: CONFIGURED_NODES, hosts: CONFIGURED_HOSTS },
});
