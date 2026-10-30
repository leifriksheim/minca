import { matches, type NodeCollection, type NodeRecord, type P2PNode, type SpaceSummary } from '@minca/core';
import { useAccess, useLive } from '@minca/react';
import { asRunner, namesTheRunner, notifyOn, type AppAutomation } from '@minca/core/schemas';
import { addTemplate, firstApp, launcherApp, sortLauncher, type LauncherApp } from './launcher';
import { TEMPLATES } from './templates';

/**
 * An app a space can open: a launcher record (`launcher.ts`), ready-made or
 * made for the space. The sidebar, the launcher, what counts as new and what
 * can be notified about all read this one list.
 */
export interface AppEntry {
  /** A ready-made app's id (`kanban`), or `made:<record key>` */
  readonly id: string;
  /** Its launcher record, which is the app */
  readonly record: NodeRecord<LauncherApp>;
  readonly title: string;
  readonly description?: string | undefined;
  readonly notify: ReadonlyArray<AppAutomation>;
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
const isForMe = (notify: AppAutomation): boolean => namesTheRunner(notify);

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

const entryOf = (record: NodeRecord<LauncherApp>, id = `made:${record.key}`): AppEntry => ({
  id,
  record,
  title: record.body?.title ?? 'An app',
  description: record.body?.description,
  notify: record.body ? madeNotify(record.body) : [],
});

/** Whether an app takes the whole window: a screen of its own does */
export const fills = (entry: AppEntry): boolean => !!entry.record.body?.screen;

/** The space's launcher records, live */
export function useLauncherRecords(spaceId: string): ReadonlyArray<NodeRecord<LauncherApp>> {
  return (
    useLive(spaceId, (node) => node.records.list<LauncherApp>(spaceId, { collection: launcherApp.name }), [
      spaceId,
    ]) ?? []
  );
}

/** The entries for what is on a launcher, in its order */
function entriesOf(placed: ReadonlyArray<NodeRecord<LauncherApp>>): ReadonlyArray<AppEntry> {
  const named = new Set<string>();
  return placed.map((record) => {
    const template = record.body?.template;
    // A ready-made app goes by its own id, so its shape and what was seen in it carry over; a second copy, by its key.
    if (template !== undefined && !named.has(template)) {
      named.add(template);
      return entryOf(record, template);
    }
    return entryOf(record);
  });
}

/** The id of the app a space opens with (`firstApp`), or undefined when it has none */
export async function landingApp(node: P2PNode, spaceId: string): Promise<string | undefined> {
  const first = await firstApp(node, spaceId);
  return first && entriesOf([first])[0]?.id;
}

const CHAT = TEMPLATES.find(({ app }) => app.template === 'chat')!;

/** Puts Chat on a new space's launcher, so it opens into a conversation */
export const addChat = (node: P2PNode, spaceId: string) => addTemplate(node, spaceId, CHAT, []);

/**
 * A space's apps: those on its launcher, in order, the ready-made ones it
 * could add, and proposals waiting. Until the space's access is known nothing can be
 * vouched for, so `loading` says to wait rather than show apps as gone.
 */
export function useSpaceApps(space: SpaceSummary, collections: ReadonlyArray<NodeCollection>) {
  const records = useLauncherRecords(space.id);
  const access = useAccess(space.id);
  const { placed, proposed } = sortLauncher(records, collections, access);
  return {
    ready: entriesOf(placed),
    placed,
    records,
    templates: TEMPLATES.filter(
      ({ app }) => !placed.some((record) => record.body?.template === app.template),
    ),
    proposed: access ? proposed : [],
    loading: !access,
  };
}
