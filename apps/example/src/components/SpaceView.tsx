import { createContext, useContext, useState, type ReactNode } from 'react';
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
import { NEW } from './DataView';
import { SpaceMark } from './SpaceList';
import { AddPeople } from './InvitePeople';
import { Avatar } from '@minca/app-shared/Avatar';
import type { PairWith } from '../contacts';
import { AccountMenu } from './AccountMenu';
import { usePopover } from './usePopover';
import { styles, palette, stack, ui } from '../styles';
import { Icon, type IconName } from './Icon';
import { WhoIsHere } from './WhoIsHere';
import { RelayDown } from './RelayNotice';
import { Notices, useWorkspace } from '../workspace';
import { CallButton } from './calls/Calls';
import { peopleFrom } from '../derive/people';
import { useBots } from '../bots';
import { PersonScopeProvider } from './Person';
import { seenAt, unreadOf, useLookingAt, useSeen, useSpaceUnread, useUnread, type Unread } from '../seen';

/** Under the hood: the views for the curious, folded in the space's menu */
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
  const navigate = useNavigate();
  // Where in the space you are, and the record open beside it: the address holds both.
  const leaf = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const openId = useParams({ strict: false }).appId;
  const { record, at } = useSearch({ from: '/spaces/$spaceId' });
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

  const fill = open ? fills(open) : false;
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
        {/* The space's apps down the left edge, under the space itself; a phone has them as tabs. */}
        <nav className="app-rail" aria-label={`Apps in ${name}`}>
          <div className="rail-top">
            <SpaceMenu space={space} pair={pair} title={title} leaf={leaf} go={go} onHome={goBack} face />
          </div>
          <div className="rail-apps">
            {apps.ready.map((app) => (
              <RailItem
                key={app.id}
                icon={<AppIcon id={app.id} size={28} />}
                label={app.title}
                unread={unreadOf(unread, app.id)}
                on={open?.id === app.id}
                onClick={() => openApp(app.id)}
              />
            ))}
            {space.writable && (
              <RailItem
                icon={
                  <span className="rail-slot">
                    <Icon name="plus" size={14} />
                  </span>
                }
                label="Add"
                on={onNew}
                onClick={() => go('/spaces/$spaceId/new')}
              />
            )}
          </div>
          <div className="rail-foot">
            {/* Every app, laid out, with the ones proposed. */}
            <RailItem
              icon={
                <span className="rail-glyph">
                  <Icon name="apps" size={18} />
                </span>
              }
              label="All apps"
              unread={newProposals}
              on={onApps}
              onClick={() => go('/spaces/$spaceId')}
            />
            {/* You, and what's new for you, at its foot. */}
            <Bell spaces={spaces} here={space} onOpenSpace={openSpace} />
            <AccountMenu />
          </div>
        </nav>

        <main className="space-main">
          <header className="space-bar">
            {/* A phone has no rail: the space is the name at the left of its bar. */}
            <span className="phone-only" style={{ flex: 1, minWidth: 0 }}>
              <SpaceMenu space={space} pair={pair} title={title} leaf={leaf} go={go} onHome={goBack} />
            </span>
            <span className="hide-on-phone" style={{ display: 'contents' }}>
              {open && <AppIcon id={open.id} size={28} />}
              <h1 style={{ ...styles.appTitle, ...ui.ellipsis, flex: 1, minWidth: 0, fontSize: 18 }}>
                {title}
              </h1>
              {/* Who is here, and calling them; a phone has them on the space's apps. */}
              {status && (
                <WhoIsHere status={status} people={people} onOpen={() => go('/spaces/$spaceId/network')} />
              )}
              <CallButton space={space} place="chip" />
            </span>
            {open && mayDefine && <AppSettingsButton space={space} record={open.record} />}
          </header>
          {/* A phone's apps: tabs under the bar, swiped along, the way to the next one a thumb away. */}
          <nav className="app-tabs scroll-x" aria-label={`Apps in ${name}`}>
            {apps.ready.map((app) => (
              <button
                key={app.id}
                onClick={() => openApp(app.id)}
                aria-current={open?.id === app.id ? 'page' : undefined}
                className="app-tab"
              >
                <AppIcon id={app.id} size={18} />
                {app.title}
                <Count unread={unreadOf(unread, app.id)} />
              </button>
            ))}
            <button
              onClick={() => go('/spaces/$spaceId')}
              aria-current={onApps ? 'page' : undefined}
              className="app-tab"
            >
              <Icon name="apps" size={14} />
              All
              <Count unread={newProposals} />
            </button>
            {space.writable && (
              <button
                onClick={() => go('/spaces/$spaceId/new')}
                aria-current={onNew ? 'page' : undefined}
                aria-label="Add apps"
                className="app-tab"
              >
                <Icon name="plus" size={14} />
              </button>
            )}
          </nav>

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
 * The way around a space, from the space itself: its face at the top of the rail, or its name at the
 * left of a phone's bar. A dropdown that names the space, then goes home, to your other groups, and
 * to the space's own sections and what is under its hood.
 */
