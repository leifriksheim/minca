import { useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useHeldSpaces, usePairSpaces } from './contacts';
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
import { useAlerts, useTabDot } from './alerts';
import { useRememberPicture } from '@minca/app-shared/rememberedPictures';
import { Avatar } from '@minca/app-shared/Avatar';
import { useRunAutomations } from './automations';
import { ConnectScreen } from './components/ConnectScreen';
import { useAccountInAddress } from './account-address';
import { ContactsView } from './components/ContactsView';
import { RelayDown } from './components/RelayNotice';
import { SpaceDialog, SpaceList } from './components/SpaceList';
import { CallLayer } from './components/calls/Calls';
import { NewSheet } from './components/NewSheet';
import { AddButton } from './components/Buttons';
import { Icon } from './components/Icon';
import { addChat, landingTool } from './components/tools/entries';

import { takeBack } from './contacts';
import { styles, palette, hstack } from './styles';
import { ask } from '@minca/app-shared/Ask';
import { Notices, useWorkspace, WorkspaceContext, type Workspace as WorkspaceValue } from './workspace';

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
  // Into the tool the space opens with, the first on its launcher; a space with none opens on its tools.
  const openSpace = (id: string) =>
    void landingTool(node, id)
      .catch(() => undefined)
      .then((toolId) =>
        toolId
          ? navigate({ to: '/spaces/$spaceId/tools/$toolId', params: { spaceId: id, toolId } })
          : navigate({ to: '/spaces/$spaceId', params: { spaceId: id } }),
      );
  const joinLink = (link: string) => mine.join(inviteFromLink(link));
  // A new group starts with Chat, and opens in it to add people.
  const create = async (params: NewSpace) => {
    const space = await mine.create(params);
    if (!space) return;
    await addChat(node, space.id).catch(() => {});
    void navigate({
      to: '/spaces/$spaceId/tools/$toolId',
      params: { spaceId: space.id, toolId: 'chat' },
      state: { addPeople: true },
    });
  };
  useShowNotifications(openSpace);
  useRunAutomations();

  /**
   * Leaving a space, after saying what it costs. A space for two goes through
   * the contact list instead, so the list never names a space you left, and a
   * request still waiting is taken back from the spaces you share.
   */
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
  };

  const workspace: WorkspaceValue = {
    spaces,
    pairs,
    loading,
    error,
    create: (params: NewSpace) => void create(params),
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
    textDecoration: 'none',
    color: on ? palette.ink.strong : palette.ink.faint,
  }) as const;

/**
 * The home screen: Home, Activity and you, in one bar that runs along the top of a wide screen
 * and the bottom of a phone's (`.tabbar`), with a dot on Activity while some of it is new.
 */
export function HomeLayout() {
  const account = useAccount();
  const picture = useAccountPicture();
  const { unread } = useAlerts(account.did);
  useTabDot(unread > 0);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const onHome = path === '/' || path.startsWith('/people');
  return (
    <div className="page">
      <div style={styles.app}>
        <nav className="tabbar" aria-label="Minca">
          <Link to="/" aria-current={onHome ? 'page' : undefined}>
            <Icon name="home" size={20} />
            Home
          </Link>
          <Link to="/activity">
            <Icon name="bell" size={20} />
            {unread > 0 && <span className="tab-dot" aria-label={`${unread} new`} />}
            Activity
          </Link>
          <Link to="/profile">
            <Avatar did={account.did} size={20} round src={picture} />
            Profile
          </Link>
        </nav>
        <Notices />
        <RelayDown />
        <Outlet />
      </div>
    </div>
  );
}

/** Home: your groups or the people you talk to, under one header, and "+" to start either */
export function ChatsLayout() {
  const on = useRouterState({ select: (state) => state.location.pathname }).startsWith('/people')
    ? 'people'
    : 'groups';
  const [starting, setStarting] = useState(false);
  return (
    <>
      <header style={{ ...hstack(20), alignItems: 'center', marginBottom: 20 }}>
        <nav role="tablist" aria-label="Home" style={{ ...hstack(20), flex: 1 }}>
          <Link
            to="/"
            role="tab"
            activeOptions={{ exact: true }}
            activeProps={{ 'aria-selected': true, style: tab(true) }}
            inactiveProps={{ 'aria-selected': false, style: tab(false) }}
          >
            Groups
          </Link>
          <Link
            to="/people"
            role="tab"
            activeProps={{ 'aria-selected': true, style: tab(true) }}
            inactiveProps={{ 'aria-selected': false, style: tab(false) }}
          >
            People
          </Link>
        </nav>
        <AddButton onClick={() => setStarting(true)} aria-label="New" title="New" style={plus}>
          <Icon name="plus" size={20} />
        </AddButton>
      </header>
      <Outlet />
      {starting && <NewSheet on={on} onClose={() => setStarting(false)} />}
    </>
  );
}

const plus = {
  width: 40,
  height: 40,
  padding: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: palette.radius.pill,
} as const;

/** Your groups, at `/`: every space but your spaces for two */
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
