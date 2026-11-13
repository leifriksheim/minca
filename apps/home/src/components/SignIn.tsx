import type { ReactNode } from 'react';
import type { AuthStage } from '@minca/auth';
import { useMinca } from '@minca/react';
import { Loader } from '@minca/app-shared/Loader';
import { shortUsername } from '@minca/app-shared/usernames';
import { Accounts, Existing, Restore, Welcome } from './GettingIn';
import { Create, PodOffer, Recovery, Unlock } from './NewAccount';
import { PairArrival } from './PairArrival';

/** Each stage of the sign-in flow, drawn; `ready` is the account itself, and `starting` the whole window's (`App`) */
const SCREENS: Partial<Record<AuthStage, () => ReactNode>> = {
  welcome: Welcome,
  existing: Existing,
  signIn: Accounts,
  restore: Restore,
  create: Create,
  recovery: Recovery,
  unlock: Unlock,
  pod: PodOffer,
  pair: PairArrival,
};

/** The sign-in flow, a screen at a time, drawn on `createMincaAuth`'s state */
export function SignIn() {
  const { state } = useMinca();
  if (!state) return null;
  // The claim runs right after the account is made: its few seconds get a screen of their own.
  if (state.stage === 'recovery' && state.username?.status === 'claiming')
    return <Claiming username={state.username.username} />;
  const Screen = SCREENS[state.stage];
  // A new screen, or another account, starts with nothing typed.
  return Screen ? <Screen key={`${state.stage} ${state.selectedId}`} /> : null;
}

function Claiming({ username }: { username: string }) {
  const shown = shortUsername(username);
  return (
    <section>
      <h1>Claiming {shown}</h1>
      <p>Making sure the name is yours, so people can find you by it.</p>
      <Loader size={22} label={`Claiming ${shown}`} />
    </section>
  );
}
