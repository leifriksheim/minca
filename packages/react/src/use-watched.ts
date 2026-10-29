import { useEffect, useState, type DependencyList } from 'react';
import type { NodeEvent, P2PNode } from '@minca/core';
import { useNode } from './context.js';

export interface Watch {
  /** The node events that call for loading again */
  readonly when?: (event: NodeEvent) => boolean;
  /** Milliseconds to wait after a burst of those events */
  readonly settle?: number;
  /** Milliseconds between loads, for what changes without telling anyone */
  readonly every?: number;
}

/**
 * Loads something from the node and keeps it current: again when `deps`
 * change, after the events `when` picks out, and every `every` ms. One load
 * at a time; asks during a load fold into one more. Undefined until the first
 * load; a failed load keeps what was there.
 */
export function useWatched<T>(
  load: (node: P2PNode) => Promise<T>,
  deps: DependencyList,
  { when, settle, every }: Watch = {},
): T | undefined {
  const node = useNode();
  const [value, setValue] = useState<T>();

  useEffect(() => {
    let current = true;
    const reload = coalesced(async () => {
      try {
        const next = await load(node);
        if (current) setValue(() => next);
      } catch (error) {
        console.warn('useWatched:', error);
      }
    });
    const later = settle ? debounced(reload, settle) : { run: reload, cancel: () => {} };

    reload();
    const unsubscribe = node.subscribe((event) => {
      if (when?.(event)) later.run();
    });
    const poll = every ? setInterval(reload, every) : undefined;
    return () => {
      current = false;
      unsubscribe();
      later.cancel();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load and when read
  }, [node, ...deps]);

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

/** Runs `work` once `ms` have passed without another call */
function debounced(work: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    run: () => {
      clearTimeout(timer);
      timer = setTimeout(work, ms);
    },
    cancel: () => clearTimeout(timer),
  };
}
