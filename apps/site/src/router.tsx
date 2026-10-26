import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { Home } from './pages/Home';
import { Developers } from './pages/Site';
import { Protocol } from './pages/Protocol';
import { Extension } from './pages/Extension';
import { Download } from './pages/Download';
import { Install } from './pages/Install';
import { Mcp } from './pages/Mcp';

/** The site's pages; a path it doesn't know shows the front page. */
const root = createRootRoute({ component: Outlet, notFoundComponent: Home });

const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: Home }),
  // Older links to the communities page
  createRoute({
    getParentRoute: () => root,
    path: '/why',
    beforeLoad: () => {
      redirect({ to: '/', replace: true, throw: true });
    },
  }),
  createRoute({ getParentRoute: () => root, path: '/developers', component: Developers }),
  createRoute({ getParentRoute: () => root, path: '/protocol', component: Protocol }),
  createRoute({ getParentRoute: () => root, path: '/extension', component: Extension }),
  createRoute({ getParentRoute: () => root, path: '/download', component: Download }),
  createRoute({ getParentRoute: () => root, path: '/mcp', component: Mcp }),
  createRoute({ getParentRoute: () => root, path: '/install/mac', component: () => <Install kind="mac" /> }),
  createRoute({
    getParentRoute: () => root,
    path: '/install/windows',
    component: () => <Install kind="windows" />,
  }),
  createRoute({
    getParentRoute: () => root,
    path: '/install/chrome',
    component: () => <Install kind="chrome" />,
  }),
] as const;

export const router = createRouter({ routeTree: root.addChildren(routes) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  /** Set by a download link (`apps/site/src/pages/Install.tsx`), so the page it lands on starts the download */
  interface HistoryState {
    download?: boolean;
  }
}
