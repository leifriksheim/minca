import { useEffect, useRef, useState } from 'react';
import { useMinca } from '@minca/core/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { wantedAccount } from '../minca';
import { palette, styles } from '../styles';

/**
 * Which account the app that opened this page acts for, when it is not the one
 * signed in here. Signed out, it picks that account on the sign-in screen;
 * signed in as another, it says so and offers to switch.
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

  // Signed in as someone else.
  if (session && stage === 'ready') {
    return (
      <div style={{ ...styles.panel, marginTop: 0, marginBottom: 16 }}>
        <div style={{ ...styles.panelBody, paddingTop: 14, display: 'flex', gap: 12 }}>
          <Avatar did={wantedAccount} size={32} />
          <div style={{ flex: 1 }}>
            <p style={{ ...styles.ok, color: palette.ink.strong }}>
              {wanted
                ? `The app you came from uses ${wanted.name}. You're signed in as ${session.account.name}.`
                : `The app you came from uses another account, one that isn't in this browser. You're signed in as ${session.account.name}.`}
            </p>
            <p style={styles.errorHint}>
              {wanted
                ? `What you change here is for ${session.account.name}, not the app's account.`
                : 'To manage it here, sign out and choose “Another account”: open its pod, use its recovery code, or add this browser from a device it is on.'}
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
                {wanted ? `Switch to ${wanted.name}` : 'Sign out'}
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

  // Signed out, and the app's account is not one this browser keeps.
  if (!session && !wanted && (stage === 'signIn' || stage === 'welcome')) {
    return (
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <Avatar did={wantedAccount} size={28} />
        <p style={{ ...styles.errorHint, margin: 0 }}>
          The app you came from uses an account that isn't in this browser yet. Choose{' '}
          {stage === 'welcome' ? '“I already have one”' : '“Another account”'} to bring it here.
        </p>
      </div>
    );
  }
  return null;
}
