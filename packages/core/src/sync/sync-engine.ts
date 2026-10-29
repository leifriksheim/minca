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
   * Gatekeeper for versions from peers, typically `createVersionCheck`. What it
   * rejects is dropped and surfaces as `rejected`. Without it, everything is
   * accepted: only for a trusted transport or a test.
   */
  readonly validate?: (version: Version) => Promise<IncomingValidation>;
  /** What this node holds, asked afresh for every hello. Default: everything. */
  readonly holds?: () => Holds;
  /** Where a files message from a peer goes (spec 05 §16.6); without it, they are dropped */
  readonly files?: (peerId: string, message: unknown) => Promise<void>;
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

/** At most this many records wait for what they depend on; the oldest give way */
const MAX_WAITING = 1000;
/** Refusals remembered, so reconciling doesn't ask a peer for the same bad version every round */
const MAX_REFUSED = 10_000;
/** Records asked for, or sent, in one message */
const MAX_IDS_PER_REQUEST = 200;
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

/**
 * Versions in messages of at most `size`, with every version of one record in
 * the same message where they fit. A message is taken in whole, so a record
 * arrives with the versions that changed or deleted it, never as it once was.
 */
function byRecord(versions: ReadonlyArray<Version>, size: number): Version[][] {
  const records = new Map<string, Version[]>();
  for (const version of versions) getOrAdd(records, version.key, () => []).push(version);
  const messages: Version[][] = [];
  let message: Version[] = [];
  for (const record of records.values()) {
    if (message.length + record.length > size && message.length > 0) {
      messages.push(message);
      message = [];
    }
    // A record with more versions than fit in one message goes over several.
    for (let i = 0; i < record.length; i += size) {
      const part = record.slice(i, i + size);
      if (message.length + part.length > size) {
        messages.push(message);
        message = [];
      }
      message.push(...part);
    }
  }
  if (message.length > 0) messages.push(message);
  return messages;
}

