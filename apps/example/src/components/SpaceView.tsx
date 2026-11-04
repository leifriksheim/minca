import { createContext, useContext, useState, type ReactNode } from 'react';
import { PersonFace } from './PersonFace';
import {
  Link,
  Outlet,
  useCanGoBack,
  useNavigate,
  useRouter,
  useParams,
  useRouterState,
  useSearch,
  type RegisteredRouter,
} from '@tanstack/react-router';
import { useMayDefine } from '@minca/app-shared/may';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import {
  useAccess,
  useCollections,
  useHoldSpace,
  useProfiles,
  useAccount,
  useSpaceStatus,
} from '@minca/react';
import { RecordPanel } from './RecordPanel';
import { OpenWith } from './apps/OpenWith';
import { AppIcon, Count } from './apps/AppIcon';
import { CreateApp } from './apps/CreateApp';
import { MadeAppScreen } from './apps/MadeApps';
import { showsRecord } from './apps/launcher';
import { Bell } from './Bell';
import { fills, useSpaceApps, type AppEntry } from './apps/entries';
import { NEW } from './DataView';
import { SpaceMark } from './SpaceList';
import { AddPeople } from './InvitePeople';
import type { PairWith } from '../contacts';
import { AccountMenu } from './AccountMenu';
import { usePopover } from './usePopover';
import css from './SpaceView.module.css';
import { Icon, type IconName } from '@minca/app-shared/Icon';
import { SyncLine } from './SyncLine';
import { RelayDown } from './RelayNotice';
import { homeTab, Notices, useWorkspace } from '../workspace';
import { peopleFrom } from '../derive/people';
import { useBots } from '../bots';
import { PersonScopeProvider } from './Person';
import { seenAt, totalOf, unreadOf, useLookingAt, useSeen, useUnread, type Unread } from '../seen';

/** Under the hood: the views for the curious, at the foot of the space's Overview */
export const HOOD = [
  {
    id: 'data',
    to: '/spaces/$spaceId/data',
    label: 'Data',
    icon: 'table',
    about: 'Every record in this space, collection by collection: what the apps read and write.',
  },
  { id: 'explore', to: '/spaces/$spaceId/explore', label: 'Explore', icon: 'compass' },
  { id: 'query', to: '/spaces/$spaceId/query', label: 'Query', icon: 'search' },
  {
    id: 'network',
    to: '/spaces/$spaceId/network',
    label: 'Network',
    icon: 'network',
    about: 'Which devices this one syncs with, and how records travel between them.',
  },
] as const satisfies ReadonlyArray<{
  id: string;
  to: SpacePath;
  label: string;
  icon: IconName;
  about?: string;
}>;

/** Where the seen store keeps when the Overview, and the proposals on it, were last looked at; no app has this id */
const PROPOSALS = ':proposals';

type Page = { readonly to: SpacePath; readonly label: string; readonly icon: IconName };

/** Who is in a group, and bringing more in: a space for two is the two of you, so it has neither */
export const PEOPLE_PAGES = [
  { to: '/spaces/$spaceId/members', label: 'Members', icon: 'people' },
  { to: '/spaces/$spaceId/invite', label: 'Invite', icon: 'invite' },
] as const satisfies ReadonlyArray<Page>;

/** Everything else about the space, behind one page */
export const SETTINGS_PAGE = {
  to: '/spaces/$spaceId/settings',
  label: 'Settings',
  icon: 'settings',
} as const satisfies Page;

/** What Settings lead to; roles are a group's, as members are */
const SETTINGS = [
  { to: '/spaces/$spaceId/roles', label: 'Roles', icon: 'shield' },
  { to: '/spaces/$spaceId/hosting', label: 'Hosting', icon: 'cloud' },
  { to: '/spaces/$spaceId/automations', label: 'Automations', icon: 'bolt' },
] as const satisfies ReadonlyArray<Page>;
export const settingsPagesOf = (pair: boolean) =>
  SETTINGS.filter((page) => !pair || page.to !== '/spaces/$spaceId/roles');

/** A space's own pages, as its menu lists them */
const sectionsOf = (pair: boolean): ReadonlyArray<Page> => [...(pair ? [] : PEOPLE_PAGES), SETTINGS_PAGE];

/** Every part of a space you can go to with only its id */
type SpacePath = Exclude<
  Extract<keyof RegisteredRouter['routesByPath'], `/spaces/${string}`>,
  `${string}$appId` | `${string}/`
>;

