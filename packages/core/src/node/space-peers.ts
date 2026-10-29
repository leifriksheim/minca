/**
 * @module node/space-peers
 * The peers of one open space: the networks it meets them on, who is at the
 * other end of each connection, sync, and live messages.
 *
 * A space is the unit of sync — its own rooms and sockets — so a peer you
 * share one space with learns nothing about the others.
 */
import type { NetworkMessage, PeerInfo, Version } from '../types.js';
import type { SpaceRecord } from '../space/space-manager.js';
import { verifyNote } from '../identity/ucan.js';
import { DEFINE_COMMAND, grantsBeyondRecords, writesRecords } from '../identity/abilities.js';
import { canonicalize } from '../schema/version.js';
import { openValue, sealValue } from '../identity/envelope.js';
import { MEMBERSHIP_LABEL, type SpaceKey } from '../privacy/space-encryption.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import { createMesh, type Mesh } from '../network/mesh.js';
import { createWebSocketTransport } from '../network/ws-transport.js';
import {
  createClientAuth,
  createMeshAuth,
  MAX_EARLIER_READ_KEYS,
  type MeshAuth,
  type ReadAccess,
} from '../network/peer-auth.js';
import { deriveReadKey } from '../space/space-access.js';
import { checkRelays, readers, type AccessState } from '../space/roles.js';
import { createSyncEngine, type Holds } from '../sync/sync-engine.js';
import type { SpaceFiles } from '../files/space-files.js';
import { base32Encode, sha256 } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import type { ConnectionState, NodeEvent, NodeNetworkConfig } from './types.js';
import type { Standing, SpaceBase } from './space-versions.js';
import type { History } from './space-history.js';
import type { Keys } from './space-keys.js';

/** How long a peer checked here has to become a peer before the check is forgotten: past any handshake's timeout */
const STALE_ADMISSION_MS = 60_000;
/** How long a removed member's socket stays open after nothing more is sent on it, for frames already on their way */
const LET_GO_AFTER_MS = 1000;
/** How long a peer let in on an older key has to show its account before it counts as nobody's */
const WHO_WAIT_MS = 10_000;

/** A peer's note, sent once when it connects */
const WHO_MESSAGE = 'who';
/** A live message: `spaces.send` */
const LIVE_MESSAGE = 'live';
const MAX_LIVE_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 16 * 1024;
/** Live messages a peer may send at once, and per second after that */
const LIVE_BURST = 60;
const LIVE_PER_SECOND = 20;

/** Which account a connected peer showed it acts for */
interface PeerAccount {
  readonly account: string | null;
  /** Its note grants writing records here and nothing more (`/record`): it can't define collections in this space */
  readonly recordsOnly: boolean;
}
const NO_ACCOUNT: PeerAccount = Object.freeze({ account: null, recordsOnly: false });

/**
 * The room a space's peers meet in on a relay. A hash of the space's id, so a
 * relay learns which connections belong together but not which space they are.
 */
export async function relayRoom(spaceId: string): Promise<string> {
  const digest = await sha256(utf8Encode(`minca-room/v1|${spaceId}`));
  return base32Encode(digest.subarray(0, 20));
}

/** The one mesh a node's spaces share, when it has relays to meet on */
export function meshFor(
  network: NodeNetworkConfig | undefined,
  session: { readonly did: string; readonly key: CryptoKey },
): Mesh | undefined {
  if (!network?.relays?.length) return undefined;
  return createMesh({
    did: session.did,
    key: session.key,
    relays: network.relays,
    ...(network.iceServers ? { iceServers: network.iceServers } : {}),
    ...(network.createTransport ? { createTransport: network.createTransport } : {}),
  });
}

/** The relays a node was configured with that a space may name */
export const usableRelays = (network: NodeNetworkConfig | undefined) =>
  (network?.relays ?? []).filter((url) => checkRelays([url]) === null);

/** A node's address with the space in its query, before any pin in the fragment */
function withSpace(node: string, spaceId: string): string {
  const [base = '', ...pin] = node.split('#');
  const query = `${base.includes('?') ? '&' : '?'}space=${encodeURIComponent(spaceId)}`;
  return `${base}${query}${pin.length ? `#${pin.join('#')}` : ''}`;
}

