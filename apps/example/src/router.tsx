import type { ReactNode } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  linkOptions,
  redirect,
  retainSearchParams,
} from '@tanstack/react-router';
import { App, GroupsPage, HomeLayout, PeoplePage } from './App';
import {
  HOOD,
  MoreRow,
  OpenApp,
  SECTIONS,
  SideHeading,
  SpaceLayout,
  useSpaceScreen,
  type SpaceScreen,
} from './components/SpaceView';
import { AppsView } from './components/apps/AppsView';
import { NewApp } from './components/apps/NewApp';
import { RolesView } from './components/RolesView';
import { HostingView } from './components/HostingView';
import { AutomationsView } from './components/automations/AutomationsView';
import { DataView } from './components/DataView';
import { GraphView } from './components/GraphView';
import { QueryPlayground } from './components/QueryPlayground';
import { NetworkView } from './components/NetworkView';
import { styles, stack } from './styles';

/**
 * Where you are in the app, and the small state that belongs in the address:
 * which space, which part of it, which record is open beside it, and which
 * collection Data shows. What lives longer (your spaces, a call) sits above
 * the routes, in `App`. Every redirect keeps the fragment, where invites and
 * doors travel.
 */
/** A search param that is some text, or nothing */
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

// Which account the tab acts for (`account-address.ts`), kept on every link and redirect.
const root = createRootRoute({
  component: App,
  validateSearch: (search: Record<string, unknown>): { as?: string } => ({ as: text(search.as) }),
  search: { middlewares: [retainSearchParams(['as'])] },
});

/** A part of a space, drawn from what its layout (`SpaceLayout`) hands down */
const page = (draw: (screen: SpaceScreen) => ReactNode) => () => draw(useSpaceScreen());

const home = createRoute({ getParentRoute: () => root, id: 'home', component: HomeLayout });
const groups = createRoute({
  getParentRoute: () => home,
  path: '/',
  // An inbox link is someone asking you to knock, which happens among your people.
  beforeLoad: ({ location }) => {
    if (/(^|&)inbox=/.test(location.hash))
      redirect({ to: '/people', hash: location.hash, replace: true, throw: true });
  },
  component: GroupsPage,
});
const people = createRoute({ getParentRoute: () => home, path: 'people', component: PeoplePage });
// Where People was before: links to add someone, handed out already, still lead there.
const contacts = createRoute({
  getParentRoute: () => root,
  path: 'contacts',
  beforeLoad: ({ location }) => {
    redirect({ to: '/people', hash: location.hash, replace: true, throw: true });
  },
});

const space = createRoute({
  getParentRoute: () => root,
  path: 'spaces/$spaceId',
  // record: open in the panel beside; at: the record the open app was asked to show.
  validateSearch: (search: Record<string, unknown>): { record?: string; at?: string } => ({
    record: text(search.record),
    at: text(search.at),
  }),
  component: SpaceLayout,
});
const inSpace = () => space;
const spaceApps = createRoute({
  getParentRoute: inSpace,
  path: '/',
  component: page((s) => (
    <AppsView {...s} onOpenApp={s.openApp} onCreate={() => s.go('/spaces/$spaceId/new')} />
  )),
});
const newApp = createRoute({
  getParentRoute: inSpace,
  path: 'new',
  component: page((s) => <NewApp {...s} onOpenApp={s.openApp} onOwn={s.startCreating} />),
});
const app = createRoute({
  getParentRoute: inSpace,
  path: 'apps/$appId',
  component: page(({ open, apps }) =>
    open ? (
      <OpenApp key={open.id} app={open} />
    ) : (
      !apps.loading && <p style={styles.emptyState}>This app isn't in the space any more.</p>
    ),
  ),
});
const members = createRoute({
  getParentRoute: inSpace,
  path: 'people',
  component: page((s) => <RolesView {...s} />),
});
const hosting = createRoute({
  getParentRoute: inSpace,
  path: 'hosting',
  component: page((s) => <HostingView {...s} onAutomations={() => s.go('/spaces/$spaceId/automations')} />),
});
const automations = createRoute({
  getParentRoute: inSpace,
  path: 'automations',
  component: page((s) => <AutomationsView {...s} />),
});
// A phone's list of the sections that have no tab of their own
const more = createRoute({
  getParentRoute: inSpace,
  path: 'more',
  component: page(({ go }) => (
    <div style={stack(2)}>
      {SECTIONS.filter((section) => section.to !== '/spaces/$spaceId/people').map((section) => (
        <MoreRow key={section.to} icon={section.icon} label={section.label} onClick={() => go(section.to)} />
      ))}
      <SideHeading>Under the hood</SideHeading>
      {HOOD.map((h) => (
        <MoreRow key={h.id} icon={h.icon} label={h.label} quiet onClick={() => go(h.to)} />
      ))}
    </div>
  )),
});
const data = createRoute({
  getParentRoute: inSpace,
  path: 'data',
  validateSearch: (search: Record<string, unknown>): { collection?: string } => ({
    collection: text(search.collection),
  }),
  component: DataPage,
});
const explore = createRoute({
  getParentRoute: inSpace,
  path: 'explore',
  component: page((s) => <GraphView {...s} />),
});
const query = createRoute({
  getParentRoute: inSpace,
  path: 'query',
  component: page((s) => <QueryPlayground {...s} onOpen={s.openRecord} />),
});
const network = createRoute({
  getParentRoute: inSpace,
  path: 'network',
  component: page((s) => <NetworkView {...s} />),
});

/** Every record, collection by collection; which collection, and which record, are in the address */
function DataPage(): ReactNode {
  const s = useSpaceScreen();
  const { collection, record } = data.useSearch();
  const navigate = data.useNavigate();
  return (
    <DataView
      {...s}
      place={{ collection: collection ?? null, key: record ?? null }}
      onPlace={(place) =>
        void navigate({
          search: { collection: place.collection ?? undefined, record: place.key ?? undefined },
        })
      }
      onOpen={s.openRecord}
    />
  );
}

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
  home.addChildren([groups, people]),
  contacts,
  space.addChildren([
    spaceApps,
    newApp,
    app,
    members,
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
  // What a move carries without putting it in the address: a new group asks for people once, and
  // "Message someone" lands in the search for them.
  interface HistoryState {
    addPeople?: boolean;
    find?: boolean;
  }
}

// The routes keep their types: a path that isn't one must not compile. If this
// stops failing, the types above have fallen back to `any`.
// @ts-expect-error -- not a route
void linkOptions({ to: '/not-a-route' });
