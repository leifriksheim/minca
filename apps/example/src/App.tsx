import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { invitableRoles, useAsking, useHeldSpaces, usePairSpaces, useSpaceInvites } from './contacts';
import { SpaceInvites } from './components/PeopleParts';
import type { NewSpace } from '@minca/core';
import {
  inviteFromLink,
  useAccount,
  useAccountPicture,
  useConnection,
  useNode,
  useSpaces,
} from '@minca/react';
import { CallsProvider } from '@minca/calls/react';
import { useShowNotifications } from './notifications';
import { useRememberPicture } from '@minca/app-shared/rememberedPictures';
import { TabBar } from './components/TabBar';
import { useRunAutomations } from './automations';
import { ConnectScreen } from './components/ConnectScreen';
import { useAccountInAddress } from './account-address';
import { ContactsView } from './components/ContactsView';
import { RelayDown } from './components/RelayNotice';
import { GroupRow, SpaceCount, SpaceDialog, SpaceList } from './components/SpaceList';
import { PersonRow } from './components/PeopleParts';
import { Loading } from './components/Loading';
import { ago } from '@minca/ui/time';
import { byRecent, useLastActive } from './recent';
import { CallLayer } from './components/calls/Calls';
import { NewSheet } from './components/NewSheet';
import { AddButton, PrimaryButton } from './components/Buttons';
import { Icon } from './components/Icon';
import { addChat, landingApp } from './components/apps/entries';

import { takeBack } from './contacts';
import { styles, palette, hstack, stack, ui } from './styles';
import { ask } from '@minca/app-shared/Ask';
import {
  Notices,
  rememberHome,
  useWorkspace,
  WorkspaceContext,
  type HomeTab,
  type Workspace as WorkspaceValue,
} from './workspace';

/** The app: connect to your account home, then your spaces, wherever the address says (`router.tsx`) */
export function App() {
  const { state } = useConnection();
  useAccountInAddress();
  // Calls sit above the workspace, so moving between spaces never touches one.
  return state.status === 'ready' ? (
    <CallsProvider>
      <Workspace />
    </CallsProvider>
  ) : (
    <ConnectScreen />
  );
}

/** Connected: your spaces for every page, notifications and automations running, and calls drawn over it all */
function Workspace() {
  const account = useAccount();
  // Kept, so the list of accounts shows this one by its picture once another is in use.
  useRememberPicture(account.did, useAccountPicture());
  const mine = useSpaces();
  const { spaces, loading, error } = mine;
  const navigate = useNavigate();
  const node = useNode();
  const pairs = usePairSpaces();
  // Into the app the space opens with, the first on its launcher; a space with none opens on its apps.
  const openSpace = (id: string) =>
    void landingApp(node, id)
      .catch(() => undefined)
      .then((appId) =>
        appId
          ? navigate({ to: '/spaces/$spaceId/apps/$appId', params: { spaceId: id, appId } })
          : navigate({ to: '/spaces/$spaceId', params: { spaceId: id } }),
      );
  const joinLink = (link: string) => mine.join(inviteFromLink(link));
  // A new group starts with Chat, with any contacts it was made for invited, and opens in it to add people.
  const create = async (params: NewSpace, invite: ReadonlyArray<string> = []) => {
    const space = await mine.create(params);
    if (!space) return;
    await addChat(node, space.id).catch(() => {});
    const [role] = invite.length > 0 ? await invitableRoles(node, space.id).catch(() => []) : [];
    for (const did of invite) await node.contacts.invite(did, space.id, role ? { role } : {}).catch(() => {});
    void navigate({
      to: '/spaces/$spaceId/apps/$appId',
      params: { spaceId: space.id, appId: 'chat' },
      state: { addPeople: true },
    });
  };
  useShowNotifications(openSpace);
  useRunAutomations();

  /**
   * Leaving a space, after saying what it costs. A space for two goes through
   * the contact list instead, so the list never names a space you left, and a
   * request still waiting is taken back from the spaces you share. Either way
   * you land back home, in place of the space, so Back doesn't return to it.
   */
  const home = () => void navigate({ to: '/', replace: true });
  const forget = async (id: string) => {
    const space = spaces.find((found) => found.id === id);
    if (!space) return;
    const pair = (await node.contacts.list().catch(() => [])).find(
      (contact) => contact.space === id && !contact.blocked,
    );
    if (pair) {
      if (
        !(await ask(
          `${space.name} is your space for two with ${pair.name}. Leaving it removes ${pair.name} from your contacts, and takes back your request if they haven't accepted. They keep their copy.`,
          { title: `Leave ${space.name}?`, yes: 'Leave', danger: true },
        ))
      )
        return;
      const shared = spaces
        .filter((other) => other.id !== id && other.writable && !other.joining)
        .map((other) => other.id);
      await takeBack(node, shared, account.did, pair.did);
      home();
      return;
    }
    if (
      !(await ask(
        `It goes from all your devices. Others in it keep it, and you need a new invite to come back. If no one else is in it, what's in it is gone.`,
        { title: `Leave ${space.name}?`, yes: 'Leave', danger: true },
      ))
    )
      return;
    await mine.leave(id);
    home();
  };

  const workspace: WorkspaceValue = {
    spaces,
    pairs,
    loading,
    error,
    create: (params, invite) => void create(params, invite),
    join: (link: string) => void joinLink(link).then((space) => space && openSpace(space.id)),
    joinLink,
    forget: (id: string) => void forget(id),
    openSpace,
  };

  return (
    <WorkspaceContext value={workspace}>
      <Outlet />
      <CallLayer spaces={spaces} onGoTo={(space) => openSpace(space.id)} />
    </WorkspaceContext>
  );
}

