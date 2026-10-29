import { useEffect, useState } from 'react';
import { useSession } from '@minca/react';

/**
 * The account's picture, as a URL to show it by, or null while there is none.
 * Read again when the account changes, so a picture chosen in an app shows here too.
 */
export function useAccountPicture(): string | null {
  const { node } = useSession();
  const [picture, setPicture] = useState<Blob | null>(null);
  useEffect(() => {
    let current = true;
    const read = () =>
      node.account.picture().then(
        (found) => current && setPicture(found && new Blob([found.bytes.slice()], { type: found.mime })),
        () => {}, // Its bytes on a device that is away: the shape stands in.
      );
    void read();
    const stop = node.subscribe((event) => event.type === 'account' && void read());
    return () => {
      current = false;
      stop();
    };
  }, [node]);
  return useObjectUrl(picture);
}

/** A URL for `blob` while it is shown, let go of after */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = blob && URL.createObjectURL(blob);
    setUrl(made);
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [blob]);
  return url;
}
