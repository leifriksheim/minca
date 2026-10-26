/**
 * One WebSocket to a relay, of any kind, kept open for as long as it is wanted:
 * a relay unreachable for a minute, a laptop asleep, a network switched, all
 * end with the socket back. Each kind of relay (`relay-minca.ts`,
 * `relay-nostr.ts`) says what to send when it opens and what to make of what
 * comes back; this keeps it open.
 *
 * A socket can die without closing: after a sleep or a network switch the
 * relay has dropped it, but nothing tells this end, which goes on looking
 * open. So the socket watches its own clock: timers stop while a device
 * sleeps, and one that fires long after it was due means the device woke, and
 * the socket is dialled again. That needs nothing of the relay. A kind that
 * can ask its relay whether it is still there (`ping`) also catches a socket
 * that dies while awake; a relay that never answers is not held to it.
 */
import { createEmitter } from '../utils/events.js';
import { isObject } from '../utils/guards.js';
import { backoff, createRetry } from '../utils/backoff.js';

/** Where one relay's socket stands */
export type RelayState =
  /** Opening a socket */
  | 'connecting'
  /** Open: peers can meet through it */
  | 'open'
  /** Closed, and trying again at `retryAt` */
  | 'waiting'
  /** Let go on purpose, or never asked to connect */
  | 'stopped';

/** One relay's connection, for showing and for deciding when to try again */
export interface RelayStatus {
  /** The relay as named, with its kind's scheme (`wss://…`, `nostr+wss://…`) */
  readonly url: string;
  readonly state: RelayState;
  /** When the state last changed (ms) */
  readonly since: number;
  /** When the socket last opened (ms), or null if it never has */
  readonly openedAt: number | null;
  /** Attempts in a row that did not open */
  readonly failures: number;
  /** When the next attempt is due (ms), while waiting */
  readonly retryAt: number | null;
  /** Why the last socket closed or failed, in a sentence, or null */
  readonly problem: string | null;
  /** Topics this socket watches: one per room */
  readonly topics: number;
}

export type RelaySocketEvents = {
  connected: () => void;
  disconnected: () => void;
  status: (status: RelayStatus) => void;
};

export interface RelaySocket {
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  /** Tries again now, if waiting to */
  readonly reconnect: () => void;
  /** Sends a JSON message if the socket is open; dropped otherwise, since `opened` says it all again */
  readonly send: (message: unknown) => void;
  readonly isConnected: () => boolean;
  readonly status: () => RelayStatus;
  /** Says how many topics the socket watches, for its status */
  readonly count: (topics: number) => void;
  readonly on: <K extends keyof RelaySocketEvents>(event: K, callback: RelaySocketEvents[K]) => void;
  readonly off: <K extends keyof RelaySocketEvents>(event: K, callback: RelaySocketEvents[K]) => void;
}

export interface RelaySocketOptions {
  /** The relay as named, for its status */
  readonly url: string;
  /** What to dial: the relay's address without its kind's scheme */
  readonly dial: string;
  /** Said each time the socket opens: a relay forgets everything when a socket closes */
  readonly opened: (send: (message: unknown) => void) => void;
  /** Each JSON message the relay sends */
  readonly heard: (message: unknown, send: (message: unknown) => void) => void;
  /** A message asking whether the relay is still there, and how to tell its answer; none for a kind that can't ask */
  readonly ping?: { readonly ask: unknown; readonly isAnswer: (message: unknown) => boolean };
}

/** Longest wait between attempts. There is no last attempt: a relay that comes back is found again. */
const MAX_BACKOFF_MS = 30_000;
/** How often the clock is looked at, to notice a sleep */
const WAKE_CHECK_MS = 5_000;
/** A look this late means the device slept for longer than a relay keeps a silent socket (two 15 s heartbeats) */
const SLEPT_MS = 30_000;
/** How often an open socket that has heard nothing pings the relay */
const PING_MS = 30_000;
/** Pings in a row a relay may leave unanswered before its socket is taken for dead */
const MAX_UNANSWERED = 2;

/**
 * Once connected it stays connected: a socket that closes is opened again,
 * waiting longer each time up to 30 seconds and never giving up, and sooner
 * when the device comes back online or its page is looked at again. Only
 * `disconnect` stops it.
 */
