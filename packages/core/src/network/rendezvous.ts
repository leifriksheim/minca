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
 * message = { kind: "hello", id, at, from, box, sig }
 *         | { kind: "offer" | "answer", id, at, from, box, to, sdp: sealValueTo(theirBox, "minca/rendezvous-signal/v1", { topic, from, to, box }, description), sig }
 * sig     = the key `from` names, over UTF-8("minca/rendezvous-sig/v1|" + topic + "|" + kind + "|" + id + "|" + at + "|" + from + "|" + box + "|" + (to ?? ""))
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
 * message can come through each: it is acted on once, by its `id`.
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
import { createSeenSignals, isPeerDid, shouldInitiate, type SeenSignals } from './introductions.js';

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
  /** Asks relays for fresh TURN passwords; they arrive as an `ice` event, from relays that have TURN */
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
/** A peer not heard from in this long is forgotten: it would have said hello twice */
const PEER_SILENT_MS = 5 * 60_000;

/** What a message's `sig` signs: everything in it but the sealed description, which is bound to its box */
const signedLabel = (
  topic: string,
  m: { kind: unknown; id: unknown; at: unknown; from: unknown; box: unknown; to?: unknown },
) =>
  utf8Encode(
    `minca/rendezvous-sig/v1|${topic}|${String(m.kind)}|${String(m.id)}|${String(m.at)}|${String(m.from)}|${String(m.box)}|${typeof m.to === 'string' ? m.to : ''}`,
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
  readonly peers: Map<string, { box: string; heard: number }>;
  /** When this node last said hello back here */
  answered: number;
  /** Ids of messages acted on here, so a copy through another relay, or a replay, is not */
  readonly seen: SeenSignals;
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

  /** Remembers a peer heard in a room; false when the room is full of others */
  const remember = (state: RoomState, peer: string, box: string): boolean => {
    const now = Date.now();
    for (const [other, at] of state.peers) if (now - at.heard > PEER_SILENT_MS) state.peers.delete(other);
    const held = state.peers.get(peer);
    if (!held && state.peers.size >= MAX_ROOM_PEERS) return false;
    state.peers.set(peer, { box, heard: now });
    return true;
  };

  /** Seals a message for a room and hands it to its relays: every one, or only `on` */
  const say = async (room: string, message: Record<string, unknown>, on?: RelayLink): Promise<void> => {
    const state = rooms.get(room);
    if (!state) return;
    const { topic, key } = await state.keys;
    const full = {
      ...message,
      id: base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12))),
      at: Date.now(),
      from: did,
      box: (await box).publicKey,
    };
    const sig = await signLabel(
      provider,
      session.key,
      signedLabel(topic, { ...full, kind: message.kind, to: message.to }),
    );
    state.seen.accept(full.id);
    const blob = await sealValue(key, ENVELOPE_LABEL, { topic }, { ...full, sig });
    for (const url of on ? [on.url] : state.urls) {
      const link = byUrl.get(url);
      if (link?.isConnected()) link.publish(topic, blob);
    }
  };

  const hello = (room: string, on?: RelayLink) => void say(room, { kind: 'hello' }, on).catch(() => {});

  /** Opens what a relay passed on, and acts on it once */
  const heard = async (topic: string, blob: string): Promise<void> => {
    const place = byTopic.get(topic);
    if (!place) return;
    const message = await openValue(place.key, ENVELOPE_LABEL, { topic }, blob);
    if (!isObject(message)) return;
    const { kind, id, at, from, box: theirs } = message;
    if (!isPeerDid(from) || from === did || !isContactPublicKey(theirs)) return;
    if (typeof id !== 'string' || id.length > 64 || typeof at !== 'number') return;
    if (Math.abs(Date.now() - at) > MAX_SKEW_MS) return;
    if (message.to !== undefined && typeof message.to !== 'string') return;
    // Signed by the key it names: nobody says anything here in another's name.
    const label = signedLabel(topic, { kind, id, at, from, box: theirs, to: message.to });
    if (!(await verifyBy(provider, from, message.sig, label))) return;
    const { room } = place;
    const state = rooms.get(room);
    if (!state) return;
    // An id counts as seen only once what it came with passed every check, so junk can't push real ones out.
    if (kind === 'hello') {
      if (!remember(state, from, theirs) || !state.seen.accept(id)) return;
      emit('peer-joined', from, room);
      // The lower DID offers; the higher makes sure the lower has heard of it, once
      // a while for the whole room, however many say hello.
      if (!shouldInitiate(did, from) && Date.now() - state.answered > ANSWER_HELLO_MS) {
        state.answered = Date.now();
        hello(room);
      }
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
    if (!isObject(payload) || !remember(state, from, theirs) || !state.seen.accept(id)) return;
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
      seen: createSeenSignals(1024),
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
      for (const link of linkList()) if (link.isConnected()) link.requestIce();
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
