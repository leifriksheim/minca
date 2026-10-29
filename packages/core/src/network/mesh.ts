/**
 * One set of connections for every space a node has open.
 *
 * A node holds one socket per relay and one WebRTC connection per peer, however
 * many spaces the two share. Each space is a room: it joins the room on the
 * relays, and on every connection proves itself separately (`peer-auth.ts`)
 * before a byte of it crosses. A peer you share one space with is a peer only
 * in that one.
 *
 * Everything on a connection is a JSON frame `{ room?, type, from, payload }`.
 * The offers peers carry for each other (`introductions.ts`) carry no room of
 * their own beyond the signal's.
 *
 * ```
 * A → B   { room, __auth-hello, { nonce: Nₐ } }        either side, once it knows the other is in the room
 * B → A   { room, __auth-hello, { nonce: N_b } }
 * A → B   { room, __auth-proof, proof over N_b }        (none in a room without auth)
 * B → A   { room, __auth-proof, proof over Nₐ }
 * ```
 *
 * A connection that ends up in no room is closed.
 */
import { getOrAdd } from '../utils/map.js';
import type { PeerInfo, NetworkMessage } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';
import { createEmitter, type Emitter } from '../utils/events.js';
import type { RelayStatus } from './relay-socket.js';
import { isObject } from '../utils/guards.js';
import { createRendezvous, isSignalKind, type SignalKind } from './rendezvous.js';
import { createRTCTransport, DEFAULT_ICE_SERVERS } from './rtc-transport.js';
import type { SignalledTransport } from './transport.js';
import { peerNonce, signLabel, verifyBy, type MeshAuth } from './peer-auth.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { NetworkEvents, NetworkManager } from './network-manager.js';
import {
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
  AUTH_HELLO_MESSAGE,
  AUTH_PROOF_MESSAGE,
  LEAVE_MESSAGE,
  MAX_HOPS,
  MAX_INTRODUCED,
  isPeerDid,
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  introductionLabel,
  type RelayedSignal,
} from './introductions.js';

export interface MeshConfig {
  readonly did: string;
  /** The private half of the key `did` names: it signs what this node says in a room */
  readonly key: CryptoKey;
  /** Relays of any kind, used all at once (`rendezvous.ts`) */
  readonly relays: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /** Let connected peers introduce the peers they know, so a relay is needed only for the first. On by default. */
  readonly introductions?: boolean;
  /**
   * How connections are made, given the ICE servers each should use. WebRTC on
   * this thread by default; a node in a worker uses the page's (`remoteTransport`).
   */
  readonly createTransport?: (iceServers: () => ReadonlyArray<RTCIceServer>) => SignalledTransport;
  /** How long a peer has to prove itself in a room. Default 10 s. */
  readonly authTimeoutMs?: number;
}

export interface Mesh {
  /**
   * A space's share of the mesh: the peers that proved themselves in its room.
   * `connect()` enters the room and `disconnect()` leaves it.
   *
   * @param room The space's room — a hash of its id
   * @param auth What peers must prove here; null lets anyone in the room in
   */
  join(room: string, auth?: MeshAuth | null): NetworkManager;
  /** The relays a room's space names as its own (`sys.relays`), joined for that room on top of the mesh's */
  useRelays(room: string, relays: ReadonlyArray<string>): void;
  /** The ICE servers for a WebRTC connection of the application's own: the configured ones, and fresh TURN from a relay */
  iceServers(): Promise<ReadonlyArray<RTCIceServer>>;
  /** The relays, the connections open and the ones being made, as they are now */
  status(): MeshStatus;
  /** Hears every change to `status()`; returns a function that stops it */
  subscribe(listener: () => void): () => void;
  /** Tries every relay that is waiting to reconnect, now */
  reconnect(): void;
}

/** A connection to a peer that has not opened yet */
export interface PendingConnection {
  readonly peer: string;
  /** When this attempt started (ms) */
  readonly since: number;
  /** Attempts so far that never opened */
  readonly tries: number;
}

/** What the mesh is doing, for a person looking at why a peer is missing */
export interface MeshStatus {
  readonly relays: ReadonlyArray<RelayStatus>;
  /** Peers with an open connection, and how many rooms each is admitted in */
  readonly links: ReadonlyArray<{ readonly peer: string; readonly rooms: number }>;
  readonly connecting: ReadonlyArray<PendingConnection>;
  /** Whether a relay offered TURN, for networks that cannot connect directly */
  readonly turn: boolean;
}

