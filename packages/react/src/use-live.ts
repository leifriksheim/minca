import type { P2PNode } from '@minca/core';
import { useWatched } from './use-watched.js';

/**
 * Loads something from a space, and loads it again whenever that space's
 * records or connection change, locally or by sync.
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
  return useWatched(load, [spaceId, ...deps], {
    when: (event) => 'space' in event && event.space === spaceId,
  });
}
