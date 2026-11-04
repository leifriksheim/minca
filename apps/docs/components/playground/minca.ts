import { createMincaConnection, type MincaConnection } from '@minca/playground';

/** The account home people connect through: ours, unless the build names another. */
export const HOME = process.env.NEXT_PUBLIC_MINCA_HOME ?? 'https://home.minca.social/connect';

/** A comma-separated list from the build's environment */
const listed = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

// Read one by one: Next writes each NEXT_PUBLIC_ value in where it is named.
const RELAYS = listed(
  process.env.NEXT_PUBLIC_MINCA_RELAYS ?? 'wss://relay.minca.social,nostr+wss://relay.damus.io',
);
const HOSTS = listed(process.env.NEXT_PUBLIC_MINCA_HOSTS ?? 'https://host.minca.social');
const NODES = listed(process.env.NEXT_PUBLIC_MINCA_NODES);

/** The space the home makes for the playground, the first time someone connects. */
export const PLAYGROUND_SPACE = 'Playground';

/** One connection for the page, made in the browser: it keeps its grant and keys there. */
export function playgroundConnection(): MincaConnection {
  return createMincaConnection({
    home: HOME,
    request: {
      name: 'Minca playground',
      access: 'write',
      create: [{ name: PLAYGROUND_SPACE, visibility: 'private' }],
    },
    network: { relays: RELAYS, hosts: HOSTS, nodes: NODES },
  });
}