/** A tab on the home screen, the colour of where you are */
const tab = (on: boolean) =>
  ({
    ...styles.appTitle,
    position: 'relative',
    textDecoration: 'none',
    color: on ? palette.ink.strong : palette.ink.faint,
  }) as const;

/** The home screen: Home, Activity and you (`TabBar`), and the one of them you're on */
export function HomeLayout() {
  return (
    <div className="page">
      <div style={styles.app}>
        <TabBar />
        <Notices />
        <RelayDown />
        <Outlet />
      </div>
    </div>
  );
}

/** The home screen's tabs, in order */
const TABS: ReadonlyArray<{ readonly to: HomeTab; readonly label: string }> = [
  { to: '/', label: 'All' },
  { to: '/people', label: 'People' },
  { to: '/groups', label: 'Groups' },
];

/** Home: everything, your groups, or the people you talk to, under one header, and "+" to start either */
export function ChatsLayout() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const at: HomeTab = path.startsWith('/people') ? '/people' : path.startsWith('/groups') ? '/groups' : '/';
  // Leaving a space comes back to the tab it was opened from.
  useEffect(() => rememberHome(at), [at]);
  const [starting, setStarting] = useState(false);
  // A dot on People while someone asks to be your contact, and on Groups while an invite to one waits.
  const { spaces } = useWorkspace();
  const asking = useAsking(spaces);
  const invites = useSpaceInvites();
  const waiting: Record<HomeTab, boolean> = {
    '/': false,
    '/people': asking.knocks.length + asking.requests.length > 0,
    '/groups': invites.length > 0,
  };
  return (
    <>
      <header style={{ ...hstack(20), alignItems: 'center', marginBottom: 20 }}>
        <nav role="tablist" aria-label="Home" style={{ ...hstack(20), flex: 1 }}>
          {TABS.map((one) => (
            <Link
              key={one.to}
              to={one.to}
              role="tab"
              activeOptions={{ exact: one.to === '/' }}
              activeProps={{ 'aria-selected': true, style: tab(true) }}
              inactiveProps={{ 'aria-selected': false, style: tab(false) }}
            >
              {one.label}
              {waiting[one.to] && <span style={tabDot} aria-label="New" />}
            </Link>
          ))}
        </nav>
        <AddButton onClick={() => setStarting(true)} aria-label="New" title="New" style={plus}>
          <Icon name="plus" size={20} />
        </AddButton>
      </header>
      <Outlet />
      {starting && (
        <NewSheet on={at === '/people' ? 'people' : 'groups'} onClose={() => setStarting(false)} />
      )}
    </>
  );
}

