import '@minca/ui/minca.css';
import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/react';
import { App } from './App';
import { connection } from './minca';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <MincaProvider connection={connection}>
    <App />
  </MincaProvider>,
);
