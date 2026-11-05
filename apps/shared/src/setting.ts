/**
 * A setting chosen once for the account, like the theme: one record per person
 * in the account's registry (`node.account.space()`), which syncs to every
 * device and every Minca app. Each device remembers the last value it saw, so
 * a page starts with it before the record arrives.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { collection, type P2PNode } from '@minca/core';
import { useNode, useWatched } from '@minca/react';

/** A record body's field, when the body is an object */
export const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === 'object' && body !== null ? Reflect.get(body, key) : undefined;

export function accountSetting<T extends object>(params: {
  /** The collection's name, and the key it is remembered under on this device */
  readonly name: string;
  readonly title: string;
  /** The JSON Schema of the record's body */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly valid: (body: unknown) => body is T;
  readonly fallback: NoInfer<T>;
}) {
  const { name, valid, fallback } = params;
  const definition = collection({
    name,
    title: params.title,
    schema: params.schema,
    rules: { onePer: ['@author'] },
  });

  const remembered = (): T => {
    try {
      const kept: unknown = JSON.parse(globalThis.localStorage?.getItem(name) ?? 'null');
      return valid(kept) ? kept : fallback;
    } catch {
      return fallback;
    }
  };

  let current = remembered();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  /** Shown here, and remembered on this device */
  function show(value: T): void {
    const text = JSON.stringify(value);
    if (text === JSON.stringify(current)) return;
    current = value;
    try {
      globalThis.localStorage?.setItem(name, text);
    } catch {
      // Storage off: remembered for this page only.
    }
    for (const listener of listeners) listener();
  }

  // Another tab chose: this one follows.
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key === name) show(remembered());
  });

  async function read(node: P2PNode): Promise<T | null> {
    const space = await node.account.space();
    if (!space) return null;
    const { records } = await node.records.query(space, { collection: definition });
    const body = records[0]?.body;
    return valid(body) ? body : null;
  }

  async function save(node: P2PNode, value: T): Promise<void> {
    show(value);
    const space = await node.account.space();
    if (!space) return;
    if (!(await node.collections.list(space)).some((c) => c.name === name && c.schema))
      await node.collections.define(space, definition);
    await node.records.put(space, definition, value);
  }

  return {
    /** The value as this device last saw it */
    get: (): T => current,
    /** The value, following the account's record as it changes here or on another device, and the way to change it */
    use: (): readonly [T, (next: T) => void] => {
      const node = useNode();
      const found = useWatched(read, [], { when: (event) => event.type === 'account' });
      useEffect(() => {
        if (found) show(found);
      }, [found]);
      const value = useSyncExternalStore(subscribe, () => current);
      return [value, (next: T) => void save(node, next).catch(() => {})];
    },
  };
}
