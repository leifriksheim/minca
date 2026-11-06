// First, so everything said while the home starts is kept for debug mode (`?debug`).
import '@minca/app-shared/debugLog';
import '@minca/ui/minca.css';
import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/react';
import { App } from './App';
import { ConnectPage } from './components/ConnectPage';
import { auth, isConnectPage } from './minca';
import { applyRememberedTheme } from '@minca/app-shared/theme';
import { mountDebugMode } from '@minca/app-shared/DebugMode';

/**
 * Two pages: the account (`/`), and the page apps open to ask for access
 * (`/connect`). A phone-pairing link lands on `/`, where sign-in picks it up.
 */

// In the account's theme from the first paint, as this device last saw it.
applyRememberedTheme();

// `?debug` anywhere: a strip along the bottom, and a report to copy.
mountDebugMode({
  app: 'Minca account home',
  details: () => {
    const { stage, busy, accounts, session, error } = auth.getState();
    return {
      'Account home': {
        Page: isConnectPage ? 'connect' : 'account',
        Stage: stage,
        Busy: busy,
        'Accounts here': accounts.length,
        'Signed in': session !== null,
        Error: error ?? '(none)',
      },
    };
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <MincaProvider auth={auth}>{isConnectPage ? <ConnectPage /> : <App />}</MincaProvider>,
);
