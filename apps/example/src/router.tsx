import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { App } from './App';

/**
 * Where you are in the app: your spaces (`/`), your contacts (`/contacts`), or
 * one space (`/spaces/<id>`). `App` lays out all three, so the calls and the
 * notices above them stay put as you move between them.
 *
 * Invites and doors travel in the fragment, which never reaches a server, and
 * every redirect here keeps it.
 */
const root = createRootRoute({ component: App });

const routes = [
  createRoute({
    getParentRoute: () => root,
    path: '/',
    // A door link is someone asking you to knock, which happens among your contacts.
    beforeLoad: ({ location }) => {
      if (/(^|&)door=/.test(location.hash))
        redirect({ to: '/contacts', hash: location.hash, replace: true, throw: true });
    },
  }),
  createRoute({ getParentRoute: () => root, path: '/contacts' }),
  createRoute({ getParentRoute: () => root, path: '/spaces/$spaceId' }),
  // Anything else, `/app` among them from when the app shared a site with the
  // landing pages, goes to your spaces.
  createRoute({
    getParentRoute: () => root,
    path: '$',
    beforeLoad: ({ location }) => {
      redirect({ to: '/', hash: location.hash, replace: true, throw: true });
    },
  }),
] as const;

export const router = createRouter({ routeTree: root.addChildren(routes) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
