import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { injectBaseStyles } from './styles';
import { exposeToAgents } from './webmcp';
import { MincaProvider } from '@minca/react';
import { connection } from './minca';
import { tellDesktop } from './desktop';
import { router } from './router';
import { followVisibleHeight } from './viewport';

// Hover, focus and placeholder states, plus the page background — the things
// inline styles cannot express.
injectBaseStyles();
// An open app fits above a phone's keyboard (`viewport.ts`).
followVisibleHeight();

// The node's operations as WebMCP tools, from the start — agents and
// extensions read the list on load. They act for whoever signs in.
exposeToAgents();
// In the desktop app, its menu bar follows the account this app is connected as.
tellDesktop(connection);

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  // Every component in the app asks this for Minca.
  <MincaProvider connection={connection}>
    <RouterProvider router={router} />
  </MincaProvider>,
);
