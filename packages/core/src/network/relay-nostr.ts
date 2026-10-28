/**
 * A Nostr relay (NIP-01), named `nostr+wss://…` (spec 04 §1.5). Its events
 * carry Minca's sealed blobs as `content`, with the topic in an `x` tag:
 *
 *   published (ephemeral, kept by nobody)   kind 24733   tags [["x", topic]]
 *   dropped (kept until it expires)         kind 4733    tags [["x", topic], ["expiration", "<unix s>"]]
 *
 * Nostr wants every event signed by a secp256k1 key. Who a peer is is proven
 * end to end once connected, and a blob is sealed, so the key is a throwaway,
 * one per event: anyone watching a public relay can't tie one room to another
 * by it. A relay that asks for authentication (NIP-42)
 * is answered with the same throwaway key.
 *
 * It can't purge (nobody clears events someone else signed) and hands out no
 * TURN passwords.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createEmitter } from '../utils/events.js';
import { base64UrlEncode, bytesToHex, utf8Encode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import { converse, createRelaySocket, dialOf } from './relay-socket.js';
import type { MailboxOptions, MailItem, RelayLink, RelayLinkEvents, RelayMailbox } from './relays.js';

/** Ephemeral: relays pass it on and keep nothing (NIP-01, 20000–29999) */
export const NOSTR_EPHEMERAL_KIND = 24733;
/** Regular: relays keep it, here until its `expiration` (NIP-40) */
export const NOSTR_HELD_KIND = 4733;
/** NIP-42's authentication event */
const AUTH_KIND = 22242;
/** The tag a topic goes in; relays index single-letter tags */
const TOPIC_TAG = 'x';
/** The most events one fetch reads */
const FETCH_LIMIT = 500;

interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly content: string;
  readonly sig: string;
}

/** A Nostr signing key nobody keeps */
function throwawayKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** Signs an event (NIP-01): its id is the SHA-256 of its serialized fields */
function signNostrEvent(
  secret: Uint8Array,
  kind: number,
  tags: ReadonlyArray<ReadonlyArray<string>>,
  content: string,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const created_at = Math.floor(Date.now() / 1000);
  const hash = sha256(utf8Encode(JSON.stringify([0, pubkey, created_at, kind, tags, content])));
  return {
    id: bytesToHex(hash),
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig: bytesToHex(schnorr.sign(hash, secret)),
  };
}

/** The answer to a relay's NIP-42 challenge */
const authEvent = (secret: Uint8Array, relay: string, challenge: string) =>
  signNostrEvent(
    secret,
    AUTH_KIND,
    [
      ['relay', relay],
      ['challenge', challenge],
    ],
    '',
  );

/** An event's topic, when it has one this side asked for */
function topicOf(
  event: unknown,
  kind: number,
): { topic: string; content: string; createdAt: unknown; expires: number } | null {
  if (
    !isObject(event) ||
    event.kind !== kind ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags)
  )
    return null;
  const tags: unknown[] = event.tags;
  const value = (name: string): unknown => {
    const tag = tags.find((t) => Array.isArray(t) && t[0] === name);
    return Array.isArray(tag) ? tag[1] : undefined;
  };
  const topic = value(TOPIC_TAG);
  const expiration = value('expiration');
  return typeof topic === 'string'
    ? {
        topic,
        content: event.content,
        createdAt: event.created_at,
        expires: typeof expiration === 'string' ? Number(expiration) : Infinity,
      }
    : null;
}

/** A short subscription id for a topic: relays cap their length */
const subscriptionOf = (topic: string) => `m${topic.slice(0, 20)}`;

/** A socket to a Nostr relay, subscribed to the topics of the rooms this node is in */
function createNostrLink(url: string): RelayLink {
  const dial = dialOf(url);
  // Answers the relay's challenge; each event gets a key of its own, so nothing ties one room's to another's.
  const secret = throwawayKey();
  const topics = new Set<string>();
  const { on, off, emit } = createEmitter<RelayLinkEvents>();
  const subscribe = (send: (message: unknown) => void, topic: string) =>
    send([
      'REQ',
      subscriptionOf(topic),
      // A little back, for a peer whose clock is behind; a copy seen before is dropped by its id.
      {
        kinds: [NOSTR_EPHEMERAL_KIND],
        [`#${TOPIC_TAG}`]: [topic],
        since: Math.floor(Date.now() / 1000) - 120,
      },
    ]);
  const socket = createRelaySocket({
    url,
    dial,
    opened: (send) => {
      for (const topic of topics) subscribe(send, topic);
    },
    heard: (message, send) => {
      if (!Array.isArray(message)) return;
      if (message[0] === 'AUTH' && typeof message[1] === 'string') {
        send(['AUTH', authEvent(secret, dial, message[1])]);
        // A relay that wanted authentication may have closed the subscriptions made before it.
        for (const topic of topics) subscribe(send, topic);
        return;
      }
      if (message[0] !== 'EVENT') return;
      // The signature is a throwaway key's and proves nothing; what counts is whether the blob opens.
      const found = topicOf(message[2], NOSTR_EPHEMERAL_KIND);
      if (found && topics.has(found.topic) && message[1] === subscriptionOf(found.topic))
        emit('blob', found.topic, found.content);
    },
  });
  socket.on('connected', () => emit('connected'));
  socket.on('disconnected', () => emit('disconnected'));
  socket.on('status', (status) => emit('status', status));

  return Object.freeze({
    url,
    connect: socket.connect,
    disconnect: () => {
      topics.clear();
      socket.disconnect();
    },
    reconnect: socket.reconnect,
    watch: (topic: string) => {
      if (topics.has(topic)) return;
      topics.add(topic);
      subscribe(socket.send, topic);
      socket.count(topics.size);
    },
    unwatch: (topic: string) => {
      if (!topics.delete(topic)) return;
      socket.send(['CLOSE', subscriptionOf(topic)]);
      socket.count(topics.size);
    },
    publish: (topic: string, blob: string) =>
      socket.send([
        'EVENT',
        signNostrEvent(throwawayKey(), NOSTR_EPHEMERAL_KIND, [[TOPIC_TAG, topic]], blob),
      ]),
    isConnected: socket.isConnected,
    status: socket.status,
    on,
    off,
  });
}

