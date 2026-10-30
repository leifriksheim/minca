import { createContext, useContext, useState, type DragEvent, type ReactNode } from 'react';
import {
  Link,
  Outlet,
  useNavigate,
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
  useNode,
  useProfiles,
  useAccount,
  useSpaceStatus,
} from '@minca/react';
import { RecordPanel } from './RecordPanel';
import { OpenWith } from './apps/OpenWith';
import { AppIcon, Count } from './apps/AppIcon';
import { CreateApp } from './apps/CreateApp';
import { NotifyButton } from './apps/NotifyButton';
import { AppSettingsButton } from './apps/AppSettings';
import { MadeAppScreen } from './apps/MadeApps';
import { Bell } from './Bell';
import { fills, useSpaceApps, type AppEntry } from './apps/entries';
import { moveApp } from './apps/launcher';
import { NEW } from './DataView';
import { SpaceRail } from './SpaceRail';
import { SpaceMark } from './SpaceList';
import { AccountMenu } from './AccountMenu';
import { styles, palette, stack, ui } from '../styles';
import { useAction } from '@minca/app-shared/action';
import { useRemembered } from '../kept';
import { Icon, type IconName } from './Icon';
import { WhoIsHere } from './WhoIsHere';
import { RelayDown } from './RelayNotice';
import { Notices, useWorkspace } from '../workspace';
import { CallButton } from './calls/Calls';
import { peopleFrom } from '../derive/people';
import { useBots } from '../bots';
import { PersonScopeProvider } from './Person';
import { seenAt, totalOf, unreadOf, useLookingAt, useSeen, useUnread, type Unread } from '../seen';
import { QuietButton } from './Buttons';

/** Under the hood: the views for the curious, folded at the foot of the sidebar */
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

/** How many apps the sidebar lists before the rest fold behind one row, so the space's own sections stay in view */
const SIDEBAR_APPS = 10;
/** Where the seen store keeps when All apps, and the proposals on it, were last looked at; no app has this id */
const PROPOSALS = ':proposals';

/** What belongs to the space rather than to one app, in sidebar order */
export const SECTIONS = [
  { to: '/spaces/$spaceId/people', label: 'People', icon: 'people' },
  { to: '/spaces/$spaceId/hosting', label: 'Hosting', icon: 'cloud' },
  { to: '/spaces/$spaceId/automations', label: 'Automations', icon: 'bolt' },
] as const satisfies ReadonlyArray<{ to: SpacePath; label: string; icon: IconName }>;

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
}

const SpaceScreenContext = createContext<SpaceScreen | null>(null);

/** The space a page is in, and what it can do there */
export function useSpaceScreen(): SpaceScreen {
  const screen = useContext(SpaceScreenContext);
  if (!screen) throw new Error('useSpaceScreen needs a space (SpaceLayout) above it');
  return screen;
}

/** `/spaces/<id>`: the space beside the rail of every space, or your spaces when you don't have it */
export function SpaceLayout() {
  const { spaceId } = useParams({ from: '/spaces/$spaceId' });
  const { spaces, loading, create, join, openSpace } = useWorkspace();
  const navigate = useNavigate();
  // Always the list's current copy, so a join that finishes, or a role that
  // changes, never leaves a stale one on screen.
  const space = spaces.find((found) => found.id === spaceId);
  // Said rather than redirected: a list a moment behind (a refresh that
  // overlapped a join) shows the space as soon as it catches up.
  if (!space)
    return loading ? null : (
      <div className="page">
        <div style={styles.app}>
          <p style={styles.emptyState}>This space isn't on this device.</p>
          <Link to="/">Your spaces</Link>
        </div>
      </div>
    );
  // The space takes the whole window beside the rail, the way chat apps are laid out.
  return (
    <div className="shell">
      <SpaceRail
        spaces={spaces}
        current={space.id}
        onOpen={(other) => openSpace(other.id)}
        onHome={() => void navigate({ to: '/' })}
        onCreate={create}
        onJoin={join}
      />
      <SpaceView key={space.id} space={space} />
    </div>
  );
}

