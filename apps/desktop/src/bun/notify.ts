/**
 * Notifications from the menu bar: what the carrier says a wake matched
 * (`minca carry`, `state: 'wake'`), shown by the system. The carrier sees a
 * record from outside only, so a notification says where something arrived
 * and what kind of thing, never what it says; the app shows that.
 *
 * A burst in one space is one notification: a carrier that was away catches
 * up all at once.
 */

/** What the carrier says a wake matched */
export interface Woke {
  readonly space: string;
  readonly collection: string;
  readonly at: string;
  readonly open?: string;
}

export interface Shown {
  readonly title: string;
  readonly body: string;
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
      const gathered = waiting.get(wake.space);
      if (gathered) return void gathered.push(wake);
      waiting.set(wake.space, [wake]);
      setTimeout(() => {
        const all = waiting.get(wake.space) ?? [];
        waiting.delete(wake.space);
        if (all.length > 0) params.show({ title: wake.space, body: described(all) });
      }, gatherMs);
    },
  };
}
