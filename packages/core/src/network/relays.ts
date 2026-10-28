/**
 * Relays of every kind behind one contract (spec 04 §1). A relay moves sealed
 * blobs under a topic and understands none of them: peers meet by publishing
 * to a room's topic (`rendezvous.ts`), and an inbox or a short link leaves
 * blobs to be fetched later (a mailbox).
 *
 * Each kind is one frozen object beside its implementation (`relay-minca.ts`,
 * `relay-nostr.ts`): the schemes that name it, a link, a mailbox, and what it
 * can do beyond the contract. Callers ask about an ability, never a kind. A
 * kind this library doesn't know is passed over, so a space can name one
 * before every member's app can use it.
 */
import type { RelayStatus } from './relay-socket.js';
import { mincaRelay } from './relay-minca.js';
import { nostrRelay } from './relay-nostr.js';

export type RelayLinkEvents = {
  /** A blob published under a topic this link watches */
  blob: (topic: string, blob: string) => void;
  /** TURN servers, with passwords that stop working at `expiresAt` (ms), from a kind that `can.ice` */
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
  /** Asks for fresh TURN passwords, which arrive as an `ice` event; only on a kind that `can.ice` */
  readonly requestIce?: () => void;
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
   * @throws Where the relay's kind can't purge
   */
  purge(
    relay: string,
    topic: string,
    sign: string,
    ids: ReadonlyArray<string> | null,
    signChallenge: (nonce: string) => Promise<string>,
  ): Promise<number>;
}

/** One kind's mailbox: the contract, and `purge` on a kind that `can.purge` */
export type RelayMailbox = Pick<MailboxClient, 'drop' | 'fetch'> & Partial<Pick<MailboxClient, 'purge'>>;

export interface MailboxOptions {
  /** How long to wait for a relay to answer. Default 8 seconds. */
  readonly timeoutMs?: number;
  /** The WebSocket to use. Default the global one (browsers, Node 22+). */
  readonly WebSocket?: typeof WebSocket;
}

/** A kind of relay (spec 04 §1.2) */
export interface RelayKind {
  /** The URL schemes that name it, lower case */
  readonly schemes: ReadonlyArray<string>;
  readonly link: (url: string) => RelayLink;
  readonly mailbox: (options: MailboxOptions) => RelayMailbox;
  /** What it does beyond the contract every relay meets */
  readonly can: {
    /** An inbox's owner can clear what others dropped (spec 07 §5) */
    readonly purge: boolean;
    /** It may hand out TURN passwords (spec 04 §1.4) */
    readonly ice: boolean;
  };
}

/** The kinds this library speaks */
const KINDS: ReadonlyArray<RelayKind> = Object.freeze([mincaRelay, nostrRelay]);

/** A relay's kind, from its URL's scheme; null for a kind this library doesn't speak */
export function relayKind(url: string): RelayKind | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? '';
  return KINDS.find((kind) => kind.schemes.includes(scheme)) ?? null;
}

/** A socket to a relay, or null for a kind this library doesn't speak */
export function createRelayLink(url: string): RelayLink | null {
  return relayKind(url)?.link(url) ?? null;
}

/** Mailboxes of every kind: each call goes to the kind its relay's URL names */
export function createMailboxClient(options: MailboxOptions = {}): MailboxClient {
  const boxes = new Map(KINDS.map((kind) => [kind, kind.mailbox(options)]));
  const of = (relay: string): { kind: RelayKind; box: RelayMailbox } => {
    const kind = relayKind(relay);
    const box = kind && boxes.get(kind);
    if (!kind || !box) throw new Error(`${relay} is a kind of relay this app doesn't speak`);
    return { kind, box };
  };
  const client: MailboxClient = {
    drop: (relay, topic, blob, ttl) => of(relay).box.drop(relay, topic, blob, ttl),
    fetch: (relay, topic, after, pages) => of(relay).box.fetch(relay, topic, after, pages),
    purge: (relay, topic, sign, ids, signChallenge) => {
      const { kind, box } = of(relay);
      return kind.can.purge && box.purge
        ? box.purge(relay, topic, sign, ids, signChallenge)
        : Promise.reject(new Error(`${relay} can't clear what others left`));
    },
  };
  return Object.freeze(client);
}