/** One space, laid out like a chat app: its apps down a sidebar, the part you're in beside them */
function SpaceView({ space }: { space: SpaceSummary }) {
  const { spaces, openSpace } = useWorkspace();
  const account = useAccount();
  const node = useNode();
  const navigate = useNavigate();
  const goHome = () => void navigate({ to: '/' });
  // Where in the space you are, and the record open beside it: the address holds both.
  const leaf = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const openId = useParams({ strict: false }).appId;
  const { record, at } = useSearch({ from: '/spaces/$spaceId' });
  const onApps = leaf === APPS_ROUTE;
  const onApp = leaf === APP_ROUTE;
  const hood = HOOD.find((h) => h.to === leaf);
  const onNew = leaf === '/spaces/$spaceId/new';
  const onPeople = leaf === '/spaces/$spaceId/people';

  // The app being dragged to a new place in the sidebar, by its launcher record, and why a move failed
  const [dragging, setDragging] = useState<string | null>(null);
  const moving = useAction();
  const [creating, setCreating] = useState(false);
  // A record more than one app can open, while the person picks which
  const [choosing, setChoosing] = useState<NodeRecord | null>(null);
  const [everyApp, setEveryApp] = useState(false);
  // Whether Under the hood was left open in the sidebar, in this browser
  const [hoodKept, keepHood] = useRemembered('minca:hood-open');
  const [hoodOpen, setHoodOpen] = useState(() => hoodKept === '1' || hood !== undefined);
  const openHood = (open: boolean) => {
    setHoodOpen(open);
    keepHood(open ? '1' : '0');
  };
  // Wherever a view under the hood is opened from, the sidebar unfolds to show where one is.
  // Adjusted while rendering rather than in an effect, so the folded sidebar is never painted.
  const [wasHood, setWasHood] = useState(hood?.id);
  if (hood?.id !== wasHood) {
    setWasHood(hood?.id);
    if (hood) setHoodOpen(true);
  }

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
  const openApp = (appId: string) =>
    void navigate({ to: '/spaces/$spaceId/apps/$appId', params: { spaceId: space.id, appId } });
  // In Data, a record opens in its own collection. Elsewhere it opens in the app that shows its
  // collection, so a message opens in the chat: the open one if it does, else the only one, else
  // the person picks one. With none, or when that app asks (`here`) to open one of its own,
  // beside what is open.
  const showing = (collection: string) =>
    apps.ready.filter((app) => app.record.body?.shows?.includes(collection) === true);
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
    const can = here ? [] : showing(r.collection);
    const app = can.find((one) => one.id === open?.id) ?? (can.length === 1 ? can[0] : undefined);
    if (app) return openIn(r, app);
    if (can.length > 1) return setChoosing(r);
    void navigate({ to: '.', search: (was) => ({ ...was, record: r.key }) });
  };
  const clearShown = () =>
    void navigate({ to: '.', search: (was) => ({ ...was, at: undefined }), replace: true });
  const closeRecord = () => void navigate({ to: '.', search: (was) => ({ ...was, record: undefined }) });

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

  // The sidebar's apps: the first few, and the open one wherever it sits; the rest behind "more", with what is new in them.
  const folds = apps.ready.length > SIDEBAR_APPS;
  const listed =
    folds && !everyApp
      ? apps.ready.filter((app, at) => at < SIDEBAR_APPS || app.id === open?.id)
      : apps.ready;
  const folded = apps.ready.filter((app) => !listed.includes(app));
  const newInFolded = totalOf(folded.map((app) => unreadOf(unread, app.id)));

  const fill = open ? fills(open) : false;
  // Dropped on another app: it goes where that one is, for everyone in the space.
  const dropOn = (target: AppEntry) => {
    const key = dragging;
    setDragging(null);
    if (!key || key === target.record.key) return;
    const to = apps.placed.findIndex((placed) => placed.key === target.record.key);
    void moving.run(() => moveApp(node, space.id, apps.placed, key, to));
  };
  const title =
    open?.title ??
    [
      ...SECTIONS,
      ...HOOD,
      { to: '/spaces/$spaceId/new', label: 'New app' },
      { to: '/spaces/$spaceId/more', label: 'More' },
    ].find((part) => part.to === leaf)?.label ??
    space.name;

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
  };

  return (
    <PersonScopeProvider space={space} people={people} roles={roleOf} me={account.did} openSpace={openSpace}>
      <div className="space-shell" data-app-open={open ? '' : undefined}>
        <aside className="space-sidebar" aria-label={space.name}>
          <div className="space-sidebar-scroll">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 12px' }}>
              <SpaceMark space={space} size={32} />
              <div style={{ minWidth: 0 }}>
                <strong
                  style={{
                    ...ui.ellipsis,
                    display: 'block',
                    fontFamily: palette.display,
                    fontSize: 16,
                    fontWeight: 700,
                    letterSpacing: '-0.04em',
                    color: palette.ink.strong,
                  }}
                >
                  {space.name}
                </strong>
                <Privacy space={space} />
              </div>
            </div>
            {status && (
              <div style={{ padding: '0 8px 12px' }}>
                <WhoIsHere status={status} people={people} onOpen={() => go('/spaces/$spaceId/network')} />
              </div>
            )}

            <nav aria-label="This space" style={stack(1)}>
              <SideItem
                icon={<Icon name="apps" size={16} />}
                label="All apps"
                unread={newProposals}
                on={onApps}
                onClick={() => go('/spaces/$spaceId')}
              />
              <CallButton space={space} place="sidebar" />
              <SideHeading>Apps</SideHeading>
              {listed.map((app) => (
                <SideItem
                  key={app.id}
                  icon={<AppIcon id={app.id} size={20} />}
                  label={app.title}
                  unread={unreadOf(unread, app.id)}
                  on={open?.id === app.id}
                  onClick={() => openApp(app.id)}
                  {...(mayDefine
                    ? {
                        drag: {
                          over: dragging !== null && dragging !== app.record.key,
                          onStart: () => setDragging(app.record.key),
                          onEnd: () => setDragging(null),
                          onDrop: () => dropOn(app),
                        },
                      }
                    : {})}
                />
              ))}
              {moving.error && (
                <p role="alert" style={{ ...styles.error, padding: '2px 8px', fontSize: 12 }}>
                  {moving.error}
                </p>
              )}
              {folds && (
                <SideItem
                  icon={
                    <span
                      style={{
                        display: 'inline-flex',
                        transform: everyApp ? 'rotate(-90deg)' : 'rotate(90deg)',
                      }}
                    >
                      <Icon name="chevron" size={12} />
                    </span>
                  }
                  label={everyApp ? 'Show fewer' : `${folded.length} more`}
                  unread={newInFolded}
                  quiet
                  expanded={everyApp}
                  onClick={() => setEveryApp(!everyApp)}
                />
              )}
              {space.writable && (
                <SideItem
                  icon={<Icon name="plus" size={16} />}
                  label="New app"
                  quiet
                  on={onNew}
                  onClick={() => go('/spaces/$spaceId/new')}
                />
              )}
              <SideHeading>Space</SideHeading>
              {SECTIONS.map((section) => (
                <SideItem
                  key={section.to}
                  icon={<Icon name={section.icon} size={16} />}
                  label={section.label}
                  on={leaf === section.to}
                  onClick={() => go(section.to)}
                />
              ))}
            </nav>

            <nav aria-label="Under the hood" style={{ ...stack(1), marginTop: 'auto', paddingTop: 24 }}>
              <button
                onClick={() => openHood(!hoodOpen)}
                aria-expanded={hoodOpen}
                aria-current={!hoodOpen && hood ? 'page' : undefined}
                data-nav
                className="side-item"
                style={{ color: palette.ink.faint, fontSize: 13 }}
              >
                <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="layers" size={14} />
                </span>
                <span style={{ ...ui.ellipsis, flex: 1, minWidth: 0 }}>Under the hood</span>
                <span
                  style={{
                    display: 'inline-flex',
                    transform: hoodOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform .12s ease',
                  }}
                >
                  <Icon name="chevron" size={12} />
                </span>
              </button>
              {hoodOpen &&
                HOOD.map((h) => (
                  <SideItem
                    key={h.id}
                    icon={<Icon name={h.icon} size={16} />}
                    label={h.label}
                    quiet
                    on={hood?.id === h.id}
                    onClick={() => go(h.to)}
                  />
                ))}
            </nav>
          </div>

          {/* You, the way chat apps put you: at the foot of the sidebar, with what's new for you. */}
          <div className="you-bar">
            <AccountMenu place="sidebar" />
            <Bell spaces={spaces} here={space} place="above" onOpenSpace={openSpace} />
          </div>
        </aside>

        <main className="space-main">
          <header className="space-bar">
            {onApp ? (
              <QuietButton
                onClick={() => go('/spaces/$spaceId')}
                aria-label="All apps"
                className="phone-only"
                style={{ width: 36, padding: 0 }}
              >
                <Icon name="back" size={16} />
              </QuietButton>
            ) : (
              <span className="phone-only" style={{ display: 'contents' }}>
                <SpaceMark space={space} size={30} />
              </span>
            )}
            {open && <AppIcon id={open.id} size={28} />}
            <div style={{ flex: 1, minWidth: 0, ...stack(1) }}>
              <h1 style={{ ...styles.appTitle, ...ui.ellipsis, fontSize: 18 }}>{title}</h1>
              {/* Under the space's name on a phone, as the sidebar has it beside a wide screen. */}
              {onApps && (
                <span className="phone-only">
                  <Privacy space={space} />
                </span>
              )}
            </div>
            {open && mayDefine && <AppSettingsButton space={space} record={open.record} />}
            {open && <NotifyButton space={space} app={open} collections={collections} />}
            {/* A phone has no sidebar, so you are in its top bar instead; an open app has the bar to itself. */}
            {!onApp && (
              <span className="phone-only">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Bell spaces={spaces} here={space} onOpenSpace={openSpace} />
                  <AccountMenu />
                </span>
              </span>
            )}
          </header>

          <div className="space-content" data-fill={fill || undefined}>
            <div className="space-inner" data-wide={hood ? true : undefined}>
              <Notices inSpace />
              {!hood && <RelayDown />}
              {onApps && (
                <div className="phone-only">
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20, minWidth: 0 }}
                  >
                    {status && (
                      <WhoIsHere
                        status={status}
                        people={people}
                        onOpen={() => go('/spaces/$spaceId/network')}
                      />
                    )}
                    <CallButton space={space} place="chip" />
                  </div>
                </div>
              )}
              {!space.writable && (
                <p style={{ ...styles.errorHint, marginTop: 0, marginBottom: 16 }}>
                  {space.joining
                    ? 'Joining — waiting for your invite to arrive from someone in the space. It will, once one of them is online.'
                    : "You're following this space: you can see it but not change it. Someone who runs it can give you a role."}
                </p>
              )}
              {status && status.rejected > 0 && !onApp && (
                <button
                  onClick={() => go('/spaces/$spaceId/network')}
                  style={{
                    ...styles.badge,
                    color: palette.accent.danger,
                    border: 'none',
                    cursor: 'pointer',
                    marginBottom: 16,
                  }}
                  title="Records peers sent that failed validation"
                >
                  {status.rejected} rejected
                </button>
              )}

              {hood && (
                <div style={{ ...stack(10), marginBottom: 24 }}>
                  <div role="tablist" aria-label="Under the hood" className="segmented phone-only scroll-x">
                    {HOOD.map((h) => (
                      <button key={h.id} role="tab" aria-selected={hood.id === h.id} onClick={() => go(h.to)}>
                        <Icon name={h.icon} size={14} />
                        {h.label}
                      </button>
                    ))}
                  </div>
                  {'about' in hood && <p style={styles.quiet}>{hood.about}</p>}
                </div>
              )}

              <SpaceScreenContext value={screen}>
                <Outlet />
              </SpaceScreenContext>
            </div>
          </div>
        </main>

        {/* On a phone the sections move under the thumb, with the way home. */}
        <nav aria-label="This space" className="tabbar">
          <button onClick={goHome}>
            <Icon name="home" size={20} />
            Spaces
          </button>
          <button
            onClick={() => go('/spaces/$spaceId')}
            aria-current={onApps || onApp || onNew ? 'page' : undefined}
          >
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icon name="apps" size={20} />
              <span className="tab-count">
                <Count unread={totalOf([...unread.values(), newProposals])} />
              </span>
            </span>
            Apps
          </button>
          <button onClick={() => go('/spaces/$spaceId/people')} aria-current={onPeople ? 'page' : undefined}>
            <Icon name="people" size={20} />
            People
          </button>
          <button
            onClick={() => go('/spaces/$spaceId/more')}
            aria-current={!onApps && !onApp && !onNew && !onPeople ? 'page' : undefined}
          >
            <Icon name="menu" size={20} />
            More
          </button>
        </nav>
      </div>

      {record && (
        <RecordPanel
          space={space}
          recordKey={record}
          collections={collections}
          onOpen={openRecord}
          onClose={closeRecord}
          onOpenWith={(r) => (showing(r.collection).length > 1 ? () => setChoosing(r) : undefined)}
        />
      )}

      {choosing && (
        <OpenWith
          apps={showing(choosing.collection)}
          onClose={() => setChoosing(null)}
          onChoose={(app) => {
            setChoosing(null);
            openIn(choosing, app);
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

/** An open app: its screen, or its records as lists */
export function OpenApp({ app }: { app: AppEntry }) {
  const { space, collections, openRecord, shown, clearShown } = useSpaceScreen();
  return (
    <MadeAppScreen
      space={space}
      record={app.record}
      collections={collections}
      onOpen={(r) => openRecord(r, app.record.body?.shows?.includes(r.collection))}
      shown={shown}
      onShown={clearShown}
    />
  );
}

/** Who can read the space, in a word */
function Privacy({ space }: { space: SpaceSummary }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12.5,
        color: palette.ink.muted,
      }}
      title={
        space.visibility === 'private'
          ? 'Encrypted end to end: only people in the space hold the key'
          : 'Not encrypted: anyone with the link can read it'
      }
    >
      <Icon name={space.visibility === 'private' ? 'lock' : 'globe'} size={12} />
      {space.visibility === 'private' ? 'Private' : 'Public'}
      {space.role ? ` · ${space.role}` : ''}
    </span>
  );
}

export function SideHeading({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        padding: '16px 8px 4px',
        fontSize: 12.5,
        fontWeight: 500,
        color: palette.ink.muted,
      }}
    >
      {children}
    </span>
  );
}

