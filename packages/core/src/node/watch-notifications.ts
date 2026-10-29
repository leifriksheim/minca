/**
 * @module node/watch-notifications
 * An app showing its own notifications: the automations the person kept for
 * it, matched against records as they arrive.
 *
 * They live in the account registry (`space/own-automations.ts`). This reads
 * the ones naming the app, follows the spaces they look at, and hands the app
 * each record that comes to match: when it is written, or when something its
 * computed fields read is (a new 👍 can make a todo done). Each record is news
 * once per automation; what matched when it started never is.
 */
import { holdsFor, ownQuery, setsOff, type Trigger } from '../space/own-automations.js';
import { causeOf, linkedReads, namedComputed, type ComputedFields } from '../query/computed.js';
import type { NodeRecord, OwnAutomationView, P2PNode } from './types.js';
import { serial } from '../utils/serial.js';

/** A record one of the app's automations asks about */
export interface NotifyMatch {
  readonly automation: OwnAutomationView;
  readonly record: NodeRecord;
}

export interface WatchNotificationsOptions {
  /** The app's origin, as the home saw it. Default: this page's. */
  readonly origin?: string;
  readonly onNotify: (match: NotifyMatch) => void;
  readonly onError?: (error: unknown) => void;
}

/** How many of the newest records of a collection are looked at after each change */
const LOOK_BACK = 50;

/**
 * Starts matching. Needs a node with the account key — an app connected with
 * `scope: 'account'`; any other has no automations to read, and hears nothing.
 * @returns Stops it
 */
export function watchNotifications(node: P2PNode, options: WatchNotificationsOptions): () => void {
  const origin = options.origin ?? globalThis.location?.origin;
  let stopped = false;
  let automations: ReadonlyArray<OwnAutomationView> = [];
  let spaces = new Set<string>();
  /** The records each automation has held for, by space: one that joins them is news, once */
  const holding = new Map<string, Set<string>>();
  /** Spaces with a change not yet looked at; null means the automations or spaces changed */
  const dirty = new Set<string | null>([null]);

  const lookingAt = (space: string) =>
    automations.filter(
      (own) => own.spaces === undefined || own.spaces === 'all' || own.spaces.includes(space),
    );

  /** Hands on each record an automation has come to hold for; the first look in a space only learns which */
  async function look(space: string, own: OwnAutomationView): Promise<void> {
    const at = `${space}\n${own.id}`;
    const first = !holding.has(at);
    const held = holding.get(at) ?? new Set<string>();
    holding.set(at, held);
    const { collection, where } = ownQuery(own);
    const fields = (await node.collections.list(space)).find((c) => c.name === collection)?.computed ?? {};
    // Only the fields the filter names: what the others read can't change whether it holds.
    const named = namedComputed(fields, where);
    const keys = await recentKeys(space, collection, named);
    if (keys.size === 0) return;
    const { records } = await node.records.query(space, {
      collection,
      where: { '@key': { $in: [...keys] } },
    });
    for (const record of records) {
      if (stopped) return;
      if (!holdsFor(own, record, node.did) || held.has(record.key)) continue;
      held.add(record.key);
      if (first) continue;
      const trigger = await triggerOf(space, own, record, named);
      if (trigger && setsOff(own, space, trigger, node.did)) options.onNotify({ automation: own, record });
    }
  }

  /** The newest records, and those the newest of what their computed fields read link to */
  async function recentKeys(space: string, collection: string, named: ComputedFields): Promise<Set<string>> {
    const newest = (name: string) =>
      node.records.list(space, { collection: name, newestFirst: true, limit: LOOK_BACK });
    const keys = new Set((await newest(collection)).map((r) => r.key));
    for (const { collection: from, rel } of linkedReads(named))
      for (const r of await newest(from)) for (const link of r.links) if (link.rel === rel) keys.add(link.to);
    return keys;
  }

  /** What made a record hold, not what came last: a 😡 after the second 👍 tells no one anything */
  async function triggerOf(
    space: string,
    own: OwnAutomationView,
    record: NodeRecord,
    named: ComputedFields,
  ): Promise<Trigger | null> {
    if (Object.keys(named).length === 0) return record;
    const linked = (key: string, o: { rel?: string; collection?: string }) =>
      node.records.linked(space, key, o);
    const cause = await causeOf({ linked }, record, named, (computed) =>
      holdsFor(own, { ...record, computed }, node.did),
    );
    if (!cause) return null;
    return cause === record
      ? record
      : { createdAt: cause.updatedAt, createdBy: cause.root ?? cause.createdBy };
  }

  async function reload(): Promise<void> {
    automations = (await node.automations.list()).filter((own) => !own.paused && own.app?.origin === origin);
    spaces = new Set((await node.spaces.list()).map((space) => space.id));
    // Something newly looked at starts from what is there now; the rest still report what arrived since.
    for (const space of spaces) for (const own of lookingAt(space)) await look(space, own);
  }

  // One look at a time; asked meanwhile, it looks once more after.
  const kick = serial(async () => {
    if (stopped) return;
    const changed = [...dirty];
    dirty.clear();
    try {
      if (changed.includes(null)) await reload();
      for (const space of changed) {
        if (space === null || !spaces.has(space)) continue;
        for (const own of lookingAt(space)) await look(space, own);
      }
    } catch (error) {
      options.onError?.(error);
    }
  });

  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces' || event.type === 'account') dirty.add(null);
    else if (event.type === 'records') dirty.add(spaces.has(event.space) ? event.space : null);
    else return;
    void kick();
  });
  void kick();

  return () => {
    stopped = true;
    unsubscribe();
  };
}
