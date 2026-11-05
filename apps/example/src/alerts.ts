/**
 * What this app's notifications match, for the bell and the tab's dot and count. The list is worked
 * out from the records (`watchNotifications`' activity), so every device shows the same, and what was
 * read is how far, kept with the rest of what you have seen (`seen.ts`).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { ActivityMatch } from '@minca/core';
import { useAsync, useNode } from '@minca/react';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { state } from '@minca/ui/tokens';
import { seenAt, useBegin, useLookingAt, useSeen } from './seen';

export interface Alert {
  /** The record it is about */
  readonly record: string;
  readonly space: string;
  /** What the notification says */
  readonly label: string;
  /** When what set it off was written */
  readonly at: string;
}

/** What a notification says: its own words, or the automation's name */
export const labelOf = ({ automation }: Pick<ActivityMatch, 'automation'>): string =>
  automation.then.kind === 'notify' ? automation.then.text : automation.name;

// The latest list, from the one watcher the app runs (`useShowNotifications`)
let latest: ReadonlyArray<Alert> = [];
const listeners = new Set<() => void>();

/** What the notifications match now, as the watcher last said */
export function setActivity(matches: ReadonlyArray<ActivityMatch>): void {
  latest = matches.map((match) => ({
    record: match.record.key,
    space: match.record.space,
    label: labelOf(match),
    at: match.at,
  }));
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Where reading the activity is kept: under the account registry's id, the one place that spans every space */
const ACTIVITY = ':activity';

function useActivityPlace(): string {
  const node = useNode();
  const found = useAsync(() => node.account.space(), [node]);
  // Without a registry, an app given only some spaces, it is kept in memory under no space.
  return found.status === 'done' ? (found.value ?? '') : '';
}

/** The latest matches, and how many are newer than what was read */
export function useAlerts(): { items: ReadonlyArray<Alert>; unread: number } {
  const items = useSyncExternalStore(subscribe, () => latest);
  const place = useActivityPlace();
  const seen = useSeen();
  useBegin(place);
  const read = seenAt(seen, place, ACTIVITY);
  return { items, unread: items.filter((item) => Date.parse(item.at) > read).length };
}

/** Reads the activity, up to its newest, while `open`: the bell's panel, or the Activity page */
export function useReadingAlerts(open: boolean): void {
  const items = useSyncExternalStore(subscribe, () => latest);
  const place = useActivityPlace();
  const newest = items.reduce((at, item) => (item.at > at ? item.at : at), '');
  useLookingAt(place, open ? ACTIVITY : undefined, newest);
}

/** Minca's mark, as the tab's icon: the rainbow (`@minca/app-shared/mark`), lowered to sit in a square */
const MARK = `<g transform="translate(0 5.5)">${MARK_BANDS.map(({ d, fill }) => `<path fill="${fill}" d="${d}"/>`).join('')}</g>`;
const DOT = `<circle cx="20" cy="5" r="4.5" fill="${state.danger}" stroke="${state.paper}" stroke-width="1.5"/>`;
const icon = (dot: boolean) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${MARK}${dot ? DOT : ''}</svg>`)}`;

/** How many are new, as the tab's title starts: `(3) Minca` */
const COUNT = /^\(\d+\+?\) /;

/** The tab's icon with a red dot, and its title with how many, while something matched hasn't been looked at */
export function useTabBadge(unread: number) {
  const dot = unread > 0;
  useEffect(() => {
    const title = globalThis.document.title.replace(COUNT, '');
    globalThis.document.title = dot ? `(${unread > 99 ? '99+' : unread}) ${title}` : title;
  }, [dot, unread]);
  useEffect(() => {
    let link = globalThis.document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = globalThis.document.createElement('link');
      link.rel = 'icon';
      globalThis.document.head.append(link);
    }
    link.type = 'image/svg+xml';
    link.href = icon(dot);
  }, [dot]);
}
