import { useState } from 'react';
import { useConnection } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Choices, MARK_SIZE } from '@minca/app-shared/Choices';
import { Loader } from '@minca/app-shared/Loader';
import { Shape } from '@minca/app-shared/shapes';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { Intro } from './Intro';
import css from './ConnectScreen.module.css';
import { useRemembered } from '../kept';

/**
 * Before the app is connected: one button that opens the account home, where
 * the person signs in or makes an account, and the accounts connected here
 * before, to go on as without asking the home again.
 */
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
      <header>
        <Wordmark />
        <button data-intent="ghost" onClick={() => setIntro(true)}>
          What’s Minca?
        </button>
      </header>

      <div aria-hidden className={css.tile} data-hue={expired ? 2 : 1}>
        <Shape kind={expired ? 'burst' : 'scallop'} colour={expired ? 'coral' : 'cobalt'} size={220} />
        <Shape kind="key" colour="ink" size={40} />
      </div>

      <section>
        <h1>{expired ? 'Connect again' : 'Sign in to Minca'}</h1>
        <p>
          {expired
            ? `This app’s access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
            : 'Your groups and people, here and on every device. One account works in every Minca app.'}
        </p>
      </section>

      {own !== null ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            // Straight from the submit, so the browser lets the window open.
            void connection.connect(own);
          }}
        >
          <label>
            Your account home’s address
            <input
              value={own}
              onChange={(event) => setOwn(event.target.value)}
              placeholder="home.example.com"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
            />
          </label>
          <small>The address of the Minca home you run yourself. This app remembers it.</small>
          <div className={`lead ${css.go}`}>
            <button data-intent="primary" type="submit" disabled={waiting || !own.trim()}>
              {state.status === 'connecting' ? 'Waiting for your account home…' : 'Continue'}
            </button>
          </div>
          <button data-intent="ghost" type="button" onClick={() => setOwn(null)}>
            Use {home} instead
          </button>
        </form>
      ) : waiting ? (
        // The work happens in the home's window now: say where, rather than grey out the button.
        <article>
          <Loader
            label={state.status === 'starting' ? 'Opening your account' : 'Waiting for your account home'}
          />
          <div className="stack" data-gap="tight">
            <strong>
              {state.status === 'starting' ? 'Opening your account…' : 'Continue in the Minca window'}
            </strong>
            <small>
              {state.status === 'starting'
                ? 'Picking up where you left off.'
                : `Sign in or make an account at ${home}, then choose what this app gets. Closing that window cancels.`}
            </small>
          </div>
        </article>
      ) : (
        <div className="stack">
          <div className={`lead ${css.go}`}>
            <button data-intent="primary" onClick={() => void connection.connect()}>
              {expired ? 'Connect again' : 'Continue with Minca'}
            </button>
          </div>
          <small className={css.centred}>
            Opens <strong>{home}</strong> in a new window. This app never sees your password.
          </small>
        </div>
      )}

      {/* Another account connected here works now, without the home. */}
      {others.length > 0 && state.status !== 'starting' && own === null && (
        <section className="stack">
          <h3>Or go on as</h3>
          <Choices
            label="Accounts connected here"
            options={others.map((other) => ({
              value: other.did,
              face: <Avatar did={other.did} size={MARK_SIZE} round />,
              title: other.name,
              detail: 'Connected here before',
            }))}
            onPick={(did) => connection.use(did)}
          />
        </section>
      )}

      {state.error && (
        <aside data-tone="danger" role="alert" className="stack">
          <p>{state.error}</p>
          {/* Still trying, but stuck: reloading is what helps, so offer it right here. */}
          {state.status === 'starting' && (
            <button data-intent="ghost" onClick={() => globalThis.location.reload()}>
              Reload
            </button>
          )}
        </aside>
      )}

      {own === null && !waiting && (
        <p className={css.centred}>
          <small>
            Run your own Minca?{' '}
            <button data-intent="inline" onClick={() => setOwn('')}>
              Use your own home
            </button>
          </small>
        </p>
      )}
    </main>
  );
}
