/**
 * Notifications in the Chrome extension: what one of the account's
 * automations matched, shown by the system. A notification says where
 * something arrived and what kind of thing; the app shows what it says.
 *
 * A burst in one space, for one app, is one notification: a node that was
 * away catches up all at once.
 */

/** A record one of the account's automations matched */
export interface Matched {
  /** The space's name */
  readonly space: string;
  readonly collection: string;
  readonly at: string;
  /** The app the notification leads to */
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

function described(matches: ReadonlyArray<Matched>): string {
  const kinds = [...new Set(matches.map((match) => kindOf(match.collection)))];
  if (matches.length === 1) return `New ${kinds[0]}`;
  if (kinds.length === 1) return `${matches.length} new ${kinds[0]}s`;
  return `${matches.length} new things`;
}

export function createNotifier(params: {
  readonly show: (shown: Shown) => void;
  /** How long a burst in one space gathers before it is shown */
  readonly gatherMs?: number;
}) {
  const gatherMs = params.gatherMs ?? 1500;
  const waiting = new Map<string, Matched[]>();
  return {
    matched(match: Matched): void {
      // One burst per space and app, so each notification leads to the app that asked for it.
      const key = `${match.space} ${match.open ?? ''}`;
      const gathered = waiting.get(key);
      if (gathered) return void gathered.push(match);
      waiting.set(key, [match]);
      setTimeout(() => {
        const all = waiting.get(key) ?? [];
        waiting.delete(key);
        if (all.length > 0)
          params.show({
            title: match.space,
            body: described(all),
            ...(match.open ? { open: match.open } : {}),
          });
      }, gatherMs);
    },
  };
}
