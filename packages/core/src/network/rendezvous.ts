/**
 * Meeting peers through relays of any kind (spec 04 §2–§4). A room is a topic
 * on every relay the node uses, and everything said there is sealed under a
 * key only those who know the room hold, so a relay sees a topic and opaque
 * blobs, and nothing of who meets whom.
 *
 * ```
 * topic = base64url(SHA-256(UTF-8("minca/rendezvous-topic/v1|" + room)))
 * key   = SHA-256(UTF-8("minca/rendezvous-key/v1|" + room))          AES-256-GCM
 * blob  = sealValue(key, "minca/rendezvous/v1", { topic }, message)
 *
 * message = { kind: "hello", at, from, box, sig }
 *         | { kind: "offer" | "answer", at, from, box, to, sdp: sealValueTo(theirBox, "minca/rendezvous-signal/v1", { topic, from, to, box }, description), sig }
 * sig     = the key `from` names, over UTF-8("minca/rendezvous-sig/v1|" + topic + "|" + kind + "|" + at + "|" + from + "|" + box + "|" + (to ?? "") + "|" + (sdp ?? ""))
 * ```
 *
 * Every message is signed by the session key its `from` names, so nobody can
 * say hello, offer or answer in another's name, in this room or any other.
 *
 * `box` is a P-256 key this node made for meeting, so an offer or answer is
 * sealed to the one peer it is for: others in the room never see its
 * addresses. A peer says hello on joining, after every reconnect and every
 * two minutes; on a hello the lower DID offers, and the higher says hello
 * back so the lower hears of it. Relays are used all at once, so the same
 * message can come through each: a peer acts once on each time a sender
 * signed, in whatever order they come.
 *
 * A hello costs nothing to send, so a room remembers at most 64 peers, and
 * forgets one it hasn't heard from in five minutes: someone saying hello
 * under made-up names can fill a room, not make this node dial without end.
 *
 * A room can name relays of its own: a space says where its members meet
 * (`sys.relays`), so two people whose apps use different relays still find
 * each other there. Those are used for that room only, and let go of once no
 * room names them.
 */
