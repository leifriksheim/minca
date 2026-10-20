import { MincaAuth, useMinca } from '@minca/core/react';
import { AccountHint } from './components/AccountHint';
import { AccountNotices } from './components/AccountNotices';
import { AccountSwitcher } from './components/AccountSwitcher';
import { Settings } from './components/Settings';
import { HostingDue } from './components/Hosting';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { TABS, useTab } from './tabs';
import { styles } from './styles';

/** The account home: sign in, then the account and everything about it, a tab at a time. */
export function App() {
  const { state } = useMinca();
  const [tab, openTab] = useTab();

  if (state?.stage !== 'ready') {
    return (
      <div className="page">
        <div style={styles.card}>
          <Wordmark />
          <AccountHint />
          <MincaAuth />
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <header className="home-bar">
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wordmark compact />
          <span className="home-bar-label">Account</span>
        </span>
        <AccountSwitcher />
      </header>
      <div className="home-layout">
        <nav className="home-tabs" role="tablist" aria-label="Account">
          {TABS.map((each) => (
            <button
              key={each.id}
              role="tab"
              aria-selected={tab === each.id}
              onClick={() => openTab(each.id)}
              className="home-tab"
            >
              {each.label}
            </button>
          ))}
        </nav>
        <main
          role="tabpanel"
          aria-label={TABS.find((each) => each.id === tab)?.label}
          style={{ minWidth: 0 }}
        >
          <AccountHint />
          <AccountNotices />
          <HostingDue />
          <Settings tab={tab} openTab={openTab} />
        </main>
      </div>
    </div>
  );
}
