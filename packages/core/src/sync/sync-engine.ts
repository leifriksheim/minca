/**
 * Keeps one store in step with its peers.
 *
 * 1. A peer says hello with a fingerprint of each collection it keeps. Equal
 *    fingerprints mean the same versions.
 * 2. For each collection that differs, the initiator reconciles it with the
 *    other (`negentropy.ts`), and ends up knowing which versions each side lacks.
 * 3. The initiator asks for what it lacks, and sends what the other lacks.
 *    Everything that arrives passes the gatekeeper before it is stored.
 *
 * Cost follows the difference, not the size. The initiator is the peer whose
 * id sorts first; the other answers a hello with its own, which starts it.
 *
 * A node may hold every collection, or only some (plus `sys.*`, which every
 * node holds), and says which in its hello. Two peers reconcile only what both
 * hold. Whatever a node takes in from a peer, it tells that peer (`stored`), so
 * a node holding part of a space can let go of its own writes.
 */
import { getOrAdd } from '../utils/map.js';
import type { Version } from '../types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { cidDigest, cidOfDigest } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, bytesToHex } from '../utils/encoding.js';
import { createEmitter } from '../utils/events.js';
import { createReconciler, fingerprintOf } from './negentropy.js';
import {
  parseSyncMessage,
  SYNC_PROTOCOL_VERSION,
  type SyncMessage,
  type SyncMessageBody,
} from './sync-messages.js';

/** Verdict on a version that arrived from a peer */
export interface IncomingValidation {
  readonly valid: boolean;
  readonly reason?: string;
  /**
   * Not judged yet: it depends on something that has not arrived. It is held
   * and tried again as other records come in.
   */
  readonly later?: boolean;
}

/** What a node holds of a space: every collection, or these (besides `sys.*`, which every node holds) */
export type Holds = 'all' | ReadonlySet<string>;

export interface SyncEngineConfig {
  readonly storageProvider: StorageProvider;
  readonly sendToPeer: (peerId: string, message: SyncMessage) => void;
  /**
   * This node's id among its peers; of two peers, the one that sorts first
   * starts reconciling. Without it this node always starts, sometimes doubling the work.
   */
  readonly self?: string;
  readonly heartbeatInterval?: number;
  /**
   * Gatekeeper for versions from peers, given which peer sent each, typically
   * `createVersionCheck`. What it rejects is dropped and surfaces as
   * `rejected`. Without it, everything is accepted: only for a trusted
   * transport or a test.
   */
  readonly validate?: (version: Version, from: string) => Promise<IncomingValidation>;
  /** What this node holds, asked afresh for every hello. Default: everything. */
  readonly holds?: () => Holds;
  /**
   * Whether this node asks a peer to sync by shallow sets (05 §5.1), asked
   * afresh for every hello. A peer that asks is answered in kind anyway.
   */
  readonly shallowWith?: (peerId: string) => boolean;
  /** Where a files message from a peer goes (spec 05 §16.6); without it, they are dropped */
  readonly files?: (peerId: string, message: unknown) => Promise<void>;
  /**
   * Bytes sent to a peer that haven't left yet. Sending a peer what it lacks
   * waits while this is over `MAX_MESSAGE_BYTES`, so a large space goes out
   * as fast as the connection takes it, read from the store as it goes.
   * Without it, everything goes at once.
   */
  readonly backlog?: (peerId: string) => number;
}

/**
 * - `synced` (peer, full): nothing left in flight with the peer; `full` when it holds every collection
 * - `level` (peer, collection, full): this node holds what the peer holds of a collection
 * - `stored` (peer, ids): the peer says it now has these versions
 * - `version-received` (version): each version taken in
 * - `received` (versions): every version one message brought, once all are in
 * - `rejected` (peer, version, reason), `error` (error)
 */
interface SyncEvents {
  synced: (peer: string, full: boolean) => void;
  level: (peer: string, collection: string, full: boolean) => void;
  stored: (peer: string, ids: string[]) => void;
  'version-received': (version: Version) => void;
  received: (versions: Version[]) => void;
  /** A method, so listeners written before `reason` could be missing still type-check */
  rejected(peer: string, version: Version, reason: string | undefined): void;
  error: (error: unknown) => void;
}
export type SyncEvent = keyof SyncEvents;

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Handles whatever a peer sent; anything that is not a sync message this peer speaks is ignored. */
  handleMessage(peerId: string, message: unknown): Promise<void>;
  /** Says hello to these peers now, rather than at the next heartbeat. */
  notifyPeers(peers: ReadonlyArray<string>): void;
  /** Whether the peer was last found level with this node, and this node has taken in nothing since */
  levelWith(peerId: string): boolean;
  /** Asks every peer that holds the collection for these versions, by id, ahead of the rest */
  ask(collection: string, ids: ReadonlyArray<string>): void;
  onLocalChange(version: Version): void;
  addPeer(peerId: string): void;
  removePeer(peerId: string): void;
  on<K extends SyncEvent>(event: K, callback: SyncEvents[K]): void;
  off<K extends SyncEvent>(event: K, callback: SyncEvents[K]): void;
}

