import { matches, type NodeCollection, type NodeRecord, type SpaceSummary } from '@minca/core';
import { useAccess, useLive } from '@minca/core/react';
import { asRunner, namesTheRunner, notifyOn, type AppAutomation } from '@minca/core/schemas';
import { hash } from '@minca/app-shared/hash';
import { APPS, type MincaApp } from './index';
import { launcherApp, sortLauncher, type LauncherApp } from './launcher';
import type { Glyph } from '../Icon';

/**
 * An app a space can open, whichever kind: written as code here, or made for
 * the space and kept in it. Either way it is on the space's launcher
 * (`launcher.ts`). The sidebar, the launcher, what counts as new and what can
 * be notified about all read this one list.
 */
export interface AppEntry {
  /** A built-in app's id, or `made:<record key>` */
  readonly id: string;
  /** Its launcher record */
  readonly record: NodeRecord<LauncherApp>;
  readonly title: string;
  readonly description?: string | undefined;
  readonly icon: Glyph;
  readonly hue: number;
  readonly notify: ReadonlyArray<AppAutomation>;
  readonly builtIn?: MincaApp;
  /** A made app's launcher record, which is the app */
  readonly made?: NodeRecord<LauncherApp>;
}

/**
 * What a made app notifies about: what it says, or else new records in the
 * first collection it shows, usually the thing it is about.
 */
export function madeNotify(body: LauncherApp): ReadonlyArray<AppAutomation> {
  if (body.notify) return body.notify;
  const first = body.collections?.[0];
  return first ? [notifyOn(`New in ${body.title ?? first}`, first)] : [];
}

/** An entry about records that name the person — "Mentions me", "A seat on my trip" */
export const isForMe = (notify: AppAutomation): boolean => namesTheRunner(notify);

/** Whether a record is one of an app's "…me" entries is about: its `where` holds, with the person as `$me` */
export function namesMe(
  notify: ReadonlyArray<AppAutomation>,
  collection: string,
  record: NodeRecord,
  did: string,
): boolean {
  return notify.some((entry) => {
    const { collection: about, where } = entry.when.query;
    if (!isForMe(entry) || about !== collection || !where) return false;
    return matches(record, asRunner(where, did));
  });
}

const builtInEntry = (app: MincaApp, record: NodeRecord<LauncherApp>): AppEntry => ({
  id: app.id,
  record,
  title: app.title,
  description: app.description,
  icon: app.icon,
  hue: app.hue,
  notify: app.notify,
  builtIn: app,
});

const madeEntry = (record: NodeRecord<LauncherApp>): AppEntry => ({
  id: `made:${record.key}`,
  record,
  title: record.body?.title ?? 'An app',
  description: record.body?.description,
  icon: 'sparkle',
  hue: hash(record.key) % 360,
  notify: record.body ? madeNotify(record.body) : [],
  made: record,
});

/** Whether an app takes the whole window: a conversation, or a screen of its own */
export const fills = (entry: AppEntry): boolean =>
  entry.builtIn ? entry.builtIn.fill === true : !!entry.made?.body?.screen;

/** The space's launcher records, live */
export function useLauncherRecords(spaceId: string): ReadonlyArray<NodeRecord<LauncherApp>> {
  return (
    useLive(spaceId, (node) => node.records.list<LauncherApp>(spaceId, { collection: launcherApp.name }), [
      spaceId,
    ]) ?? []
  );
}

/** The entries for what is on a launcher, in its order: built-in apps this app doesn't know are left out */
function entriesOf(placed: ReadonlyArray<NodeRecord<LauncherApp>>): ReadonlyArray<AppEntry> {
  return placed.flatMap((record) => {
    const id = record.body?.builtIn;
    if (id === undefined) return [madeEntry(record)];
    const app = APPS.find((one) => one.id === id);
    return app ? [builtInEntry(app, record)] : [];
  });
}

/** The collections a built-in app needs, by its id; undefined for one this app doesn't know */
export const needsOf = (id: string): ReadonlyArray<string> | undefined =>
  APPS.find((app) => app.id === id)?.needs.map((need) => need.name);

/**
 * A space's apps: those on its launcher, in order, the built-in ones it could
 * add, and proposals waiting. Until the space's access is known nothing can be
 * vouched for, so `loading` says to wait rather than show apps as gone.
 */
export function useSpaceApps(space: SpaceSummary, collections: ReadonlyArray<NodeCollection>) {
  const records = useLauncherRecords(space.id);
  const access = useAccess(space.id);
  const { placed, proposed } = sortLauncher(records, collections, access, needsOf);
  return {
    ready: entriesOf(placed),
    placed,
    records,
    addable: APPS.filter((app) => !placed.some((record) => record.body?.builtIn === app.id)),
    proposed: access ? proposed : [],
    loading: !access,
  };
}
