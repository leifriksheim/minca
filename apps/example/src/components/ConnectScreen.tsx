import { useState } from 'react';
import { useConnection } from '@minca/react';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { styles, palette } from '../styles';

/** Before the app is connected: one button that opens the account home, where the person signs in */
export function ConnectScreen() {
  const { connection, state } = useConnection();
  const [own, setOwn] = useState<string | null>(null);
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(state.home).host;
  const others = state.accounts.filter((other) => other.did !== state.grant?.did);

  return (
    <div className="page">
      <div style={styles.card}>
        <div style={{ marginBottom: 40 }}>
          <Wordmark compact />
        </div>
        <h1 style={styles.title}>{expired ? 'Connect again' : 'Your spaces, in this app'}</h1>
        <p style={styles.subtitle}>
          {expired
            ? `This app's access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
            : 'Connect your Minca account. You sign in at your account home, and choose what this app may use.'}
        </p>

        {own === null ? (
          <>
            <button
              onClick={() => void connection.connect()}
              disabled={waiting}
              data-variant="primary"
              style={styles.button}
            >
              {state.status === 'starting'
                ? 'Opening your account…'
                : state.status === 'connecting'
                  ? 'Waiting for your account home…'
                  : 'Connect with Minca'}
            </button>
            <p style={{ ...styles.errorHint, marginTop: 16 }}>
              Opens <strong style={{ color: palette.ink.strong }}>{home}</strong>, where you sign in. This app
              gets a note signed by your account for its own key — never your password.
            </p>
            <div style={styles.linkRow}>
              <button
                onClick={() => setOwn('')}
                data-variant="ghost"
                style={{ ...styles.linkButton, paddingLeft: 0 }}
              >
                Use your own home
              </button>
              {/* Another account connected here works now, without the home. */}
              {state.status !== 'starting' &&
                others.map((other) => (
                  <button
                    key={other.did}
                    onClick={() => void connection.use(other.did)}
                    data-variant="ghost"
                    style={styles.linkButton}
                  >
                    Use {other.name}
                  </button>
                ))}
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // Straight from the submit, so the browser lets the window open.
              void connection.connect(own);
            }}
            style={styles.form}
          >
            <input
              value={own}
              onChange={(event) => setOwn(event.target.value)}
              placeholder="home.example.com"
              aria-label="Your account home's address"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              style={styles.input}
            />
            <button
              type="submit"
              disabled={waiting || !own.trim()}
              data-variant="primary"
              style={styles.button}
            >
              {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect'}
            </button>
            <p style={{ ...styles.errorHint, marginTop: 8 }}>
              The address of the Minca home you run yourself. This app remembers it.
            </p>
            <div style={styles.linkRow}>
              <button
                type="button"
                onClick={() => setOwn(null)}
                data-variant="ghost"
                style={{ ...styles.linkButton, paddingLeft: 0 }}
              >
                Use {home} instead
              </button>
            </div>
          </form>
        )}

        {state.error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{state.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