/**
 * Records waiting for what they depend on, past which nothing more is asked
 * for but what they wait on: a long history fills in from below instead of
 * being dropped and asked for again. High, since below it histories arrive
 * as fast as the peer sends them: pausing at 1,000 made 100 records of 50
 * edits each settle in 30 s instead of 2.
 */
const MAX_WAITING = 20_000;
/** Records held while what they wait on is fetched; past this the oldest is let go and asked for again later */
const MAX_HELD = 2 * MAX_WAITING;
/** Refusals remembered, so reconciling doesn't ask a peer for the same bad version every round */
const MAX_REFUSED = 10_000;
/** Records asked for, or sent, in one message */
const MAX_IDS_PER_REQUEST = 200;
/**
 * Bytes of versions in one message, besides the count: a message of large
 * records is held whole in memory at both ends, and a socket refuses one past
 * its limit. One version larger than this still goes, alone.
 */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** How often a sender waiting for its connection to drain looks again */
const DRAIN_POLL_MS = 25;
/** `want`s in flight to one peer at a time; the rest queue */
const MAX_WANTS_IN_FLIGHT = 4;
/** Largest Negentropy message, in bytes before base64: well inside a data channel's limit */
const FRAME_SIZE_LIMIT = 32_000;
/** Collections one hello may name. Past this it is hostile, not big. */
const MAX_COLLECTIONS = 1000;
/** Rounds one reconciliation may take before it is given up as runaway */
const MAX_ROUNDS = 64;
/** A session or want that has heard nothing for this long is given up on */
const STALE_MS = 30_000;

/** Whether a collection is held, given what a node holds */
const holdsCollection = (holds: Holds, collection: string): boolean =>
  collection.startsWith('sys.') || holds === 'all' || holds.has(collection);

/** What a hello says the peer holds; anything malformed counts as holding nothing past `sys.*` */
function readHolds(value: unknown): Holds {
  if (value === undefined || value === 'all') return 'all';
  if (!Array.isArray(value) || value.length > MAX_COLLECTIONS) return new Set();
  return new Set(value.filter((c): c is string => typeof c === 'string'));
}

/** Collection definitions first, then records by version: what others depend on comes first */
const rank = (e: Version): number => (e?.collection === 'sys.collection' ? -1 : (e?.seq ?? 0));

/** About the bytes a version takes in a message */
const wireBytes = (version: Version): number => JSON.stringify(version).length;

/** Reconciling one collection with one peer, as initiator */
interface Session {
  readonly id: number;
  readonly collection: string;
  readonly reconciler: ReturnType<typeof createReconciler>;
  /** Comparing shallow sets */
  readonly shallow: boolean;
  rounds: number;
  touchedAt: number;
  /** The peer said something new about this collection mid-session: go again once done */
  again: boolean;
  /** Ids already found: a round cut short by the frame limit can name some again */
  readonly handled: Set<string>;
  /** Ids found so far, oldest first: what they lack, and what we lack */
  readonly have: string[];
  readonly need: string[];
}

interface Want {
  readonly ids: ReadonlySet<string>;
  readonly collection: string;
  readonly at: number;
}

/** Everything in flight with one peer */
interface PeerState {
  readonly sessions: Map<string, Session>;
  /** `want`s in flight, by request id */
  readonly wants: Map<number, Want>;
  /**
   * Ids to ask for once fewer wants are in flight, front first. An entry
   * counts only while its id is in `queuedIds`; the rest are passed over.
   */
  readonly queued: Array<{ readonly id: string; readonly collection: string; readonly first: boolean }>;
  readonly queuedIds: Set<string>;
  /** What the peer said it holds, in its last hello */
  holds: Holds;
  /** Whether its last hello asked to sync with this node by shallow sets */
  shallow: boolean;
  /**
   * Sends of what it lacks still going, by collection. Until they are done
   * the collection isn't level and no new session starts for it: a session
   * would find the same versions missing and send them again.
   */
  readonly sending: Map<string, number>;
  /** Collections to reconcile again once their sends are done */
  readonly beginAfter: Set<string>;
}

/** What one message brought in: the versions stored, and the versions they wait for */
interface Intake {
  readonly placed: Version[];
  readonly firsts: Map<string, string>;
}

