import { useState } from 'react';
import { useConnection } from '@minca/react';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { Intro } from './Intro';
import css from './ConnectScreen.module.css';
import { useRemembered } from '../kept';

/** Before the app is connected: one button that opens the account home, where the person signs in */
export function ConnectScreen() {
  const { connection, state } = useConnection();
  const [own, setOwn] = useState<string | null>(null);
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(state.home).host;
  const others = state.accounts.filter((other) => other.did !== state.grant?.did);
  // The intro shows once on this device, before the first connect; skipping it counts.
  const [introSeen, setIntroSeen] = useRemembered('minca:intro');
  const [intro, setIntro] = useState(introSeen === null && !state.grant && state.accounts.length === 0);
  if (intro)
    return (
      <Intro
        onDone={() => {
          setIntroSeen('seen');
          setIntro(false);
        }}
      />
    );

  return (
    <main className={css.screen}>
      <Wordmark compact />
      <section>
        <h1>{expired ? 'Connect again' : 'Your spaces, in this app'}</h1>
        <p>
          {expired
            ? `This app's access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
            : 'Sign in with your Minca account to see your groups and people here.'}
        </p>
      </section>

      {own === null ? (
        <section>
          <p>
            <button data-intent="primary" onClick={() => void connection.connect()} disabled={waiting}>
              {state.status === 'starting'
                ? 'Opening your account…'
                : state.status === 'connecting'
                  ? 'Waiting for your account home…'
                  : 'Connect with Minca'}
            </button>
          </p>
          <small>
            Opens <strong>{home}</strong>. This app never sees your password.
          </small>
          <div className="row" data-gap="tight">
            <button data-intent="ghost" onClick={() => setOwn('')}>
              Use your own home
            </button>
            <button data-intent="ghost" onClick={() => setIntro(true)}>
              What’s Minca?
            </button>
            {/* Another account connected here works now, without the home. */}
            {state.status !== 'starting' &&
              others.map((other) => (
                <button data-intent="ghost" key={other.did} onClick={() => void connection.use(other.did)}>
                  Use {other.name}
                </button>
              ))}
          </div>
        </section>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            // Straight from the submit, so the browser lets the window open.
            void connection.connect(own);
          }}
        >
          <input
            value={own}
            onChange={(event) => setOwn(event.target.value)}
            placeholder="home.example.com"
            aria-label="Your account home's address"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
          />
          <button data-intent="primary" type="submit" disabled={waiting || !own.trim()}>
            {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect'}
          </button>
          <small>The address of the Minca home you run yourself. This app remembers it.</small>
          <div className="row">
            <button data-intent="ghost" type="button" onClick={() => setOwn(null)}>
              Use {home} instead
            </button>
          </div>
        </form>
      )}

      {state.error && (
        <aside data-tone="danger" role="alert">
          {state.error}
        </aside>
      )}
    </main>
  );
}
