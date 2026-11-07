/**
 * The seen state of one account, kept in its registry: what `seen.ts` shows as new. Apart from the
 * hooks so it runs, and is tested, without React.
 */
import { collection, type P2PNode } from '@minca/core';

/** When you last looked at each app in one space, and when your devices first saw it */
export interface SpaceSeen {
  /** Nothing before this is new: when one of your devices first saw the space */
  readonly since: string;
  /** Per app: when the newest record you saw in it was written */
  readonly apps: Readonly<Record<string, string>>;
}

/** What you have seen, by space; a space not in it hasn't been seen by any device of yours yet */
export type Seen = ReadonlyMap<string, SpaceSeen>;

/** One record per space, in the account registry; the Minca app's own, like its theme */
const seenRecords = collection({
  name: 'minca.seen',
  title: 'Seen',
  schema: {
    type: 'object',
    properties: {
      space: { type: 'string', maxLength: 200 },
      since: { type: 'string', maxLength: 40 },
      // When each app was last open; a list, since a stored schema can't describe a map
      apps: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: { app: { type: 'string', maxLength: 200 }, at: { type: 'string', maxLength: 40 } },
          required: ['app', 'at'],
        },
      },
    },
    required: ['space', 'since', 'apps'],
  },
  rules: { onePer: ['@author', 'space'] },
});

const isLook = (value: unknown): value is { app: string; at: string } =>
  typeof value === 'object' &&
  value !== null &&
  'app' in value &&
  typeof value.app === 'string' &&
  'at' in value &&
  typeof value.at === 'string';

/** A stored record as a space's seen state, or null when it isn't one */
function spaceSeenOf(body: unknown): (SpaceSeen & { readonly space: string }) | null {
  if (typeof body !== 'object' || body === null) return null;
  if (!('space' in body && typeof body.space === 'string')) return null;
  if (!('since' in body && typeof body.since === 'string')) return null;
  if (!('apps' in body && Array.isArray(body.apps))) return null;
  const looks = body.apps.filter(isLook);
  return { space: body.space, since: body.since, apps: Object.fromEntries(looks.map((l) => [l.app, l.at])) };
}

/** Whether a stored record lacks a look made here: an earlier start, or a later look at some app */
function lacks(stored: SpaceSeen, here: SpaceSeen): boolean {
  if (here.since < stored.since) return true;
  return Object.entries(here.apps).some(([app, at]) => at > (stored.apps[app] ?? ''));
}

/** The later of two times for each app: a record from another device never takes back a look made here */
function merged(a: SpaceSeen, b: SpaceSeen): SpaceSeen {
  const apps: Record<string, string> = { ...a.apps };
  for (const [app, at] of Object.entries(b.apps)) if (!apps[app] || at > apps[app]) apps[app] = at;
  return { since: a.since < b.since ? a.since : b.since, apps };
}

/**
 * The seen state of one node's account: read from the registry and kept current as it changes on
 * other devices, with looks made here held until they are written. Without a registry, an app given
 * only some spaces, it lives in memory alone.
 */
export function createSeenStore(node: P2PNode) {
  let seen: Seen = new Map();
  /** Whether the registry was read: no space begins before it is, or it would start over */
  let loaded = false;
  /** Spaces looked at here since they were last written */
  const unwritten = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = (next: Seen) => {
    seen = next;
    for (const listener of listeners) listener();
  };

  const load = async () => {
    const registry = await node.account.space();
    const found = new Map<string, SpaceSeen>();
    if (registry) {
      const { records } = await node.records.query(registry, { collection: seenRecords });
      for (const record of records) {
        const one = spaceSeenOf(record.body);
        if (one) found.set(one.space, one);
      }
    }
    const next = new Map(seen);
    /** Spaces whose record lost reads this device made, when two devices wrote at once */
    const lost: string[] = [];
    for (const [space, one] of found) {
      const here = next.get(space);
      next.set(space, here ? merged(one, here) : one);
      if (here && !unwritten.has(space) && lacks(one, here)) lost.push(space);
    }
    loaded = true;
    changed(next);
    // Written back, so every device ends up with the reads of both.
    for (const space of lost) {
      unwritten.add(space);
      keep(space);
    }
  };

  const write = async (space: string) => {
    const one = seen.get(space);
    const registry = await node.account.space();
    if (!one || !registry) return;
    unwritten.delete(space);
    const body = {
      space,
      since: one.since,
      apps: Object.entries(one.apps).map(([app, at]) => ({ app, at })),
    };
    if (!(await node.collections.list(registry)).some((c) => c.name === seenRecords.name && c.schema))
      await node.collections.define(registry, seenRecords);
    // One record per space: the first look writes it, every one after edits it.
    const key = await node.records.onePerKey(registry, seenRecords.name, body);
    if (key && (await node.records.get(registry, key))) await node.records.update(registry, key, body);
    else await node.records.put(registry, seenRecords.name, body);
  };
  // One write at a time, so two looks in quick succession don't both create the space's record.
  let writing = Promise.resolve();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const keep = (space: string) => {
    clearTimeout(timers.get(space));
    timers.delete(space);
    if (!unwritten.has(space)) return;
    writing = writing.then(() => write(space)).catch((error: unknown) => console.warn('seen:', error));
  };

  void load().catch((error: unknown) => console.warn('seen:', error));
  node.subscribe((event) => {
    if (event.type === 'account') void load().catch(() => {});
  });

  return {
    read: () => seen,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** An app in a space was read up to a record written at `upTo`: held here until `keep` */
    look(space: string, app: string, upTo: string) {
      const now = new Date().toISOString();
      // A writer dates its own records: one from the future would hide everything after it.
      const at = upTo > now ? now : upTo;
      const one = seen.get(space) ?? { since: now, apps: {} };
      if (!at || at <= (one.apps[app] ?? one.since)) return;
      changed(new Map(seen).set(space, { ...one, apps: { ...one.apps, [app]: at } }));
      unwritten.add(space);
      clearTimeout(timers.get(space));
      timers.set(
        space,
        setTimeout(() => keep(space), QUIET_MS),
      );
    },
    /** A space none of your devices has seen yet starts now: what came before is not new */
    begin(space: string) {
      if (!loaded || seen.has(space)) return;
      changed(new Map(seen).set(space, { since: new Date().toISOString(), apps: {} }));
      unwritten.add(space);
      keep(space);
    },
    keep,
  };
}

/** How long looking goes on with nothing new before it is written anyway */
const QUIET_MS = 10_000;