/** Every route in the app, by its id */
type RouteId = keyof RegisteredRouter['routesById'];

/** The route that is a space's apps, and the one that is one app open */
const APPS_ROUTE: RouteId = '/spaces/$spaceId/';
const APP_ROUTE: RouteId = '/spaces/$spaceId/apps/$appId';

/** What a space's pages share, from the layout around them */
export interface SpaceScreen {
  readonly space: SpaceSummary;
  readonly collections: ReturnType<typeof useCollections>;
  readonly apps: ReturnType<typeof useSpaceApps>;
  readonly unread: ReturnType<typeof useUnread>;
  readonly status: ReturnType<typeof useSpaceStatus>;
  readonly mayDefine: boolean;
  /** The app open, at `/apps/<id>`, when the space has it */
  readonly open: AppEntry | undefined;
  /** Go to another part of this space */
  readonly go: (to: SpacePath) => void;
  readonly openApp: (id: string) => void;
  /** Open a record: in the app that shows its collection, else in the panel beside whatever is open */
  readonly openRecord: (record: NodeRecord, here?: boolean) => void;
  /** The record the open app was asked to show, until it has been handed over */
  readonly shown: string | undefined;
  readonly clearShown: () => void;
  /** Ask an agent to make an app, or make one by hand */
  readonly startCreating: () => void;
  /** Where in itself the open app's screen is (`minca.view`), and going elsewhere in it (`minca.go`) */
  readonly view: string | null;
  readonly goView: (view: string | null, title: string | null) => void;
}

const SpaceScreenContext = createContext<SpaceScreen | null>(null);

/** The space a page is in, and what it can do there */
export function useSpaceScreen(): SpaceScreen {
  const screen = useContext(SpaceScreenContext);
  if (!screen) throw new Error('useSpaceScreen needs a space (SpaceLayout) above it');
  return screen;
}

/** `/spaces/<id>`: the space, or a way back to your groups when you don't have it */
export function SpaceLayout() {
  const { spaceId } = useParams({ from: '/spaces/$spaceId' });
  const { spaces, loading } = useWorkspace();
  // Always the list's current copy, so a join that finishes, or a role that
  // changes, never leaves a stale one on screen.
  const space = spaces.find((found) => found.id === spaceId);
  // Said rather than redirected: a list a moment behind (a refresh that
  // overlapped a join) shows the space as soon as it catches up.
  if (!space)
    return loading ? null : (
      <main>
        <div className="empty">
          <p>This space isn't on this device.</p>
          <Link to="/">Your spaces</Link>
        </div>
      </main>
    );
  // The space takes the whole window, the way chat apps are laid out.
  return <SpaceView key={space.id} space={space} />;
}