/** Creates a sync engine orchestrator. */
export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  const { storageProvider: storage, sendToPeer, heartbeatInterval = 30000, validate, self } = config;
  const ourHolds = config.holds ?? (() => 'all' as const);
  const { on, off, emit } = createEmitter<SyncEvents>();
  const report = (err: unknown) => emit('error', err);

  /** Peers to say hello to and push to */
  const peers = new Set<string>();
  const states = new Map<string, PeerState>();
  /** Peers found level with this node, until it takes in or writes anything more */
  const level = new Set<string>();
  /** Records that could not be judged yet, until what they wait for is admitted */
  const waiting = new Map<string, { peerId: string; version: Version }>();
  /** Waiting records by a version of their own chain they lack (`prev` or first): tried again once it is stored */
  const waitingOn = new Map<string, Set<string>>();
  /** Waiting records that lack nothing of their own chain, so wait for something else: tried after every intake */
  const waitingOther = new Set<string>();
  /**
   * Refused versions, by peer and id, oldest first. An id doesn't cover the
   * signature, so a stranger's mangled copy must not stop us fetching the real one.
   */
  const refused = new Set<string>();
  /** Which connection to each peer is open now, so a message from a closed one is dropped */
  const connections = new Map<string, number>();
  /** Where each peer's messages are up to */
  const inOrder = new Map<string, Promise<void>>();
  /** What is still being sent to each peer, so one session's versions go after another's */
  const sending = new Map<string, Promise<void>>();
  /** Answers to each peer's `want`s still waiting for room, in the order asked */
  const answering = new Map<string, Promise<void>>();
  let lastConnection = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let nextId = 1;

  const send = (peerId: string, msg: SyncMessageBody) =>
    sendToPeer(peerId, { v: SYNC_PROTOCOL_VERSION, ...msg });
  const stateOf = (peerId: string): PeerState => getOrAdd(states, peerId, newPeerState);
  const peerHolds = (peerId: string, collection: string) =>
    holdsCollection(states.get(peerId)?.holds ?? 'all', collection);
  const isRefused = (peerId: string, id: string) => refused.has(refusal(peerId, id));

  // ─── Taking in versions ────────────────────────────────────────────

  /** Stores a version from a peer if the gatekeeper allows it; one that must wait names what it waits for */
  const admit = async (peerId: string, version: Version, intake: Intake): Promise<boolean> => {
    const verdict: IncomingValidation = validate ? await validate(version, peerId) : { valid: true };
    if (!verdict.valid) {
      if (verdict.later) await holdBack(peerId, version, intake);
      else refuse(peerId, version, verdict.reason);
      return false;
    }
    waiting.delete(version.id);
    await storage.addVersion(version);
    intake.placed.push(version);
    emit('version-received', version);
    return true;
  };

  const holdBack = async (peerId: string, version: Version, intake: Intake) => {
    waiting.set(version.id, { peerId, version });
    if (waiting.size > MAX_HELD) letGoOldest();
    const dependsOn = version.seq > 0 ? [version.genesis, version.prev] : [];
    const lacking: string[] = [];
    for (const needed of dependsOn) {
      if (typeof needed !== 'string' || (await storage.getVersion(needed))) continue;
      lacking.push(needed);
      // Syncing shallow, the version before is not fetched: a keeper's copy of this one comes without it.
      if (needed === version.prev && config.shallowWith?.(peerId)) continue;
      intake.firsts.set(needed, version.collection);
    }
    if (lacking.length === 0) waitingOther.add(version.id);
    for (const needed of lacking) getOrAdd(waitingOn, needed, () => new Set()).add(version.id);
  };

  /** Lets the longest-waiting record go, still to be asked for: dropped and forgotten, a peer would look level without it */
  const letGoOldest = () => {
    const [id, held] = waiting.entries().next().value ?? [];
    if (!id || !held) return;
    waiting.delete(id);
    waitingOther.delete(id);
    if (peers.has(held.peerId)) want(held.peerId, held.version.collection, [id]);
  };

  const refuse = (peerId: string, version: Version, reason: string | undefined) => {
    refused.add(refusal(peerId, version.id));
    dropOldest(refused, MAX_REFUSED);
    emit('rejected', peerId, version, reason);
  };

  /**
   * Tries again what waited for the versions just stored, and what those let
   * in in turn, then what waits for anything else; each sender hears what was
   * stored. Each waiting record is tried once per version it lacked: trying
   * every one on every arrival took a 1,000-edit history quadratic time.
   */
  const retryWaiting = async (intake: Intake) => {
    const stored = new Map<string, string[]>();
    const tryAgain = async (id: string) => {
      const held = waiting.get(id);
      if (!held) return;
      waiting.delete(id);
      waitingOther.delete(id);
      if (await admit(held.peerId, held.version, intake)) getOrAdd(stored, held.peerId, () => []).push(id);
    };
    let next = 0;
    for (;;) {
      // Stored versions are appended to `placed` as they go in, so this follows a chain to its end.
      for (; next < intake.placed.length; next++) {
        const placedId = intake.placed[next]!.id;
        const dependents = waitingOn.get(placedId);
        waitingOn.delete(placedId);
        for (const id of dependents ?? []) await tryAgain(id);
      }
      const placedBefore = intake.placed.length;
      for (const id of [...waitingOther]) await tryAgain(id);
      if (intake.placed.length === placedBefore) break;
    }
    for (const [peerId, ids] of stored) if (peers.has(peerId)) send(peerId, { type: 'stored', ids });
  };

  /**
   * Queues ids to ask a peer for, behind the rest or ahead of them (`ahead`,
   * and always for `sys.*`: who may do what decides whether the rest counts).
   */
  const want = (peerId: string, collection: string, ids: ReadonlyArray<string>, ahead = false) => {
    const first = ahead || collection.startsWith('sys.');
    const state = stateOf(peerId);
    const entries = ids
      .filter((id) => first || !state.queuedIds.has(id))
      .map((id) => ({ id, collection, first }));
    for (const { id } of entries) state.queuedIds.add(id);
    if (first) state.queued.unshift(...entries);
    else state.queued.push(...entries);
    pump(peerId);
  };

  /** Sends wants from the front of the queue while there is room in flight */
  const pump = (peerId: string) => {
    const state = states.get(peerId);
    if (!state) return;
    while (state.wants.size < MAX_WANTS_IN_FLIGHT && state.queuedIds.size > 0) {
      if (waiting.size >= MAX_WAITING && !nextIsFirst(state)) break;
      const batch = takeBatch(state);
      if (!batch) break;
      const id = nextId++;
      state.wants.set(id, { ids: new Set(batch.ids), collection: batch.collection, at: Date.now() });
      send(peerId, { type: 'want', id, ids: batch.ids });
    }
  };

  /** Admits a batch, what others depend on first, passing over collections not held here */
  const admitAll = async (peerId: string, versions: ReadonlyArray<Version>) => {
    const holds = ourHolds();
    const stored: string[] = [];
    const intake: Intake = { placed: [], firsts: new Map() };
    for (const version of [...versions].sort((a, b) => rank(a) - rank(b))) {
      if (!version || typeof version !== 'object' || typeof version.collection !== 'string') continue;
      if (!holdsCollection(holds, version.collection)) continue;
      if (await admit(peerId, version, intake)) stored.push(version.id);
    }
    if (stored.length > 0) {
      send(peerId, { type: 'stored', ids: stored });
      await retryWaiting(intake);
    }
    if (intake.firsts.size > 0 && peers.has(peerId)) await askFirsts(peerId, intake.firsts);
    if (intake.placed.length > 0) {
      level.clear();
      emit('received', intake.placed);
    }
  };

  /** Asks at once for the versions still waited on, unless asked, refused or already here */
  const askFirsts = async (peerId: string, firsts: ReadonlyMap<string, string>) => {
    const inFlight = askedOf(peerId);
    const state = states.get(peerId);
    // Coming anyway, a batch at a time: asking for each one alone walks a chain a link per round trip.
    // Or here already, waiting in turn for the one below it: asked again, it comes again, and waits again.
    const coming = (id: string, collection: string) =>
      inFlight.has(id) || waiting.has(id) || !!state?.queuedIds.has(id) || !!state?.sessions.has(collection);
    const byCollection = new Map<string, string[]>();
    for (const [id, collection] of firsts) {
      if (coming(id, collection) || isRefused(peerId, id) || (await storage.getVersion(id))) continue;
      getOrAdd(byCollection, collection, () => []).push(id);
    }
    for (const [collection, ids] of byCollection) want(peerId, collection, ids, true);
  };

  /** Ids asked of a peer and not yet answered */
  const askedOf = (peerId: string) =>
    new Set([...(states.get(peerId)?.wants.values() ?? [])].flatMap((w) => [...w.ids]));

  // ─── Hello ─────────────────────────────────────────────────────────

  /** Whether an exchange with a peer compares shallow sets: either side may say so */
  const shallowWith = (peerId: string) =>
    !!states.get(peerId)?.shallow || (config.shallowWith?.(peerId) ?? false);

  /** A fingerprint of each collection held and kept, hex: of its shallow set in a shallow exchange */
  const ourSums = async (holds: Holds, shallow = false): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [collection, sum] of await (shallow ? storage.shallowSums() : storage.sums())) {
      if (holdsCollection(holds, collection)) out[collection] = bytesToHex(await fingerprintOf(sum));
    }
    return out;
  };

  const hello = async (peerId: string, reply = false) => {
    const holds = ourHolds();
    // Only this node's own wish: a peer that asked has its answer in kind, not the same ask back.
    const askShallow = config.shallowWith?.(peerId) ?? false;
    send(peerId, {
      type: 'hello',
      holds: holds === 'all' ? 'all' : [...holds],
      sums: await ourSums(holds, shallowWith(peerId)),
      ...(reply ? { reply } : {}),
      ...(askShallow ? { shallow: true } : {}),
    });
  };

  const sayHello = (peerId: string, reply = false) => void hello(peerId, reply).catch(report);

  const onHello = async (
    peerId: string,
    theirs: Readonly<Record<string, string>>,
    theirHolds: unknown,
    reply: boolean,
    theirShallow: boolean,
  ) => {
    if (typeof theirs !== 'object' || theirs === null) return;
    const names = Object.keys(theirs);
    if (names.length > MAX_COLLECTIONS) return;
    const state = stateOf(peerId);
    state.holds = readHolds(theirHolds);
    state.shallow = theirShallow;
    const holds = ourHolds();
    const ours = await ourSums(holds, shallowWith(peerId));
    // Every collection this node holds counts, even one it has nothing of yet.
    const named = new Set([...names, ...Object.keys(ours), ...(holds === 'all' ? [] : holds)]);
    const shared = [...named].filter((c) => holdsCollection(holds, c) && holdsCollection(state.holds, c));
    const differing = shared.filter((c) => theirs[c] !== ours[c]);
    for (const c of shared) if (theirs[c] === ours[c]) emit('level', peerId, c, state.holds === 'all');
    if (differing.length === 0) {
      // A shallow ask hears that it is level: no round of reconciling tells it so.
      if (theirShallow && !reply) await hello(peerId, true);
      return settleIfDone(peerId);
    }
    if (self !== undefined && self > peerId) {
      // The other side starts. It may not have heard from us yet.
      if (!reply) await hello(peerId, true);
      return;
    }
    // Who may do what first, then the smallest: what a screen shows first is rarely a long log.
    const sizes = await storage.sums();
    const order = (c: string) => (c.startsWith('sys.') ? -1 : (sizes.get(c)?.count ?? 0));
    for (const collection of differing.sort((a, b) => order(a) - order(b))) await begin(peerId, collection);
  };

  // ─── Reconciling, as initiator ─────────────────────────────────────

  const busy = (peerId: string) => {
    const state = states.get(peerId);
    if (
      state &&
      (state.sessions.size > 0 || state.wants.size > 0 || state.queuedIds.size > 0 || state.sending.size > 0)
    )
      return true;
    // What it sent that waits for its chain isn't taken in yet.
    for (const held of waiting.values()) if (held.peerId === peerId) return true;
    return false;
  };

  const settleIfDone = (peerId: string) => {
    if (busy(peerId)) return;
    level.add(peerId);
    emit('synced', peerId, states.get(peerId)?.holds === 'all');
  };

  const sendRound = (peerId: string, session: Session, message: Uint8Array) =>
    send(peerId, {
      type: 'reconcile',
      id: session.id,
      collection: session.collection,
      message: base64UrlEncode(message),
      ...(session.shallow ? { shallow: true } : {}),
    });

  const begin = async (peerId: string, collection: string) => {
    if (typeof collection !== 'string') return;
    const state = stateOf(peerId);
    const current = state.sessions.get(collection);
    if (current && Date.now() - current.touchedAt < STALE_MS) {
      current.again = true;
      return;
    }
    if (state.sending.has(collection)) {
      state.beginAfter.add(collection);
      return;
    }
    const shallow = shallowWith(peerId);
    const reconciler = createReconciler(
      await (shallow ? storage.shallowItems(collection) : storage.items(collection)),
      { initiator: true, frameSizeLimit: FRAME_SIZE_LIMIT },
    );
    const session: Session = {
      id: nextId++,
      collection,
      reconciler,
      shallow,
      rounds: 0,
      touchedAt: Date.now(),
      again: false,
      handled: new Set(),
      have: [],
      need: [],
    };
    state.sessions.set(collection, session);
    sendRound(peerId, session, await reconciler.initiate());
  };

  /**
   * When a collection's session and its wants are over, this node is level
   * with the peer, and tells it so in a reply hello that starts no new round.
   */
  const levelIfDone = (peerId: string, collection: string) => {
    const state = states.get(peerId);
    if (!state || state.sessions.has(collection) || state.sending.has(collection)) return;
    const wanting = [...state.wants.values()].some((w) => w.collection === collection);
    const queued = state.queued.some((q) => q.collection === collection && state.queuedIds.has(q.id));
    if (wanting || queued) return;
    emit('level', peerId, collection, state.holds === 'all');
    sayHello(peerId, true);
  };

  /**
   * Ends a session: asks for what we lack and sends what they lack, newest
   * first. Only now, since rounds find versions oldest first, and sending as
   * they go would show a record as it once was.
   */
  const endSession = async (peerId: string, state: PeerState, session: Session) => {
    // Asked for before the session goes, so the peer never looks idle in between.
    want(peerId, session.collection, session.need.reverse());
    state.sessions.delete(session.collection);
    sendAll(peerId, state, session.collection, session.have.reverse());
    if (session.again) void begin(peerId, session.collection).catch(report);
  };

  /**
   * Sends a peer versions it lacks, in order, after whatever is still going
   * to it. Off the peer's message queue, so taking in what the peer sends
   * never waits on it taking in what this node sends.
   */
  const sendAll = (peerId: string, state: PeerState, collection: string, ids: ReadonlyArray<string>) => {
    if (ids.length === 0) return;
    const connection = connections.get(peerId);
    state.sending.set(collection, (state.sending.get(collection) ?? 0) + 1);
    const run = (sending.get(peerId) ?? Promise.resolve())
      .then(() => sendPaced(peerId, connection, ids))
      .catch(report);
    sending.set(peerId, run);
    void run.finally(() => {
      if (sending.get(peerId) === run) sending.delete(peerId);
      // A peer that went, or came back on a new connection, starts afresh.
      if (states.get(peerId) !== state) return;
      const left = (state.sending.get(collection) ?? 1) - 1;
      if (left > 0) return void state.sending.set(collection, left);
      state.sending.delete(collection);
      if (state.beginAfter.delete(collection)) return void begin(peerId, collection).catch(report);
      levelIfDone(peerId, collection);
      settleIfDone(peerId);
    });
  };

  /**
   * Reads versions from the store a message at a time, and waits for the
   * connection to drain before each: what is held in memory at once is one
   * message, however much the peer lacks. A record's versions go in the same
   * message, in the place of its newest (spec 05 §6.3), so the store is read
   * twice: once to learn which record each version is of, keeping only that,
   * then a message's worth at a time to send.
   */
  const sendPaced = async (peerId: string, connection: number | undefined, ids: ReadonlyArray<string>) => {
    const open = () => connections.get(peerId) === connection && peers.has(peerId);
    const records = new Map<string, string[]>();
    for (const id of ids) {
      if (!open()) return;
      const version = await storage.getVersion(id);
      if (version) getOrAdd(records, version.key, () => []).push(id);
    }

    let message: Version[] = [];
    let bytes = 0;
    const flush = async () => {
      if (message.length === 0) return;
      if (await drained(peerId, connection)) send(peerId, { type: 'versions', versions: message });
      message = [];
      bytes = 0;
    };
    for (const record of records.values()) {
      if (!open()) return;
      const versions: Array<{ version: Version; size: number }> = [];
      for (const id of record) {
        const version = await storage.getVersion(id);
        if (version) versions.push({ version, size: wireBytes(version) });
      }
      const size = versions.reduce((sum, one) => sum + one.size, 0);
      // A record that doesn't fit in what is left starts a message of its own.
      if (message.length + versions.length > MAX_IDS_PER_REQUEST || bytes + size > MAX_MESSAGE_BYTES)
        await flush();
      // One with more than a message holds goes over several.
      for (const one of versions) {
        if (
          message.length >= MAX_IDS_PER_REQUEST ||
          (message.length > 0 && bytes + one.size > MAX_MESSAGE_BYTES)
        )
          await flush();
        message.push(one.version);
        bytes += one.size;
      }
    }
    await flush();
  };

  const onReconciled = async (peerId: string, id: number, message: string, held: boolean) => {
    const state = states.get(peerId);
    const session = state && [...state.sessions.values()].find((s) => s.id === id);
    if (!state || !session) return; // not ours, or already over
    session.touchedAt = Date.now();

    if (!held) {
      // They changed what they hold since their hello.
      await endSession(peerId, state, session);
      return settleIfDone(peerId);
    }

    let round;
    try {
      round = await session.reconciler.reconcile(base64UrlDecode(message));
    } catch (err) {
      await endSession(peerId, state, session);
      emit('error', abandoned(peerId, err instanceof Error ? err.message : String(err)));
      return settleIfDone(peerId);
    }

    const isNew = (versionId: string) => {
      if (session.handled.has(versionId)) return false;
      session.handled.add(versionId);
      return true;
    };
    session.have.push(...round.have.map(cidOfDigest).filter(isNew));
    session.need.push(...round.need.map(cidOfDigest).filter((v) => isNew(v) && !isRefused(peerId, v)));

    if (round.message && ++session.rounds < MAX_ROUNDS) return sendRound(peerId, session, round.message);
    if (round.message) emit('error', abandoned(peerId, `more than ${MAX_ROUNDS} rounds`));
    await endSession(peerId, state, session);
    levelIfDone(peerId, session.collection);
    settleIfDone(peerId);
  };

  // ─── Answering ─────────────────────────────────────────────────────

  const onReconcile = async (
    peerId: string,
    id: number,
    collection: string,
    message: string,
    shallow: boolean,
  ) => {
    if (typeof collection !== 'string' || typeof message !== 'string') return;
    if (!holdsCollection(ourHolds(), collection)) {
      send(peerId, { type: 'reconciled', id, message: '', held: false });
      return;
    }
    const responder = createReconciler(
      await (shallow ? storage.shallowItems(collection) : storage.items(collection)),
      { initiator: false, frameSizeLimit: FRAME_SIZE_LIMIT },
    );
    const round = await responder.reconcile(base64UrlDecode(message));
    send(peerId, { type: 'reconciled', id, message: base64UrlEncode(round.message!) });
  };

  /**
   * Answers a `want` once the connection has room, after the answers before
   * it. Off the peer's message queue, like `sendAll`, and apart from it, so an
   * answer never waits behind a large push. A peer that asks and doesn't read
   * holds up only its own answers, and what waits is the ids it asked for.
   */
  const serveWant = (peerId: string, id: number, ids: ReadonlyArray<string>) => {
    const connection = connections.get(peerId);
    const asked = ids.slice(0, MAX_IDS_PER_REQUEST);
    const run = (answering.get(peerId) ?? Promise.resolve())
      .then(async () => {
        if (!(await drained(peerId, connection))) return;
        const versions: Version[] = [];
        let bytes = 0;
        // In the order asked, until a message's worth: the asker asks again for what comes after.
        for (const v of asked) {
          if (bytes >= MAX_MESSAGE_BYTES) break;
          const version = typeof v === 'string' && cidDigest(v) ? await storage.getVersion(v) : null;
          if (!version) continue;
          versions.push(version);
          bytes += wireBytes(version);
        }
        // Always answered, even empty: the asker counts replies to know it is done.
        if (connections.get(peerId) === connection) send(peerId, { type: 'versions', id, versions });
      })
      .catch(report);
    answering.set(peerId, run);
    void run.finally(() => {
      if (answering.get(peerId) === run) answering.delete(peerId);
    });
  };

  /** Waits until the connection has under a message's worth left to send; false once it is gone */
  const drained = async (peerId: string, connection: number | undefined): Promise<boolean> => {
    const open = () => connections.get(peerId) === connection && peers.has(peerId);
    while (open() && (config.backlog?.(peerId) ?? 0) > MAX_MESSAGE_BYTES)
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    return open();
  };

  const onVersions = async (peerId: string, id: number | undefined, versions: ReadonlyArray<Version>) => {
    // Sent unasked, because we lacked them: each still passes the gatekeeper.
    if (id === undefined) return admitAll(peerId, versions.slice(0, MAX_IDS_PER_REQUEST));
    const state = states.get(peerId);
    const asked = state?.wants.get(id);
    if (!state || !asked) return;
    const answered = versions.filter((v) => asked.ids.has(v?.id));
    await admitAll(peerId, answered);
    state.wants.delete(id);
    // An answer that stopped at a message's worth: what came after the last sent is asked for again,
    // ahead of the rest, where it was.
    // One that brought none is not, so a peer lacking them is asked once.
    const order = [...asked.ids];
    const sent = new Set(answered.map((v) => v.id));
    let last = order.length - 1;
    while (last >= 0 && !sent.has(order[last]!)) last--;
    if (last >= 0 && last < order.length - 1) want(peerId, asked.collection, order.slice(last + 1), true);
    pump(peerId);
    levelIfDone(peerId, asked.collection);
    settleIfDone(peerId);
  };

  const onStored = (peerId: string, ids: unknown) => {
    if (!Array.isArray(ids)) return;
    const named = ids.filter((v): v is string => typeof v === 'string');
    emit('stored', peerId, named.slice(0, 10 * MAX_IDS_PER_REQUEST));
  };

  // ─── Housekeeping ──────────────────────────────────────────────────

  /** Drops sessions and wants a peer stopped answering, so a lost message can't wedge sync */
  const sweep = () => {
    const now = Date.now();
    const stale = (at: number) => now - at > STALE_MS;
    for (const [peerId, state] of states) {
      for (const [collection, session] of state.sessions)
        if (stale(session.touchedAt)) state.sessions.delete(collection);
      // What a lost want asked for is found again on the next round.
      const lost = [...state.wants].filter(([, want]) => stale(want.at));
      if (lost.length === 0) continue;
      for (const [id] of lost) state.wants.delete(id);
      pump(peerId);
      settleIfDone(peerId);
    }
  };

  const handle = async (peerId: string, message: unknown): Promise<void> => {
    try {
      const msg = parseSyncMessage(message);
      // A peer not added yet has no way back for an answer. Each side says
      // hello once it adds the other, so nothing said before then is needed.
      if (!msg || !peers.has(peerId)) return;
      switch (msg.type) {
        case 'hello':
          return await onHello(peerId, msg.sums, msg.holds, msg.reply === true, msg.shallow === true);
        case 'reconcile':
          return await onReconcile(peerId, msg.id, msg.collection, msg.message, msg.shallow === true);
        case 'reconciled':
          return await onReconciled(peerId, msg.id, msg.message, msg.held !== false);
        case 'want':
          return serveWant(peerId, msg.id, Array.isArray(msg.ids) ? msg.ids : []);
        case 'versions':
          return await onVersions(peerId, msg.id, Array.isArray(msg.versions) ? msg.versions : []);
        case 'push-update':
          if (msg.version && typeof msg.version === 'object') await admitAll(peerId, [msg.version]);
          return;
        case 'want-file':
        case 'file':
        case 'file-done':
          return await config.files?.(peerId, msg);
        case 'stored':
          return onStored(peerId, msg.ids);
      }
    } catch (err) {
      report(err);
    }
  };

  const forget = (peerId: string) => {
    states.delete(peerId);
    level.delete(peerId);
  };

  return {
    start() {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        sweep();
        for (const peer of peers) sayHello(peer);
      }, heartbeatInterval);
    },

    stop() {
      if (intervalId !== null) clearInterval(intervalId);
      intervalId = null;
      states.clear();
      // Every send still going ends: none of the connections it was for is current any more.
      connections.clear();
    },

    handleMessage(peerId: string, message: unknown): Promise<void> {
      // One peer's messages run in the order they came: a hello must not
      // overtake the versions sent before it. One from a connection closed
      // since is dropped when its turn comes.
      const connection = connections.get(peerId);
      const run = (inOrder.get(peerId) ?? Promise.resolve()).then(() =>
        connections.get(peerId) === connection ? handle(peerId, message) : undefined,
      );
      inOrder.set(peerId, run);
      void run.finally(() => {
        if (inOrder.get(peerId) === run) inOrder.delete(peerId);
      });
      return run;
    },

    notifyPeers(peerIds: ReadonlyArray<string>) {
      for (const peer of peerIds) if (peers.has(peer)) sayHello(peer);
    },

    ask(collection: string, ids: ReadonlyArray<string>) {
      if (ids.length === 0) return;
      for (const peer of peers) if (peerHolds(peer, collection)) want(peer, collection, ids, true);
    },

    levelWith: (peerId: string) => level.has(peerId),

    onLocalChange(version: Version) {
      level.clear();
      // Not to a peer that doesn't hold the collection: it would pass it by.
      for (const peer of peers)
        if (peerHolds(peer, version.collection)) send(peer, { type: 'push-update', version });
    },

    addPeer(peerId: string) {
      // A new connection: nothing half-finished from an earlier one carries over.
      connections.set(peerId, ++lastConnection);
      forget(peerId);
      peers.add(peerId);
    },

    removePeer(peerId: string) {
      connections.delete(peerId);
      peers.delete(peerId);
      forget(peerId);
    },

    on,
    off,
  };
}

