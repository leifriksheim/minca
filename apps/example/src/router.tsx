import { createRootRoute, createRoute, createRouter, linkOptions, redirect } from '@tanstack/react-router';
import { App, ContactsPage, HomeLayout, SpacesPage } from './App';
import { SpaceLayout } from './components/SpaceView';
import {
  AppPage,
  AppsPage,
  AutomationsPage,
  DataPage,
  ExplorePage,
  HostingPage,
  MorePage,
  NetworkPage,
  NewAppPage,
  PeoplePage,
  QueryPage,
} from './components/SpacePages';

/**
 * Where you are in the app, and the small state that belongs in the address:
 * which space, which part of it, which record is open beside it, and which
 * collection Data shows. What lives longer (who you are, your spaces, a call)
 * sits above the routes, in `App`.
 *
 * Invites and doors travel in the fragment, which never reaches a server, and
 * every redirect here keeps it.
 */
const root = createRootRoute({ component: App });

/** A search param that is some text, or nothing */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

// Your spaces and your contacts, under one header.
const home = createRoute({ getParentRoute: () => root, id: 'home', component: HomeLayout });
const spaces = createRoute({
  getParentRoute: () => home,
  path: '/',
  // A door link is someone asking you to knock, which happens among your contacts.
  beforeLoad: ({ location }) => {
    if (/(^|&)door=/.test(location.hash))
      redirect({ to: '/contacts', hash: location.hash, replace: true, throw: true });
  },
  component: SpacesPage,
});
const contacts = createRoute({ getParentRoute: () => home, path: 'contacts', component: ContactsPage });

// One space: its apps down a sidebar, the part of it you're in beside them, and a record open over that.
const space = createRoute({
  getParentRoute: () => root,
  path: 'spaces/$spaceId',
  validateSearch: (search: Record<string, unknown>): { record?: string } => {
    const record = text(search.record);
    return record ? { record } : {};
  },
  component: SpaceLayout,
});
const inSpace = () => space;
const spaceApps = createRoute({ getParentRoute: inSpace, path: '/', component: AppsPage });
const newApp = createRoute({ getParentRoute: inSpace, path: 'new', component: NewAppPage });
const app = createRoute({ getParentRoute: inSpace, path: 'apps/$appId', component: AppPage });
const people = createRoute({ getParentRoute: inSpace, path: 'people', component: PeoplePage });
const hosting = createRoute({ getParentRoute: inSpace, path: 'hosting', component: HostingPage });
const automations = createRoute({ getParentRoute: inSpace, path: 'automations', component: AutomationsPage });
const more = createRoute({ getParentRoute: inSpace, path: 'more', component: MorePage });
// Under the hood
const data = createRoute({
  getParentRoute: inSpace,
  path: 'data',
  validateSearch: (search: Record<string, unknown>): { collection?: string } => {
    const collection = text(search.collection);
    return collection ? { collection } : {};
  },
  component: DataPage,
});
const explore = createRoute({ getParentRoute: inSpace, path: 'explore', component: ExplorePage });
const query = createRoute({ getParentRoute: inSpace, path: 'query', component: QueryPage });
const network = createRoute({ getParentRoute: inSpace, path: 'network', component: NetworkPage });

// Anything else, `/app` among them from when the app shared a site with the
// landing pages, goes to your spaces.
const elsewhere = createRoute({
  getParentRoute: () => root,
  path: '$',
  beforeLoad: ({ location }) => {
    redirect({ to: '/', hash: location.hash, replace: true, throw: true });
  },
});

// Each route is a constant of its own: one written inline in this list loses
// the router's types, and every path and param quietly becomes `any`.
const routeTree = root.addChildren([
  home.addChildren([spaces, contacts]),
  space.addChildren([
    spaceApps,
    newApp,
    app,
    people,
    hosting,
    automations,
    more,
    data,
    explore,
    query,
    network,
  ]),
  elsewhere,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// The routes keep their types: a path that isn't one must not compile. If this
// stops failing, the types above have fallen back to `any`.
// @ts-expect-error -- not a route
void linkOptions({ to: '/not-a-route' });