/** One space, laid out like a chat app: its apps down a sidebar, the part you're in beside them */
function SpaceView({ space }: { space: SpaceSummary }) {
  const { spaces, pairs, openSpace } = useWorkspace();
  // A space for two is the person it is with, in its name and its face.
  const pair = pairs.get(space.id);
  const name = pair?.name ?? space.name;
  // A group just made asks who to add, once, over the chat it opened in.
  const justMade = useRouterState({ select: (state) => state.location.state.addPeople === true });
  const [adding, setAdding] = useState(justMade);
  const account = useAccount();
  const navigate = useNavigate();
  // Where in the space you are, and the record open beside it: the address holds both.
  const leaf = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const openId = useParams({ strict: false }).appId;
  const { record, at, view } = useSearch({ from: '/spaces/$spaceId' });
  // An app's own views (`minca.go`): which, by the address, and their names, kept with each page of history.
  const viewTitle = useRouterState({ select: (state) => state.location.state.viewTitle });
  const viewBase = useRouterState({ select: (state) => state.location.state.viewBase });
  const historyAt = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const onApps = leaf === APPS_ROUTE;
  const onApp = leaf === APP_ROUTE;
  const hood = HOOD.find((h) => h.to === leaf);
  const onNew = leaf === '/spaces/$spaceId/new';

  const [creating, setCreating] = useState(false);
  // A record more than one app can open, while the person picks which
  const [choosing, setChoosing] = useState<NodeRecord | null>(null);
  // Syncing while it is on screen. Opening writes nothing: standard schemas
  // are added only when someone picks them from the library.
  useHoldSpace(space.id);
  const collections = useCollections(space.id);
  const people = peopleFrom(useProfiles(space.id), useBots(space.id));
  const status = useSpaceStatus(space.id);
  const access = useAccess(space.id);
  const mayDefine = useMayDefine(space.id) && space.writable;
  const roleOf = new Map(
    (access?.members ?? []).map((m) => [
      m.did,
      m.founder
        ? 'Founder'
        : m.roles.map((name) => access?.roles.find((r) => r.name === name)?.title ?? name).join(', '),
    ]),
  );

  const apps = useSpaceApps(space, collections);
  const unread = useUnread(space.id, apps.ready);
  const seen = useSeen();
  const open = onApp ? apps.ready.find((app) => app.id === openId) : undefined;

  const params = { spaceId: space.id };
  const go = (to: SpacePath) => void navigate({ to, params });
  // Going into an app is a step Back comes out of; from one app to another is a swap, as tabs are, so Back
  // leaves the apps rather than going through each one.
  const openApp = (appId: string) =>
    void navigate({
      to: '/spaces/$spaceId/apps/$appId',
      params: { spaceId: space.id, appId },
      replace: onApp,
    });
  const router = useRouter();
  const canGoBack = useCanGoBack();
  // Home, to the list the space was opened from: from an app.
  const goHome = () => void navigate({ to: homeTab() });
  // An app one level into itself: its bar is the app's own, naming where it is, and Back comes back out.
  const inView = onApp && view !== undefined;
  // The Overview is where a space opens, so its Back goes home. Anywhere else in the space is a step
  // in from it: back to where you were, or else to the Overview.
  const goBack = () => {
    if (onApps) return goHome();
    if (canGoBack) return router.history.back();
    if (inView) return goView(null, null);
    go('/spaces/$spaceId');
  };
  /**
   * The open app's screen going somewhere in itself. A step in is a page of history, so every Back
   * comes back out, but only just after the person did something: a screen can't fill Back on its own.
   * Its start is wherever it was before the first step in, so going there goes back that far.
   */
  const goView = (next: string | null, name: string | null) => {
    const here = view ?? null;
    if (next === here) {
      if (next !== null)
        void navigate({
          to: '.',
          search: (was) => was,
          state: (was) => ({ ...was, viewTitle: name ?? undefined }),
          replace: true,
        });
      return;
    }
    if (next === null) {
      if (viewBase !== undefined && viewBase < historyAt) return router.history.go(viewBase - historyAt);
      void navigate({ to: '.', search: (was) => ({ ...was, view: undefined }), replace: true });
      return;
    }
    const tapped = globalThis.navigator.userActivation?.isActive ?? true;
    void navigate({
      to: '.',
      search: (was) => ({ ...was, view: next }),
      state: { viewTitle: name ?? undefined, viewBase: here === null ? historyAt : viewBase },
      replace: !tapped,
    });
  };
  // In Data, a record opens in its own collection. Elsewhere it opens in the app that shows it,
  // so a message opens in the chat: the open one if it does, else the only one, else the person
  // picks one. Apps naming its kind come first (`showsRecord`), so a Bills tab opens in Bills, not
  // Lists. With none, or when that app asks (`here`) to open one of its own, beside what is open.
  const showing = (r: NodeRecord) => {
    const named = apps.ready.map((app) => ({ app, closeness: showsRecord(app.record.body?.shows, r) }));
    const closest = Math.max(0, ...named.map((one) => one.closeness));
    return closest === 0 ? [] : named.filter((one) => one.closeness === closest).map((one) => one.app);
  };
  const openIn = (r: NodeRecord, app: AppEntry) =>
    void navigate({
      to: '/spaces/$spaceId/apps/$appId',
      params: { spaceId: space.id, appId: app.id },
      search: (was) => ({ ...was, record: undefined, at: r.key }),
    });
  const openRecord = (r: NodeRecord, here = false) => {
    if (hood?.id === 'data')
      return void navigate({
        to: '/spaces/$spaceId/data',
        params,
        search: { collection: r.collection, record: r.key },
      });
    const can = here ? [] : showing(r);
    const app = can.find((one) => one.id === open?.id) ?? (can.length === 1 ? can[0] : undefined);
    if (app) return openIn(r, app);
    if (can.length > 1) return setChoosing(r);
    void navigate({ to: '.', search: (was) => ({ ...was, record: r.key }), replace: true });
  };
  const clearShown = () =>
    void navigate({ to: '.', search: (was) => ({ ...was, at: undefined }), replace: true });
  // The record beside is in the address but not a page of history: closing it is not a step to come back to.
  const closeRecord = () =>
    void navigate({ to: '.', search: (was) => ({ ...was, record: undefined }), replace: true });

  useLookingAt(space.id, open?.id, open ? unreadOf(unread, open.id).count : 0);

  // Proposed apps others, or an agent, wrote since All apps was last looked at.
  const proposalsSeen = Date.parse(seenAt(seen, space.id, PROPOSALS));
  const newProposals: Unread = {
    count: apps.proposed.filter(
      (proposed) =>
        (proposed.createdBy !== account.did || proposed.recordsOnly) &&
        Date.parse(proposed.updatedAt) > proposalsSeen,
    ).length,
    forMe: 0,
  };
  useLookingAt(space.id, onApps ? PROPOSALS : undefined, newProposals.count);

  const fill = open ? fills(open) : false;
  const title =
    (inView ? viewTitle : undefined) ??
    open?.title ??
    [
      ...PEOPLE_PAGES,
      SETTINGS_PAGE,
      ...SETTINGS,
      ...HOOD,
      { to: '/spaces/$spaceId/new', label: 'Add app' },
    ].find((part) => part.to === leaf)?.label ??
    name;

  const screen: SpaceScreen = {
    space,
    collections,
    apps,
    unread,
    status,
    mayDefine,
    open,
    go,
    openApp,
    openRecord,
    shown: at,
    clearShown,
    startCreating: () => setCreating(true),
    view: view ?? null,
    goView,
  };

  return (
    <PersonScopeProvider space={space} people={people} roles={roleOf} me={account.did} openSpace={openSpace}>
      <SyncLine space={space.id} />
      <div className={css.shell} data-app-open={open ? '' : undefined}>
        {/* The space's apps down the left edge, under the space itself; a phone has them in its bar. */}
        <nav className={`${css.rail} ${css.wide}`} aria-label={`Apps in ${name}`}>
          <div className={css.top}>
            <SpaceMenu space={space} pair={pair} leaf={leaf} go={go} />
          </div>
          <div className={css.apps}>
            {/* Back to your spaces and people, then this one's Overview: every app, with the ones proposed. */}
            <RailItem icon={<Icon name="arrowLeft" />} label="Home" on={false} onClick={goHome} />
            <RailItem
              icon={<Icon name="apps" />}
              label="Overview"
              unread={newProposals}
              on={onApps}
              onClick={() => go('/spaces/$spaceId')}
            />
            {apps.ready.map((app) => (
              <RailItem
                key={app.id}
                icon={<AppIcon app={app} size={22} />}
                label={app.title}
                unread={unreadOf(unread, app.id)}
                on={open?.id === app.id}
                onClick={() => openApp(app.id)}
              />
            ))}
            {space.writable && (
              <RailItem
                icon={
                  <span className={css.slot}>
                    <Icon name="plus" size={12} />
                  </span>
                }
                label="Add"
                on={onNew}
                onClick={() => go('/spaces/$spaceId/new')}
              />
            )}
          </div>
          <div className={`row ${css.foot}`}>
            {/* You, and what's new for you beside you, at its foot. */}
            <AccountMenu />
            <Bell spaces={spaces} here={space} onOpenSpace={openSpace} />
          </div>
        </nav>

        <div className={css.main}>
          <header className={css.bar}>
            {/* Back for everywhere a step in from the apps; a phone, with no rail, has it everywhere. */}
            <button
              data-icon
              data-intent="subtle"
              className={!onApps && (!onApp || inView) ? undefined : css.phone}
              onClick={goBack}
              aria-label={onApps ? 'Home' : 'Back'}
              title={onApps ? 'Home' : 'Back'}
            >
              <Icon name="back" />
            </button>
            <div className={`row ${css.title}`}>
              {onApps && (
                <span className={css.phone}>
                  <SpaceFace space={space} pair={pair} size={28} />
                </span>
              )}
              {open && <AppIcon app={open} size={28} />}
              {/* The rail names the space, so there the Overview is named for itself. */}
              <h1 className="truncate">
                {onApps ? (
                  <>
                    <span className={css.phone}>{name}</span>
                    <span className={css.wide}>Overview</span>
                  </>
                ) : (
                  title
                )}
              </h1>
            </div>
            {/* The Overview lists the apps already. */}
            {!onApps && (
              <AppSwitcher
                space={space}
                apps={apps.ready}
                unread={unread}
                open={open}
                onNew={onNew}
                go={go}
                openApp={openApp}
              />
            )}
          </header>

          <div className={css.content} data-fill={fill || undefined}>
            <main data-wide={hood ? true : undefined}>
              <Notices inSpace />
              {!hood && <RelayDown />}
              {!space.writable && (
                <aside>
                  {space.joining
                    ? 'Joining — waiting for your invite to arrive from someone in the space. It will, once one of them is online.'
                    : "You're following this space: you can see it but not change it. Someone who runs it can give you a role."}
                </aside>
              )}
              {status && status.rejected > 0 && !onApp && (
                <p>
                  <button
                    data-intent="danger"
                    onClick={() => go('/spaces/$spaceId/network')}
                    title="Records peers sent that failed validation"
                  >
                    {status.rejected} rejected
                  </button>
                </p>
              )}

              {hood && (
                <div className="stack">
                  <div role="tablist" aria-label="Under the hood" className={css.phone}>
                    {HOOD.map((h) => (
                      <button
                        key={h.id}
                        role="tab"
                        aria-selected={hood.id === h.id}
                        // In place, so Back leaves under the hood in one step rather than tab by tab.
                        onClick={() => void navigate({ to: h.to, params, replace: true })}
                      >
                        <Icon name={h.icon} size={14} />
                        {h.label}
                      </button>
                    ))}
                  </div>
                  {'about' in hood && <small>{hood.about}</small>}
                </div>
              )}

              <SpaceScreenContext value={screen}>
                <Outlet />
              </SpaceScreenContext>
            </main>
          </div>
        </div>
      </div>

      {record && (
        <RecordPanel
          space={space}
          recordKey={record}
          collections={collections}
          onOpen={openRecord}
          onClose={closeRecord}
          onOpenWith={(r) => (showing(r).length > 1 ? () => setChoosing(r) : undefined)}
        />
      )}

      {choosing && (
        <OpenWith
          apps={showing(choosing)}
          onClose={() => setChoosing(null)}
          onChoose={(app) => {
            setChoosing(null);
            openIn(choosing, app);
          }}
        />
      )}

      {adding && (
        <AddPeople
          space={space}
          members={new Set((access?.members ?? []).map((member) => member.did))}
          onClose={() => {
            setAdding(false);
            // Asked once: going back to this page doesn't ask again.
            void navigate({ to: '.', state: {}, replace: true });
          }}
        />
      )}

      {creating && (
        <CreateApp
          space={space}
          mayDefine={mayDefine}
          onClose={() => setCreating(false)}
          onReview={() => go('/spaces/$spaceId')}
          onBuildByHand={() =>
            void navigate({ to: '/spaces/$spaceId/data', params, search: { collection: NEW } })
          }
        />
      )}
    </PersonScopeProvider>
  );
}

