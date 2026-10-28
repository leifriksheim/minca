import { useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useConnection } from '@minca/react';
import type { ConnectedAccount } from '@minca/core/session';

/**
 * Which account a tab acts for is in its address, `?as=` and the end of the
 * account's DID: short, and enough to tell apart the few accounts one browser
 * connects. So a refresh, a bookmark or another tab keeps its account.
 */
export const shortAccount = (did: string): string => did.slice(-8);

/** The connected account the address names, or null when it names none, or more than one */
function accountNamed(accounts: ReadonlyArray<ConnectedAccount>, short: string): string | null {
  const found = accounts.filter((account) => account.did.endsWith(short));
  return found.length === 1 && found[0] ? found[0].did : null;
}

/** The account the address this page opened at names, to act for from the start */
export function accountFromAddress(accounts: ReadonlyArray<ConnectedAccount>): string | null {
  const short = new URLSearchParams(globalThis.location?.search ?? '').get('as');
  return short ? accountNamed(accounts, short) : null;
}

/**
 * Keeps the address and the account acted for in step. The address moving
 * (a link, back, the account menu) switches the account; the account moving
 * on its own (one added, or one the home disconnected) moves the address, to
 * your spaces, since the space open may not be the other account's.
 */
export function useAccountInAddress(): void {
  const { connection, state } = useConnection();
  const { as } = useSearch({ strict: false });
  const navigate = useNavigate();
  const did = state.grant?.did;
  const seen = useRef<{ did?: string | undefined; as?: string | undefined }>({});

  useEffect(() => {
    const before = seen.current;
    seen.current = { did, as };
    if (!did) return;
    const named = as ? accountNamed(state.accounts, as) : null;
    if (before.did === did && before.as !== as && named && named !== did) {
      void connection.use(named);
      return;
    }
    if (as === shortAccount(did)) return;
    // Where the address names no account here (or none yet), it names this one, in place.
    void navigate(
      before.did === did || before.did === undefined
        ? { to: '.', search: (was) => ({ ...was, as: shortAccount(did) }), hash: true, replace: true }
        : { to: '/', search: { as: shortAccount(did) } },
    );
  }, [connection, state.accounts, navigate, did, as]);
}
