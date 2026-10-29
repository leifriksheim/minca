import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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

/**
 * What `load` gives for the current `deps`; null until then, or if it fails.
 * An answer for older `deps` is dropped.
 */
export function useAnswer<T>(load: () => Promise<T>, deps: ReadonlyArray<unknown>): T | null {
  const [answer, setAnswer] = useState<T | null>(null);
  useEffect(() => {
    let current = true;
    setAnswer(null);
    load().then(
      (value) => current && setAnswer(() => value),
      () => {},
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what load reads
  }, deps);
  return answer;
}

/** A cache of answers by id: each is asked for once, and a failure is forgotten so it is asked again */
export function remembered<T>(): (id: string, make: () => Promise<T>) => Promise<T> {
  const known = new Map<string, Promise<T>>();
  return (id, make) => {
    let answer = known.get(id);
    if (!answer) {
      answer = make();
      answer.catch(() => known.delete(id));
      known.set(id, answer);
    }
    return answer;
  };
}

/** Pictures by file, asked for once for the life of the screen */
const files = remembered<string | null>();

/**
 * A picture a record refers to (`{ hash, mime, … }` in its body), as a URL an
 * `<img>` shows; null until it is here, or if it can't be had.
 */
export function useFile(key: string, ref: { readonly hash: string } | null | undefined): string | null {
  const hash = ref?.hash ?? null;
  return useAnswer(async () => (hash ? files(hash, () => minca.file(key, hash)) : null), [key, hash]);
}

/**
 * The whole file a record refers to, as a URL for `<img>`, `<video>` or
 * `<audio>`; null until it is here, or if it can't be had. Let go of when
 * the screen stops showing it, since whole files can be large.
 */
export function useBlob(key: string, ref: { readonly hash: string } | null | undefined): string | null {
  const hash = ref?.hash ?? null;
  const blob = useAnswer(async () => (hash ? minca.blob(key, hash) : null), [key, hash]);
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
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

/**
 * For a list: the key of the record this app was asked to show, once the
 * element with that `data-key` is drawn (it looks after each draw). The
 * element is scrolled to, and the key stays a moment, for `data-marked` to
 * light it up.
 */
export function useMarked(): string | null {
  const shown = useShown();
  const [marked, setMarked] = useState<string | null>(null);
  const done = useRef<{ key: string } | null>(null);
  useEffect(() => {
    if (!shown || done.current === shown) return;
    const element = document.querySelector(`[data-key="${CSS.escape(shown.key)}"]`);
    if (!element) return;
    done.current = shown;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    setMarked(shown.key);
  });
  useEffect(() => {
    if (!marked) return;
    const off = setTimeout(() => setMarked(null), 2500);
    return () => clearTimeout(off);
  }, [marked]);
  return marked;
}

/** Whether the person looking may `create`, `edit` or `delete` in a collection; false until known */
export const useCan = (action: 'create' | 'edit' | 'delete', collection: string) =>
  useLoaded(() => minca.can(action, collection), [action, collection]) ?? false;