/** Reconciling one collection with one peer, as initiator */
interface Session {
  readonly id: number;
  readonly collection: string;
  readonly reconciler: ReturnType<typeof createReconciler>;
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
  readonly queued: Array<{ readonly id: string; readonly collection: string }>;
  readonly queuedIds: Set<string>;
  /** What the peer said it holds, in its last hello */
  holds: Holds;
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
  /** Records that could not be judged yet, tried again whenever something new is admitted */
  const waiting = new Map<string, { peerId: string; version: Version }>();
  /**
   * Refused versions, by peer and id, oldest first. An id doesn't cover the
   * signature, so a stranger's mangled copy must not stop us fetching the real one.
   */
  const refused = new Set<string>();
  /** Which connection to each peer is open now, so a message from a closed one is dropped */
  const connections = new Map<string, number>();
  /** Where each peer's messages are up to */
  const inOrder = new Map<string, Promise<void>>();
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
    const verdict: IncomingValidation = validate ? await validate(version) : { valid: true };
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
    dropOldest(waiting, MAX_WAITING);
    const dependsOn = version.seq > 0 ? [version.genesis, version.prev] : [];
    for (const needed of dependsOn) {
      if (typeof needed === 'string' && !(await storage.getVersion(needed)))
        intake.firsts.set(needed, version.collection);
    }
  };

  const refuse = (peerId: string, version: Version, reason: string | undefined) => {
    refused.add(refusal(peerId, version.id));
    dropOldest(refused, MAX_REFUSED);
    emit('rejected', peerId, version, reason);
  };

  /** Tries every waiting version again until nothing more goes in; each sender hears what was stored */
  const retryWaiting = async (intake: Intake) => {
    const stored = new Map<string, string[]>();
    let progressed = true;
    while (progressed && waiting.size > 0) {
      progressed = false;
      for (const [id, held] of [...waiting]) {
        waiting.delete(id);
        if (!(await admit(held.peerId, held.version, intake))) continue;
        progressed = true;
        getOrAdd(stored, held.peerId, () => []).push(id);
      }
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
    const entries = ids.filter((id) => first || !state.queuedIds.has(id)).map((id) => ({ id, collection }));
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
    const byCollection = new Map<string, string[]>();
    for (const [id, collection] of firsts) {
      if (inFlight.has(id) || isRefused(peerId, id) || (await storage.getVersion(id))) continue;
      getOrAdd(byCollection, collection, () => []).push(id);
    }
    for (const [collection, ids] of byCollection) want(peerId, collection, ids, true);
  };

  /** Ids asked of a peer and not yet answered */
  const askedOf = (peerId: string) =>
    new Set([...(states.get(peerId)?.wants.values() ?? [])].flatMap((w) => [...w.ids]));

  // ─── Hello ─────────────────────────────────────────────────────────

  /** A fingerprint of each collection held and kept, hex */
  const ourSums = async (holds: Holds): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [collection, sum] of await storage.sums()) {
      if (holdsCollection(holds, collection)) out[collection] = bytesToHex(await fingerprintOf(sum));
    }
    return out;
  };

  const hello = async (peerId: string, reply = false) => {
    const holds = ourHolds();
    send(peerId, {
      type: 'hello',
      holds: holds === 'all' ? 'all' : [...holds],
      sums: await ourSums(holds),
      ...(reply ? { reply } : {}),
    });
  };

  const sayHello = (peerId: string, reply = false) => void hello(peerId, reply).catch(report);

  const onHello = async (
    peerId: string,
    theirs: Readonly<Record<string, string>>,
    theirHolds: unknown,
    reply: boolean,
  ) => {
    if (typeof theirs !== 'object' || theirs === null) return;
    const names = Object.keys(theirs);
    if (names.length > MAX_COLLECTIONS) return;
    const state = stateOf(peerId);
    state.holds = readHolds(theirHolds);
    const holds = ourHolds();
    const ours = await ourSums(holds);
    // Every collection this node holds counts, even one it has nothing of yet.
    const named = new Set([...names, ...Object.keys(ours), ...(holds === 'all' ? [] : holds)]);
    const shared = [...named].filter((c) => holdsCollection(holds, c) && holdsCollection(state.holds, c));
    const differing = shared.filter((c) => theirs[c] !== ours[c]);
    for (const c of shared) if (theirs[c] === ours[c]) emit('level', peerId, c, state.holds === 'all');
    if (differing.length === 0) return settleIfDone(peerId);
    if (self !== undefined && self > peerId) {
      // The other side starts. It may not have heard from us yet.
      if (!reply) await hello(peerId, true);
      return;
    }
    for (const collection of differing) await begin(peerId, collection);
  };

  // ─── Reconciling, as initiator ─────────────────────────────────────

  const busy = (peerId: string) => {
    const state = states.get(peerId);
    return !!state && (state.sessions.size > 0 || state.wants.size > 0 || state.queuedIds.size > 0);
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
    });

  const begin = async (peerId: string, collection: string) => {
    if (typeof collection !== 'string') return;
    const state = stateOf(peerId);
    const current = state.sessions.get(collection);
    if (current && Date.now() - current.touchedAt < STALE_MS) {
      current.again = true;
      return;
    }
    const reconciler = createReconciler(await storage.items(collection), {
      initiator: true,
      frameSizeLimit: FRAME_SIZE_LIMIT,
    });
    const session: Session = {
      id: nextId++,
      collection,
      reconciler,
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
    if (!state || state.sessions.has(collection)) return;
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
    const found = await Promise.all(session.have.reverse().map((id) => storage.getVersion(id)));
    const have = found.filter((v): v is Version => v !== null);
    for (const versions of byRecord(have, MAX_IDS_PER_REQUEST)) send(peerId, { type: 'versions', versions });
    if (session.again) void begin(peerId, session.collection).catch(report);
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

  const onReconcile = async (peerId: string, id: number, collection: string, message: string) => {
    if (typeof collection !== 'string' || typeof message !== 'string') return;
    if (!holdsCollection(ourHolds(), collection)) {
      send(peerId, { type: 'reconciled', id, message: '', held: false });
      return;
    }
    const responder = createReconciler(await storage.items(collection), {
      initiator: false,
      frameSizeLimit: FRAME_SIZE_LIMIT,
    });
    const round = await responder.reconcile(base64UrlDecode(message));
    send(peerId, { type: 'reconciled', id, message: base64UrlEncode(round.message!) });
  };

  const serveWant = async (peerId: string, id: number, ids: ReadonlyArray<string>) => {
    const versions: Version[] = [];
    for (const v of ids.slice(0, MAX_IDS_PER_REQUEST)) {
      const version = typeof v === 'string' && cidDigest(v) ? await storage.getVersion(v) : null;
      if (version) versions.push(version);
    }
    // Always answered, even empty: the asker counts replies to know it is done.
    send(peerId, { type: 'versions', id, versions });
  };

  const onVersions = async (peerId: string, id: number | undefined, versions: ReadonlyArray<Version>) => {
    // Sent unasked, because we lacked them: each still passes the gatekeeper.
    if (id === undefined) return admitAll(peerId, versions.slice(0, MAX_IDS_PER_REQUEST));
    const state = states.get(peerId);
    const asked = state?.wants.get(id);
    if (!state || !asked) return;
    await admitAll(
      peerId,
      versions.filter((v) => asked.ids.has(v?.id)),
    );
    state.wants.delete(id);
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
          return await onHello(peerId, msg.sums, msg.holds, msg.reply === true);
        case 'reconcile':
          return await onReconcile(peerId, msg.id, msg.collection, msg.message);
        case 'reconciled':
          return await onReconciled(peerId, msg.id, msg.message, msg.held !== false);
        case 'want':
          return await serveWant(peerId, msg.id, Array.isArray(msg.ids) ? msg.ids : []);
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
});

const refusal = (peerId: string, id: string) => `${peerId}\n${id}`;

const abandoned = (peerId: string, why: string) => new Error(`Sync with ${peerId} abandoned: ${why}`);

function getOrAdd<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

/** Drops the oldest entry once a map or set is over `max` */
function dropOldest<K>(items: Map<K, unknown> | Set<K>, max: number): void {
  if (items.size <= max) return;
  const oldest = items.keys().next();
  if (!oldest.done) items.delete(oldest.value);
}
