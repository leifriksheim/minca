/** What this browser keeps between visits, in local storage: lost with it, never synced. */
import { useState, useSyncExternalStore } from 'react';

function load(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage off: nothing kept.
    return null;
  }
}

function keep(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Kept for this page only.
  }
}

function loadJson(key: string): unknown {
  try {
    return JSON.parse(load(key) ?? 'null');
  } catch {
    return null;
  }
}

/** A word remembered under `key` on this device, like how a list was last laid out; null until one is */
export function useRemembered(key: string): readonly [string | null, (value: string) => void] {
  const [value, setValue] = useState(() => load(key));
  const set = (next: string) => {
    setValue(next);
    keep(key, next);
  };
  return [value, set];
}

/**
 * Something kept per account under `prefix`: read once and cached, and read
 * again when another tab of this app changes it. With nothing kept yet it
 * starts from `fresh()`, and keeps that.
 */
export function accountStore<T>(prefix: string, parse: (stored: unknown) => T | null, fresh: () => T) {
  const cache = new Map<string, T>();
  const listeners = new Set<() => void>();
  const keyOf = (did: string) => `${prefix}:${did}`;

  const read = (did: string): T => {
    let value = cache.get(did);
    if (value === undefined) {
      const stored = parse(loadJson(keyOf(did)));
      value = stored ?? fresh();
      if (stored === null) keep(keyOf(did), JSON.stringify(value));
      cache.set(did, value);
    }
    return value;
  };
  const write = (did: string, value: T) => {
    cache.set(did, value);
    keep(keyOf(did), JSON.stringify(value));
    listeners.forEach((listener) => listener());
  };

  globalThis.addEventListener?.('storage', (event) => {
    if (!event.key?.startsWith(`${prefix}:`)) return;
    cache.delete(event.key.slice(prefix.length + 1));
    listeners.forEach((listener) => listener());
  });

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const use = (did: string): T => useSyncExternalStore(subscribe, () => read(did));
  return { read, write, use };
}
