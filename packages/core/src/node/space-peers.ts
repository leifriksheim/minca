/**
 * @module node/space-peers
 * Who is at the other end of each connection to a space, and live messages.
 *
 * A connection proves which session key is at the other end — not whose it
 * is. So the first thing each side sends is its note, the delegation from
 * its account to that key: the same note its records carry. It names the
 * key it was made out to, and that must be the key the connection proved,
 * so a note copied off someone's record is no use to anyone else.
 */
import type { CryptoProvider, NetworkMessage } from '../types.js';
import type { SpaceRecord } from '../space/space-manager.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import { openValue, sealValue } from '../identity/envelope.js';
import { DEFINE_COMMAND, writesRecords } from '../identity/abilities.js';
import { canonicalize } from '../schema/version.js';
import { MEMBERSHIP_LABEL, type SpaceKey } from '../privacy/space-encryption.js';
import { deriveReadKey } from '../space/space-access.js';
import { readers, type AccessHistory, type AccessState } from '../space/roles.js';
import type { NetworkManager } from '../network/network-manager.js';
import { MAX_EARLIER_READ_KEYS, type ReadAccess } from '../network/peer-auth.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import { isRecord } from '../utils/guards.js';
import type { NodeEvent } from './types.js';
import { grantsBeyondRecords } from './space-common.js';

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

/** What knowing the peers reads of the open space */
export interface PeersContext {
  readonly space: SpaceRecord['space'];
  readonly rootDid: string;
  readonly session: { readonly did: string; readonly proof: () => Delegation | undefined };
  readonly provider: CryptoProvider;
  /** Every key of the space this node holds, by id */
  readonly keyring: ReadonlyMap<string, SpaceKey>;
  /** A carrier's read key pair, held without the key it comes from */
  readonly readKeyPair: SpaceRecord['read'];
  readonly newestKey: (state: AccessState) => SpaceKey | null;
  /** The read key readers must prove now */
  readonly currentReadKey: () => string;
  readonly access: () => Promise<{ readonly history: AccessHistory }>;
  readonly formerMembers: (options?: { untilNewKey?: boolean }) => Promise<ReadonlySet<string>>;
  readonly emit: (event: NodeEvent) => void;
  readonly statusChanged: () => void;
  readonly networks: ReadonlyArray<NetworkManager>;
  /** Which network a peer was met on, so replies go back the same way */
  readonly routes: Map<string, NetworkManager>;
  readonly sync: SyncEngine;
  readonly connectedPeers: () => string[];
}

export function createSpacePeers(ctx: PeersContext) {
  const {
    space,
    rootDid,
    session,
    provider,
    keyring,
    readKeyPair,
    newestKey,
    currentReadKey,
    access,
    formerMembers,
    emit,
    statusChanged,
    networks,
    routes,
    sync,
    connectedPeers,
  } = ctx;

  /** The read key each peer checked here was let in on, by session DID, and when */
  const admittedOn = new Map<string, { readonly readKey: string; readonly at: number }>();

  /** How this node proves it may read, and checks the peers that connect — against the history at that moment */
  const readAccess: ReadAccess | null =
    space.visibility !== 'private'
      ? null
      : {
          async key() {
            const held = newestKey((await access()).history.current);
            // A carrier holds the read key pair without the key it comes from: it may be served the space, and cannot open it.
            return held ? deriveReadKey(held, provider) : (readKeyPair ?? null);
          },
          current: () => currentReadKey(),
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
            const { history } = await access();
            const epoch = history.current.keys.find((known) => known.readKey === readKey);
            const held = epoch ? keyring.get(epoch.keyId) : undefined;
            if (!held) return false;
            const { account } = await accountOf(
              peerDid,
              await openValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, membership),
            );
            return account !== null && readers(history.current).has(account);
          },
          async removed(peerDid: string, readKey: string, membership: unknown) {
            const { history } = await access();
            const epoch = history.current.keys.find((known) => known.readKey === readKey);
            const held = epoch ? keyring.get(epoch.keyId) : undefined;
            if (!held) return false;
            const note = await openValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, membership);
            const { account } = await accountOf(peerDid, note);
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
      if (!admission || admission.readKey === currentReadKey()) continue;
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
          if (account !== rootDid) take(ids);
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

  return Object.freeze({
    readAccess,
    accountOf,
    onMessage,
    introduce,
    isCutOff: (peer: string) => cutOff.has(peer),
    forget,
    disconnected,
    accounts,
    letGoOfOutsiders,
    send,
    writeUntilStored,
  });
}