function SpaceMenu({
  space,
  pair,
  title,
  leaf,
  go,
  onHome,
  face,
}: {
  space: SpaceSummary;
  pair: PairWith | undefined;
  /** Where in the space you are, under its name on a phone */
  title: string;
  leaf: RouteId | undefined;
  go: (to: SpacePath) => void;
  onHome: () => void;
  /** Opened from the space's face alone, at the top of the rail, rather than from its name */
  face?: boolean;
}) {
  const { spaces, pairs, openSpace, forget } = useWorkspace();
  const { open: shown, setOpen, close, root } = usePopover();
  const name = pair?.name ?? space.name;
  const others = spaces.filter((other) => other.id !== space.id && !pairs.has(other.id));
  // Folded away, unless one of its views is open.
  const [hoodOpen, setHoodOpen] = useState(HOOD.some((h) => h.to === leaf));
  // Each row closes the menu on its way.
  const then = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <div ref={root} style={{ position: 'relative', display: 'flex' }}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-expanded={shown}
        aria-haspopup="menu"
        aria-label={face ? name : undefined}
        title={face ? name : undefined}
        className="group-button"
        style={face ? faceButton : nameButton}
      >
        <SpaceFace space={space} pair={pair} size={face ? 40 : 32} />
        {!face && (
          <span style={{ ...stack(1), minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ ...styles.appTitle, ...ui.ellipsis, fontSize: 18 }}>{name}</span>
              <span style={{ display: 'inline-flex', transform: shown ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
                <Icon name="chevron" size={14} />
              </span>
            </span>
            {title === name ? (
              <Privacy space={space} />
            ) : (
              <span style={{ ...ui.ellipsis, fontSize: 12.5, color: palette.ink.muted }}>{title}</span>
            )}
          </span>
        )}
      </button>
      {shown && (
        <nav
          aria-label={name}
          className={face ? undefined : 'drop'}
          style={face ? { ...menu, ...beside } : menu}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px 10px' }}>
            <SpaceFace space={space} pair={pair} size={32} />
            <span style={{ ...stack(1), minWidth: 0 }}>
              <strong style={{ ...styles.appTitle, ...ui.ellipsis, fontSize: 16 }}>{name}</strong>
              <Privacy space={space} />
            </span>
          </div>
          <SideItem icon={<Icon name="home" size={16} />} label="Home" onClick={then(onHome)} />
          {others.length > 0 && <SideHeading>Switch to</SideHeading>}
          {others.map((other) => (
            <OtherGroup key={other.id} space={other} onClick={then(() => openSpace(other.id))} />
          ))}
          <SideHeading>{pair ? 'This chat' : 'This group'}</SideHeading>
          {/* A space for two is the two of you, so nobody is invited to it. */}
          {SECTIONS.filter((section) => !pair || !FOR_GROUPS.has(section.to)).map((section) => (
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
          <div style={{ height: 1, background: palette.surface.line, margin: '6px 4px' }} />
          <button
            onClick={then(() => forget(space.id))}
            data-nav
            className="side-item"
            style={{ width: '100%', color: palette.accent.danger }}
          >
            <span style={{ width: 20, flexShrink: 0 }} />
            {pair ? 'Leave this chat' : 'Leave group'}
          </button>
        </nav>
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

/** An app on the rail: its shape, its name under it, what's new on its corner, and a bar beside it while open */
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
    <button onClick={onClick} aria-current={on ? 'page' : undefined} title={label} className="rail-item">
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        {icon}
        {unread && (
          <span className="rail-count">
            <Count unread={unread} />
          </span>
        )}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

const nameButton = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  maxWidth: '100%',
  padding: '4px 10px 4px 4px',
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
  textAlign: 'left' as const,
  color: palette.ink.strong,
};
/** The space's face alone, as a rail's first tile */
const faceButton = {
  display: 'flex',
  padding: 6,
  border: 'none',
  borderRadius: palette.radius.md,
  background: 'none',
};

/** Below the name; a phone pins it under the bar instead (`.drop`) */
const menu = {
  ...styles.float,
  ...stack(1),
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  zIndex: 20,
  width: 300,
  padding: 8,
  maxHeight: 'min(560px, calc(100vh - 90px))',
  overflowY: 'auto',
  animation: 'minca-fade .1s ease',
} as const;
/** Opened from the rail, the menu sits beside the face */
const beside = { top: 0, left: 'calc(100% + 8px)' } as const;

/** A row in the sidebar; bold while something in it is new, the way unread channels are */
function SideItem({
  icon,
  label,
  unread,
  on,
  quiet,
  expanded,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  unread?: Unread;
  on?: boolean;
  quiet?: boolean;
  /** For a row that folds others away: whether they show now */
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      aria-expanded={expanded}
      data-nav
      className="side-item"
      style={{
        width: '100%',
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
