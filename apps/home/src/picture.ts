import { useEffect, useState } from 'react';
import { useSession } from '@minca/react';

/**
 * The account's picture, as a URL to show it by, or null while there is none.
 * Read from the account registry, and again when the account changes, so a
 * picture chosen in an app shows here too.
 */
export function useAccountPicture(): string | null {
  const { node } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let shown: string | null = null;
    const read = () =>
      void node.account
        .picture()
        .then((found) => {
          if (!live) return;
          const next = found
            ? URL.createObjectURL(new Blob([found.bytes.slice()], { type: found.mime }))
            : null;
          if (shown) URL.revokeObjectURL(shown);
          shown = next;
          setUrl(next);
        })
        .catch(() => {
          // Its bytes on a device that is away: the shape stands in.
        });
    read();
    const stop = node.subscribe((event) => {
      if (event.type === 'account') read();
    });
    return () => {
      live = false;
      stop();
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [node]);
  return url;
}
