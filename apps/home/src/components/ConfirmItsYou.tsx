import { useState } from 'react';
import { useAuth } from '@minca/react';
import { KnownWays } from './credentials';

/**
 * Proof that the person at this screen is the account's owner, before
 * anything that hands out the whole account: the recovery code, or the
 * account sent to a phone. Being signed in is not enough, since a sign-in can
 * be kept for days on a computer anyone may walk up to.
 *
 * It asks the way signing in does, so the two look the same.
 */
export function ConfirmItsYou({
  why,
  onConfirmed,
  onCancel,
}: {
  /** What it unlocks, as the end of "Confirm it's you to …" */
  why: string;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const { auth, state } = useAuth();
  const hasPasskey = (state.entry?.shortcuts.length ?? 0) > 0;
  const hasPassword = state.entry?.hasPassword ?? false;
  const [byCode, setByCode] = useState(!hasPasskey && !hasPassword);
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState<string | null>(null);

  const confirm = async (proof: Parameters<typeof auth.confirm>[0]) => {
    setWrong(null);
    if (await auth.confirm(proof)) return onConfirmed();
    // Said here, beside the answer, rather than at the top of the page as well.
    setWrong(auth.getState().error?.message ?? 'That did not work.');
    auth.clearError();
  };

  return (
    <aside className="stack" data-gap="loose">
      <strong>Confirm it’s you to {why}.</strong>
      {byCode ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (code) void confirm({ code: code.trim() });
          }}
          className="row"
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Your recovery code"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-label="Recovery code"
          />
          <button type="submit" disabled={!code || state.busy} data-intent="primary">
            Confirm
          </button>
        </form>
      ) : (
        <KnownWays
          account={state.session?.account.name ?? 'My account'}
          hasPasskey={hasPasskey}
          hasPassword={hasPassword}
          busy={state.busy}
          passkeyLabel="Confirm with passkey"
          passwordLabel="Confirm"
          onPasskey={() => confirm({ passkey: true })}
          onPassword={(password) => confirm({ password })}
        />
      )}
      {wrong && <p role="alert">{wrong}</p>}
      <div className="row">
        {(hasPasskey || hasPassword) && (
          <button
            onClick={() => {
              setByCode((was) => !was);
              setCode('');
              setWrong(null);
            }}
            data-intent="ghost"
          >
            {byCode ? 'Use your passkey or password' : 'Use your recovery code instead'}
          </button>
        )}
        <button onClick={onCancel} data-intent="ghost">
          Cancel
        </button>
      </div>
    </aside>
  );
}
