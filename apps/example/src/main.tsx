// First, so everything said while the app starts is kept for debug mode (`?debug`).
import '@minca/app-shared/debugLog';
import '@minca/ui/minca.css';
import './app.css';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { exposeToAgents } from './webmcp';
import { MincaProvider } from '@minca/react';
import { connection } from './minca';
import { router } from './router';
import { applyRememberedTheme } from '@minca/app-shared/theme';
import { mountDebugMode } from '@minca/app-shared/DebugMode';
import { debugDetails, logConnection } from './debug';

// The node's operations as WebMCP tools, from the start — agents and
// extensions read the list on load. They act for whoever signs in.
exposeToAgents();

// In the account's theme from the first paint, as this device last saw it.
applyRememberedTheme();

// `?debug` anywhere: a strip along the bottom, and a report to copy.
logConnection();
mountDebugMode({ app: 'Minca app', details: debugDetails });

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  // Every component in the app asks this for Minca.
  <MincaProvider connection={connection}>
    <RouterProvider router={router} />
  </MincaProvider>,
);
