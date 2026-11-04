import '@minca/ui/minca.css';
import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/react';
import { App } from './App';
import { ConnectPage } from './components/ConnectPage';
import { auth, isConnectPage } from './minca';
import { applyRememberedTheme } from '@minca/app-shared/theme';

/**
 * Two pages: the account (`/`), and the page apps open to ask for access
 * (`/connect`). A phone-pairing link lands on `/`, where sign-in picks it up.
 */

// In the account's theme from the first paint, as this device last saw it.
applyRememberedTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <MincaProvider auth={auth}>{isConnectPage ? <ConnectPage /> : <App />}</MincaProvider>,
);
