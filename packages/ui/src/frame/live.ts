import { useEffect, useRef, useState } from 'preact/hooks';
import type { Heard } from './minca';

/** What `usePresence` sends, kept apart from a tool's own live messages */
const PRESENCE = 'minca.presence';
/** How often someone's state goes out at most, so a cursor fits in a screen's allowance */
const EVERY_MS = 100;
/** How often someone says they are still here, and how long until they are thought gone */
const STILL_MS = 3000;
const GONE_MS = 10_000;

const isPresence = (data: unknown): data is { [PRESENCE]: unknown; hello?: boolean; bye?: boolean } =>
  typeof data === 'object' && data !== null && PRESENCE in data;

// A live message that can't go, like one while offline, is only missed.
const send = (data: unknown, to?: string) => void minca.live.send(data, to ? { to } : {}).catch(() => {});

/**
 * Calls `onHeard` with each live message another device with this tool open
 * sends; not those `usePresence` sends.
 */
export function useLive(onHeard: (heard: Heard) => void): void {
  const latest = useRef(onHeard);
  latest.current = onHeard;
  useEffect(() => minca.live.on((heard) => !isPresence(heard.data) && latest.current(heard)), []);
}

/** Someone with this tool open, and what they share */
export interface Present<T> {
  readonly did: string;
  readonly device: string;
  readonly state: T;
}

/**
 * Shares `state` (a cursor, what is selected, "typing") with everyone else
 * who has this tool open, and gives theirs: one per device, kept current,
 * dropping anyone not heard from for ten seconds. Use it once per screen.
 */
export function usePresence<T>(state: T): Present<T>[] {
  const [others, setOthers] = useState<Present<T>[]>([]);
  const mine = useRef(state);
  mine.current = state;
  const shown = JSON.stringify(state ?? null);

  // Others, by device, with when each was last heard
  const heard = useRef(new Map<string, Present<T> & { at: number }>());
  const sentAt = useRef(0);
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const seen = heard.current;
    const show = () =>
      setOthers([...seen.values()].map(({ did, device, state }) => ({ did, device, state })));
    const stop = minca.live.on(({ from, device, data }) => {
      if (!isPresence(data)) return;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- what each screen of this tool shares is its own to agree on
      const theirs = data[PRESENCE] as T;
      // A state of null is still someone here, with nothing to show; leaving is said apart.
      if (data.bye) seen.delete(device);
      else seen.set(device, { did: from, device, state: theirs, at: Date.now() });
      // Someone who just opened the tool hears from everyone at once, not at the next "still here".
      if (data.hello) send({ [PRESENCE]: mine.current ?? null }, device);
      show();
    });
    send({ [PRESENCE]: mine.current ?? null, hello: true });
    sentAt.current = Date.now();
    const still = setInterval(() => {
      send({ [PRESENCE]: mine.current ?? null });
      const now = Date.now();
      let dropped = false;
      for (const [device, one] of seen) if (now - one.at > GONE_MS) dropped = seen.delete(device);
      if (dropped) show();
    }, STILL_MS);
    return () => {
      stop();
      clearInterval(still);
      if (soon.current) clearTimeout(soon.current);
      send({ [PRESENCE]: null, bye: true });
    };
  }, []);

  // A change goes out at once, or with the next one when they come fast: never more than one per EVERY_MS.
  const started = useRef(false);
  useEffect(() => {
    // The first state went out with the hello.
    if (!started.current) return void (started.current = true);
    if (soon.current) return;
    const wait = sentAt.current + EVERY_MS - Date.now();
    const go = () => {
      soon.current = null;
      sentAt.current = Date.now();
      send({ [PRESENCE]: mine.current ?? null });
    };
    if (wait <= 0) go();
    else soon.current = setTimeout(go, wait);
  }, [shown]);

  return others;
}