/** A space's face: the person's, for a space for two, else its own mark */
function SpaceFace({ space, pair, size }: { space: SpaceSummary; pair: PairWith | undefined; size: number }) {
  return pair ? <PersonFace did={pair.face} size={size} round /> : <SpaceMark space={space} size={size} />;
}

/** An open app: its screen, or its records as lists */
export function OpenApp({ app }: { app: AppEntry }) {
  const { space, collections, openRecord, shown, clearShown, view, goView } = useSpaceScreen();
  return (
    <MadeAppScreen
      space={space}
      record={app.record}
      collections={collections}
      onOpen={(r) => openRecord(r, showsRecord(app.record.body?.shows, r) > 0)}
      shown={shown}
      onShown={clearShown}
      view={view}
      onGo={goView}
    />
  );
}

/** Who can read the space, in a word */
function Privacy({ space }: { space: SpaceSummary }) {
  return (
    <small
      className="row"
      data-gap="tight"
      title={
        space.visibility === 'private'
          ? 'Encrypted end to end: only people in the space hold the key'
          : 'Not encrypted: anyone with the link can read it'
      }
    >
      <Icon name={space.visibility === 'private' ? 'lock' : 'globe'} size={12} />
      {space.visibility === 'private' ? 'Private' : 'Public'}
      {space.role ? ` · ${space.role}` : ''}
    </small>
  );
}

