import { useState } from 'react';
import { accountCredentialName, type AccountEntry } from '@minca/core/session';
import type { AccountSummary } from '@minca/core';
import { useAuth } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Choices, MARK_SIZE, type Choice } from '@minca/app-shared/Choices';
import { Info } from '@minca/app-shared/Info';
import { KnownWays } from './credentials';
import { Problem, Step, Way } from './SignInParts';
import styles from './SignIn.module.css';

/* The screens for someone who has an account: finding it, and getting in. */

/** New here, or not */
export function Welcome() {
  const { auth, state } = useAuth();
  return (
    <Step title="Welcome to Minca" lead="One account for every Minca app.">
      <Choices
        label="Get started"
        disabled={state.busy}
        options={[
          {
            value: 'create',
            shape: 'sparkle',
            title: 'Create an account',
            detail: 'Free, and takes a minute.',
          },
          {
            value: 'existing',
            shape: 'key',
            title: 'I already have one',
            detail: 'Sign in, or bring it to this device.',
          },
        ]}
        onPick={(way) => (way === 'create' ? auth.startCreating() : auth.showExisting())}
      />
      <Problem error={state.error} />
      <PodLine />
    </Step>
  );
}

/**
 * "I already have an account", from a place that does not list it. Where the
 * data lives comes up here and only here: someone with a pod has something to
 * point at, and someone without one has other ways in. A pod opened here
 * before is first, to open again.
 */
export function Existing() {
  const { auth, state } = useAuth();
  const [pairHelp, setPairHelp] = useState(false);
  return (
    <Step title="Find your account" lead="Any of these gets you in.">
      <Choices
        label="Ways to your account"
        disabled={state.busy}
        options={[
          ...(state.podToReopen && state.folderAvailable
            ? [
                {
                  value: 'reopen',
                  shape: 'stack',
                  colour: 'sage',
                  title: `Open “${state.podToReopen}” again`,
                  detail: 'The browser asks once more.',
                } as const,
              ]
            : []),
          ...(state.folderAvailable
            ? [
                {
                  value: 'pod',
                  shape: 'stack',
                  colour: 'sage',
                  title: 'Open your pod',
                  detail: 'The folder your account is kept in.',
                } as const,
              ]
            : []),
          {
            value: 'pair',
            shape: 'signal',
            colour: 'peach',
            title: 'Add this device from another',
            detail: 'Scan a code on a device you’re signed in on.',
          },
          {
            value: 'restore',
            shape: 'lock',
            colour: 'lilac',
            title: 'Use your recovery code',
            detail: 'The code you kept when you made it.',
          },
        ]}
        onPick={(way) =>
          way === 'reopen'
            ? auth.reopenPod()
            : way === 'pod'
              ? auth.choosePod()
              : way === 'pair'
                ? setPairHelp((was) => !was)
                : auth.showRestore()
        }
      />
      {pairHelp && (
        <aside>
          <ol>
            <li>On the signed-in device, open your account page.</li>
            <li>
              Choose <strong>Add your phone</strong> and show the pairing code.
            </li>
            <li>Scan it with this device’s camera and open the link.</li>
          </ol>
        </aside>
      )}
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => (state.accounts.length > 0 ? auth.showSignIn() : auth.showWelcome())}>Back</Way>
        <Way onClick={() => auth.startCreating()}>Create a new account instead</Way>
      </div>
      <PodLine />
    </Step>
  );
}

/** The accounts kept here: the one being signed in to open, the rest to switch to */
export function Accounts() {
  const { auth, state } = useAuth();
  const { accounts, place, entry } = state;
  const open = entry ? accounts.find((account) => account.id === state.selectedId) : undefined;
  const others = accounts.filter((account) => account !== open);
  return (
    <Step
      title={open ? 'Welcome back' : 'Choose your account'}
      lead={
        open ? undefined : accounts.length > 0 ? 'The accounts kept here.' : 'There are no accounts here yet.'
      }
    >
      {open && entry && (
        <article className={styles.account}>
          <div className={`stack ${styles.who}`}>
            <Avatar did={open.did} size={64} round />
            <h2 className="truncate">{open.name}</h2>
          </div>
          <WaysIn account={open} entry={entry} />
        </article>
      )}
      {others.length > 0 && (
        <Choices
          label={open ? 'Another account here' : 'Accounts here'}
          disabled={state.busy}
          options={others.map((account) => accountChoice(account))}
          onPick={(id) => auth.select(id)}
        />
      )}
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => auth.showExisting()}>Another account</Way>
        <Way onClick={() => auth.startCreating()}>Create a new account</Way>
      </div>
      {place && (
        <small className="row">
          {place.kind === 'folder'
            ? `Accounts in the folder “${place.directory?.name ?? 'your pod'}”`
            : 'Accounts kept in this browser'}
          {state.folderAvailable && (
            <>
              <Way onClick={() => auth.choosePod()} inline>
                {place.kind === 'folder' ? 'Open another folder' : 'Open a folder'}
              </Way>
              {place.kind === 'folder' && (
                <Way onClick={() => auth.useBrowser()} inline>
                  Use this browser
                </Way>
              )}
            </>
          )}
        </small>
      )}
    </Step>
  );
}

