/** What this app's notifications matched lately, for the bell and the dot on the tab's icon; kept in this browser only. */
import { useEffect } from 'react';
import { MARK_BANDS } from '@minca/app-shared/mark';
import { accent, surface } from '@minca/ui/tokens';
import { accountStore } from './kept';

export interface Alert {
  /** The record it is about */
  readonly record: string;
  readonly space: string;
  /** What the notification says */
  readonly label: string;
  readonly at: string;
}

interface Kept {
  readonly items: ReadonlyArray<Alert>;
  /** Everything up to this was looked at */
  readonly readAt: string;
}

/** How many are kept, newest first */
const KEEP = 50;
const EMPTY: Kept = { items: [], readAt: '' };

function isAlert(value: unknown): value is Alert {
  return (
    typeof value === 'object' &&
    value !== null &&
    'record' in value &&
    typeof value.record === 'string' &&
    'space' in value &&
    typeof value.space === 'string' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'at' in value &&
    typeof value.at === 'string'
  );
}

const kept = accountStore<Kept>(
  'minca.alerts',
  (stored) =>
    typeof stored === 'object' && stored !== null && 'items' in stored && Array.isArray(stored.items)
      ? {
          items: stored.items.filter(isAlert),
          readAt: 'readAt' in stored && typeof stored.readAt === 'string' ? stored.readAt : '',
        }
      : null,
  () => EMPTY,
);

/** Something a notification matched; one record is one alert */
export function addAlert(did: string, alert: Alert) {
  const now = kept.read(did);
  if (now.items.some((item) => item.record === alert.record)) return;
  kept.write(did, { ...now, items: [alert, ...now.items].slice(0, KEEP) });
}

/** Everything so far was looked at */
export function markRead(did: string) {
  const now = kept.read(did);
  const newest = now.items[0]?.at ?? '';
  if (newest && newest > now.readAt) kept.write(did, { ...now, readAt: newest });
}

/** The latest alerts, and how many came since they were last looked at */
export function useAlerts(did: string): { items: ReadonlyArray<Alert>; unread: number } {
  const { items, readAt } = kept.use(did);
  return { items, unread: items.filter((item) => item.at > readAt).length };
}

/** Minca's mark, as the tab's icon: the rainbow (`@minca/app-shared/mark`), lowered to sit in a square */
const MARK = `<g transform="translate(0 5.5)">${MARK_BANDS.map(({ d, fill }) => `<path fill="${fill}" d="${d}"/>`).join('')}</g>`;
const DOT = `<circle cx="20" cy="5" r="4.5" fill="${accent.danger}" stroke="${surface.page}" stroke-width="1.5"/>`;
const icon = (dot: boolean) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${MARK}${dot ? DOT : ''}</svg>`)}`;

/** The tab's icon, with a red dot while something matched hasn't been looked at */
export function useTabDot(dot: boolean) {
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
