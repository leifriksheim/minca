import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/core/react';
import { App } from './App';
import { ConnectPage } from './components/ConnectPage';
import { injectBaseStyles } from './styles';
import { auth, isConnectPage } from './minca';

/**
 * Two pages: the account (`/`), and the page apps open to ask for access
 * (`/connect`). A phone-pairing link lands on `/`, where sign-in picks it up.
 */
injectBaseStyles();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <MincaProvider auth={auth}>{isConnectPage ? <ConnectPage /> : <App />}</MincaProvider>,
);
