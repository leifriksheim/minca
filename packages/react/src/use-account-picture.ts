import { useEffect, useMemo } from 'react';
import { useNode } from './context.js';
import { useWatched } from './use-watched.js';

/**
 * The account's picture as a URL to show it by; null while there is none, or
 * while it can't be read (an app without the account key, or its bytes on a
 * device that is away). Read again when the account changes.
 */
export function useAccountPicture(): string | null {
  const node = useNode();
  const picture = useWatched(() => node.account.picture().catch(() => null), [node], {
    when: (event) => event.type === 'account',
  });
  return useObjectUrl(picture ?? null);
}

/** A URL for these bytes while they are shown, let go of after */
export function useObjectUrl(
  file: { readonly bytes: Uint8Array; readonly mime: string } | null,
): string | null {
  const url = useMemo(
    () => file && URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mime })),
    [file],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}