/** Takes up to one want's worth of queued ids, all of one collection, off the front of the queue */
/** Whether the next id to ask for is one held records wait on */
function nextIsFirst(state: PeerState): boolean {
  const next = state.queued.find((entry) => state.queuedIds.has(entry.id));
  return next?.first ?? false;
}

function takeBatch(state: PeerState): { collection: string; ids: string[] } | null {
  const ids: string[] = [];
  let collection: string | null = null;
  while (state.queued.length > 0 && ids.length < MAX_IDS_PER_REQUEST) {
    const next = state.queued[0]!;
    if (!state.queuedIds.has(next.id)) {
      state.queued.shift();
      continue;
    }
    if (collection !== null && next.collection !== collection) break;
    collection = next.collection;
    state.queued.shift();
    state.queuedIds.delete(next.id);
    ids.push(next.id);
  }
  return collection === null ? null : { collection, ids };
}

const newPeerState = (): PeerState => ({
  sessions: new Map(),
  wants: new Map(),
  queued: [],
  queuedIds: new Set(),
  holds: 'all',
  shallow: false,
  sending: new Map(),
  beginAfter: new Set(),
});

const refusal = (peerId: string, id: string) => `${peerId}\n${id}`;

const abandoned = (peerId: string, why: string) => new Error(`Sync with ${peerId} abandoned: ${why}`);

/** Drops the oldest entry once a map or set is over `max` */
function dropOldest<K>(items: Map<K, unknown> | Set<K>, max: number): void {
  if (items.size <= max) return;
  const oldest = items.keys().next();
  if (!oldest.done) items.delete(oldest.value);
}