/** Something waiting for you behind a tab, on its top right corner */
const tabDot = {
  position: 'absolute',
  top: 2,
  right: -9,
  width: 8,
  height: 8,
  borderRadius: palette.radius.pill,
  background: palette.accent.danger,
} as const;

const plus = {
  width: 40,
  height: 40,
  padding: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.pill,
} as const;

/**
 * Everything, at `/`: your groups and the people you talk to in one list, the one something last
 * happened in first, the way a messaging app's chats are
 */
export function AllPage() {
  const { spaces, pairs, loading, error, create, join, openSpace } = useWorkspace();
  const [naming, setNaming] = useState(false);
  // Invites contacts leave wait in your spaces for two, so those keep syncing here.
  useHeldSpaces([...pairs.keys()]);
  const last = useLastActive(spaces);
  const rows = byRecent(
    spaces.map((space) => ({ space, pair: pairs.get(space.id) })),
    last,
  );
  const when = (id: string) => {
    const at = last.get(id);
    return at ? ago(at) : '';
  };
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <SpaceInvites
          names={new Map([...pairs.values()].map((pair) => [pair.face, pair.name]))}
          onJoined={openSpace}
        />
      </div>
      {loading && spaces.length === 0 ? (
        <Loading label="Opening your chats" style={styles.emptyState} />
      ) : rows.length === 0 ? (
        <div style={{ ...styles.emptyState, ...stack(10), alignItems: 'center' }}>
          <strong style={{ color: palette.ink.strong, fontSize: 15 }}>Nothing here yet</strong>
          <span>Start a group, or find someone by their username under People.</span>
          <PrimaryButton onClick={() => setNaming(true)} style={{ marginTop: 6 }}>
            New group
          </PrimaryButton>
        </div>
      ) : (
        <ul className="rows" aria-label="Groups and people" style={ui.list}>
          {rows.map(({ space, pair }) =>
            pair ? (
              <PersonRow
                key={space.id}
                face={pair.face}
                name={pair.name}
                detail={['Person', when(space.id)].filter(Boolean).join(' · ')}
                onOpen={() => openSpace(space.id)}
              >
                <SpaceCount space={space} />
              </PersonRow>
            ) : (
              <GroupRow
                key={space.id}
                space={space}
                detail={['Group', when(space.id)].filter(Boolean).join(' · ')}
                onOpen={() => openSpace(space.id)}
              />
            ),
          )}
        </ul>
      )}
      {error && <p style={{ ...styles.error, marginTop: 10 }}>{error}</p>}
      {naming && (
        <SpaceDialog initial="new" onClose={() => setNaming(false)} onCreate={create} onJoin={join} />
      )}
    </>
  );
}

/** Your groups, at `/groups`: every space but your spaces for two */
export function GroupsPage() {
  const { spaces, pairs, loading, error, create, join, openSpace } = useWorkspace();
  const [naming, setNaming] = useState(false);
  // Invites contacts leave wait in your spaces for two, so those keep syncing here.
  useHeldSpaces([...pairs.keys()]);
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <SpaceInvites
          names={new Map([...pairs.values()].map((pair) => [pair.face, pair.name]))}
          onJoined={openSpace}
        />
      </div>
      <SpaceList
        spaces={spaces.filter((space) => !pairs.has(space.id))}
        loading={loading}
        error={error}
        onOpen={(space) => openSpace(space.id)}
        onNew={() => setNaming(true)}
      />
      {naming && (
        <SpaceDialog initial="new" onClose={() => setNaming(false)} onCreate={create} onJoin={join} />
      )}
    </>
  );
}

/** The people you talk to, at `/people`: your contacts, each a chat for two */
export function PeoplePage() {
  const { spaces, openSpace } = useWorkspace();
  return <ContactsView spaces={spaces} onOpen={openSpace} />;
}
