import { useEffect, useState } from 'react';
import type { P2PNode } from '@minca/core';
import { useNode } from './context.js';

/**
 * Loads something from a space, and loads it again whenever that space's
 * records or connection change — locally or by sync. One load at a time; a
 * change during a load triggers one more, never a queue of stale ones.
 *
 * The named hooks (`useRecord`, `useCollections`, …) cover the usual reads;
 * this is for anything else.
 *
 * @param spaceId The space to follow
 * @param load What to read, given the node
 * @param deps When these change, start over
 * @returns The latest value, or undefined until the first load finishes
 */
export function useLive<T>(
  spaceId: string,
  load: (node: P2PNode) => Promise<T>,
  deps: ReadonlyArray<unknown>,
): T | undefined {
  const node = useNode();
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    const reload = coalesced(async () => {
      try {
        const next = await load(node);
        if (!stopped) setValue(next);
      } catch (error) {
        console.warn('useLive:', error);
      }
    });
    reload();
    const unsubscribe = node.subscribe((event) => {
      if ('space' in event && event.space === spaceId) reload();
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load reads
  }, [node, spaceId, ...deps]);

  return value;
}

/** Runs `work` now, or once more after the run in progress: calls in between fold into one. */
function coalesced(work: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    do {
      again = false;
      await work();
    } while (again);
    running = false;
  };
  return () => {
    if (running) again = true;
    else void run();
  };
}
