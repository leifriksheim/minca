import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/react';
import { baseCss } from '@minca/app-shared/styles';
import { App } from './App';
import { connection } from './minca';
import { injectAppStyles } from './styles';

const base = document.createElement('style');
base.textContent = baseCss;
document.head.append(base);
injectAppStyles();

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <MincaProvider connection={connection}>
    <App />
  </MincaProvider>,
);