export function createRelaySocket(options: RelaySocketOptions): RelaySocket {
  const { url } = options;
  let ws: WebSocket | null = null;
  let wanted = false;
  let topics = 0;
  /** Lets go of the socket in use as if it had closed, for one that is likely dead */
  let drop: ((reason: string) => void) | null = null;
  const { on, off, emit } = createEmitter<RelaySocketEvents>();

  let status: RelayStatus = Object.freeze({
    url,
    state: 'stopped',
    since: Date.now(),
    openedAt: null,
    failures: 0,
    retryAt: null,
    problem: null,
    topics: 0,
  });
  const setStatus = (patch: Partial<RelayStatus>): void => {
    const next = { ...status, ...patch, topics };
    if (next.state !== status.state) next.since = Date.now();
    status = Object.freeze(next);
    emit('status', status);
  };

  const send = (message: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  // A failed open's close schedules the next try.
  const retry = createRetry(() => open().catch(() => {}));
  const scheduleRetry = (delay: number): void => {
    setStatus({ state: 'waiting', retryAt: Date.now() + delay });
    retry.schedule(delay);
  };

  /** Opens a socket, unless one is open or opening. Settles when it opens or fails. */
  const open = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        resolve();
        return;
      }
      retry.clear();

      let socket: WebSocket;
      try {
        socket = new WebSocket(options.dial);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setStatus({ failures: status.failures + 1, problem: error.message });
        if (wanted) scheduleRetry(backoff(status.failures, MAX_BACKOFF_MS));
        reject(error);
        return;
      }
      ws = socket;
      let opened = false;
      /** Whether this relay answers pings: one that never has is not held to it */
      let answers = false;
      /** Pings sent since the relay last said anything */
      let unanswered = 0;
      /** Whether the relay said anything since the last look: then there is no need to ask */
      let heard = false;
      let pinging: ReturnType<typeof setInterval> | undefined;
      setStatus({ state: 'connecting', retryAt: null });
      drop = (reason) => {
        // Its close may never come, so it is ended here, and the late one finds it replaced.
        ended({ reason });
        socket.close();
      };

      socket.onopen = () => {
        if (ws !== socket) return;
        opened = true;
        setStatus({ state: 'open', openedAt: Date.now(), failures: 0, problem: null });
        emit('connected');
        options.opened(send);
        const { ping } = options;
        if (ping)
          pinging = setInterval(() => {
            // Replaced or let go of, with its close still to come.
            if (ws !== socket) return clearInterval(pinging);
            if (heard) {
              heard = false;
              return;
            }
            if (answers && unanswered >= MAX_UNANSWERED) return drop?.('The relay stopped answering.');
            unanswered++;
            send(ping.ask);
          }, PING_MS);
        resolve();
      };

      socket.onmessage = (event) => {
        if (ws !== socket) return;
        unanswered = 0;
        heard = true;
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (options.ping?.isAnswer(message)) {
          answers = true;
          return;
        }
        options.heard(message, send);
      };

      socket.onerror = () => {
        if (ws !== socket) return;
        if (!opened) reject(new Error(`Could not reach ${url}`));
      };

      // A socket already replaced or let go of says nothing about the one in use.
      const ended = (event: Partial<CloseEvent> | undefined) => {
        clearInterval(pinging);
        if (ws !== socket) return;
        ws = null;
        drop = null;
        const failures = opened ? 0 : status.failures + 1;
        const problem =
          event?.reason || (opened ? 'The connection to the relay closed.' : 'Could not reach the relay.');
        setStatus({ failures, problem });
        if (opened) emit('disconnected');
        else reject(new Error(problem));
        if (!wanted) {
          setStatus({ state: 'stopped', retryAt: null });
          return;
        }
        scheduleRetry(backoff(failures, MAX_BACKOFF_MS));
      };
      socket.onclose = ended;
    });

  /** Tries now rather than at the scheduled time, and from a fresh backoff. */
  const reconnect = (): void => {
    if (!wanted || status.state !== 'waiting') return;
    setStatus({ failures: 0 });
    open().catch(() => {});
  };

  /** Awake again, or back online: whatever socket there is most likely died meanwhile. */
  const redial = (): void => {
    drop?.('This device was asleep, or its network changed.');
    reconnect();
  };

  // Looked at again: the network may well be back.
  const onVisible = (): void => {
    if (globalThis.document?.visibilityState !== 'hidden') reconnect();
  };
  let lastLook = 0;
  let looking: ReturnType<typeof setInterval> | undefined;
  const listen = (listening: boolean): void => {
    const method = listening ? 'addEventListener' : 'removeEventListener';
    if (typeof globalThis.addEventListener === 'function') globalThis[method]('online', redial);
    globalThis.document?.[method]('visibilitychange', onVisible);
    clearInterval(looking);
    if (!listening) return;
    lastLook = Date.now();
    looking = setInterval(() => {
      const slept = Date.now() - lastLook > SLEPT_MS;
      lastLook = Date.now();
      if (slept) redial();
    }, WAKE_CHECK_MS);
  };

  return Object.freeze({
    connect: (): Promise<void> => {
      if (!wanted) {
        wanted = true;
        listen(true);
      }
      return open();
    },
    disconnect: (): void => {
      const was = status.state === 'open';
      if (wanted) listen(false);
      wanted = false;
      retry.clear();
      const socket = ws;
      ws = null;
      drop = null;
      socket?.close();
      topics = 0;
      setStatus({ state: 'stopped', retryAt: null, failures: 0 });
      if (was) emit('disconnected');
    },
    reconnect,
    send,
    isConnected: () => status.state === 'open',
    status: () => status,
    count: (watched: number) => {
      topics = watched;
      setStatus({});
    },
    on,
    off,
  });
}

