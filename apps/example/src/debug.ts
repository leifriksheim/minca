/**
 * What this app tells debug mode (`?debug`) about itself: its connection to
 * the account home, and its node. Names and ids only, never a grant's keys.
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
  return {
    Connection: {
      Status: status,
      Home: home,
      Error: error ?? '(none)',
      'Acting for': grant
        ? `${grant.name} ${grant.did}, from ${grant.home}, until ${new Date(grant.expiresAt * 1000).toISOString()}`
        : '(nobody)',
      'Accounts connected here': accounts.map(
        (account) =>
          `${account.name} ${account.did}, until ${new Date(account.expiresAt * 1000).toISOString()}`,
      ),
      'Spaces on the node': spaces,
    },
  };
}