/**
 * The way around a space, from its face and name at the top of the rail: a menu that names the space,
 * then goes to its Overview and its own sections.
 */
function SpaceMenu({
  space,
  pair,
  leaf,
  go,
}: {
  space: SpaceSummary;
  pair: PairWith | undefined;
  leaf: RouteId | undefined;
  go: (to: SpacePath) => void;
}) {
  const { forget } = useWorkspace();
  const { open: shown, setOpen, close, root } = usePopover();
  const name = pair?.name ?? space.name;
  // Each row closes the menu on its way.
  const then = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <div ref={root} className={css.anchor}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={shown}
        aria-haspopup="menu"
        aria-label={name}
        title={name}
        className={css.item}
      >
        <SpaceFace space={space} pair={pair} size={36} />
        <strong className="truncate">{name}</strong>
      </button>
      {shown && (
        <menu aria-label={name} className={css.menu}>
          <li className="row">
            <SpaceFace space={space} pair={pair} size={32} />
            <span className="stack" data-gap="tight">
              <strong>{name}</strong>
              <Privacy space={space} />
            </span>
          </li>
          <li>
            <small>{pair ? 'This chat' : 'This group'}</small>
          </li>
          <SideItem
            icon={<Icon name="apps" size={16} />}
            label="Overview"
            on={leaf === APPS_ROUTE}
            onClick={then(() => go('/spaces/$spaceId'))}
          />
          {/* A space for two is the two of you, so nobody is invited to it. */}
          {sectionsOf(!!pair).map((section) => (
            <SideItem
              key={section.to}
              icon={<Icon name={section.icon} size={16} />}
              label={section.label}
              on={leaf === section.to}
              onClick={then(() => go(section.to))}
            />
          ))}
          <li>
            <hr />
          </li>
          <li>
            <button data-intent="danger" onClick={then(() => forget(space.id))}>
              {pair ? 'Leave this chat' : 'Leave group'}
            </button>
          </li>
        </menu>
      )}
    </div>
  );
}