/** How long a dropped blob is kept when the dropper names no time: the inbox's two weeks */
const DEFAULT_TTL_SECONDS = 14 * 24 * 3600;

/** A Nostr relay as a mailbox: each call opens its own socket, under a key used once */
function createNostrMailbox(options: MailboxOptions = {}): RelayMailbox {
  const talk = {
    timeoutMs: options.timeoutMs ?? 8000,
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  };

  const client: RelayMailbox = {
    drop(relay: string, topic: string, blob: string, ttlSeconds?: number) {
      const dial = dialOf(relay);
      const secret = throwawayKey();
      const expires = Math.floor(Date.now() / 1000) + (ttlSeconds || DEFAULT_TTL_SECONDS);
      const event = signNostrEvent(
        secret,
        NOSTR_HELD_KIND,
        [
          [TOPIC_TAG, topic],
          ['expiration', String(expires)],
        ],
        blob,
      );
      const id = base64UrlEncode(sha256(utf8Encode(blob)));
      let authed = false;
      return converse(
        dial,
        talk,
        (send) => send(['EVENT', event]),
        (answer, send) => {
          if (!Array.isArray(answer)) return undefined;
          if (answer[0] === 'AUTH' && typeof answer[1] === 'string' && !authed) {
            authed = true;
            send(['AUTH', authEvent(secret, dial, answer[1])]);
            send(['EVENT', event]);
            return undefined;
          }
          if (answer[0] !== 'OK' || answer[1] !== event.id) return undefined;
          const reason = typeof answer[3] === 'string' ? answer[3].slice(0, 200) : '';
          // Asked to authenticate first: the event goes again once the relay's challenge is answered.
          if (answer[2] !== true && reason.startsWith('auth-required:')) return undefined;
          if (answer[2] === true || reason.startsWith('duplicate:')) return id;
          throw new Error(`${relay} refused it: ${reason || 'no reason given'}`);
        },
      );
    },

    fetch(relay: string, topic: string, after = 0) {
      const dial = dialOf(relay);
      const subscription = subscriptionOf(topic);
      const secret = throwawayKey();
      let authed = false;
      const found = new Map<string, MailItem>();
      const now = Math.floor(Date.now() / 1000);
      const filter = {
        kinds: [NOSTR_HELD_KIND],
        [`#${TOPIC_TAG}`]: [topic],
        limit: FETCH_LIMIT,
        ...(after > 0 ? { since: after + 1 } : {}),
      };
      return converse(
        dial,
        talk,
        (send) => send(['REQ', subscription, filter]),
        (answer, send) => {
          if (Array.isArray(answer) && answer[0] === 'AUTH' && typeof answer[1] === 'string' && !authed) {
            authed = true;
            send(['AUTH', authEvent(secret, dial, answer[1])]);
            send(['REQ', subscription, filter]);
            return undefined;
          }
          if (!Array.isArray(answer) || answer[1] !== subscription) return undefined;
          if (answer[0] === 'EVENT') {
            const held = topicOf(answer[2], NOSTR_HELD_KIND);
            if (!held || held.topic !== topic || typeof held.createdAt !== 'number' || held.expires <= now)
              return undefined;
            const id = base64UrlEncode(sha256(utf8Encode(held.content)));
            // Its time is the dropper's word: it orders, and judges nothing.
            if (!found.has(id)) found.set(id, { seq: held.createdAt, id, blob: held.content });
            return undefined;
          }
          // Asked to authenticate first: once the relay's challenge is answered, the subscription goes again.
          if (answer[0] === 'CLOSED' && String(answer[2]).startsWith('auth-required:')) return undefined;
          if (answer[0] === 'EOSE' || answer[0] === 'CLOSED') {
            send(['CLOSE', subscription]);
            return [...found.values()].sort((a, b) => a.seq - b.seq);
          }
          return undefined;
        },
      );
    },
  };
  return Object.freeze(client);
}

/** `nostr+wss://`, or `nostr+ws://` on this machine (spec 04 §1.5) */
export const nostrRelay = Object.freeze({
  schemes: Object.freeze(['nostr+wss', 'nostr+ws']),
  link: createNostrLink,
  mailbox: createNostrMailbox,
  can: Object.freeze({ purge: false, ice: false }),
});
