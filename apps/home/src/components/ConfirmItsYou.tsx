import { useState } from 'react';
import { useAuth } from '@minca/react';
import { palette, styles, hstack, stack } from '../styles';

/**
 * Proof that the person at this screen is the account's owner, before
 * anything that hands out the whole account: the recovery code, or the
 * account sent to a phone. Being signed in is not enough, since a sign-in can
 * be kept for days on a computer anyone may walk up to.
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
  const [answer, setAnswer] = useState('');
  const [wrong, setWrong] = useState<string | null>(null);

  const confirm = async (proof: Parameters<typeof auth.confirm>[0]) => {
    setWrong(null);
    if (await auth.confirm(proof)) return onConfirmed();
    // Said here, beside the answer, rather than at the top of the page as well.
    setWrong(auth.getState().error?.message ?? 'That did not work.');
    auth.clearError();
  };

  return (
    <div style={{ ...styles.note, ...stack(10) }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>Confirm it’s you to {why}.</p>
      {hasPasskey && !byCode && (
        <button
          onClick={() => void confirm({ passkey: true })}
          disabled={state.busy}
          data-variant="primary"
          style={{ ...styles.darkSmall, alignSelf: 'flex-start' }}
        >
          {state.busy ? 'Waiting…' : 'Use your passkey'}
        </button>
      )}
      {(hasPassword || byCode) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (answer) void confirm(byCode ? { code: answer.trim() } : { password: answer });
          }}
          style={hstack(6)}
        >
          <input
            type={byCode ? 'text' : 'password'}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={byCode ? 'Your recovery code' : 'Your password'}
            autoComplete={byCode ? 'off' : 'current-password'}
            spellCheck={false}
            aria-label={byCode ? 'Recovery code' : 'Password'}
            style={{ ...styles.input, height: 36 }}
          />
          <button
            type="submit"
            disabled={!answer || state.busy}
            data-variant={hasPasskey && !byCode ? 'quiet' : 'primary'}
            style={hasPasskey && !byCode ? styles.smallButton : styles.darkSmall}
          >
            Confirm
          </button>
        </form>
      )}
      {wrong && <p style={styles.error}>{wrong}</p>}
      <div style={hstack(12)}>
        {(hasPasskey || hasPassword) && (
          <button
            onClick={() => {
              setByCode((was) => !was);
              setAnswer('');
              setWrong(null);
            }}
            data-variant="ghost"
            style={styles.linkButton}
          >
            {byCode ? 'Use your passkey or password' : 'Use your recovery code instead'}
          </button>
        )}
        <button onClick={onCancel} data-variant="ghost" style={styles.linkButton}>
          Cancel
        </button>
      </div>
    </div>
  );
}
