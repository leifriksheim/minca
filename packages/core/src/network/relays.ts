/**
 * Relays of every kind behind one contract (spec 04 §1). A relay moves sealed
 * blobs under a topic and understands none of them: peers meet by publishing
 * to a room's topic (`rendezvous.ts`), and an inbox or a short link leaves
 * blobs to be fetched later (a mailbox).
 *
 * A relay's kind is its URL's scheme: `wss://` is a Minca relay
 * (`relay-minca.ts`), `nostr+wss://` a Nostr relay (`relay-nostr.ts`). A
 * kind this library doesn't know is passed over, so a space can name one
 * before every member's app can use it.
 */
import type { RelayStatus } from './relay-socket.js';
import { createMincaLink, createMincaMailbox } from './relay-minca.js';
import { createNostrLink, createNostrMailbox } from './relay-nostr.js';

export type RelayLinkEvents = {
  /** A blob published under a topic this link watches */
  blob: (topic: string, blob: string) => void;
  /**
   * TURN servers the relay offers, with passwords that stop working at
   * `expiresAt` (ms). Only Minca relays with TURN offer them.
   */
  ice: (servers: ReadonlyArray<RTCIceServer>, expiresAt: number) => void;
  connected: () => void;
  disconnected: () => void;
  /** The socket opened, closed, or is waiting to try again */
  status: (status: RelayStatus) => void;
};

/** A socket to one relay, kept open, publishing and watching topics that are not kept */
export interface RelayLink {
  readonly url: string;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  /** Tries again now, if waiting to */
  readonly reconnect: () => void;
  /** Hears what is published under a topic, now and after every reconnect */
  readonly watch: (topic: string) => void;
  readonly unwatch: (topic: string) => void;
  /** Hands a blob to whoever watches the topic now; nobody keeps it */
  readonly publish: (topic: string, blob: string) => void;
  /** Asks for fresh TURN passwords; they arrive as an `ice` event, from relays that have TURN */
  readonly requestIce: () => void;
  readonly isConnected: () => boolean;
  readonly status: () => RelayStatus;
  readonly on: <K extends keyof RelayLinkEvents>(event: K, callback: RelayLinkEvents[K]) => void;
  readonly off: <K extends keyof RelayLinkEvents>(event: K, callback: RelayLinkEvents[K]) => void;
}

/** One blob a mailbox holds */
export interface MailItem {
  /** Increases with every blob that mailbox takes; fetch `after` the last one seen */
  readonly seq: number;
  /** base64url SHA-256 of the blob: the same at every mailbox */
  readonly id: string;
  readonly blob: string;
}

export interface MailboxClient {
  /**
   * Leaves a blob under a topic, kept for `ttlSeconds` or the relay's own
   * limit, whichever is shorter.
   * @returns The blob's id
   * @throws When the relay refuses it, or can't be reached
   */
  drop(relay: string, topic: string, blob: string, ttlSeconds?: number): Promise<string>;
  /** Everything a relay holds under a topic, after a sequence number, in at most `pages` pages (default 8) */
  fetch(relay: string, topic: string, after?: number, pages?: number): Promise<ReadonlyArray<MailItem>>;
  /**
   * Clears blobs from a topic — all of them, or those named — as the inbox's
   * owner: shows the signing key and signs the relay's challenge with it.
   * @throws Where the relay's kind can't clear (a Nostr relay)
   */
  purge(
    relay: string,
    topic: string,
    sign: string,
    ids: ReadonlyArray<string> | null,
    signChallenge: (nonce: string) => Promise<string>,
  ): Promise<number>;
}

export interface MailboxOptions {
  /** How long to wait for a relay to answer. Default 8 seconds. */
  readonly timeoutMs?: number;
  /** The WebSocket to use. Default the global one (browsers, Node 22+). */
  readonly WebSocket?: typeof WebSocket;
}

/** The kinds of relay this library speaks */
export type RelayKind = 'minca' | 'nostr';

/**
 * A relay's kind, from its scheme: `wss:` (or `ws:`) is Minca's own,
 * `nostr+wss:` Nostr's; null for a kind this library doesn't speak.
 */
export function relayKind(url: string): RelayKind | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'wss' || scheme === 'ws') return 'minca';
  if (scheme === 'nostr+wss' || scheme === 'nostr+ws') return 'nostr';
  return null;
}

/** A socket to a relay, or null for a kind this library doesn't speak */
export function createRelayLink(url: string): RelayLink | null {
  const kind = relayKind(url);
  if (kind === 'minca') return createMincaLink(url);
  if (kind === 'nostr') return createNostrLink(url);
  return null;
}

/** Mailboxes of every kind: each call goes to the kind its relay's URL names */
export function createMailboxClient(options: MailboxOptions = {}): MailboxClient {
  const minca = createMincaMailbox(options);
  const nostr = createNostrMailbox(options);
  const of = (relay: string): MailboxClient => {
    const kind = relayKind(relay);
    if (kind === 'minca') return minca;
    if (kind === 'nostr') return nostr;
    throw new Error(`${relay} is a kind of relay this app doesn't speak`);
  };
  const client: MailboxClient = {
    drop: (relay, topic, blob, ttl) => of(relay).drop(relay, topic, blob, ttl),
    fetch: (relay, topic, after, pages) => of(relay).fetch(relay, topic, after, pages),
    purge: (relay, topic, sign, ids, signChallenge) =>
      of(relay).purge(relay, topic, sign, ids, signChallenge),
  };
  return Object.freeze(client);
}
