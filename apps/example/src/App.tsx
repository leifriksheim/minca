import { Link, Outlet, useNavigate } from '@tanstack/react-router';
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
import { SpaceList } from './components/SpaceList';
import { CallLayer } from './components/calls/Calls';
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
  const openSpace = (id: string) => void navigate({ to: '/spaces/$spaceId', params: { spaceId: id } });
  const joinLink = (link: string) => mine.join(inviteFromLink(link));
  useShowNotifications(openSpace);
  useRunAutomations();

  /**
   * Leaving a space, after saying what it costs. A space for two goes through
   * the contact list instead, so the list never names a space you left, and a
   * request still waiting is taken back from the spaces you share.
   */
  const node = useNode();
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
    loading,
    error,
    create: (params: NewSpace) => void mine.create(params).then((space) => space && openSpace(space.id)),
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

/** The home screen: your spaces or your contacts, under one header */
export function HomeLayout() {
  const { spaces, openSpace } = useWorkspace();
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
        <nav role="tablist" aria-label="Home" style={{ ...hstack(20), marginBottom: 20 }}>
          <Link
            to="/"
            role="tab"
            activeOptions={{ exact: true }}
            activeProps={{ 'aria-selected': true, style: tab(true) }}
            inactiveProps={{ 'aria-selected': false, style: tab(false) }}
          >
            Spaces
          </Link>
          <Link
            to="/contacts"
            role="tab"
            activeProps={{ 'aria-selected': true, style: tab(true) }}
            inactiveProps={{ 'aria-selected': false, style: tab(false) }}
          >
            Contacts
          </Link>
        </nav>
        <Outlet />
      </div>
    </div>
  );
}

/** Your spaces, at `/` */
export function SpacesPage() {
  const { spaces, loading, error, create, join, forget, openSpace } = useWorkspace();
  return (
    <>
      <SpaceList
        spaces={spaces}
        loading={loading}
        error={error}
        onOpen={(space) => openSpace(space.id)}
        onCreate={create}
        onJoin={join}
        onRemove={forget}
      />
      <AgentCard />
      <DocsNote path="packages/core/docs/spaces.md" style={{ marginTop: 16 }}>
        Each space keeps its own store and sync, and an invite carries its key in the link.
      </DocsNote>
    </>
  );
}

/** Your contacts, at `/contacts` */
export function ContactsPage() {
  const { spaces, openSpace } = useWorkspace();
  return <ContactsView spaces={spaces} onOpen={openSpace} />;
}
