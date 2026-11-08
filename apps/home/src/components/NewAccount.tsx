import { useState } from 'react';
import { adHocName, nameFromUsername } from '@minca/core/inbox';
import { useAuth } from '@minca/react';
import { Choices } from '@minca/app-shared/Choices';
import { Info } from '@minca/app-shared/Info';
import { usernameStatus } from '@minca/app-shared/UsernamePicker';
import { shortUsername, useAvailability } from '@minca/app-shared/usernames';
import { PasswordForm, RecoveryCodeShown, setPassword } from './credentials';
import { PodLine } from './GettingIn';
import { PairingLine } from './PairArrival';
import { Problem, Step, Way } from './SignInParts';

/* The screens for making an account: its name, its recovery code, how it is opened every day, and where it is kept. */

/** The account's name: a username where this home gives them out, else just what to be called */
export function Create() {
  const { auth } = useAuth();
  return auth.usernames ? <PickUsername /> : <PickName />;
}

function PickName() {
  const { auth, state } = useAuth();
  const [name, setName] = useState('');
  return (
    <Step title="Create your account" lead="What should apps call you? You can change it later.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void auth.createAccount(name.trim());
        }}
        className="stack"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="off"
          autoFocus
          disabled={state.busy}
        />
        <button type="submit" disabled={state.busy} data-intent="primary">
          {state.busy ? 'Creating…' : 'Continue'}
        </button>
      </form>
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => auth.showExisting()}>I already have an account</Way>
      </div>
      <PodLine />
    </Step>
  );
}

function PickUsername() {
  const { auth, state } = useAuth();
  const [typed, setTyped] = useState('');
  const name = typed.trim().toLowerCase();
  const availability = useAvailability(name);
  const status = usernameStatus(availability, name);
  // One its service couldn't vouch for is tried when the account is made.
  const wanted =
    availability.status === 'free' || availability.status === 'unknown' ? availability.username : null;
  return (
    <Step title="Pick a username" lead="Free, and yours. No email or phone number needed.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (wanted) void auth.createAccount(nameFromUsername(name.split('@')[0]!), { username: wanted });
        }}
        className="stack"
      >
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="yourname"
          aria-label="Username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={320}
          autoFocus
          disabled={state.busy}
        />
        <small aria-live="polite" data-tone={status.tone}>
          {status.text}
        </small>
        <button type="submit" disabled={state.busy || !wanted} data-intent="primary">
          {state.busy ? 'Creating…' : 'Continue'}
        </button>
      </form>
      <Problem error={state.error} />
      <div className="row">
        {/* No username, so nobody finds the account by one: a name to show until it is given its own. */}
        <Way onClick={() => auth.createAccount(adHocName())}>Continue without a username</Way>
        <Way onClick={() => auth.showExisting()}>I already have an account</Way>
      </div>
      <PodLine />
    </Step>
  );
}

/** How the username asked for at sign-up went, above the setup screens that follow */
function Claimed() {
  const { state } = useAuth();
  const claim = state.username;
  if (!claim || claim.status === 'claiming') return null;
  const shown = shortUsername(claim.username);
  if (claim.status === 'claimed') return <small data-tone="good">{shown} is your username.</small>;
  // The service's own words, without who refused what: the line says that already.
  const why = (claim.error ?? 'the name service said no').replace(/^.* refused \S+: /, '');
  return (
    <small data-tone="danger">
      {shown} couldn’t be yours: {why}. Pick another in any app, under Contacts.
    </small>
  );
}

/**
 * The recovery code, to keep: copied or downloaded, and kept as a note or on
 * paper, never as this site's login.
 */
