/**
 * What this app tells debug mode (`?debug`) about itself: its connection to
 * the account home, and its node. Never a grant's keys; the report shortens
 * the DIDs.
 */
import { connection } from './minca';

/** Says each change of the connection's status in the log, so the report shows when each came */
export function logConnection(): void {
  let said = '';
  const say = () => {
    const { status, error } = connection.getState();
    const now = `${status}${error ? `: ${error}` : ''}`;
    if (now === said) return;
    said = now;
    console.debug(`[app] connection ${now}`);
  };
  connection.subscribe(say);
  say();
}

export async function debugDetails(): Promise<Record<string, unknown>> {
  const { status, home, grant, accounts, error, node } = connection.getState();
  const spaces = node ? await node.spaces.list().then((list) => list.length, String) : '(no node)';
  const network = node?.network.status();
  const ago = (at: number | null) => (at === null ? 'never' : `${Math.round((Date.now() - at) / 1000)}s ago`);
  return {
    Connection: {
      Status: status,
      Home: home,
      Error: error ?? '(none)',
      'Acting for': grant
        ? `${grant.did}, from ${grant.home}, until ${new Date(grant.expiresAt * 1000).toISOString()}`
        : '(nobody)',
      'Accounts connected here': accounts.map(
        (account) => `${account.did}, until ${new Date(account.expiresAt * 1000).toISOString()}`,
      ),
      'Spaces on the node': spaces,
    },
    Network: network
      ? {
          Relays: network.relays.map(
            (relay) =>
              `${relay.url}: ${relay.state} since ${ago(relay.since)}, opened ${ago(relay.openedAt)}, ${relay.failures} failures`,
          ),
          'Peers connected': network.links.map((link) => `${link.peer} in ${link.rooms} rooms`),
          Connecting: network.connecting.map((pending) => `${pending.peer}, try ${pending.tries}`),
          TURN: network.turn,
        }
      : { Network: '(no node)' },
  };
}