import { p256 } from '@noble/curves/nist.js';
import { createEmitter } from '../utils/events.js';
import { isObject } from '../utils/guards.js';
import { base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { openValue, sealValue } from '../identity/envelope.js';
import { openValueFrom, sealValueTo } from '../identity/hpke.js';
import { contactKeyPair, isContactPublicKey } from '../identity/contact-key.js';
import type { RelayStatus } from './relay-socket.js';
import type { CryptoProvider } from '../types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { signLabel, verifyBy } from './peer-auth.js';
import { createRelayLink, relayKind, type RelayLink } from './relays.js';
import { isPeerDid, shouldInitiate } from './introductions.js';

/** What a peer's connection offer or answer is */
export type SignalKind = 'offer' | 'answer';

/** Whether a value names an offer or answer */
export function isSignalKind(value: unknown): value is SignalKind {
  return value === 'offer' || value === 'answer';
}

export type RendezvousEvents = {
  /** A peer said hello in a room: it is there now */
  'peer-joined': (did: string, room: string) => void;
  /** An offer or answer from a peer, opened */
  /** An offer or answer from a peer, opened, with the room it came in and the box to answer to */
  signal: (message: {
    readonly type: SignalKind;
    readonly from: string;
    readonly payload: unknown;
    readonly room: string;
    readonly box: string;
  }) => void;
  /** TURN servers relays offered, all of them, with the earliest time their passwords stop working */
  ice: (servers: ReadonlyArray<RTCIceServer>, expiresAt: number) => void;
  connected: () => void;
  disconnected: () => void;
  /** A relay opened, closed or is waiting to try again; carries every relay */
  status: (relays: ReadonlyArray<RelayStatus>) => void;
};

export interface Rendezvous {
  /** Connects to every relay, succeeding if any of them answers */
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  /** Enters a room on every relay, and on `relays` as well — joining again with a different list moves to it */
  readonly join: (room: string, relays?: ReadonlyArray<string>) => void;
  readonly leave: (room: string) => void;
  /**
   * Sends an offer or answer to a peer in one room: an offer where its hello
   * was heard, sealed to the box it said hello with; an answer where the
   * offer came, sealed to the box the offer came with.
   */
  readonly signal: (kind: SignalKind, to: string, payload: unknown, room: string, box?: string) => void;
  /** Asks the relays that can hand out TURN passwords for fresh ones; they arrive as an `ice` event */
  readonly requestIce: () => void;
  /** Tries every relay that is waiting to reconnect, now */
  readonly reconnect: () => void;
  /** Every relay in use and where its socket stands */
  readonly relays: () => ReadonlyArray<RelayStatus>;
  readonly isConnected: () => boolean;
  readonly on: <K extends keyof RendezvousEvents>(event: K, callback: RendezvousEvents[K]) => void;
  readonly off: <K extends keyof RendezvousEvents>(event: K, callback: RendezvousEvents[K]) => void;
}

const ENVELOPE_LABEL = 'minca/rendezvous/v1';
const SIGNAL_LABEL = 'minca/rendezvous-signal/v1';
/** How often a peer says hello again in each room */
const HELLO_MS = 120_000;
/** A message older or newer than this is a replay, or a clock too far off to meet */
const MAX_SKEW_MS = 120_000;
/** A node says hello back in a room at most this often */
const ANSWER_HELLO_MS = 10_000;
/** Peers a room remembers, as a relay's room held at most 64 */
const MAX_ROOM_PEERS = 64;
/** Messages from one peer a room acts on within the 2-minute window: far more than an honest peer sends */
const MAX_ACTED = 256;
/** A peer not heard from in this long is forgotten: it would have said hello twice */
const PEER_SILENT_MS = 5 * 60_000;

/** What a message's `sig` signs: every field of it, the sealed description too, so nobody puts their own in under it */
const signedLabel = (
  topic: string,
  m: { kind: unknown; at: unknown; from: unknown; box: unknown; to?: unknown; sdp?: unknown },
) =>
  utf8Encode(
    `minca/rendezvous-sig/v1|${topic}|${String(m.kind)}|${String(m.at)}|${String(m.from)}|${String(m.box)}|${typeof m.to === 'string' ? m.to : ''}|${typeof m.sdp === 'string' ? m.sdp : ''}`,
  );

/** A room's topic and key, as everyone who knows the room derives them */
export async function rendezvousKeys(room: string): Promise<{ topic: string; key: CryptoKey }> {
  const topic = base64UrlEncode(await sha256(utf8Encode(`minca/rendezvous-topic/v1|${room}`)));
  const raw = await sha256(utf8Encode(`minca/rendezvous-key/v1|${room}`));
  const key = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { topic, key };
}

interface RoomState {
  readonly keys: Promise<{ topic: string; key: CryptoKey }>;
  /** The relays this room is on: the node's, and the room's own */
  urls: ReadonlySet<string>;
  /** Peers heard in this room: the box to seal to, and when last heard */
  readonly peers: Map<string, { box: string; heard: number; at: number }>;
  /** When this node last said hello back here */
  answered: number;
  /** A hello back due once the last one is 10 s old, so a newcomer within them waits no longer */
  due: ReturnType<typeof setTimeout> | undefined;
}

/** Meets peers through every relay given, of whatever kind; kinds this library doesn't speak are passed over */
export function createRendezvous(
  urls: ReadonlyArray<string>,
  session: { readonly did: string; readonly key: CryptoKey },
  provider: CryptoProvider = createP256Provider(),
): Rendezvous {
  const { did } = session;
  const defaults = new Set(urls.filter((url) => relayKind(url) !== null));
  if (defaults.size === 0) throw new Error('At least one relay is needed to introduce peers.');

  const byUrl = new Map<string, RelayLink>();
  const rooms = new Map<string, RoomState>();
  /**
   * The times acted on from each peer in each room, by `topic did`, kept as
   * long as this node's box: leaving a room and joining it again, or a
   * reconnect, doesn't let a replay through.
   */
  const acted = new Map<string, Set<number>>();
  /** Rooms by topic, once derived */
  const byTopic = new Map<string, { room: string; key: CryptoKey }>();
  /** TURN servers each relay offered, and when their passwords stop working */
  const turn = new Map<RelayLink, { servers: ReadonlyArray<RTCIceServer>; expiresAt: number }>();
  let connecting = false;
  let helloTimer: ReturnType<typeof setInterval> | undefined;
  const { on, off, emit } = createEmitter<RendezvousEvents>();

  // A key of this node's for meeting: offers and answers to it are sealed to it.
  const box = contactKeyPair(p256.utils.randomSecretKey());

  const linkList = () => [...byUrl.values()];
  const connectedCount = () => linkList().filter((link) => link.isConnected()).length;
  const relays = (): ReadonlyArray<RelayStatus> => linkList().map((link) => link.status());

  /**
   * Whether a message from a peer is new: no message from it in this room was
   * acted on with this time. A copy through another relay, or a replay, is
   * not, in whatever order they come; nor is anything from a newcomer to a
   * room full of others, or from a peer that said more than it could have.
   */
  const isNew = (state: RoomState, topic: string, peer: string, at: number): boolean => {
    const now = Date.now();
    for (const [other, held] of state.peers) if (now - held.heard > PEER_SILENT_MS) state.peers.delete(other);
    if (!state.peers.has(peer) && state.peers.size >= MAX_ROOM_PEERS) return false;
    // Times older than the window are refused anyway, so only the window's are kept.
    const times = acted.get(`${topic} ${peer}`);
    if (!times) return true;
    for (const time of times) if (time < now - MAX_SKEW_MS) times.delete(time);
    return !times.has(at) && times.size < MAX_ACTED;
  };
  /** Remembers a peer's message as acted on: its time, and its box when it is the newest heard */
  const remember = (state: RoomState, topic: string, peer: string, box: string, at: number): void => {
    const key = `${topic} ${peer}`;
    const times = acted.get(key) ?? acted.set(key, new Set()).get(key)!;
    times.add(at);
    const held = state.peers.get(peer);
    // An older message replayed after a newer one leaves the newer box: the older may have died with a restart.
    const newest = !held || at > held.at;
    state.peers.set(peer, { box: newest ? box : held.box, heard: Date.now(), at: newest ? at : held.at });
  };
  /** When this node last sent: each message it sends is later than the one before, so no two share a time */
  let sentAt = 0;

  /** Seals a message for a room and hands it to its relays: every one, or only `on` */
  const say = async (room: string, message: Record<string, unknown>, on?: RelayLink): Promise<void> => {
    const state = rooms.get(room);
    if (!state) return;
    const { topic, key } = await state.keys;
    const full = {
      ...message,
      at: (sentAt = Math.max(Date.now(), sentAt + 1)),
      from: did,
      box: (await box).publicKey,
    };
    const sig = await signLabel(
      provider,
      session.key,
      signedLabel(topic, { ...full, kind: message.kind, to: message.to, sdp: message.sdp }),
    );
    const blob = await sealValue(key, ENVELOPE_LABEL, { topic }, { ...full, sig });
    for (const url of on ? [on.url] : state.urls) {
      const link = byUrl.get(url);
      if (link?.isConnected()) link.publish(topic, blob);
    }
  };

  const hello = (room: string, on?: RelayLink) => void say(room, { kind: 'hello' }, on).catch(() => {});

  /** Says hello back in a room: now, or once 10 s have passed since the last time, but once for all who said hello meanwhile */
  const answer = (room: string, state: RoomState): void => {
    if (state.due) return;
    const wait = state.answered + ANSWER_HELLO_MS - Date.now();
    const go = () => {
      state.due = undefined;
      if (rooms.get(room) !== state) return;
      state.answered = Date.now();
      hello(room);
    };
    if (wait <= 0) return go();
    state.due = setTimeout(go, wait);
  };

  /** Opens what a relay passed on, and acts on it once */
  const heard = async (topic: string, blob: string): Promise<void> => {
    const place = byTopic.get(topic);
    if (!place) return;
    const message = await openValue(place.key, ENVELOPE_LABEL, { topic }, blob);
    if (!isObject(message)) return;
    const { kind, at, from, box: theirs, to, sdp } = message;
    if (!isPeerDid(from) || from === did || !isContactPublicKey(theirs)) return;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return;
    if (Math.abs(Date.now() - at) > MAX_SKEW_MS) return;
    if (kind === 'hello' ? to !== undefined || sdp !== undefined : !isSignalKind(kind) || to !== did) return;
    if (kind !== 'hello' && typeof sdp !== 'string') return;
    const { room } = place;
    const state = rooms.get(room);
    if (!state || !isNew(state, topic, from, at)) return;
    // Signed by the key it names, every field: nobody says anything here in another's name.
    const label = signedLabel(topic, { kind, at, from, box: theirs, to, sdp });
    if (!(await verifyBy(provider, from, message.sig, label))) return;
    // Checked again: another message from it may have been acted on while this one was checked.
    if (kind === 'hello') {
      if (!isNew(state, topic, from, at)) return;
      remember(state, topic, from, theirs, at);
      emit('peer-joined', from, room);
      // The lower DID offers; the higher makes sure the lower has heard of it, once
      // a while for the whole room, however many say hello.
      if (!shouldInitiate(did, from)) answer(room, state);
      return;
    }
    if (!isSignalKind(kind) || message.to !== did) return;
    // The box it came with is bound in: whoever re-wraps it with a box of their own opens nothing.
    const payload = await openValueFrom(
      await box,
      SIGNAL_LABEL,
      { topic, from, to: did, box: theirs },
      message.sdp,
    );
    if (!isObject(payload) || !isNew(state, topic, from, at)) return;
    remember(state, topic, from, theirs, at);
    emit('signal', { type: kind, from, payload, room, box: theirs });
  };

  /** A relay's link, made and wired the first time it is needed */
  const linkFor = (url: string): RelayLink | null => {
    const held = byUrl.get(url);
    if (held) return held;
    const link = createRelayLink(url);
    if (!link) return null;
    byUrl.set(url, link);
    link.on('blob', (topic, blob) => void heard(topic, blob).catch(() => {}));
    link.on('ice', (servers, expiresAt) => {
      turn.set(link, { servers, expiresAt });
      const offers = [...turn.values()];
      emit(
        'ice',
        offers.flatMap((offer) => offer.servers),
        Math.min(...offers.map((offer) => offer.expiresAt)),
      );
    });
    link.on('status', () => emit('status', relays()));
    link.on('connected', () => {
      // A relay forgets everything when a socket closes: say hello again in every room on it.
      for (const [room, state] of rooms) if (state.urls.has(url)) hello(room, link);
      if (connectedCount() === 1) emit('connected');
    });
    link.on('disconnected', () => {
      if (connectedCount() === 0) emit('disconnected');
    });
    // One of a room's own, added while running: connected now, like the rest.
    if (connecting) void link.connect().catch(() => {});
    return link;
  };

  /** Lets go of a relay once no room uses it, unless it is one of the node's */
  const release = (url: string): void => {
    if (defaults.has(url) || [...rooms.values()].some((state) => state.urls.has(url))) return;
    const link = byUrl.get(url);
    if (!link) return;
    byUrl.delete(url);
    turn.delete(link);
    link.disconnect();
    emit('status', relays());
  };

  for (const url of defaults) linkFor(url);

  const join = (room: string, own: ReadonlyArray<string> = []): void => {
    const held = rooms.get(room);
    const state: RoomState = held ?? {
      keys: rendezvousKeys(room),
      urls: new Set(),
      peers: new Map(),
      answered: 0,
      due: undefined,
    };
    const before = state.urls;
    state.urls = new Set([...defaults, ...own.filter((url) => linkFor(url))]);
    rooms.set(room, state);
    void state.keys.then(({ topic, key }) => {
      if (rooms.get(room) !== state) return;
      byTopic.set(topic, { room, key });
      for (const url of before) if (!state.urls.has(url)) byUrl.get(url)?.unwatch(topic);
      for (const url of state.urls) byUrl.get(url)?.watch(topic);
      for (const url of before) if (!state.urls.has(url)) release(url);
      if (!held) hello(room);
    });
  };

  const leave = (room: string): void => {
    const state = rooms.get(room);
    if (!state) return;
    rooms.delete(room);
    clearTimeout(state.due);
    void state.keys.then(({ topic }) => {
      byTopic.delete(topic);
      for (const url of state.urls) {
        byUrl.get(url)?.unwatch(topic);
        release(url);
      }
    });
  };

  return Object.freeze({
    connect: async (): Promise<void> => {
      connecting = true;
      clearInterval(helloTimer);
      helloTimer = setInterval(() => {
        for (const room of rooms.keys()) hello(room);
        // Times past the window are refused anyway.
        const old = Date.now() - MAX_SKEW_MS;
        for (const [key, times] of acted) {
          for (const time of times) if (time < old) times.delete(time);
          if (times.size === 0) acted.delete(key);
        }
      }, HELLO_MS);
      const all = [...byUrl.keys()];
      const results = await Promise.allSettled(linkList().map((link) => link.connect()));
      if (results.some((result) => result.status === 'fulfilled')) return;
      throw new Error(`None of the ${all.length} relays could be reached: ${all.join(', ')}`);
    },

    disconnect: (): void => {
      connecting = false;
      clearInterval(helloTimer);
      for (const link of linkList()) link.disconnect();
      // A room's own relays are made again when a room names them.
      for (const url of [...byUrl.keys()]) if (!defaults.has(url)) byUrl.delete(url);
      for (const state of rooms.values()) clearTimeout(state.due);
      rooms.clear();
      byTopic.clear();
      turn.clear();
    },

    join,
    leave,

    signal: (kind: SignalKind, to: string, payload: unknown, room: string, given?: string): void => {
      const state = rooms.get(room);
      const theirs = given ?? state?.peers.get(to)?.box;
      if (!state || !theirs) return;
      void (async () => {
        const { topic } = await state.keys;
        const mine = (await box).publicKey;
        const sdp = await sealValueTo(theirs, SIGNAL_LABEL, { topic, from: did, to, box: mine }, payload);
        await say(room, { kind, to, sdp });
      })().catch(() => {});
    },

    requestIce: () => {
      for (const link of linkList())
        if (link.isConnected() && relayKind(link.url)?.can.ice) link.requestIce?.();
    },

    reconnect: () => {
      for (const link of linkList()) link.reconnect();
    },

    relays,
    isConnected: (): boolean => connectedCount() > 0,
    on,
    off,
  });
}