/** Ask the relay for new TURN passwords once the ones held run out within this */
const ICE_REFRESH_MS = 10 * 60_000;
/** How long to wait for them before going ahead with what there is */
const ICE_WAIT_MS = 1500;
/**
 * How long a connection has to open before it is given up, doubling with each
 * try up to the cap. An unanswered offer never fails on its own.
 */
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_CONNECT_TIMEOUT_MS = 5 * 60_000;
/** A relayed signal older or newer than this is a replay, or a clock too far off */
const SIGNAL_WINDOW_MS = 120_000;
/** Signals from one origin a room acts on within that window */
const MAX_SIGNALS_ACTED = 256;
/** Origins whose times are held at once, across rooms */
const MAX_ORIGINS_HELD = 1024;
/** A relayed description longer than this is not taken: one with its candidates is a few KB */
const MAX_SDP_CHARS = 32_000;
/** Peers whose failed tries are remembered */
const MAX_TRIED = 512;

interface Handshake {
  readonly nonce: string;
  proved: boolean;
  verified: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Room {
  readonly auth: MeshAuth | null;
  readonly peers: Map<string, PeerInfo>;
  readonly handshakes: Map<string, Handshake>;
  readonly events: Emitter<NetworkEvents>;
}

interface Frame {
  readonly room?: string;
  readonly type: string;
  readonly payload?: unknown;
}

type Deliver = (kind: SignalKind, data: unknown) => void;

export function createMesh(config: MeshConfig): Mesh {
  const { did } = config;
  const signaling = createRendezvous(config.relays, { did, key: config.key });
  const configuredIce = config.iceServers ?? DEFAULT_ICE_SERVERS;
  let relayIce: { servers: ReadonlyArray<RTCIceServer>; expiresAt: number } | null = null;
  let iceAskedAt = 0;
  const hasTurn = () => relayIce !== null && relayIce.expiresAt > Date.now();
  const currentIce = (): ReadonlyArray<RTCIceServer> =>
    relayIce && hasTurn() ? [...configuredIce, ...relayIce.servers] : configuredIce;
  const transport = config.createTransport?.(currentIce) ?? createRTCTransport({ iceServers: currentIce });
  const introduce = config.introductions !== false;
  const authTimeoutMs = config.authTimeoutMs ?? 10_000;
  const provider = createP256Provider();

  const rooms = new Map<string, Room>();
  /** Relays each room's space names, for its room only */
  const roomRelays = new Map<string, ReadonlyArray<string>>();
  /** Connections that are open */
  const links = new Set<string>();
  /** Peers a connection has been started with, so it is not opened twice */
  const attempted = new Set<string>();
  /** Rooms to greet a peer in once its connection opens */
  const expected = new Map<string, Set<string>>();
  /** Open connections waiting to be put to use in some room, or closed */
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  /** Connections started and not yet open, each with the timer that gives up on it */
  const pending = new Map<string, { since: number; tries: number; timer: ReturnType<typeof setTimeout> }>();
  /** Failed tries per peer; forgotten once a connection opens */
  const tries = new Map<string, number>();
  const seenSignals = createSeenSignals();
  /** The times of signals acted on, by `room origin`, within the window */
  const actedOn = new Map<string, Set<number>>();
  /** When this node last sent a signal over the mesh: each later than the one before */
  let introducedAt = 0;
  let started: Promise<void> | null = null;

  const changes = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...changes]) listener();
  };

  signaling.on('status', changed);
  signaling.on('ice', (servers, expiresAt) => {
    relayIce = { servers, expiresAt };
    iceAskedAt = 0;
    changed();
  });

  const roomList = () => [...rooms.values()];
  /** Peers proved in at least one room: the only ones anything but a handshake is taken from */
  const isAdmitted = (peer: string) => roomList().some((room) => room.peers.has(peer));
  const isInUse = (peer: string) =>
    roomList().some((room) => room.peers.has(peer) || room.handshakes.has(peer));

  const fail = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const room of rooms.values()) room.events.emit('error', err);
  };

  const sendFrame = (peer: string, frame: Frame): void => {
    try {
      transport.send(peer, utf8Encode(JSON.stringify({ ...frame, from: did })));
    } catch {
      // Closed since it was listed; the disconnect tidies up.
    }
  };

  // ─── Connection attempts ────────────────────────────────────────────

  /** Gives an attempt a deadline, after which the peer is forgotten until heard of again. */
  const watch = (peer: string): void => {
    const held = pending.get(peer);
    if (held) clearTimeout(held.timer);
    const tried = tries.get(peer) ?? 0;
    const wait = Math.min(CONNECT_TIMEOUT_MS * 2 ** tried, MAX_CONNECT_TIMEOUT_MS);
    const timer = setTimeout(() => giveUp(peer, tried), wait);
    pending.set(peer, { since: held?.since ?? Date.now(), tries: tried, timer });
    changed();
  };

  const giveUp = (peer: string, tried: number): void => {
    pending.delete(peer);
    if (links.has(peer)) return;
    setNewest(tries, peer, tried + 1, MAX_TRIED);
    transport.close(peer);
    attempted.delete(peer);
    expected.delete(peer);
    changed();
  };

  const unwatch = (peer: string): void => {
    clearTimeout(pending.get(peer)?.timer);
    if (pending.delete(peer)) changed();
  };

  /** Forgets a connection, closed by either side. */
  const lost = (peer: string): void => {
    clearTimeout(idle.get(peer));
    idle.delete(peer);
    unwatch(peer);
    if (links.delete(peer)) changed();
    attempted.delete(peer);
    expected.delete(peer);
    for (const room of rooms.values()) drop(room, peer);
  };

  const closeIfIdle = (peer: string): void => {
    if (!links.has(peer) || isInUse(peer)) return;
    transport.close(peer);
    // Closing it here is not always reported back as a disconnect.
    lost(peer);
  };

  // ─── Proving, per room ──────────────────────────────────────────────

  const endHandshake = (room: Room, peer: string) => {
    clearTimeout(room.handshakes.get(peer)?.timer);
    room.handshakes.delete(peer);
  };

  const refuse = (room: Room, peer: string) => {
    endHandshake(room, peer);
    closeIfIdle(peer);
  };

  /** Starts proving ourselves to a peer in a room, unless that is under way or done. */
  const greet = (name: string, peer: string): Handshake | null => {
    const room = rooms.get(name);
    if (!room || room.peers.has(peer)) return null;
    const held = room.handshakes.get(peer);
    if (held) return held;
    const handshake: Handshake = {
      nonce: peerNonce(),
      proved: false,
      verified: room.auth === null,
      timer: setTimeout(() => refuse(room, peer), authTimeoutMs),
    };
    room.handshakes.set(peer, handshake);
    sendFrame(peer, { room: name, type: AUTH_HELLO_MESSAGE, payload: { nonce: handshake.nonce } });
    return handshake;
  };

  /** Their hello: prove ourselves over their nonce. */
  const onHello = async (name: string, room: Room, peer: string, payload: unknown): Promise<void> => {
    const handshake = greet(name, peer);
    const nonce = isObject(payload) ? payload.nonce : undefined;
    if (!handshake || handshake.proved || typeof nonce !== 'string') return;
    handshake.proved = true;
    if (!room.auth) return;
    const proof = await room.auth.prove(peer, nonce, transport.binding?.(peer) ?? null);
    sendFrame(peer, { room: name, type: AUTH_PROOF_MESSAGE, payload: proof });
  };

  /** Their proof: check it over our nonce */
  const onProof = async (
    room: Room,
    peer: string,
    payload: unknown,
  ): Promise<'ignored' | 'refused' | 'verified'> => {
    const handshake = room.handshakes.get(peer);
    if (!handshake || handshake.verified || !room.auth) return 'ignored';
    const binding = transport.binding?.(peer) ?? null;
    if (!(await room.auth.check(peer, handshake.nonce, binding, payload))) return 'refused';
    handshake.verified = true;
    return 'verified';
  };

  const onHandshake = async (name: string, peer: string, type: string, payload: unknown): Promise<void> => {
    const room = rooms.get(name);
    if (!room) return;
    if (type === AUTH_HELLO_MESSAGE) await onHello(name, room, peer, payload);
    else {
      const outcome = await onProof(room, peer, payload);
      if (outcome === 'ignored') return;
      if (outcome === 'refused') return refuse(room, peer);
    }
    const handshake = room.handshakes.get(peer);
    if (!handshake?.proved || !handshake.verified || rooms.get(name) !== room) return;
    endHandshake(room, peer);
    admit(name, room, peer);
  };

  /** A connection becomes a peer in a room: announced, and introduced to the room's others. */
  const admit = (name: string, room: Room, peer: string): void => {
    const info: PeerInfo = { did: peer, connectionId: peer, connectedAt: new Date().toISOString() };
    room.peers.set(peer, info);
    room.events.emit('peer-connected', info);
    changed();
    if (!introduce) return;
    // Both ways: told only the newcomer, the higher DID would wait for an offer nobody sends.
    const others = [...room.peers.keys()].filter((other) => other !== peer);
    if (others.length === 0) return;
    sendFrame(peer, { room: name, type: PEERS_MESSAGE, payload: others });
    for (const other of others) sendFrame(other, { room: name, type: PEERS_MESSAGE, payload: [peer] });
  };

  const drop = (room: Room, peer: string): void => {
    endHandshake(room, peer);
    const info = room.peers.get(peer);
    if (!info || !room.peers.delete(peer)) return;
    room.events.emit('peer-disconnected', info);
    changed();
  };

  // ─── Connecting ─────────────────────────────────────────────────────
  //
  // A relay gets you your first connection; after that, the peers you reach
  // carry offers to the ones you don't.

  /** Pushes a signal out to the room's other peers, skipping where it came from. */
  const floodSignal = (name: string, signal: RelayedSignal, except?: string): void => {
    for (const peer of rooms.get(name)?.peers.keys() ?? [])
      if (peer !== except) sendFrame(peer, { room: name, type: SIGNAL_MESSAGE, payload: signal });
  };

  /** Through the room's peers, signed by this node so nobody passing it on can change it */
  const throughMesh =
    (target: string, name: string): Deliver =>
    (kind, data) => {
      if (!isObject(data) || typeof data.sdp !== 'string') return;
      const { sdp } = data;
      const at = (introducedAt = Math.max(Date.now(), introducedAt + 1));
      const fields = { origin: did, target, kind, at, sdp };
      void signLabel(provider, config.key, introductionLabel(name, fields))
        .then((sig) => floodSignal(name, relayedSignal(fields, sig, MAX_HOPS)))
        .catch(() => {});
    };

  /** Through the relays, in one room, to the box the peer's message came with */
  const throughRelay =
    (target: string, room: string, box?: string): Deliver =>
    (kind, data) =>
      signaling.signal(kind, target, data, room, box);

  const offerTo = async (peer: string, deliver: Deliver): Promise<void> => {
    watch(peer);
    try {
      deliver('offer', await transport.createOffer(peer));
    } catch (err) {
      fail(err);
    }
  };

  /** Acts on a peer's offer or answer, sending the answer back the way the offer came. */
  const onSignal = async (peer: string, kind: SignalKind, data: unknown, deliver: Deliver): Promise<void> => {
    // A proved connection is not replaced by an unproved offer: anyone can put someone's name on one.
    if (!data || typeof data !== 'object' || isAdmitted(peer)) return;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- setRemoteDescription checks it and throws into the catch below
    const description = data as RTCSessionDescriptionInit;
    try {
      if (kind === 'answer') return await transport.handleAnswer(peer, description);
      attempted.add(peer);
      watch(peer);
      deliver('answer', await transport.handleOffer(peer, description));
    } catch (err) {
      fail(err);
    }
  };

  /** Learned that a peer is in a room: greet it there, or connect first. */
  const meet = (name: string, peer: string, offer: Deliver | null): void => {
    if (peer === did || !rooms.has(name)) return;
    if (links.has(peer)) {
      greet(name, peer);
      return;
    }
    getOrAdd(expected, peer, () => new Set()).add(name);
    if (!offer || attempted.has(peer)) return;
    attempted.add(peer);
    void offerTo(peer, offer);
  };

  // Both sides hear each other's hello; one rule says who offers.
  signaling.on('peer-joined', (peer, room) =>
    meet(room, peer, shouldInitiate(did, peer) ? throughRelay(peer, room) : null),
  );
  signaling.on('signal', ({ from, type, payload, room, box }) => {
    void onSignal(from, type, payload, throughRelay(from, room, box));
  });

  const onPeerList = (name: string, peers: unknown): void => {
    if (!introduce || !Array.isArray(peers)) return;
    for (const peer of peers.slice(0, MAX_INTRODUCED))
      if (isPeerDid(peer)) meet(name, peer, shouldInitiate(did, peer) ? throughMesh(peer, name) : null);
  };

  /** Whether a signal from an origin in a room is new: none from it there was acted on with this time */
  const isNewSignal = (name: string, origin: string, at: number): boolean => {
    const old = Date.now() - SIGNAL_WINDOW_MS;
    const times = actedOn.get(`${name} ${origin}`);
    if (!times) {
      if (actedOn.size < MAX_ORIGINS_HELD) return true;
      // Full: let go of origins whose times are all past the window.
      for (const [key, held] of actedOn) if ([...held].every((time) => time < old)) actedOn.delete(key);
      return actedOn.size < MAX_ORIGINS_HELD;
    }
    for (const time of times) if (time < Date.now() - SIGNAL_WINDOW_MS) times.delete(time);
    if (times.size === 0) actedOn.delete(`${name} ${origin}`);
    return !times.has(at) && times.size < MAX_SIGNALS_ACTED;
  };

  const onRelayedSignal = async (from: string, name: string, payload: unknown): Promise<void> => {
    const signal = readSignal(payload);
    if (!signal || signal.origin === did) return;
    const { origin, target, kind, at, sdp, sig, hops } = signal;
    const forUs = target === did;
    // Checked before the signature, so a copy arriving again costs nothing.
    const passed = `${name}|${origin}|${at}`;
    if (forUs ? !isNewSignal(name, origin, at) : seenSignals.has(passed)) return;
    if (!(await verifyBy(provider, origin, sig, introductionLabel(name, signal)))) return;
    if (forUs) {
      if (!isNewSignal(name, origin, at)) return;
      getOrAdd(actedOn, `${name} ${origin}`, () => new Set()).add(at);
      void onSignal(origin, kind, { type: kind, sdp }, throughMesh(origin, name));
      return;
    }
    if (typeof hops !== 'number' || hops <= 0 || typeof sig !== 'string' || !seenSignals.accept(passed))
      return;
    // Never further than we would send it ourselves.
    floodSignal(name, relayedSignal(signal, sig, Math.min(hops, MAX_HOPS) - 1), from);
  };

  const onFrame = (peer: string, frame: Record<string, unknown>): void => {
    const { type, payload } = frame;
    const name = typeof frame.room === 'string' ? frame.room : null;
    if (typeof type !== 'string') return;
    // Before a peer has proved itself somewhere, the handshake is all there is.
    if (type === AUTH_HELLO_MESSAGE || type === AUTH_PROOF_MESSAGE) {
      if (!name) return;
      void onHandshake(name, peer, type, payload).catch(() => {
        const room = rooms.get(name);
        if (room) refuse(room, peer);
      });
      return;
    }
    if (!isAdmitted(peer)) return;
    const room = name ? rooms.get(name) : undefined;
    if (!name || !room?.peers.has(peer)) return;
    if (type === SIGNAL_MESSAGE) return void onRelayedSignal(peer, name, payload).catch(() => {});
    if (type === PEERS_MESSAGE) return onPeerList(name, payload);
    if (type === LEAVE_MESSAGE) {
      drop(room, peer);
      return closeIfIdle(peer);
    }
    // The sender is the connection it arrived on, not whatever the frame claims.
    if (!isControlMessage(type)) room.events.emit('message', { type, from: peer, payload });
  };

  transport.on('connected', (peer) => {
    unwatch(peer);
    tries.delete(peer);
    links.add(peer);
    attempted.add(peer);
    changed();
    for (const name of expected.get(peer) ?? []) greet(name, peer);
    expected.delete(peer);
    // The other side greets in the rooms it knows we share; if none does, the connection has no use.
    const timer = setTimeout(() => {
      idle.delete(peer);
      closeIfIdle(peer);
    }, authTimeoutMs);
    idle.set(peer, timer);
  });

  transport.on('disconnected', lost);

  transport.on('data', (peer, data) => {
    let frame: unknown;
    try {
      frame = JSON.parse(utf8Decode(data));
    } catch {
      return fail(new Error('Failed to parse incoming message'));
    }
    if (isObject(frame)) onFrame(peer, frame);
  });

  transport.on('error', (peer, error) =>
    fail(new Error(`Transport error with peer ${peer}: ${error.message}`)),
  );

  // ─── Rooms ──────────────────────────────────────────────────────────

  const start = (): Promise<void> => {
    started ??= signaling.connect().catch((error) => {
      started = null;
      throw error;
    });
    return started;
  };

  /** The last room is gone: let go of every timer and the relays. */
  const stop = (): void => {
    for (const timer of idle.values()) clearTimeout(timer);
    idle.clear();
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    tries.clear();
    signaling.disconnect();
    started = null;
  };

  /** Waits for a relay's TURN offer, briefly: relays without TURN never answer. */
  const askForIce = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signaling.off('ice', done);
        resolve();
      };
      const timer = setTimeout(done, ICE_WAIT_MS);
      signaling.on('ice', done);
      signaling.requestIce();
    });

  return {
    status: (): MeshStatus => ({
      relays: signaling.relays(),
      links: [...links].map((peer) => ({
        peer,
        rooms: roomList().filter((room) => room.peers.has(peer)).length,
      })),
      connecting: [...pending].map(([peer, { since, tries: tried }]) => ({ peer, since, tries: tried })),
      turn: hasTurn(),
    }),

    subscribe(listener) {
      changes.add(listener);
      return () => changes.delete(listener);
    },

    reconnect: () => signaling.reconnect(),

    async iceServers() {
      const stale = !relayIce || relayIce.expiresAt - Date.now() < ICE_REFRESH_MS;
      // A relay that did not answer last time has no TURN; don't wait on it every call.
      if (signaling.isConnected() && stale && Date.now() - iceAskedAt > ICE_REFRESH_MS) {
        iceAskedAt = Date.now();
        await askForIce();
      }
      return currentIce();
    },

    useRelays(name: string, relays: ReadonlyArray<string>) {
      const before = roomRelays.get(name) ?? [];
      if (before.length === relays.length && before.every((url, i) => url === relays[i])) return;
      roomRelays.set(name, [...relays]);
      if (rooms.has(name)) signaling.join(name, relays);
    },

    join(name: string, auth: MeshAuth | null = null): NetworkManager {
      const room: Room = { auth, peers: new Map(), handshakes: new Map(), events: createEmitter() };
      const isCurrent = () => rooms.get(name) === room;
      const send = (peer: string, message: NetworkMessage) => {
        if (room.peers.has(peer))
          sendFrame(peer, { room: name, type: message.type, payload: message.payload });
      };

      return Object.freeze({
        async connect() {
          if (rooms.has(name)) throw new Error('This mesh is already in that room');
          rooms.set(name, room);
          signaling.join(name, roomRelays.get(name) ?? []);
          await start();
        },
        disconnect() {
          if (!isCurrent()) return;
          for (const peer of room.peers.keys()) sendFrame(peer, { room: name, type: LEAVE_MESSAGE });
          for (const peer of [...room.handshakes.keys()]) endHandshake(room, peer);
          room.peers.clear();
          rooms.delete(name);
          signaling.leave(name);
          for (const peer of [...links]) closeIfIdle(peer);
          if (rooms.size === 0) stop();
        },
        send,
        broadcast: (message: NetworkMessage) => {
          for (const peer of room.peers.keys()) send(peer, message);
        },
        drop(peer: string) {
          if (!isCurrent() || !room.peers.has(peer)) return;
          // Only this room: the connection may still serve spaces the two share.
          sendFrame(peer, { room: name, type: LEAVE_MESSAGE });
          drop(room, peer);
          closeIfIdle(peer);
        },
        getPeers: () => [...room.peers.values()],
        on: room.events.on,
        off: room.events.off,
        // Reachable: after the first introduction that no longer depends on a relay.
        isConnected: () => signaling.isConnected() || room.peers.size > 0,
      });
    },
  };
}

/** A relayed signal's fields, if it has the shape of one and is within the window */
function readSignal(signal: unknown) {
  if (!isObject(signal) || !isObject(signal.data)) return null;
  const { origin, target, kind, at, sig, hops } = signal;
  const { sdp } = signal.data;
  if (!isPeerDid(origin) || !isPeerDid(target) || !isSignalKind(kind)) return null;
  if (signal.data.type !== kind || typeof sdp !== 'string' || sdp.length > MAX_SDP_CHARS) return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || Math.abs(Date.now() - at) > SIGNAL_WINDOW_MS)
    return null;
  return { origin, target, kind, at, sdp, sig, hops };
}

function relayedSignal(
  fields: { origin: string; target: string; kind: SignalKind; at: number; sdp: string },
  sig: string,
  hops: number,
): RelayedSignal {
  const { origin, target, kind, at, sdp } = fields;
  return { origin, target, kind, data: { type: kind, sdp }, at, sig, hops };
}

/** Sets `key` as the newest entry, letting the oldest go past `limit` */
function setNewest<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  // A map iterates in insertion order: the first is the oldest.
  if (map.size > limit) map.delete(map.keys().next().value ?? key);
}
