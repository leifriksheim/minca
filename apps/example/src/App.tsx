import { useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useHeldSpaces, usePairSpaces } from './contacts';
import { SpaceInvites } from './components/PeopleParts';
import type { NewSpace } from '@minca/core';
import { inviteFromLink, useAccount, useConnection, useNode, useSpaces } from '@minca/react';
import { CallsProvider } from '@minca/calls/react';
import { AccountMenu } from './components/AccountMenu';
import { AgentCard } from './components/AgentCard';
import { useShowNotifications } from './notifications';
import { Bell } from './components/Bell';
import { useRunAutomations } from './automations';
import { ConnectScreen } from './components/ConnectScreen';
import { useAccountInAddress } from './account-address';
import { ContactsView } from './components/ContactsView';
import { RelayDown } from './components/RelayNotice';
import { DocsNote } from './components/DocsNote';
import { SpaceDialog, SpaceList } from './components/SpaceList';
import { CallLayer } from './components/calls/Calls';
import { NewSheet } from './components/NewSheet';
import { Icon } from './components/Icon';
import { AddButton } from './components/Buttons';
import { addChat, landingApp } from './components/apps/entries';
import { Wordmark } from '@minca/app-shared/Wordmark';

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
  // A new group starts with Chat, and opens in it to add people.
  const create = async (params: NewSpace) => {
    const space = await mine.create(params);
    if (!space) return;
    await addChat(node, space.id).catch(() => {});
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
   * request still waiting is taken back from the spaces you share.
   */
  const account = useAccount();
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

/** The home screen: your groups or the people you talk to, under one header, and "+" to start either */
export function HomeLayout() {
  const { spaces, openSpace } = useWorkspace();
  const on = useRouterState({ select: (state) => state.location.pathname }).startsWith('/people')
    ? 'people'
    : 'groups';
  const [starting, setStarting] = useState(false);
  return (
    <div className="page">
      <div style={styles.app}>
        <Notices />
        <RelayDown />
        <header style={styles.headerRow}>
          <Wordmark compact />
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell spaces={spaces} onOpenSpace={openSpace} />
            <AccountMenu />
          </span>
        </header>
        <div style={{ ...hstack(20), alignItems: 'center', marginBottom: 20 }}>
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
          <AddButton
            onClick={() => setStarting(true)}
            className="hide-on-phone"
            style={{ height: 40, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Icon name="plus" size={16} /> New
          </AddButton>
        </div>
        <Outlet />
        {/* Under the thumb on a phone. */}
        <button
          onClick={() => setStarting(true)}
          data-variant="primary"
          className="fab"
          style={{ bottom: 'calc(20px + env(safe-area-inset-bottom))' }}
        >
          <Icon name="plus" size={16} /> New
        </button>
        {starting && <NewSheet on={on} onClose={() => setStarting(false)} />}
      </div>
    </div>
  );
}

/** Your groups, at `/`: every space but your spaces for two */
export function GroupsPage() {
  const { spaces, pairs, loading, error, create, join, forget, openSpace } = useWorkspace();
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
        onRemove={forget}
      />
      {naming && (
        <SpaceDialog initial="new" onClose={() => setNaming(false)} onCreate={create} onJoin={join} />
      )}
      <AgentCard />
      <DocsNote path="packages/core/docs/spaces.md" style={{ marginTop: 16 }}>
        Each group is a space: it keeps its own store and sync, and an invite carries its key in the link.
      </DocsNote>
    </>
  );
}

/** The people you talk to, at `/people`: your contacts, each a chat for two */
export function PeoplePage() {
  const { spaces, openSpace } = useWorkspace();
  return <ContactsView spaces={spaces} onOpen={openSpace} />;
}
