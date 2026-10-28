import { useEffect, useRef, useState } from 'react';
import { useMinca } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { wantedAccount } from '../minca';
import { palette, styles } from '../styles';

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
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <Avatar did={wantedAccount} size={28} />
        <p style={{ ...styles.errorHint, margin: 0, flex: 1 }}>
          The app you came from uses an account that isn't in this browser. If you don't recognise it, ignore
          this.
        </p>
        <button onClick={() => setDismissed(true)} data-variant="quiet" style={styles.smallButton}>
          OK
        </button>
      </div>
    );
  }

  // Signed in as someone else.
  if (session && stage === 'ready') {
    return (
      <div style={{ ...styles.panel, marginTop: 0, marginBottom: 16 }}>
        <div style={{ ...styles.panelBody, paddingTop: 14, display: 'flex', gap: 12 }}>
          <Avatar did={wantedAccount} size={32} />
          <div style={{ flex: 1 }}>
            <p style={{ ...styles.ok, color: palette.ink.strong }}>
              The app you came from uses {wanted.name}. You're signed in as {session.account.name}.
            </p>
            <p style={styles.errorHint}>
              What you change here is for {session.account.name}, not the app's account.
            </p>
            <div style={{ ...styles.linkRow, gap: 8 }}>
              <button
                onClick={() => {
                  picking.current = true;
                  void auth.signOut();
                }}
                disabled={state.busy}
                data-variant="quiet"
                style={styles.smallButton}
              >
                Switch to {wanted.name}
              </button>
              <button onClick={() => setDismissed(true)} data-variant="quiet" style={styles.smallButton}>
                Stay as {session.account.name}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
