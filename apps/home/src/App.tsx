import { useMinca } from '@minca/react';
import { AccountHint } from './components/AccountHint';
import { AccountNotices } from './components/AccountNotices';
import { AccountSwitcher } from './components/AccountSwitcher';
import { Settings } from './components/Settings';
import { SignIn } from './components/SignIn';
import { HostingDue } from './components/Hosting';
import { Wordmark } from '@minca/app-shared/Wordmark';
import { TABS, useTab } from './tabs';
import styles from './App.module.css';

/** The account home: sign in, then the account and everything about it, a tab at a time. */
export function App() {
  const { state } = useMinca();
  const [tab, openTab] = useTab();

  if (state?.stage !== 'ready') {
    return (
      <main className={styles.signIn}>
        <Wordmark />
        <AccountHint />
        <SignIn />
      </main>
    );
  }

  return (
    <>
      <header className={styles.nav}>
        <div className={`row ${styles.bar}`}>
          <span className="row">
            <Wordmark />
            <span className={styles.label}>Account</span>
          </span>
          <AccountSwitcher />
        </div>
        <nav role="tablist" aria-label="Account">
          {TABS.map((each) => (
            <button key={each.id} role="tab" aria-selected={tab === each.id} onClick={() => openTab(each.id)}>
              {each.label}
            </button>
          ))}
        </nav>
      </header>
      <main className={styles.main} role="tabpanel" aria-label={TABS.find((each) => each.id === tab)?.label}>
        <AccountHint />
        <AccountNotices />
        <HostingDue />
        <Settings tab={tab} openTab={openTab} />
      </main>
    </>
  );
}
