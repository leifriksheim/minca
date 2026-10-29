import { useEffect, useState, type DependencyList } from 'react';
import type { NodeEvent, P2PNode } from '@minca/core';
import { useNode } from '@minca/react';

type Watch = {
  /** The node events that call for loading again */
  readonly when?: (event: NodeEvent) => boolean;
  /** Milliseconds to wait after a burst of those events */
  readonly settle?: number;
  /** Milliseconds between loads, for what changes without telling anyone */
  readonly every?: number;
};

/**
 * Loads something from the node, again whenever `deps` change, and again
 * after the events `when` picks out. Undefined until the first load; a failed
 * load keeps what was there.
 */
export function useWatched<T>(
  load: (node: P2PNode) => Promise<T>,
  deps: DependencyList,
  { when, settle = 0, every }: Watch = {},
): T | undefined {
  const node = useNode();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () =>
      void load(node).then(
        (next) => current && setValue(() => next),
        () => {},
      );
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, settle);
    };
    reload();
    const stop = node.subscribe((event) => {
      if (when?.(event)) later();
    });
    const poll = every ? setInterval(reload, every) : undefined;
    return () => {
      current = false;
      clearTimeout(timer);
      clearInterval(poll);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load and when read
  }, [node, ...deps]);
  return value;
}
