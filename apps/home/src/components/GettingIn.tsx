import { useState } from 'react';
import { accountCredentialName, type AccountEntry } from '@minca/core/session';
import type { AccountSummary } from '@minca/core';
import { useAuth } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Info } from '@minca/app-shared/Info';
import { Choice, Problem, Step, Way } from './SignInParts';
import styles from './SignIn.module.css';

/* The screens for someone who has an account: finding it, and getting in. */

/** New here, or not */
export function Welcome() {
  const { auth, state } = useAuth();
  return (
    <Step title="Welcome to Minca" lead="One account for every Minca app.">
      <ul role="list">
        <Choice
          shape={['sparkle', 'cobalt']}
          title="Create an account"
          text="Takes a minute."
          onClick={() => auth.startCreating()}
        />
        <Choice
          shape={['key', 'coral']}
          title="I already have one"
          text="Sign in, or bring it to this device."
          onClick={() => auth.showExisting()}
        />
      </ul>
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
      <ul role="list">
        {state.podToReopen && state.folderAvailable && (
          <Choice
            shape={['stack', 'sage']}
            title={`Open “${state.podToReopen}” again`}
            text="The browser asks once more."
            onClick={() => auth.reopenPod()}
          />
        )}
        {state.folderAvailable && (
          <Choice
            shape={['stack', 'sage']}
            title="Open your pod"
            text="The folder your account is kept in."
            onClick={() => auth.choosePod()}
          />
        )}
        <Choice
          shape={['signal', 'peach']}
          title="Add this device from another"
          text="Scan a code on a device you’re signed in on."
          onClick={() => setPairHelp((was) => !was)}
        />
        {pairHelp && (
          <li>
            <ol>
              <li>On the signed-in device, open your account page.</li>
              <li>
                Choose <strong>Add your phone</strong> and show the pairing code.
              </li>
              <li>Scan it with this device’s camera and open the link.</li>
            </ol>
          </li>
        )}
        <Choice
          shape={['lock', 'lilac']}
          title="Use your recovery code"
          text="The code you kept when you made it."
          onClick={() => auth.showRestore()}
        />
      </ul>
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
      title="Welcome back"
      // With one account its name is under its face already, so the line above it doesn't say it again.
      lead={
        accounts.length === 1
          ? 'Sign in to continue.'
          : accounts.length > 0
            ? 'Choose your account.'
            : 'There are no accounts here yet.'
      }
    >
      {open && entry && (
        <article>
          <span className="row">
            <Avatar did={open.did} size={40} round />
            <strong className="truncate">{open.name}</strong>
          </span>
          <WaysIn account={open} entry={entry} />
        </article>
      )}
      {others.length > 0 && (
        <ul role="list">
          {others.map((account) => (
            <li key={account.id}>
              <button
                onClick={() => void auth.select(account.id)}
                disabled={state.busy}
                data-intent="open"
                className="row"
              >
                <Avatar did={account.did} size={32} round />
                <strong className="truncate">{account.name}</strong>
              </button>
            </li>
          ))}
        </ul>
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
              <Way onClick={() => auth.choosePod()}>
                {place.kind === 'folder' ? 'Open another folder' : 'Open a folder'}
              </Way>
              {place.kind === 'folder' && <Way onClick={() => auth.useBrowser()}>Use this browser</Way>}
            </>
          )}
        </small>
      )}
    </Step>
  );
}

/** The ways into the open account: one main button, the rest set back */
function WaysIn({ account, entry }: { account: AccountSummary; entry: AccountEntry }) {
  const { auth, state } = useAuth();
  const hasPasskey = entry.shortcuts.length > 0;
  // One way in at a time: the passkey, with the password a tap away when there is one too.
  const [byPassword, setByPassword] = useState(!hasPasskey);

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
      {byPassword ? (
        <PasswordSignIn account={account} />
      ) : (
        <button onClick={() => void auth.signInWithPasskey()} disabled={state.busy} data-intent="primary">
          {state.busy ? 'Waiting…' : 'Sign in with passkey'}
        </button>
      )}
      <div className="row">
        {hasPasskey && entry.hasPassword && (
          <Way onClick={() => setByPassword((was) => !was)}>
            {byPassword ? 'Use your passkey instead' : 'Use your password instead'}
          </Way>
        )}
        <Way onClick={() => auth.showRestore()}>
          {entry.hasPassword ? 'Forgot it? Use your recovery code' : 'Use your recovery code instead'}
        </Way>
      </div>
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

/** The everyday password, filed under the account's name so a manager fills the right one. */
function PasswordSignIn({ account }: { account: AccountSummary }) {
  const { auth, state } = useAuth();
  const [password, setPassword] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (password) void auth.signInWithPassword(password);
      }}
      className="stack"
    >
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={accountCredentialName(account.name)}
        readOnly
        className={styles.offscreen}
        tabIndex={-1}
        aria-hidden
      />
      <input
        type="password"
        name="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoFocus
        aria-label="Password"
        disabled={state.busy}
      />
      <button type="submit" disabled={state.busy} data-intent="primary">
        {state.busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/** Where accounts are read from, shown only when it is a pod — a new person should not have to think about it. */
export function PodLine() {
  const { auth, state } = useAuth();
  if (state.place?.kind !== 'folder') return null;
  return (
    <small className="row">
      Pod: {state.place.directory?.name ?? 'your folder'}
      <Way onClick={() => auth.useBrowser()}>Use this browser instead</Way>
    </small>
  );
}
