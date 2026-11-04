/**
 * What this device downloads of others' files before anyone opens them, and
 * how much it keeps per space: chosen per device, since a phone on mobile data
 * wants less than a laptop at home. Kept in this browser and given to the
 * node each time it starts (`node.setFileLimits`), as the node keeps none.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { DEVICE_LIMITS, type FileLimits } from '@minca/core';
import { useNode } from '@minca/react';
import { readKept, writeKept } from './kept';

const KEY = 'minca:downloads';
const MB = 1024 * 1024;

export type Ahead = 'thumbnails' | 'photos' | 'everything';
export type Keep = '256' | '1024' | '4096';

export interface Downloads {
  readonly ahead: Ahead;
  readonly keep: Keep;
}

/** The largest file fetched before it is opened: one chunk, which every thumbnail fits; a device's default; any */
const AHEAD_BYTES: Readonly<Record<Ahead, number>> = {
  thumbnails: 256 * 1024,
  photos: DEVICE_LIMITS.ahead,
  everything: Infinity,
};

const DEFAULT: Downloads = Object.freeze({ ahead: 'photos', keep: '256' });

const isAhead = (value: unknown): value is Ahead => typeof value === 'string' && value in AHEAD_BYTES;
const isKeep = (value: unknown): value is Keep => value === '256' || value === '1024' || value === '4096';

function read(): Downloads {
  const kept = readKept(KEY);
  if (typeof kept !== 'object' || kept === null) return DEFAULT;
  const ahead: unknown = Reflect.get(kept, 'ahead');
  const keep: unknown = Reflect.get(kept, 'keep');
  return { ahead: isAhead(ahead) ? ahead : DEFAULT.ahead, keep: isKeep(keep) ? keep : DEFAULT.keep };
}

let current = read();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

// Another tab chose: this one follows.
globalThis.addEventListener?.('storage', (event) => {
  if (event.key !== KEY) return;
  current = read();
  changed();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** This device's choice, and the way to change it */
export function useDownloads(): readonly [Downloads, (next: Downloads) => void] {
  const downloads = useSyncExternalStore(subscribe, () => current);
  const set = (next: Downloads) => {
    current = next;
    writeKept(KEY, next);
    changed();
  };
  return [downloads, set];
}

/** The node's limits for a choice */
const limitsOf = (downloads: Downloads): FileLimits => ({
  ahead: AHEAD_BYTES[downloads.ahead],
  keep: Number(downloads.keep) * MB,
});

/** Gives the node this device's choice when it starts, and again whenever it changes */
export function useApplyDownloads(): void {
  const node = useNode();
  const [downloads] = useDownloads();
  useEffect(() => {
    void node.setFileLimits(limitsOf(downloads)).catch(() => {
      // A node from before limits could be set: it keeps its own.
    });
  }, [node, downloads]);
}
