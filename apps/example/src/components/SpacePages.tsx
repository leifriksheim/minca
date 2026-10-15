/**
 * The parts of a space, one per route (`router.tsx`), each drawn inside the
 * space's layout (`SpaceLayout` in `SpaceView.tsx`), which hands them the
 * space through `useSpaceScreen`.
 */
import { useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { NodeRecord, SpaceSummary } from '@minca/core';
import { AppsView } from './apps/AppsView';
import { NewApp } from './apps/NewApp';
import { MadeAppScreen } from './apps/MadeApps';
import type { AppEntry } from './apps/entries';
import { RolesView } from './RolesView';
import { HostingView } from './HostingView';
import { AutomationsView } from './automations/AutomationsView';
import { DataView } from './DataView';
import { GraphView } from './GraphView';
import { QueryPlayground } from './QueryPlayground';
import { NetworkView } from './NetworkView';
import { HOOD, MoreRow, SECTIONS, SideHeading, useSpaceScreen } from './SpaceView';
import { seenAt, useSeen } from '../seen';
import { styles } from '../styles';

/** Every app in the space, and the ones proposed for it */
export function AppsPage() {
  const { space, collections, apps, unread, mayDefine, openApp, go } = useSpaceScreen();
  return (
    <AppsView
      space={space}
      collections={collections}
      apps={apps}
      unread={unread}
      mayDefine={mayDefine}
      onOpenApp={openApp}
      onCreate={() => go('/spaces/$spaceId/new')}
    />
  );
}

/** Adding an app: a ready-made one, or one of the space's own */
export function NewAppPage() {
  const { space, collections, apps, mayDefine, openApp, startCreating } = useSpaceScreen();
  return (
    <NewApp
      space={space}
      collections={collections}
      apps={apps}
      mayDefine={mayDefine}
      onOpenApp={openApp}
      onOwn={startCreating}
    />
  );
}

/** One app, open */
export function AppPage() {
  const { appId } = useParams({ from: '/spaces/$spaceId/apps/$appId' });
  const { space, collections, apps, openRecord } = useSpaceScreen();
  const app = apps.ready.find((entry) => entry.id === appId);
  if (app)
    return <OpenApp key={app.id} space={space} app={app} collections={collections} onOpen={openRecord} />;
  return apps.loading ? null : <p style={styles.emptyState}>This app isn't in the space any more.</p>;
}

/** An open app: a built-in one's own view, or one made for the space */
function OpenApp({
  space,
  app,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  app: AppEntry;
  collections: Parameters<typeof MadeAppScreen>[0]['collections'];
  onOpen: (record: NodeRecord) => void;
}) {
  // What was new when it opened stays marked as new while it is open, though opening marks it seen.
  const seen = useSeen();
  const [since] = useState(() => seenAt(seen, space.id, app.id));
  if (app.made)
    return <MadeAppScreen space={space} record={app.made} collections={collections} onOpen={onOpen} />;
  if (!app.builtIn) return null;
  const View = app.builtIn.View;
  return <View space={space} collections={collections} onOpen={onOpen} since={since} />;
}

export function PeoplePage() {
  const { space, collections } = useSpaceScreen();
  return <RolesView space={space} collections={collections} />;
}

export function HostingPage() {
  const { space, go } = useSpaceScreen();
  return <HostingView space={space} onAutomations={() => go('/spaces/$spaceId/automations')} />;
}

export function AutomationsPage() {
  const { space, collections } = useSpaceScreen();
  return <AutomationsView space={space} collections={collections} />;
}

/** A phone's list of the sections that have no tab of their own */
export function MorePage() {
  const { go } = useSpaceScreen();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {SECTIONS.filter((section) => section.to !== '/spaces/$spaceId/people').map((section) => (
        <MoreRow key={section.to} icon={section.icon} label={section.label} onClick={() => go(section.to)} />
      ))}
      <SideHeading>Under the hood</SideHeading>
      {HOOD.map((h) => (
        <MoreRow key={h.id} icon={h.icon} label={h.label} quiet onClick={() => go(h.to)} />
      ))}
    </div>
  );
}

/** Every record, collection by collection; the collection and the open record are in the address */
export function DataPage() {
  const { space, collections, openRecord } = useSpaceScreen();
  const { collection, record } = useSearch({ from: '/spaces/$spaceId/data' });
  const navigate = useNavigate();
  return (
    <DataView
      space={space}
      collections={collections}
      place={{ collection: collection ?? null, key: record ?? null }}
      onPlace={(place) =>
        void navigate({
          to: '/spaces/$spaceId/data',
          params: { spaceId: space.id },
          search: {
            ...(place.collection ? { collection: place.collection } : {}),
            ...(place.key ? { record: place.key } : {}),
          },
        })
      }
      onOpen={openRecord}
    />
  );
}

export function ExplorePage() {
  const { space, collections } = useSpaceScreen();
  return <GraphView space={space} collections={collections} />;
}

export function QueryPage() {
  const { space, collections, openRecord } = useSpaceScreen();
  return <QueryPlayground space={space} collections={collections} onOpen={openRecord} />;
}

export function NetworkPage() {
  const { space, status } = useSpaceScreen();
  return <NetworkView space={space} status={status} />;
}
