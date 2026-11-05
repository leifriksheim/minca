/**
 * Notifications from a carrier, in the Chrome extension: what it says a wake matched, shown by the system. The carrier
 * sees a record from outside only, so a notification says where something
 * arrived and what kind of thing, never what it says; the app shows that.
 *
 * A burst in one space, for one app, is one notification: a carrier that was
 * away catches up all at once.
 */

/** What the carrier says a wake matched */
export interface Woke {
  /** The space's name */
  readonly space: string;
  readonly collection: string;
  readonly at: string;
  /** The app the wake's notification leads to */
  readonly open?: string;
}

export interface Shown {
  readonly title: string;
  readonly body: string;
  readonly open?: string;
}

/** `app.chat.message` → `message`: the last part of a collection's name, in words */
export function kindOf(collection: string): string {
  const last = collection.split('.').filter(Boolean).at(-1) ?? 'record';
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function described(wakes: ReadonlyArray<Woke>): string {
  const kinds = [...new Set(wakes.map((wake) => kindOf(wake.collection)))];
  if (wakes.length === 1) return `New ${kinds[0]}`;
  if (kinds.length === 1) return `${wakes.length} new ${kinds[0]}s`;
  return `${wakes.length} new things`;
}

export function createNotifier(params: {
  readonly show: (shown: Shown) => void;
  /** How long a burst in one space gathers before it is shown */
  readonly gatherMs?: number;
}) {
  const gatherMs = params.gatherMs ?? 1500;
  const waiting = new Map<string, Woke[]>();
  return {
    woke(wake: Woke): void {
      // One burst per space and app, so each notification leads to the app that asked for it.
      const key = `${wake.space} ${wake.open ?? ''}`;
      const gathered = waiting.get(key);
      if (gathered) return void gathered.push(wake);
      waiting.set(key, [wake]);
      setTimeout(() => {
        const all = waiting.get(key) ?? [];
        waiting.delete(key);
        if (all.length > 0)
          params.show({ title: wake.space, body: described(all), ...(wake.open ? { open: wake.open } : {}) });
      }, gatherMs);
    },
  };
}
