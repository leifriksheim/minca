import { useEffect, useState } from 'preact/hooks';
import type { Minca, ScreenRecord } from './minca';

/**
 * What `load` gives, again whenever the space changes; null until the first answer.
 * `deps` are what `load` reads, like a hook's.
 */
function useLoaded<T>(load: () => Promise<T>, deps: ReadonlyArray<unknown>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    // A slow answer must not overwrite a newer one.
    let asked = 0;
    const fetch = () => {
      const at = ++asked;
      // A failed answer keeps the last one; the next change asks again.
      load().then(
        (next) => live && at === asked && setValue(() => next),
        () => {},
      );
    };
    fetch();
    const stop = minca.onChange(fetch);
    return () => {
      live = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load reads
  }, deps);
  return value;
}

/** A collection's records, oldest first, kept current; null until they are here */
export const useRecords = <T = Record<string, unknown>>(collection: string, where?: unknown) =>
  useLoaded<ScreenRecord<T>[]>(
    () => minca.list<T>(collection, where === undefined ? {} : { where }),
    [collection, JSON.stringify(where ?? null)],
  );

/** Everyone in the space, asked once per change however many faces are showing */
let people: ReturnType<Minca['people']> | null = null;
// Registered before any hook's, so it runs first on each change.
minca.onChange(() => (people = null));

/** Everyone in the space who said their name */
export const usePeople = () => useLoaded(() => (people ??= minca.people()), []) ?? [];

/** Pictures by file, asked for once for the life of the screen */
const files = new Map<string, Promise<string | null>>();

/**
 * A picture a record refers to (`{ hash, mime, … }` in its body), as a URL an
 * `<img>` shows; null until it is here, or if it can't be had.
 */
export function useFile(key: string, ref: { readonly hash: string } | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const hash = ref?.hash ?? null;
  useEffect(() => {
    if (!hash) return setUrl(null);
    let live = true;
    let known = files.get(hash);
    if (!known) {
      known = minca.file(key, hash);
      // A file that couldn't be had now, like one still syncing, may be had later: not remembered.
      known.catch(() => files.delete(hash));
      files.set(hash, known);
    }
    known.then(
      (found) => live && setUrl(found),
      () => live && setUrl(null),
    );
    return () => {
      live = false;
    };
  }, [key, hash]);
  return url;
}

/**
 * The whole file a record refers to, as a URL for `<img>`, `<video>` or
 * `<audio>`; null until it is here, or if it can't be had. Let go of when
 * the screen stops showing it, since whole files can be large.
 */
export function useBlob(key: string, ref: { readonly hash: string } | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const hash = ref?.hash ?? null;
  useEffect(() => {
    setUrl(null);
    if (!hash) return;
    let live = true;
    let made: string | null = null;
    minca.blob(key, hash).then(
      (blob) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => {},
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [key, hash]);
  return url;
}

/**
 * The key of the record this app was last asked to show, opened from
 * elsewhere (a file's message, from the Files app, opens in the chat); null
 * until one is. Each opening is a new value, even of the same record, so an
 * effect on it runs every time.
 */
export function useShown(): { key: string } | null {
  const [shown, setShown] = useState<{ key: string } | null>(() => {
    const key = minca.shown();
    return key ? { key } : null;
  });
  useEffect(() => minca.onShow((key) => setShown({ key })), []);
  return shown;
}

/** Whether the person looking may `create`, `edit` or `delete` in a collection; false until known */
export const useCan = (action: 'create' | 'edit' | 'delete', collection: string) =>
  useLoaded(() => minca.can(action, collection), [action, collection]) ?? false;
