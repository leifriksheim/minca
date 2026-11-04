import { useEffect, useRef, useState } from 'react';
import { useMinca } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { wantedAccount } from '../minca';

/**
 * Which account the app that opened this page acts for, when it is not the one
 * signed in here. Signed out, it picks that account on the sign-in screen;
 * signed in as another, it says so and offers to switch. An account this
 * browser doesn't keep is only mentioned, never offered.
 *
 * The hint comes from whatever page opened this one, so it never signs out or
 * switches by itself, and the account is shown by its avatar (drawn from the
 * DID), not a name the link could have made up.
 */
export function AccountHint() {
  const { auth, state } = useMinca();
  const [dismissed, setDismissed] = useState(false);
  // Picked once on the sign-in screen, and again after "Switch": after that, the person's choice stands.
  const picking = useRef(true);
  const wanted = state?.accounts.find((account) => account.did === wantedAccount) ?? null;

  useEffect(() => {
    if (!auth || !state || !wanted || !picking.current || state.stage !== 'signIn') return;
    picking.current = false;
    if (state.selectedId !== wanted.id) void auth.select(wanted.id);
  }, [auth, state, wanted]);

  if (!auth || !state || !wantedAccount || dismissed) return null;
  const { session, stage } = state;
  if (session?.did === wantedAccount) return null;

  // Not an account this browser keeps. Any page can name any account, and one
  // that isn't yours is how a stranger's pairing link would be sold, so this
  // says what happened and points nowhere.
  if (!wanted) {
    if (session ? stage !== 'ready' : stage !== 'signIn' && stage !== 'welcome') return null;
    return (
      <aside className="row">
        <Avatar did={wantedAccount} size={28} />
        <p>
          <small>
            The app you came from uses an account that isn't in this browser. If you don't recognise it,
            ignore this.
          </small>
        </p>
        <button onClick={() => setDismissed(true)}>OK</button>
      </aside>
    );
  }

  // Signed in as someone else.
  if (session && stage === 'ready') {
    return (
      <article className="row" data-gap="loose">
        <Avatar did={wantedAccount} size={32} />
        <div className="stack">
          <strong>
            The app you came from uses {wanted.name}. You're signed in as {session.account.name}.
          </strong>
          <small>What you change here is for {session.account.name}, not the app's account.</small>
          <div className="row">
            <button
              onClick={() => {
                picking.current = true;
                void auth.signOut();
              }}
              disabled={state.busy}
            >
              Switch to {wanted.name}
            </button>
            <button onClick={() => setDismissed(true)}>Stay as {session.account.name}</button>
          </div>
        </div>
      </article>
    );
  }
  return null;
}
