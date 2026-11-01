import { useEffect, useState } from 'react';
import { useNode } from '@minca/react';

/** How long the line stays after the last records arrived: long enough to be seen, short enough to mean now */
const LINGER_MS = 900;

/**
 * A hairline along the top of the screen while records come in (`.sync-line`): in one space, or in
 * any of yours where none is open. It knows only that records changed, which is what a peer sending
 * them looks like here; what you write yourself shows for a moment too, on its way out.
 */
export function SyncLine({ space }: { space?: string }) {
  const node = useNode();
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = node.subscribe((event) => {
      if (event.type !== 'records' || (space !== undefined && event.space !== space)) return;
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), LINGER_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [node, space]);
  return <div className="sync-line" data-on={on || undefined} aria-hidden />;
}