/**
 * A phone's way between apps: the grid at the right of its bar opens every app as a grid of their
 * shapes, with what is new in each and a slot to add one.
 */
function AppSwitcher({
  space,
  apps,
  unread,
  open,
  onNew,
  go,
  openApp,
}: {
  space: SpaceSummary;
  apps: ReadonlyArray<AppEntry>;
  unread: ReturnType<typeof useUnread>;
  open: AppEntry | undefined;
  onNew: boolean;
  go: (to: SpacePath) => void;
  openApp: (id: string) => void;
}) {
  const { open: shown, setOpen, close, root } = usePopover();
  const then = (action: () => void) => () => {
    close();
    action();
  };
  // While its grid is shut, what's new in the apps not on screen shows on the button.
  const elsewhere = totalOf([...unread.entries()].filter(([id]) => id !== open?.id).map(([, one]) => one));
  return (
    <div ref={root} className={`${css.anchor} ${css.phone}`}>
      <button
        data-icon
        data-intent="subtle"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={shown}
        aria-haspopup="menu"
        aria-label={open ? `${open.title}: every app` : 'Every app'}
        title="Apps"
      >
        <Icon name="apps" />
        {!shown && (
          <span className={css.corner}>
            <Count unread={elsewhere} />
          </span>
        )}
      </button>
      {shown && (
        <menu aria-label="Apps" className={css.drop}>
          {apps.map((app) => (
            <li key={app.id}>
              <button
                onClick={then(() => openApp(app.id))}
                aria-current={open?.id === app.id ? 'page' : undefined}
                className={css.item}
              >
                <span className={css.icon}>
                  <AppIcon app={app} size={36} />
                  <span className={css.corner}>
                    <Count unread={unreadOf(unread, app.id)} />
                  </span>
                </span>
                <span className="truncate">{app.title}</span>
              </button>
            </li>
          ))}
          {space.writable && (
            <li>
              <button
                onClick={then(() => go('/spaces/$spaceId/new'))}
                aria-current={onNew ? 'page' : undefined}
                className={css.item}
              >
                {/* On the same tile an app's shape takes, so its name lines up with theirs. */}
                <span className={css.icon}>
                  <span className={css.slot}>
                    <Icon name="plus" />
                  </span>
                </span>
                <span className="truncate">Add</span>
              </button>
            </li>
          )}
        </menu>
      )}
    </div>
  );
}

/** An app on the rail: its shape beside its name, what's new on its corner, and a tile of its own while open */
function RailItem({
  icon,
  label,
  unread,
  on,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  unread?: Unread;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} aria-current={on ? 'page' : undefined} title={label} className={css.item}>
      <span className={css.icon}>
        {icon}
        {unread && (
          <span className={css.corner}>
            <Count unread={unread} />
          </span>
        )}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A row in the space's menu */
function SideItem({
  icon,
  label,
  on,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button onClick={onClick} aria-current={on ? 'page' : undefined}>
        {icon}
        {label}
      </button>
    </li>
  );
}
