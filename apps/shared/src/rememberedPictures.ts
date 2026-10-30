/**
 * The pictures of accounts this browser has seen signed in, kept so a list of
 * accounts can show each by the picture its owner chose. An account's picture
 * lives with the account, readable only while it is signed in; this is this
 * browser's own copy, never synced, and only ever a face to recognise, never a
 * proof of whose account it is.
 */
import { useEffect } from 'react';

const keyOf = (did: string) => `minca:picture:${did}`;

/** The picture this browser last saw for an account, as a data URL, or null */
export function rememberedPicture(did: string): string | null {
  try {
    return globalThis.localStorage?.getItem(keyOf(did)) ?? null;
  } catch {
    return null;
  }
}

/** Forgets an account's picture here, as when it is removed */
export function forgetPicture(did: string): void {
  try {
    globalThis.localStorage?.removeItem(keyOf(did));
  } catch {
    // Storage off: nothing was kept.
  }
}

/**
 * Keeps the signed-in account's picture as it is shown (`src`, an object URL),
 * so a list of accounts can show it later. Its absence clears nothing: a
 * picture not loaded yet is not a picture taken away.
 */
export function useRememberPicture(did: string, src: string | null): void {
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    void fetch(src)
      .then((answer) => answer.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              typeof reader.result === 'string'
                ? resolve(reader.result)
                : reject(new Error('The picture could not be read'));
            reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read'));
            reader.readAsDataURL(blob);
          }),
      )
      .then((url) => {
        if (!cancelled) globalThis.localStorage?.setItem(keyOf(did), url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [did, src]);
}
