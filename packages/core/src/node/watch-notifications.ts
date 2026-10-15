/**
 * @module node/watch-notifications
 * An app showing its own notifications: the automations the person kept for
 * it, matched against records as they arrive.
 *
 * They live in the account registry (`space/own-automations.ts`), which a
 * node given the whole account can open. This reads the ones naming the app,
 * follows every space they look at, and hands each record that comes to
 * match to the app — which decides how to show it. A record comes to match
 * when it is written, or when something its computed fields read is: a new
 * 👍 can make a todo done. What already matched when it started is never news.
 */
import { holdsFor, ownQuery, setsOff, type Trigger } from '../space/own-automations.js';
import { lastRead, linkedReads, readsComputed } from '../query/computed.js';
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
  /** The records each automation holds for, by space: one that joins them is news */
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
    const reads = readsComputed(fields, where);
    // The newest records, and those the newest of what their computed fields read link to.
    const newest = (name: string) =>
      node.records.list(space, { collection: name, newestFirst: true, limit: LOOK_BACK });
    const keys = new Set((await newest(collection)).map((r) => r.key));
    for (const { collection: from, rel } of reads ? linkedReads(fields) : []) {
      for (const r of await newest(from)) for (const link of r.links) if (link.rel === rel) keys.add(link.to);
    }
    if (keys.size === 0) return;
    const { records } = await node.records.query(space, {
      collection,
      where: { '@key': { $in: [...keys] } },
    });
    const linked = (key: string, o: { rel?: string; collection?: string }) =>
      node.records.linked(space, key, o);
    for (const record of records) {
      if (stopped) return;
      if (!holdsFor(own, record, node.did)) {
        held.delete(record.key);
        continue;
      }
      if (held.has(record.key)) continue;
      held.add(record.key);
      if (first) continue;
      const last = reads ? await lastRead({ linked }, record.key, fields) : null;
      const trigger: Trigger =
        last && last.updatedAt > record.createdAt
          ? { createdAt: last.updatedAt, createdBy: last.root ?? last.createdBy }
          : record;
      if (setsOff(own, space, trigger, node.did)) options.onNotify({ automation: own, record });
    }
  }

  async function reload(): Promise<void> {
    automations = (await node.automations.list()).filter((own) => !own.paused && own.app?.origin === origin);
    spaces = new Set((await node.spaces.list()).map((space) => space.id));
    // Anything newly looked at starts from what is there now. What was looked at before still
    // reports what arrived since: the account changes all the time, and that is no reason to drop news.
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
