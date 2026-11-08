import { useState, type ReactNode } from 'react';
import {
  accountCredentialName,
  offerToSave,
  passwordStrength,
  recoveryKit,
  type MincaAuth,
} from '@minca/core/session';
import { useCopy } from '@minca/app-shared/action';
import styles from './SignIn.module.css';

/** The everyday ways into an account, as it has them here */
type Way = 'passkey' | 'password';

/**
 * Opening an account with what it has here: its passkey, its password, or
 * either. With both, they sit side by side as two tabs, the passkey first,
 * since it is the one with nothing to type. Signing in and confirming it's
 * you both ask this way, so they look the same.
 */
export function KnownWays({
  account,
  hasPasskey,
  hasPassword,
  busy,
  passkeyLabel,
  passwordLabel,
  onPasskey,
  onPassword,
}: {
  /** The account's name, which a password manager files its password under */
  account: string;
  hasPasskey: boolean;
  hasPassword: boolean;
  busy: boolean;
  passkeyLabel: string;
  passwordLabel: string;
  onPasskey: () => unknown;
  onPassword: (password: string) => unknown;
}) {
  const [way, setWay] = useState<Way>(hasPasskey ? 'passkey' : 'password');
  const [password, setPassword] = useState('');
  return (
    <div className="stack" data-gap="loose">
      {hasPasskey && hasPassword && (
        <div role="tablist" aria-label="Sign in with" className={styles.ways}>
          {(['passkey', 'password'] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={way === each}
              onClick={() => setWay(each)}
              disabled={busy}
            >
              {each === 'passkey' ? 'Passkey' : 'Password'}
            </button>
          ))}
        </div>
      )}
      {way === 'passkey' ? (
        <div className="stack">
          <div className={`lead ${styles.go}`}>
            <button onClick={() => void onPasskey()} disabled={busy} data-intent="primary">
              {busy ? 'Waiting for your passkey…' : passkeyLabel}
            </button>
          </div>
          <small className={styles.centred}>Face ID, Touch ID, Windows Hello or your password manager.</small>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (password) void onPassword(password);
          }}
          className="stack"
        >
          {/* Off-screen, not hidden: a password manager reads it to pick the entry filed under the account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={accountCredentialName(account)}
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
            disabled={busy}
          />
          <div className={`lead ${styles.go}`}>
            <button type="submit" disabled={busy || !password} data-intent="primary">
              {busy ? 'Opening…' : passwordLabel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Sets the account's password, then offers it to the browser's password manager under the account's name */
export async function setPassword(auth: MincaAuth, account: string, password: string): Promise<boolean> {
  const ok = await auth.setPassword(password);
  if (ok) {
    const filedAs = accountCredentialName(account);
    await offerToSave(filedAs, password, filedAs);
  }
  return ok;
}

/** A new password, twice; a manager fills both and offers to save it under the account's name */
export function PasswordForm({
  account,
  busy,
  label = 'Save password',
  onSave,
  children,
}: {
  account: string;
  busy: boolean;
  label?: string;
  onSave: (password: string) => unknown;
  /** Beside the save button: Cancel */
  children?: ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setMismatch(password !== again);
        if (password === again) void onSave(password);
      }}
      className="stack"
    >
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={accountCredentialName(account)}
        readOnly
        aria-label="Account"
      />
      <input
        type="password"
        name="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoFocus
        aria-label="New password"
        aria-describedby="password-strength"
      />
      <Strength password={password} />
      <input
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        placeholder="The same again"
        value={again}
        onChange={(event) => setAgain(event.target.value)}
        aria-label="Confirm password"
      />
      {mismatch && <p role="alert">Those two do not match.</p>}
      <div className="row">
        <button type="submit" disabled={busy || !password} data-intent="primary">
          {busy ? 'Saving…' : label}
        </button>
        {children}
      </div>
    </form>
  );
}

/** How strong a password is, as it is typed: a warning, never a refusal */
function Strength({ password }: { password: string }) {
  const check = passwordStrength(password);
  const filled = password ? { weak: 1, fair: 2, strong: 3 }[check.strength] : 0;
  return (
    <div className="stack">
      <meter aria-hidden min={0} max={3} low={1.5} high={2.5} optimum={3} value={filled} />
      <small
        id="password-strength"
        aria-live="polite"
        data-tone={password && check.strength === 'weak' ? 'danger' : undefined}
      >
        {check.hint || 'Any password works. Let your password manager make a strong one.'}
      </small>
    </div>
  );
}

/**
 * The recovery code, shown, to copy or download. Never a login form: saved as this site's password,
 * a manager would replace it with the everyday password later, losing the only copy.
 */
export function RecoveryCodeShown({
  code,
  name,
  did,
  children,
}: {
  code: string;
  name: string;
  did: string;
  /** Beside Copy and Download: Hide */
  children?: ReactNode;
}) {
  const { copied, copy } = useCopy();
  const download = () => {
    const kit = recoveryKit({ code, name, did });
    const url = URL.createObjectURL(new Blob([kit.text], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = kit.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <pre>{code}</pre>
      <div className="row">
        <button onClick={() => copy(code)}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={download}>Download</button>
        {children}
      </div>
    </>
  );
}