/** A row of a phone's More: a section to open, tall enough for a thumb */
export function MoreRow({
  icon,
  label,
  quiet,
  onClick,
}: {
  icon: IconName;
  label: string;
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      data-nav
      className="side-item"
      style={{ height: 48, fontSize: 15, color: quiet ? palette.ink.muted : palette.ink.strong }}
    >
      <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={18} />
      </span>
      <span style={{ ...ui.ellipsis, flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ display: 'inline-flex', color: palette.ink.faint }}>
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}

/** A row in the sidebar; bold while something in it is new, the way unread channels are */
function SideItem({
  icon,
  label,
  unread,
  on,
  quiet,
  expanded,
  drag,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  unread?: Unread;
  on?: boolean;
  quiet?: boolean;
  /** For a row that folds others away: whether they show now */
  expanded?: boolean;
  /** For a row that can be dragged to a new place, and another dropped on */
  drag?: {
    readonly over: boolean;
    readonly onStart: () => void;
    readonly onEnd: () => void;
    readonly onDrop: () => void;
  };
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      aria-expanded={expanded}
      data-nav
      className="side-item"
      {...(drag
        ? {
            draggable: true,
            onDragStart: (event: DragEvent) => {
              event.dataTransfer.effectAllowed = 'move';
              // Some browsers start no drag without data.
              event.dataTransfer.setData('text/plain', label);
              drag.onStart();
            },
            onDragEnd: () => {
              setHovered(false);
              drag.onEnd();
            },
            onDragOver: (event: DragEvent) => {
              if (!drag.over) return;
              event.preventDefault();
              setHovered(true);
            },
            onDragLeave: () => setHovered(false),
            onDrop: (event: DragEvent) => {
              event.preventDefault();
              setHovered(false);
              drag.onDrop();
            },
          }
        : {})}
      style={{
        outline: hovered ? `1px dashed ${palette.surface.lineStrong}` : undefined,
        color:
          on || (unread?.count ?? 0) > 0 ? palette.ink.strong : quiet ? palette.ink.muted : palette.ink.body,
        fontWeight: on || (unread?.count ?? 0) > 0 ? 600 : 400,
      }}
    >
      <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ ...ui.ellipsis, flex: 1, minWidth: 0 }}>{label}</span>
      {unread && <Count unread={unread} />}
    </button>
  );
}
