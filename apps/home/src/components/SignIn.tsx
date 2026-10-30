import { MincaAuth, useMinca } from '@minca/react';
import { avatarElement } from '@minca/ui/avatar';
import { Loader } from '@minca/app-shared/Loader';
import { styles } from '../styles';

/** The sign-in flow, with Minca's own loader while it starts or signs out, or claims a new account's username */
export function SignIn() {
  const { auth, state } = useMinca();
  if (!state || state.stage === 'starting')
    return (
      <p style={{ padding: '24px 0' }}>
        <Loader label={state?.signingOut ? 'Signing out' : 'Looking for your accounts'} showLabel />
      </p>
    );
  // The claim runs right after the account is made: its few seconds get a screen of their own.
  if (state.stage === 'recovery' && state.username?.status === 'claiming')
    return <Claiming username={state.username.username} domain={auth?.usernames ?? null} />;
  return <MincaAuth avatar={avatarElement} />;
}

function Claiming({ username, domain }: { username: string; domain: string | null }) {
  const shown = domain && username.endsWith(`@${domain}`) ? username.slice(0, -domain.length - 1) : username;
  return (
    <div>
      <h1 style={styles.title}>Claiming {shown}</h1>
      <p style={styles.subtitle}>Making sure the name is yours, so people can find you by it.</p>
      <Loader size={22} label={`Claiming ${shown}`} />
    </div>
  );
}
