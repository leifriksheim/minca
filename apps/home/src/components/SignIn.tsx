import { MincaAuth, useMinca } from '@minca/core/react';
import { avatarElement } from '@minca/ui/avatar';
import { Loader } from '@minca/app-shared/Loader';

/** The sign-in flow, with Minca's own loader while it starts or signs out */
export function SignIn() {
  const { state } = useMinca();
  if (!state || state.stage === 'starting')
    return (
      <p style={{ padding: '24px 0' }}>
        <Loader label={state?.signingOut ? 'Signing out' : 'Looking for your accounts'} showLabel />
      </p>
    );
  return <MincaAuth avatar={avatarElement} />;
}
