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

/** How long the node takes to answer `ask`, or that it didn't within 8 s */
async function timed(ask: () => Promise<unknown>): Promise<string> {
  const started = performance.now();
  const ms = () => `${Math.round(performance.now() - started)} ms`;
  return Promise.race([
    ask().then(
      (answer) => `${Array.isArray(answer) ? `${answer.length} ` : ''}in ${ms()}`,
      (error: unknown) => `failed in ${ms()}: ${String(error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('no answer in 8 s'), 8000)),
  ]);
}

export async function debugDetails(): Promise<Record<string, unknown>> {
  const { status, home, grant, accounts, error, node } = connection.getState();
  const answers = node
    ? await Promise.all([
        timed(() => node.spaces.get('none')),
        timed(() => node.spaces.list()),
        timed(() => node.contacts.list()),
      ])
    : null;
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
    },
    'Node answers': answers
      ? { 'One space by id': answers[0], 'Spaces listed': answers[1], 'Contacts listed': answers[2] }
      : { Node: '(no node)' },
  };
}