/** An account as a choice in a list: its face, its name, and a line under it */
export function accountChoice(account: AccountSummary, detail?: string): Choice<string> {
  return {
    value: account.id,
    face: <Avatar did={account.did} size={MARK_SIZE} round />,
    title: account.name,
    ...(detail ? { detail } : {}),
  };
}

/** The ways into the open account: its passkey or password, and the recovery code when neither will do */
function WaysIn({ account, entry }: { account: AccountSummary; entry: AccountEntry }) {
  const { auth, state } = useAuth();
  const hasPasskey = entry.shortcuts.length > 0;

  if (!hasPasskey && !entry.hasPassword)
    return (
      <>
        <small>
          No passkey or password here yet. Use your recovery code once, then choose one.
          <Info label="Why it is asking for the recovery code">
            {/* An account with wraps, none usable here, has been used on another site. */}
            {entry.vault.wraps.length > 0
              ? 'This account’s passkeys belong to the sites that made them — a passkey works on one web address only. The recovery code opens it anywhere.'
              : 'The recovery code opens the account anywhere, with nothing stored. Next you set up a passkey or password so it stops asking.'}
          </Info>
        </small>
        <CodeForm account={account} />
      </>
    );

  return (
    <>
      <KnownWays
        account={account.name}
        hasPasskey={hasPasskey}
        hasPassword={entry.hasPassword}
        busy={state.busy}
        passkeyLabel="Sign in with passkey"
        passwordLabel="Sign in"
        onPasskey={() => auth.signInWithPasskey()}
        onPassword={(password) => auth.signInWithPassword(password)}
      />
      <small className={styles.centred}>
        Can’t get in?{' '}
        <Way onClick={() => auth.showRestore()} inline>
          Use your recovery code
        </Way>
      </small>
    </>
  );
}

/** The recovery code, typed in: on a new device, or when no everyday way in is to hand. */
export function Restore() {
  const { auth, state } = useAuth();
  const selected = state.accounts.find((account) => account.id === state.selectedId) ?? null;
  // From the account list it restores that account; from "I already have one", any.
  const forSelected = selected && state.entry ? selected : null;
  return (
    <Step
      title="Use your recovery code"
      lead={`${forSelected ? `For ${forSelected.name}. ` : ''}The 26-character code you kept when you made the account.`}
    >
      <CodeForm account={forSelected} />
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => (state.accounts.length > 0 ? auth.showSignIn() : auth.showExisting())}>Back</Way>
      </div>
      <small>Lost it? If you’re signed in on another device, add this one from there instead.</small>
    </Step>
  );
}

/**
 * The recovery-code form. A password form, because before passwords the
 * recovery code was this site's login and many managers hold it that way.
 * Its username is writable: a manager fills the whole credential at once,
 * and letting it overwrite the name is what makes a mismatch detectable.
 */
function CodeForm({ account }: { account: AccountSummary | null }) {
  const { auth, state } = useAuth();
  const filedAs = accountCredentialName(account?.name ?? 'My account');
  const [username, setUsername] = useState(filedAs);
  const [code, setCode] = useState('');
  const wrong = account !== null && username.trim() !== '' && username.trim() !== filedAs;
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void auth.signInWithCode(code.trim());
        }}
        className="stack"
      >
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className={styles.offscreen}
          tabIndex={-1}
          aria-hidden
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoFocus
          aria-label="Recovery code"
          disabled={state.busy}
        />
        <button type="submit" disabled={state.busy} data-intent="primary">
          {state.busy ? 'Opening…' : 'Continue'}
        </button>
      </form>
      {wrong && (
        <p role="alert">
          Your password manager filled <strong>{username.trim()}</strong>, not <strong>{account.name}</strong>
          . Pick the entry named <strong>{account.name}</strong>, or open that account instead.
        </p>
      )}
    </>
  );
}

/** Where accounts are read from, shown only when it is a pod — a new person should not have to think about it. */
export function PodLine() {
  const { auth, state } = useAuth();
  if (state.place?.kind !== 'folder') return null;
  return (
    <small className="row">
      Pod: {state.place.directory?.name ?? 'your folder'}
      <Way onClick={() => auth.useBrowser()} inline>
        Use this browser instead
      </Way>
    </small>
  );
}