/**
 * A short conversation with a relay on a socket of its own: `start` says the
 * first thing, `hear` answers what comes back (it may `send` again) and
 * settles it by returning a value. Mailboxes talk this way, so the relay can't
 * tie what is dropped or fetched to a peer's long-lived socket.
 */
export function converse<T>(
  dial: string,
  options: { readonly timeoutMs: number; readonly WebSocket?: typeof WebSocket },
  start: (send: (message: unknown) => void) => void,
  hear: (answer: unknown, send: (message: unknown) => void) => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  if (!Socket) return Promise.reject(new Error('No WebSocket here to reach a relay with'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new Socket(dial);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing
      }
      return true;
    };
    const fail = (error: Error) => {
      if (settle()) reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`${dial} did not answer`)), options.timeoutMs);
    const say = (message: unknown) => ws.send(JSON.stringify(message));
    ws.onopen = () => start(say);
    ws.onerror = () => fail(new Error(`Could not reach ${dial}`));
    ws.onclose = () => fail(new Error(`${dial} closed the connection`));
    ws.onmessage = (event: MessageEvent) => {
      let answer: unknown;
      try {
        answer = JSON.parse(String(event.data));
      } catch {
        return;
      }
      Promise.resolve()
        .then(() => hear(answer, say))
        .then(
          (value) => {
            if (value !== undefined && settle()) resolve(value);
          },
          (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
        );
    };
  });
}

/** A relay's TURN offer, kept only if it has the shape of one: `turn:`/`turns:` URLs, a username and a password */
export function iceFrom(
  payload: unknown,
): { servers: ReadonlyArray<RTCIceServer>; expiresAt: number } | null {
  if (!isObject(payload)) return null;
  const { servers, expiresAt } = payload;
  if (!Array.isArray(servers) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  const kept: RTCIceServer[] = [];
  for (const server of servers.slice(0, 4)) {
    if (!isObject(server)) continue;
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
      (url): url is string => typeof url === 'string' && url.length < 256 && /^turns?:/.test(url),
    );
    if (urls.length === 0 || typeof server.username !== 'string' || typeof server.credential !== 'string')
      continue;
    kept.push({ urls, username: server.username, credential: server.credential });
  }
  return kept.length > 0 ? { servers: kept, expiresAt } : null;
}

/** What to dial for a relay: its address with the kind taken off the scheme (`nostr+wss://x` → `wss://x`) */
export function dialOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9.-]*\+(wss?:)/i, '$1');
}
