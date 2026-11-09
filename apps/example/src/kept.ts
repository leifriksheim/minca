/** What this browser keeps between visits, in local storage: lost with it, never synced. */
import { useState } from 'react';

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

/** A value kept under `key` on this device as JSON, read when asked; null until one is */
export const readKept = (key: string): unknown => loadJson(key);
export const writeKept = (key: string, value: unknown): void => keep(key, JSON.stringify(value));

/** A word remembered under `key` on this device, like how a list was last laid out; null until one is */
export function useRemembered(key: string): readonly [string | null, (value: string) => void] {
  const [value, setValue] = useState(() => load(key));
  const set = (next: string) => {
    setValue(next);
    keep(key, next);
  };
  return [value, set];
}
