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
 * message = { kind: "hello", id, at, from, box }
 *         | { kind: "offer" | "answer", id, at, from, box, to, sdp: sealValueTo(theirBox, "minca/rendezvous-signal/v1", { topic, from, to }, description) }
 * ```
 *
 * `box` is a P-256 key this node made for meeting, so an offer or answer is
 * sealed to the one peer it is for: others in the room never see its
 * addresses. A peer says hello on joining, after every reconnect and every
 * two minutes; on a hello the lower DID offers, and the higher says hello
 * back so the lower hears of it. Relays are used all at once, so the same
 * message can come through each: it is acted on once, by its `id`.
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
import { createRelayLink, relayKind, type RelayLink } from './relays.js';
import { createSeenSignals, isPeerDid, shouldInitiate } from './introductions.js';

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
  signal: (message: { readonly type: SignalKind; readonly from: string; readonly payload: unknown }) => void;
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
  /** Sends an offer or answer to a peer, in the room it last said hello in */
  readonly signal: (kind: SignalKind, to: string, payload: unknown) => void;
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
/** The higher DID says hello back to a peer at most this often */
const ANSWER_HELLO_MS = 10_000;
/** Peers remembered, with the room and box to answer them in */
const MAX_PEERS = 512;

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
}

/** Meets peers through every relay given, of whatever kind; kinds this library doesn't speak are passed over */
export function createRendezvous(urls: ReadonlyArray<string>, did: string): Rendezvous {
  const defaults = new Set(urls.filter((url) => relayKind(url) !== null));
  if (defaults.size === 0) throw new Error('At least one relay is needed to introduce peers.');

  const byUrl = new Map<string, RelayLink>();
  const rooms = new Map<string, RoomState>();
  /** Rooms by topic, once derived */
  const byTopic = new Map<string, { room: string; key: CryptoKey }>();
  /** Where to answer each peer: the room it last spoke in, and its box */
  const peers = new Map<string, { room: string; box: string }>();
  const answered = new Map<string, number>();
  const seen = createSeenSignals(2048);
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

  const remember = (peer: string, at: { room: string; box: string }) => {
    peers.delete(peer);
    peers.set(peer, at);
    // A map iterates in insertion order: the first is the oldest.
    if (peers.size > MAX_PEERS) peers.delete(peers.keys().next().value ?? peer);
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
    seen.accept(full.id);
    const blob = await sealValue(key, ENVELOPE_LABEL, { topic }, full);
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
    if (Math.abs(Date.now() - at) > MAX_SKEW_MS || !seen.accept(id)) return;
    const { room } = place;
    if (!rooms.has(room)) return;
    if (kind === 'hello') {
      remember(from, { room, box: theirs });
      emit('peer-joined', from, room);
      // The lower DID offers; the higher makes sure the lower has heard of it.
      if (!shouldInitiate(did, from) && Date.now() - (answered.get(from) ?? 0) > ANSWER_HELLO_MS) {
        answered.set(from, Date.now());
        if (answered.size > MAX_PEERS) answered.delete(answered.keys().next().value ?? from);
        hello(room);
      }
      return;
    }
    if (!isSignalKind(kind) || message.to !== did) return;
    const payload = await openValueFrom(await box, SIGNAL_LABEL, { topic, from, to: did }, message.sdp);
    if (!isObject(payload)) return;
    remember(from, { room, box: theirs });
    emit('signal', { type: kind, from, payload });
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
    const state: RoomState = held ?? { keys: rendezvousKeys(room), urls: new Set() };
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
    for (const [peer, at] of peers) if (at.room === room) peers.delete(peer);
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
      peers.clear();
      answered.clear();
      turn.clear();
    },

    join,
    leave,

    signal: (kind: SignalKind, to: string, payload: unknown): void => {
      const at = peers.get(to);
      if (!at) return;
      void (async () => {
        const state = rooms.get(at.room);
        if (!state) return;
        const { topic } = await state.keys;
        const sdp = await sealValueTo(at.box, SIGNAL_LABEL, { topic, from: did, to }, payload);
        await say(at.room, { kind, to, sdp });
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
