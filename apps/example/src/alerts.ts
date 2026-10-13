/** What this app's notifications matched lately, for the bell and the dot on the tab's icon; kept in this browser only. */
import { useEffect, useSyncExternalStore } from 'react';
import { MARK_BANDS } from '@weave/app-shared/mark';
import { accent, surface } from '@weave/app-shared/tokens';

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

const keyOf = (did: string) => `weave.alerts:${did}`;
const cache = new Map<string, Kept>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

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

function read(did: string): Kept {
  const held = cache.get(did);
  if (held) return held;
  let kept = EMPTY;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage.getItem(keyOf(did)) ?? 'null');
    if (typeof parsed === 'object' && parsed !== null && 'items' in parsed && Array.isArray(parsed.items))
      kept = {
        items: parsed.items.filter(isAlert),
        readAt: 'readAt' in parsed && typeof parsed.readAt === 'string' ? parsed.readAt : '',
      };
  } catch {
    // Storage blocked or spoiled: start empty.
  }
  cache.set(did, kept);
  return kept;
}

function write(did: string, kept: Kept) {
  cache.set(did, kept);
  try {
    globalThis.localStorage.setItem(keyOf(did), JSON.stringify(kept));
  } catch {
    // Kept for this page only.
  }
  changed();
}

/** Something a notification matched; one record is one alert */
export function addAlert(did: string, alert: Alert) {
  const kept = read(did);
  if (kept.items.some((item) => item.record === alert.record)) return;
  write(did, { ...kept, items: [alert, ...kept.items].slice(0, KEEP) });
}

/** Everything so far was looked at */
export function markRead(did: string) {
  const kept = read(did);
  const newest = kept.items[0]?.at ?? '';
  if (newest && newest > kept.readAt) write(did, { ...kept, readAt: newest });
}

// Another tab of this app adds or reads them too.
globalThis.addEventListener?.('storage', (event) => {
  if (!event.key?.startsWith('weave.alerts:')) return;
  cache.delete(event.key.slice('weave.alerts:'.length));
  changed();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The latest alerts, and how many came since they were last looked at */
export function useAlerts(did: string): { items: ReadonlyArray<Alert>; unread: number } {
  const kept = useSyncExternalStore(subscribe, () => read(did));
  return { items: kept.items, unread: kept.items.filter((item) => item.at > kept.readAt).length };
}

/** Minca's mark, as the tab's icon: the rainbow (`@weave/app-shared/mark`), lowered to sit in a square */
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