/**
 * Where the members meet, and the read key a reader must prove now: both
 * follow the access history, and a handshake asks for them without waiting.
 */
export function createMeeting(
  record: SpaceRecord,
  mesh: Mesh | undefined,
  onRelays?: (relays: ReadonlyArray<string>) => Promise<void>,
) {
  let currentReadKey = record.space.readKey ?? '';
  /**
   * Where the members meet: the relays the space names once it names some,
   * until then the ones the invite named. Handed to the mesh for this room alone.
   */
  let relays: ReadonlyArray<string> = record.relays ?? [];
  let meshRoom: string | null = null;
  function useRelays(named: ReadonlyArray<string>): void {
    const same = named.length === relays.length && named.every((url, i) => url === relays[i]);
    if (named.length === 0 || same) return;
    relays = [...named];
    if (meshRoom) mesh?.useRelays(meshRoom, relays);
    void onRelays?.(relays).catch(() => {});
  }
  return {
    relays: () => relays,
    readKey: () => currentReadKey,
    /** The access history was read anew */
    heard(state: AccessState): void {
      currentReadKey = state.keys.at(-1)?.readKey ?? currentReadKey;
      useRelays(state.relays);
    },
    /** Joins the space's room on the mesh, with the relays it meets on */
    async join(mesh: Mesh, auth: MeshAuth): Promise<NetworkManager> {
      meshRoom = await relayRoom(record.space.id);
      mesh.useRelays(meshRoom, relays);
      return mesh.join(meshRoom, auth);
    },
  };
}

type Meeting = ReturnType<typeof createMeeting>;

export interface PeersDeps extends SpaceBase {
  readonly network: NodeNetworkConfig | undefined;
  readonly mesh: Mesh | undefined;
  readonly meeting: Meeting;
  readonly history: History;
  readonly keys: Keys;
  readonly holds: () => Holds;
  readonly files: SpaceFiles;
  readonly emit: (event: NodeEvent) => void;
  readonly statusChanged: () => void;
  readonly admit: (version: Version) => Promise<Standing>;
  readonly recordsChanged: (placed?: ReadonlyArray<Version>) => void;
  readonly filesChanged: () => void;
  readonly onArrived: ((version: Version) => void) | undefined;
}

