import type { AuthState, MincaSession, PairingStage } from '@minca/core/session';
import { useAuth } from '@minca/react';
import { Avatar } from '@minca/app-shared/Avatar';
import { Info } from '@minca/app-shared/Info';
import { Problem, Step, Way } from './SignInParts';

/* The phone's side of pairing: it arrives here from the QR code `PairPhone` shows on the computer. */

/** How a pairing is going, from the phone that is being added */
function describe(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Looking for your computer…';
    case 'confirm':
    case 'compare':
      return 'Check your computer shows the same code, and confirm there.';
    case 'sending':
      return 'The codes matched. Setting up this phone…';
    case 'joining':
      return `Adding your spaces: ${stage.joined} of ${stage.total}…`;
    case 'received':
      return stage.spaces === 1 ? 'Added 1 space.' : `Added ${stage.spaces} spaces.`;
    case 'sent':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

export function PairingLine({ stage }: { stage: PairingStage }) {
  return stage.kind === 'failed' ? <p role="alert">{stage.reason}</p> : <small>{describe(stage)}</small>;
}

/**
 * One button. The link holds only where to meet, but meeting still takes a
 * tap: a page that went looking the instant it loaded would pair from a link
 * someone had merely opened by accident. Once the computer answers, both show
 * the same code, and the account comes over only after the person confirms
 * it there.
 */
export function PairArrival() {
  const { auth, state } = useAuth();
  if (state.pairingArrival && state.session)
    return <Arrived arrival={state.pairingArrival} session={state.session} />;
  const stage = state.pairingStage;
  const code = stage?.kind === 'confirm' ? stage.code : null;
  // Before the codes match there is still something to tap, and to be warned about.
  const before = !code && stage?.kind !== 'sending';
  return (
    <Step
      title={state.session ? 'Add an account' : 'Add this phone'}
      lead="You scanned a code from your computer."
    >
      {code ? (
        <pre>{`${code.slice(0, 3)} ${code.slice(3)}`}</pre>
      ) : (
        <p>
          {state.session
            ? `This phone is signed in as ${state.session.account.name}. Pairing brings the account on the computer showing the code; you choose whether to add it once it arrives.`
            : 'This phone becomes the same account, with its own copy of your spaces.'}
          <Info label="What happens next">
            Your computer and this phone show the same six digits. When you confirm them on the computer, it
            sends the account here directly — the relay only introduces the two, and sees nothing it could
            use.
          </Info>
        </p>
      )}
      {before && state.accounts.length > 0 && (
        <p role="alert">
          Only continue if the code is on your own screen, in front of you. A link someone sent you would put
          this phone in their account instead of yours.
        </p>
      )}
      {before && state.pairing && (
        <div>
          <button onClick={() => void auth.acceptPairing()} disabled={state.busy} data-intent="primary">
            {state.busy ? 'Looking…' : 'Continue'}
          </button>
        </div>
      )}
      {stage && <PairingLine stage={stage} />}
      <Problem error={state.error} />
      <small>Keep the code showing on your computer until this finishes.</small>
      <div className="row">
        {/* Open while the codes are compared: the way out of a pairing that isn't yours */}
        <button onClick={() => auth.dismissPairing()} disabled={state.busy && !code} data-intent="ghost">
          {state.pairing ? 'Not now' : 'Back'}
        </button>
      </div>
    </Step>
  );
}

/** The account a pairing brought, to a phone signed in to another: add it, or switch to it if it is already here */
function Arrived({
  arrival,
  session,
}: {
  arrival: NonNullable<AuthState['pairingArrival']>;
  session: MincaSession;
}) {
  const { auth, state } = useAuth();
  const current = session.account.name;
  const known = arrival.account;
  return (
    <Step title={known ? `Switch to ${known.name}?` : 'Add this account?'}>
      <div className="row">
        <Avatar did={arrival.did} size={40} />
        <p>
          {known
            ? `The computer that showed the code sent ${known.name}, which is already on this phone. Switch to it? ${current} stays here, to switch back to.`
            : `The computer that showed the code sent a different account from ${current}, one this phone doesn't have. Add it only if it is yours: if you meant to add this phone to ${current}, it already is, and this account is someone else's.`}
        </p>
      </div>
      <div>
        <button onClick={() => void auth.answerPairing(true)} disabled={state.busy} data-intent="primary">
          {known ? `Switch to ${known.name}` : 'Add and switch'}
        </button>
      </div>
      <Problem error={state.error} />
      <div className="row">
        <Way onClick={() => auth.answerPairing(false)}>Stay as {current}</Way>
      </div>
    </Step>
  );
}