export function Recovery() {
  const { auth, state } = useAuth();
  const [stored, setStored] = useState(false);
  return (
    <Step title="Your recovery code">
      <Claimed />
      <p>
        This code is your account. With it you can restore your account on any device, even if you lose
        everything else.
        <Info label="Why it matters">
          Nobody can reissue it: there is no server that knows your account. Anyone who has it can open your
          account, so keep it private. Save it as a secure note in your password manager, or print it and put
          it away — not as a login for this site, where a new password could replace it.
        </Info>
      </p>
      <RecoveryCodeShown
        code={state.freshCode ?? ''}
        name={state.session?.account.name ?? 'My account'}
        did={state.session?.did ?? ''}
      />
      <label>
        <input type="checkbox" checked={stored} onChange={(event) => setStored(event.target.checked)} />
        I’ve stored my recovery code somewhere safe.
      </label>
      <div>
        <button onClick={() => auth.codeSaved()} disabled={!stored} data-intent="primary">
          Continue
        </button>
      </div>
    </Step>
  );
}

/**
 * How this account is opened every day. Not skippable: without one, every
 * visit asks for the recovery code, and it ends up being used as a password
 * after all.
 */
export function Unlock() {
  const { auth, state } = useAuth();
  const passkeys = typeof globalThis.PublicKeyCredential !== 'undefined';
  const [choosingPassword, setChoosingPassword] = useState(!passkeys);
  const name = state.session?.account.name ?? 'My account';
  return (
    <Step
      title="How do you want to sign in?"
      lead={
        <>
          This is what you will use every day.
          <Info label="Where it works">
            A passkey signs you in on this site, in this browser. A password works wherever your account is
            kept — this browser, or your pod in any app pointed at it. On a new device, add it from this one
            or use your recovery code.
          </Info>
        </>
      }
    >
      <Claimed />
      {passkeys && (
        <Choices
          label="Sign in with"
          disabled={state.busy}
          options={[
            {
              value: 'passkey',
              shape: 'pass',
              title: 'Passkey',
              tag: 'Recommended',
              detail: 'Face ID, Touch ID, Windows Hello or your password manager. Nothing to type.',
            },
            ...(choosingPassword
              ? []
              : [
                  {
                    value: 'password',
                    shape: 'key',
                    title: 'Password',
                    detail: 'Saved in your password manager, like any other login.',
                  } as const,
                ]),
          ]}
          onPick={(way) => (way === 'passkey' ? auth.addPasskey() : setChoosingPassword(true))}
        />
      )}
      {choosingPassword && (
        <PasswordForm
          account={name}
          busy={state.busy}
          label="Use this password"
          onSave={(password) => setPassword(auth, name, password)}
        />
      )}
      {/* The code was typed into a password field: saved as this site's login, the password set now would replace it. */}
      {state.setup === 'restored' && (
        <small>
          If your browser offered to save the recovery code as a password, don’t — the password you set now
          would replace it. Keep the code where you had it.
        </small>
      )}
      {state.setup === 'paired' && (
        <>
          {state.pairingStage && <PairingLine stage={state.pairingStage} />}
          {/* The app waits in the tab it opened; the camera opened this one. */}
          <small>If an app sent you to sign in, you can go back to it now.</small>
        </>
      )}
      <Problem error={state.error} />
    </Step>
  );
}

/** Offered once, at the end of making an account in a browser that can open a folder. */
export function PodOffer() {
  const { auth, state } = useAuth();
  return (
    <Step
      title="Keep your data in a folder?"
      lead="A folder on your computer that keeps your account and spaces. Back it up, or keep it in iCloud or Dropbox."
    >
      <Choices
        label="Where to keep it"
        disabled={state.busy}
        options={[
          {
            value: 'folder',
            shape: 'stack',
            colour: 'sage',
            title: 'Choose a folder',
            detail: 'Your browser will ask to see it, then to save into it.',
          },
        ]}
        onPick={() => auth.choosePod()}
      />
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => auth.finishSetup()}>Not now — keep it in this browser</Way>
      </div>
      <small>You can move it to a pod any time from your account page.</small>
    </Step>
  );
}