export async function openPeers(deps: PeersDeps) {
  const {
    record,
    keyring,
    storage,
    provider,
    session,
    meeting,
    files,
    emit,
    statusChanged,
    admit,
    recordsChanged,
    filesChanged,
  } = deps;
  const { space } = record;
  const { access, formerMembers } = deps.history;
  const { newestKey } = deps.keys;

  /** How the first connect went; after that, what the networks say now (`liveConnection`) */
  let connection: ConnectionState = 'offline';
  let rejected = 0;
  const networks: NetworkManager[] = [];
  const reachable = () => networks.some((network) => network.isConnected());
  /**
   * Connected while some network is: a relay reachable, or a peer. Once up, a
   * space whose relays are all gone and whose peers have left is trying again,
   * not connected; one whose first try failed is connected once a retry works.
   */
  const liveConnection = (): ConnectionState => {
    if (connection === 'offline') return connection;
    if (reachable()) return 'connected';
    return connection === 'connected' ? 'connecting' : connection;
  };
  let shown: ConnectionState | null = null;
  // Relays come and go without a peer doing so; say so when that changes how this space connects.
  const stopWatchingMesh = deps.mesh?.subscribe(() => {
    const now = liveConnection();
    if (now === shown) return;
    shown = now;
    statusChanged();
  });
  /** Which network a peer was met on, so replies go back the same way */
  const routes = new Map<string, NetworkManager>();
  const connectedPeers = () => [
    ...new Set(networks.flatMap((network) => network.getPeers().map((peer) => peer.did))),
  ];

  const sync = createSyncEngine({
    storageProvider: storage,
    self: session.did,
    holds: deps.holds,
    files: (peer, message) => files.onMessage(peer, message),
    sendToPeer: (peerId, message) => {
      routes.get(peerId)?.send(peerId, { type: 'sync', from: session.did, payload: message });
    },
    validate: async (version) => {
      const verdict = await admit(version);
      return verdict.ok || verdict.withdrawn
        ? { valid: true }
        : { valid: false, reason: verdict.reason, ...(verdict.later ? { later: true } : {}) };
    },
  });

  /**
   * Tells every connected peer this node's root, soon after it took in
   * something new — from a peer or from a folder. Without it, a record passed
   * along waits for the next heartbeat at every hop: a carrier would sit on a
   * friend's write for half a minute before the pod, or your phone, heard of
   * it. A peer already level answers and nothing moves.
   */
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const announceSoon = () => {
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      sync.notifyPeers(connectedPeers());
    }, 100);
  };

  // Once per message from a peer, with everything it brought.
  sync.on('received', (versions: ReadonlyArray<Version>) => {
    recordsChanged(versions);
    announceSoon();
    for (const version of versions) deps.onArrived?.(version);
  });
  sync.on('rejected', (peer: string, _version: Version, reason: string) => {
    rejected += 1;
    emit({ type: 'rejected', space: space.id, peer, reason });
  });

  // ─── Who is at the other end ──────────────────────────────────────
  //
  // A connection proves which session key is at the other end — not whose it
  // is. So the first thing each side sends is its note, the delegation from
  // its account to that key: the same note its records carry. It names the
  // key it was made out to, and that must be the key the connection proved,
  // so a note copied off someone's record is no use to anyone else.

  /** The read key each peer checked here was let in on, by session DID, and when */
  const admittedOn = new Map<string, { readonly readKey: string; readonly at: number }>();

  /** The account a peer's membership note shows, opened with the key whose read key it proved */
  async function shownAccount(peerDid: string, readKey: string, membership: unknown): Promise<string | null> {
    const epoch = (await access()).history.current.keys.find((known) => known.readKey === readKey);
    const held = epoch ? keyring.get(epoch.keyId) : undefined;
    if (!held) return null;
    const note = await openValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, membership);
    return (await accountOf(peerDid, note)).account;
  }

  /** How this node proves it may read, and checks the peers that connect — against the history at that moment */
  const readAccess: ReadAccess | null =
    space.visibility !== 'private'
      ? null
      : {
          async key() {
            const held = newestKey((await access()).history.current);
            // A carrier holds the read key pair without the key it comes from: it may be served the space, and cannot open it.
            return held ? deriveReadKey(held, provider) : (record.read ?? null);
          },
          current: meeting.readKey,
          async earlier() {
            const { current } = (await access()).history;
            const newest = newestKey(current);
            const older = [...current.keys]
              .reverse()
              .map((epoch) => keyring.get(epoch.keyId))
              .filter((held): held is SpaceKey => held !== undefined && held !== newest);
            return Promise.all(
              older.slice(0, MAX_EARLIER_READ_KEYS).map((held) => deriveReadKey(held, provider)),
            );
          },
          async membership() {
            const held = newestKey((await access()).history.current);
            return held ? sealValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, session.proof()) : null;
          },
          async admits(peerDid: string, readKey: string, membership: unknown) {
            const account = await shownAccount(peerDid, readKey, membership);
            return account !== null && readers((await access()).history.current).has(account);
          },
          async removed(peerDid: string, readKey: string, membership: unknown) {
            const account = await shownAccount(peerDid, readKey, membership);
            return account !== null && (await formerMembers({ untilNewKey: true })).has(account);
          },
          admitted(peerDid: string, readKey: string) {
            admittedOn.set(peerDid, { readKey, at: Date.now() });
          },
        };

  const peerAccounts = new Map<string, Promise<PeerAccount>>();
  /** Peers let go of because their account was removed, by session DID: turned away again when they redial */
  const cutOff = new Map<string, string>();
  const knownAccounts = new Map<string, PeerAccount>();
  const liveAllowance = new Map<string, { tokens: number; at: number }>();

  async function accountOf(peer: string, note: unknown): Promise<PeerAccount> {
    if (!isRecord(note) || canonicalize(note).length > MAX_NOTE_LENGTH) return NO_ACCOUNT;
    const checked = await verifyNote(note, provider).catch(() => null);
    if (!checked?.valid || checked.audience !== peer) return NO_ACCOUNT;
    return {
      account: checked.root,
      // A key that writes records somewhere but can't define here. Judged on the
      // whole note, so a key for another space doesn't pass as the account here.
      // A note that only reads is not one: it writes nothing. The note is the
      // account's own, one link, so its key can't sign itself a wider one.
      recordsOnly:
        writesRecords(checked.note) && !grantsBeyondRecords(checked.note, space.id, DEFINE_COMMAND),
    };
  }

  /** A peer's share of live messages: a burst, then a steady rate — as the relay limits them */
  function withinAllowance(peer: string): boolean {
    const now = Date.now();
    const held = liveAllowance.get(peer) ?? { tokens: LIVE_BURST, at: now };
    const tokens = Math.min(LIVE_BURST, held.tokens + ((now - held.at) / 1000) * LIVE_PER_SECOND);
    liveAllowance.set(peer, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }

  async function onLive(peer: string, payload: unknown): Promise<void> {
    if (!withinAllowance(peer)) return;
    if ((JSON.stringify(payload ?? null)?.length ?? 0) > MAX_LIVE_BYTES) return;
    const { account, recordsOnly } = (await peerAccounts.get(peer)) ?? NO_ACCOUNT;
    // Gone while its note was being checked.
    if (!routes.has(peer)) return;
    if (account !== null && (await formerMembers()).has(account)) return;
    emit({ type: 'message', space: space.id, from: account, peer, recordsOnly, message: payload });
  }

  /**
   * Lets go of the peers a handshake would refuse now. A handshake checks a
   * reader once, but the space's key changes when someone is removed: a peer
   * let in on a key that is no longer current stays only while it acts for
   * someone who may still read, as it would get in again (`checkRead`).
   * Anyone else — someone removed, a view-only link from before — stops
   * getting anything the moment this node knows the new key.
   */
  async function letGoOfOutsiders(): Promise<void> {
    const connected = new Set(connectedPeers());
    // Someone removed is let go of as soon as this node knows, on any key:
    // the key may not have changed yet, if nobody who manages the space is here.
    const gone = await formerMembers({ untilNewKey: true });
    for (const [peer, account] of cutOff) if (!gone.has(account)) cutOff.delete(peer);
    for (const peer of connected) {
      const account = knownAccounts.get(peer)?.account ?? null;
      if (account === null || !gone.has(account) || cutOff.has(peer)) continue;
      cutOff.set(peer, account);
      admittedOn.delete(peer);
      // Nothing more goes to them from now; the socket closes a moment later,
      // so what was already sent — the "stored" for their own leaving — arrives.
      sync.removePeer(peer);
      routes.delete(peer);
      setTimeout(() => {
        forget(peer);
        for (const network of networks) network.drop(peer);
      }, LET_GO_AFTER_MS);
    }
    if (admittedOn.size === 0) return;
    for (const [peer, { at }] of admittedOn) {
      // Checked, and never let in: a handshake the other side refused.
      if (!connected.has(peer) && Date.now() - at > STALE_ADMISSION_MS) admittedOn.delete(peer);
    }
    const allowed = readers((await access()).history.current);
    for (const peer of connected) {
      const admission = admittedOn.get(peer);
      if (!admission || admission.readKey === meeting.readKey()) continue;
      // Its note is said first, but may still be on its way; this runs again when it lands.
      if (!peerAccounts.has(peer) && Date.now() - admission.at < WHO_WAIT_MS) continue;
      const { account } = (await peerAccounts.get(peer)) ?? NO_ACCOUNT;
      if (account !== null && allowed.has(account)) continue;
      // Let in again meanwhile, on the key it holds now.
      if (admittedOn.get(peer) !== admission) continue;
      admittedOn.delete(peer);
      for (const network of networks) network.drop(peer);
    }
  }

  /** A peer's note arrived: who it acts for, checked once */
  function heard(peer: string, payload: unknown): void {
    const note = isRecord(payload) ? payload.note : undefined;
    const checked = accountOf(peer, note);
    peerAccounts.set(peer, checked);
    void checked.then((known) => {
      if (peerAccounts.get(peer) !== checked) return;
      knownAccounts.set(peer, known);
      statusChanged();
      void letGoOfOutsiders().catch(() => {});
    });
  }

  /** A message from a peer that isn't sync: its note, or a live message */
  function onMessage(message: NetworkMessage): void {
    if (message.type === WHO_MESSAGE) heard(message.from, message.payload);
    else if (message.type === LIVE_MESSAGE) void onLive(message.from, message.payload);
  }

  /** Said first to a peer that connects, so it reaches them before any live message from here */
  function introduce(network: NetworkManager, peer: string): void {
    network.send(peer, { type: WHO_MESSAGE, from: session.did, payload: { note: session.proof() } });
  }

  /** What was learned of a peer that is gone */
  function forget(peer: string): void {
    peerAccounts.delete(peer);
    knownAccounts.delete(peer);
    liveAllowance.delete(peer);
  }

  /** A peer left a network: once it is on none, its admission is forgotten too */
  function disconnected(peer: string): void {
    if (!connectedPeers().includes(peer)) admittedOn.delete(peer);
  }

  /** The account each connected peer showed, by session DID */
  const accounts = () =>
    Object.fromEntries(
      [...knownAccounts].flatMap(([peer, known]) =>
        known.account && routes.has(peer) ? [[peer, known.account]] : [],
      ),
    );

  /** Sends a live message to every connected peer, or those of one peer or account */
  async function send(message: unknown, to?: string): Promise<void> {
    const encoded = JSON.stringify(message ?? null);
    if (encoded.length > MAX_LIVE_BYTES) throw new Error('A live message can be at most 64 KB');
    const gone = await formerMembers();
    for (const peer of connectedPeers()) {
      const account = (await peerAccounts.get(peer))?.account ?? null;
      if (to && to !== peer && account !== to) continue;
      // Removed, or left: live messages stop with everything else.
      if (account !== null && gone.has(account)) continue;
      routes.get(peer)?.send(peer, { type: LIVE_MESSAGE, from: session.did, payload: message ?? null });
    }
  }

  /**
   * Writes a version, then waits up to `waitMs` for a peer to say it has
   * stored it: of another account, with `othersOnly`. True when one did;
   * false when that long passed first, or `waitMs` is none, or nobody can
   * come (`reachable`).
   */
  async function writeUntilStored(
    write: () => Promise<string>,
    options: { readonly waitMs: number; readonly othersOnly: boolean; readonly reachable: boolean },
  ): Promise<boolean> {
    const taken = new Set<string>();
    let wanted: string | null = null;
    let found: () => void = () => {};
    const take = (ids: ReadonlyArray<string>) => {
      for (const id of ids) taken.add(id);
      if (wanted !== null && taken.has(wanted)) found();
    };
    const onStored = (peer: string, ids: ReadonlyArray<string>) => {
      if (!options.othersOnly) take(ids);
      else
        void peerAccounts.get(peer)?.then(({ account }) => {
          if (account !== deps.rootDid) take(ids);
        });
    };
    // Listening before writing: a peer can answer before the write returns.
    sync.on('stored', onStored);
    try {
      wanted = await write();
      if (taken.has(wanted)) return true;
      if (options.waitMs <= 0 || !options.reachable) return false;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), options.waitMs);
        found = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
    } finally {
      sync.off('stored', onStored);
    }
  }

  // Both sides of a socket to a node prove who they are; in a private space the client also proves it may read.
  let authenticator: ReturnType<typeof createClientAuth> | null = null;
  /** A socket to an always-on node, for this space */
  function nodeNetwork(node: string): NetworkManager {
    authenticator ??= createClientAuth(space.id, session, readAccess, provider);
    const url = withSpace(node, space.id);
    const auth = authenticator;
    return createNetworkManager({
      did: session.did,
      createTransport: () => createWebSocketTransport({ url, did: session.did, authenticator: auth }),
    });
  }
  /** Sockets to the hosts the account or the space uses, by address: they change while the space is open */
  const hostNetworks = new Map<string, NetworkManager>();

  const net = deps.network;
  if (net) {
    // Who is at the other end is asked of the history at each handshake: the space's key may change while it is open.
    await access();
    if (deps.mesh) {
      // Every peer met through a relay proves who it is, and in a private space that it may read.
      networks.push(await meeting.join(deps.mesh, createMeshAuth(space.id, session, readAccess, provider)));
    }
    for (const node of net.nodes ?? []) networks.push(nodeNetwork(node));
    for (const transport of net.transports?.(space.id, session.did) ?? []) {
      networks.push(createNetworkManager({ did: session.did, createTransport: () => transport }));
    }
  }

  function listen(network: NetworkManager): void {
    network.on('message', (message: NetworkMessage) => {
      if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
      else onMessage(message);
    });
    network.on('peer-connected', (info: PeerInfo) => {
      if (cutOff.has(info.did)) {
        network.drop(info.did);
        return;
      }
      // Said first, so it reaches them before any live message from here.
      introduce(network, info.did);
      routes.set(info.did, network);
      sync.addPeer(info.did);
      // Reconcile at once rather than waiting for the heartbeat.
      sync.notifyPeers([info.did]);
      // It may hold a file nobody else had.
      files.joined(info.did);
      filesChanged();
      statusChanged();
      // The key may have changed between checking it and letting it in.
      void letGoOfOutsiders().catch(() => {});
    });
    network.on('peer-disconnected', (info: PeerInfo) => {
      if (routes.get(info.did) === network) {
        routes.delete(info.did);
        sync.removePeer(info.did);
        forget(info.did);
      }
      disconnected(info.did);
      statusChanged();
    });
    network.on('error', () => {
      if (!networks.some((n) => n.isConnected())) connection = 'error';
      statusChanged();
    });
  }
  for (const network of networks) listen(network);

  return {
    sync,
    readAccess,
    connectedPeers,
    letGoOfOutsiders,
    announceSoon,
    send,
    writeUntilStored,
    /** Sends a message to a peer, the way it was met */
    toPeer(peer: string, message: NetworkMessage): void {
      routes.get(peer)?.send(peer, message);
    },
    /** Starts every network */
    connect(): void {
      if (networks.length === 0) return;
      connection = 'connecting';
      // Online as soon as one way in works: a node that is slow to answer, or
      // never does, must not keep the space saying "connecting" meanwhile.
      void Promise.any(networks.map((network) => network.connect())).then(
        () => {
          connection = 'connected';
          statusChanged();
        },
        () => {
          connection = 'error';
          statusChanged();
        },
      );
      sync.start();
    },

    /** How this space connects, who is connected, and what they sent that was refused */
    status: () => ({ connection: liveConnection(), peers: connectedPeers(), accounts: accounts(), rejected }),

    /**
     * Waits up to `waitMs` for this node to be level with `peer` here: nothing
     * left in flight either way, so the peer holds everything this node does.
     * False when that long passed first.
     */
    syncedWith: (peer: string, waitMs: number): Promise<boolean> => {
      if (sync.levelWith(peer)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (level: boolean) => {
          clearTimeout(timer);
          sync.off('synced', onSynced);
          resolve(level);
        };
        const onSynced = (from: string) => {
          if (from === peer) done(true);
        };
        const timer = setTimeout(() => done(false), waitMs);
        sync.on('synced', onSynced);
        // Behind, it would start catching up only at the next heartbeat.
        sync.notifyPeers([peer]);
      });
    },

    /**
     * Always-on nodes to hold a socket to besides those configured: the hosts
     * the account or the space uses. Sockets to any given before and not now
     * are closed.
     */
    useNodes: (nodes: ReadonlyArray<string>): void => {
      if (!net || deps.isClosed()) return;
      const configured = new Set(net.nodes ?? []);
      const wanted = new Set(nodes.filter((node) => !configured.has(node)));
      for (const [node, network] of hostNetworks) {
        if (wanted.has(node)) continue;
        hostNetworks.delete(node);
        networks.splice(networks.indexOf(network), 1);
        network.disconnect();
      }
      for (const node of wanted) {
        if (hostNetworks.has(node)) continue;
        const network = nodeNetwork(node);
        hostNetworks.set(node, network);
        networks.push(network);
        listen(network);
        if (connection === 'offline') connection = 'connecting';
        sync.start();
        void network.connect().then(
          () => {
            connection = 'connected';
            statusChanged();
          },
          () => statusChanged(),
        );
      }
    },

    /** Stops telling of relays coming and going */
    quiet(): void {
      stopWatchingMesh?.();
    },

    close(): void {
      if (announceTimer) clearTimeout(announceTimer);
      sync.stop();
      for (const network of networks) network.disconnect();
    },
  };
}

export type Peers = Awaited<ReturnType<typeof openPeers>>;
