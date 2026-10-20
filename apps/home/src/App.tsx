import { MincaAuth, useMinca } from '@minca/core/react';
import { AccountHint } from './components/AccountHint';
import { AccountNotices } from './components/AccountNotices';
import { AccountSwitcher } from './components/AccountSwitcher';
import { Settings } from './components/Settings';
import { HostingDue } from './components/Hosting';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { avatarElement } from '@minca/app-shared/avatar';
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
          <MincaAuth avatar={avatarElement} />
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <header className="home-nav">
        <div className="home-nav-bar">
          <span className="home-brand">
            <Wordmark compact />
            <span className="home-brand-label">Account</span>
          </span>
          <AccountSwitcher />
        </div>
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
      </header>
      <main className="home-main" role="tabpanel" aria-label={TABS.find((each) => each.id === tab)?.label}>
        <AccountHint />
        <AccountNotices />
        <HostingDue />
        <Settings tab={tab} openTab={openTab} />
      </main>
    </div>
  );
}
