/**
 * In the desktop app (apps/desktop), the menu bar keeps this app's account's
 * spaces online, and only that account's: so it is told which account this
 * app is connected as, whenever that changes. Anywhere else there is no one
 * to tell, and this does nothing.
 */
import type { MincaConnection } from '@minca/core/session';

interface Desktop {
  account(who: { readonly did: string; readonly name: string } | null): void;
}

function isDesktop(value: unknown): value is Desktop {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'account') === 'function';
}

export function tellDesktop(connection: MincaConnection): void {
  const desktop: unknown = Reflect.get(globalThis, 'mincaDesktop');
  if (!isDesktop(desktop)) return;
  let told: string | null | undefined;
  const tell = () => {
    const { status, grant } = connection.getState();
    // Starting says nothing yet: the grant kept from before may still be loading.
    if (status === 'starting' || status === 'connecting') return;
    const who = status === 'ready' && grant ? { did: grant.did, name: grant.name } : null;
    if ((who?.did ?? null) === told) return;
    told = who?.did ?? null;
    desktop.account(who);
  };
  connection.subscribe(tell);
  tell();
}
