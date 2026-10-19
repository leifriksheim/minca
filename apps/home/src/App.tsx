import type { ReactNode } from 'react';
import { MincaAuth, useMinca } from '@minca/core/react';
import { AccountHint } from './components/AccountHint';
import { AccountNotices } from './components/AccountNotices';
import { Settings } from './components/Settings';
import { HostingDue } from './components/Hosting';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { palette, styles } from './styles';

/** The account home: sign in, then the account and everything about it. */
export function App() {
  const { state } = useMinca();

  if (state?.stage !== 'ready') {
    return (
      <Page>
        <Wordmark />
        <AccountHint />
        <MincaAuth />
      </Page>
    );
  }

  return (
    <Page wide>
      <header style={{ ...styles.headerRow, marginBottom: 32 }}>
        <Wordmark compact />
        <span style={{ fontSize: 13, color: palette.ink.muted }}>Your account home</span>
      </header>
      <AccountHint />
      <AccountNotices />
      <HostingDue />
      <Settings />
    </Page>
  );
}

function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="page">
      <div style={wide ? styles.app : styles.card}>{children}</div>
    </div>
  );
}
