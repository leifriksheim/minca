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
import { AppSettingsButton } from './apps/AppSettings';
import { MadeAppScreen } from './apps/MadeApps';
import { Bell } from './Bell';
import { fills, useSpaceApps, type AppEntry } from './apps/entries';
import { moveApp } from './apps/launcher';
import { NEW } from './DataView';
import { SpaceMark } from './SpaceList';
import { AddPeople } from './InvitePeople';
import { Avatar } from '@minca/app-shared/Avatar';
import type { PairWith } from '../contacts';
import { AccountMenu } from './AccountMenu';
import { usePopover } from './usePopover';
import { styles, palette, stack, ui } from '../styles';
import { useAction } from '@minca/app-shared/action';
import { Icon, type IconName } from './Icon';
import { WhoIsHere } from './WhoIsHere';
import { RelayDown } from './RelayNotice';
import { Notices, useWorkspace } from '../workspace';
import { CallButton } from './calls/Calls';
import { peopleFrom } from '../derive/people';
import { useBots } from '../bots';
import { PersonScopeProvider } from './Person';
import {
  seenAt,
  totalOf,
  unreadOf,
  useLookingAt,
  useSeen,
  useSpaceUnread,
  useUnread,
  type Unread,
} from '../seen';

/** Under the hood: the views for the curious, folded at the foot of the sidebar */
const HOOD = [
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
const SECTIONS = [
  { to: '/spaces/$spaceId/members', label: 'Members', icon: 'people' },
  { to: '/spaces/$spaceId/invite', label: 'Invite', icon: 'invite' },
  { to: '/spaces/$spaceId/hosting', label: 'Hosting', icon: 'cloud' },
  { to: '/spaces/$spaceId/automations', label: 'Automations', icon: 'bolt' },
] as const satisfies ReadonlyArray<{ to: SpacePath; label: string; icon: IconName }>;

/** The sections only a group has: a space for two is the two of you */
const FOR_GROUPS: ReadonlySet<string> = new Set(['/spaces/$spaceId/members', '/spaces/$spaceId/invite']);

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
      <div className="page">
        <div style={styles.app}>
          <p style={styles.emptyState}>This space isn't on this device.</p>
          <Link to="/">Your spaces</Link>
        </div>
      </div>
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
  const node = useNode();
  const navigate = useNavigate();
  // Where in the space you are, and the record open beside it: the address holds both.
  const leaf = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const openId = useParams({ strict: false }).appId;
  const { record, at } = useSearch({ from: '/spaces/$spaceId' });
  const onApps = leaf === APPS_ROUTE;
  const onApp = leaf === APP_ROUTE;
  const hood = HOOD.find((h) => h.to === leaf);
  const onNew = leaf === '/spaces/$spaceId/new';

  // The app being dragged to a new place in the sidebar, by its launcher record, and why a move failed
  const [dragging, setDragging] = useState<string | null>(null);
  const moving = useAction();
  const [creating, setCreating] = useState(false);
  // A record more than one app can open, while the person picks which
  const [choosing, setChoosing] = useState<NodeRecord | null>(null);
  const [everyApp, setEveryApp] = useState(false);
  // Under the hood is folded away, unless one of its views is open.
  const [hoodOpen, openHood] = useState(hood !== undefined);
  // Wherever a view under the hood is opened from, the sidebar unfolds to show where one is.
  // Adjusted while rendering rather than in an effect, so the folded sidebar is never painted.
  const [wasHood, setWasHood] = useState(hood?.id);
  if (hood?.id !== wasHood) {
    setWasHood(hood?.id);
    if (hood) openHood(true);
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

  // Back to the list it was opened from.
  const goBack = () => void navigate({ to: pair ? '/people' : '/' });
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
    [...SECTIONS, ...HOOD, { to: '/spaces/$spaceId/new', label: 'Add apps' }].find((part) => part.to === leaf)
      ?.label ??
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
  };

  return (
    <PersonScopeProvider space={space} people={people} roles={roleOf} me={account.did} openSpace={openSpace}>
      <div className="space-shell" data-app-open={open ? '' : undefined}>
        <aside className="space-sidebar" aria-label={space.name}>
          <div className="space-sidebar-scroll">
            <GroupMenu space={space} pair={pair} go={go} onHome={goBack} />
            {/* Who is here, and calling them. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 8px', minWidth: 0 }}>
              {status && (
                <WhoIsHere status={status} people={people} onOpen={() => go('/spaces/$spaceId/network')} />
              )}
              <CallButton space={space} place="chip" />
            </div>

            <nav aria-label="This space" style={stack(1)}>
              <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4 }}>
                <span style={{ flex: 1 }}>
                  <SideHeading>Apps</SideHeading>
                </span>
                {/* Every app, laid out, with the ones proposed: what's new there shows on it. */}
                <button
                  onClick={() => go('/spaces/$spaceId')}
                  aria-current={onApps ? 'page' : undefined}
                  aria-label="All apps"
                  title="All apps"
                  data-nav
                  className="side-item"
                  style={{
                    position: 'relative',
                    width: 30,
                    height: 28,
                    padding: 0,
                    justifyContent: 'center',
                    marginTop: 12,
                  }}
                >
                  <Icon name="apps" size={14} />
                  {newProposals.count > 0 && (
                    <span style={{ position: 'absolute', top: -6, right: -6 }}>
                      <Count unread={newProposals} />
                    </span>
                  )}
                </button>
              </div>
              {listed.map((app) => (
                <SideItem
                  key={app.id}
                  app
                  icon={<AppIcon id={app.id} size={24} />}
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
                  app
                  icon={
                    <span className="app-slot" aria-hidden>
                      <Icon name="plus" size={12} />
                    </span>
                  }
                  label="Add apps"
                  quiet
                  on={onNew}
                  onClick={() => go('/spaces/$spaceId/new')}
                />
              )}
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
            <AccountMenu />
            <Bell spaces={spaces} here={space} onOpenSpace={openSpace} />
          </div>
        </aside>

        <main className="space-main">
          <header className="space-bar">
            <span className="phone-only" style={{ flex: 1, minWidth: 0 }}>
              <SpaceMenu
                space={space}
                pair={pair}
                title={title}
                apps={apps.ready}
                unread={unread}
                newProposals={newProposals}
                open={open}
                leaf={leaf}
                go={go}
                openApp={openApp}
                onHome={goBack}
              />
            </span>
            <span className="hide-on-phone" style={{ display: 'contents' }}>
              {open && <AppIcon id={open.id} size={28} />}
              <h1 style={{ ...styles.appTitle, ...ui.ellipsis, flex: 1, minWidth: 0, fontSize: 18 }}>
                {title}
              </h1>
            </span>
            {open && mayDefine && <AppSettingsButton space={space} record={open.record} />}
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
  return pair ? <Avatar did={pair.face} size={size} round /> : <SpaceMark space={space} size={size} />;
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

function SideHeading({ children }: { children: ReactNode }) {
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

/**
 * A wide screen's way around from a space, from its name at the top of the sidebar, the way a
 * Slack workspace's is: home, your other groups to switch to, and what is done to this one.
 */
function GroupMenu({
  space,
  pair,
  go,
  onHome,
}: {
  space: SpaceSummary;
  pair: PairWith | undefined;
  go: (to: SpacePath) => void;
  onHome: () => void;
}) {
  const { spaces, pairs, openSpace, forget } = useWorkspace();
  const { open, setOpen, close, root } = usePopover();
  const name = pair?.name ?? space.name;
  const others = spaces.filter((other) => other.id !== space.id && !pairs.has(other.id));
  // Each row closes the menu on its way.
  const then = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <div ref={root} style={{ position: 'relative', marginBottom: 8 }}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="side-item group-button"
        style={{ width: '100%', height: 'auto', padding: 8, gap: 10 }}
      >
        <SpaceFace space={space} pair={pair} size={32} />
        <span style={{ ...stack(1), flex: 1, minWidth: 0 }}>
          <strong style={groupTitle}>{name}</strong>
          <Privacy space={space} />
        </span>
        <span
          style={{
            display: 'inline-flex',
            color: palette.ink.muted,
            transform: open ? 'rotate(-90deg)' : 'rotate(90deg)',
          }}
        >
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {open && (
        <div role="menu" style={groupMenu}>
          <SideItem icon={<Icon name="home" size={16} />} label="Home" onClick={then(onHome)} />
          {others.length > 0 && <SideHeading>Switch to</SideHeading>}
          {others.map((other) => (
            <OtherGroup key={other.id} space={other} onClick={then(() => openSpace(other.id))} />
          ))}
          <div style={{ height: 1, background: palette.surface.line, margin: '6px 4px' }} />
          {/* What is done to the space itself, which most people need now and then. A space for two
              is the two of you, so nobody is invited to it. */}
          {SECTIONS.filter((section) => !pair || !FOR_GROUPS.has(section.to)).map((section) => (
            <SideItem
              key={section.to}
              icon={<Icon name={section.icon} size={16} />}
              label={section.label}
              onClick={then(() => go(section.to))}
            />
          ))}
          <button
            onClick={then(() => forget(space.id))}
            data-nav
            className="side-item"
            style={{ color: palette.accent.danger }}
          >
            <span style={{ width: 20, flexShrink: 0 }} />
            {pair ? 'Leave this chat' : 'Leave group'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Another group to switch to, with what is new in it */
function OtherGroup({ space, onClick }: { space: SpaceSummary; onClick: () => void }) {
  return (
    <SideItem
      icon={<SpaceMark space={space} size={20} />}
      label={space.name}
      unread={useSpaceUnread(space)}
      onClick={onClick}
    />
  );
}

/** A group goes by its name in the display face */
const groupTitle = {
  ...ui.ellipsis,
  display: 'block',
  fontFamily: palette.display,
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: '-0.04em',
  color: palette.ink.strong,
} as const;

const groupMenu = {
  ...styles.float,
  ...stack(1),
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  zIndex: 20,
  padding: 6,
  maxHeight: 'min(440px, 70vh)',
  overflowY: 'auto',
  animation: 'minca-fade .1s ease',
} as const;

/**
 * A phone's way around a space, from its name at the top, the way a Discord server's is: the way
 * home, its apps, its own sections and what is under the hood, in one menu.
 */
function SpaceMenu({
  space,
  pair,
  title,
  apps,
  unread,
  newProposals,
  open,
  leaf,
  go,
  openApp,
  onHome,
}: {
  space: SpaceSummary;
  pair: PairWith | undefined;
  /** Where in the space you are */
  title: string;
  apps: ReadonlyArray<AppEntry>;
  unread: ReturnType<typeof useUnread>;
  newProposals: Unread;
  open: AppEntry | undefined;
  leaf: RouteId | undefined;
  go: (to: SpacePath) => void;
  openApp: (id: string) => void;
  onHome: () => void;
}) {
  const { open: shown, setOpen, close, root } = usePopover();
  const name = pair?.name ?? space.name;
  // Each row closes the menu on its way.
  const then = (action: () => void) => () => {
    close();
    action();
  };
  const newHere = totalOf([...unread.values(), newProposals]);
  // Folded away, unless one of its views is open.
  const [hoodOpen, setHoodOpen] = useState(HOOD.some((h) => h.to === leaf));
  return (
    <div ref={root}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={shown}
        aria-haspopup="menu"
        style={menuButton}
      >
        <SpaceFace space={space} pair={pair} size={32} />
        <span style={{ ...stack(1), minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ ...styles.appTitle, ...ui.ellipsis, fontSize: 18 }}>{name}</span>
            <span style={{ display: 'inline-flex', transform: shown ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
              <Icon name="chevron" size={14} />
            </span>
            {!shown && <Count unread={newHere} />}
          </span>
          {title === name ? (
            <Privacy space={space} />
          ) : (
            <span style={{ ...ui.ellipsis, fontSize: 12.5, color: palette.ink.muted }}>{title}</span>
          )}
        </span>
      </button>
      {shown && (
        <nav aria-label={name} className="drop" style={{ ...styles.float, ...stack(1), padding: 8 }}>
          <SideItem icon={<Icon name="home" size={16} />} label="Home" quiet onClick={then(onHome)} />
          <SideItem
            icon={<Icon name="apps" size={16} />}
            label="All apps"
            unread={newProposals}
            on={leaf === APPS_ROUTE}
            onClick={then(() => go('/spaces/$spaceId'))}
          />
          <SideHeading>Apps</SideHeading>
          {apps.map((app) => (
            <SideItem
              key={app.id}
              icon={<AppIcon id={app.id} size={20} />}
              label={app.title}
              unread={unreadOf(unread, app.id)}
              on={open?.id === app.id}
              onClick={then(() => openApp(app.id))}
            />
          ))}
          {space.writable && (
            <SideItem
              icon={<Icon name="plus" size={16} />}
              label="Add apps"
              quiet
              on={leaf === '/spaces/$spaceId/new'}
              onClick={then(() => go('/spaces/$spaceId/new'))}
            />
          )}
          <SideHeading>Space</SideHeading>
          {SECTIONS.map((section) => (
            <SideItem
              key={section.to}
              icon={<Icon name={section.icon} size={16} />}
              label={section.label}
              on={leaf === section.to}
              onClick={then(() => go(section.to))}
            />
          ))}
          <SideItem
            icon={<Icon name="layers" size={16} />}
            label="Under the hood"
            quiet
            expanded={hoodOpen}
            onClick={() => setHoodOpen(!hoodOpen)}
          />
          {hoodOpen &&
            HOOD.map((h) => (
              <SideItem
                key={h.id}
                icon={<Icon name={h.icon} size={16} />}
                label={h.label}
                quiet
                on={leaf === h.to}
                onClick={then(() => go(h.to))}
              />
            ))}
        </nav>
      )}
    </div>
  );
}

const menuButton = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  maxWidth: '100%',
  padding: 0,
  border: 'none',
  background: 'none',
  textAlign: 'left' as const,
  color: palette.ink.strong,
};

/** A row in the sidebar; bold while something in it is new, the way unread channels are */
function SideItem({
  icon,
  label,
  unread,
  on,
  quiet,
  expanded,
  drag,
  app,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** An app in the sidebar's list: a taller row, with room for its shape */
  app?: boolean;
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
      className={app ? 'side-item app-item' : 'side-item'}
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
