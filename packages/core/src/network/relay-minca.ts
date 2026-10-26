/**
 * A Minca relay (`packages/relay/relay.mjs`; spec 04 §1.4, 07 §5): one
 * mailbox, spoken in JSON text frames. A blob dropped with `ttl: 0` goes to
 * whoever watches its topic and is kept by nobody, which is how peers meet; a
 * blob dropped with a ttl is kept, which is how inboxes and short links work.
 * Minca relays also hand out TURN passwords.
 *
 *   client → { type: 'drop', topic, blob, ttl? }       relay → { type: 'dropped', topic, id } | { type: 'refused', topic, reason }  (nothing for ttl 0)
 *   client → { type: 'fetch', topic, after?, watch? }  relay → { type: 'mail', topic, items: [{ seq?, id?, blob }], more }
 *   client → { type: 'unwatch', topic }
 *   client → { type: 'challenge' }                     relay → { type: 'challenge', nonce }
 *   client → { type: 'purge', topic, sign, ids?, sig } relay → { type: 'purged', topic, count } | { type: 'refused', topic, reason }
 *   client → { type: 'ice' }                           relay → { type: 'ice', payload: { servers, expiresAt } }
 *   client → { type: 'ping' }                          relay → { type: 'pong' }
 */
import { createEmitter } from '../utils/events.js';
import { isObject } from '../utils/guards.js';
import { converse, createRelaySocket, iceFrom } from './relay-socket.js';
import type { MailboxClient, MailboxOptions, MailItem, RelayLink, RelayLinkEvents } from './relays.js';

/** A socket to a Minca relay, watching the topics of the rooms this node is in */
export function createMincaLink(url: string): RelayLink {
  const topics = new Set<string>();
  const { on, off, emit } = createEmitter<RelayLinkEvents>();
  const socket = createRelaySocket({
    url,
    dial: url,
    opened: (send) => {
      for (const topic of topics) send({ type: 'fetch', topic, watch: true });
    },
    heard: (message) => {
      if (!isObject(message)) return;
      if (message.type === 'ice') {
        const offered = iceFrom(message.payload);
        if (offered) emit('ice', offered.servers, offered.expiresAt);
        return;
      }
      const { topic, items } = message;
      if (message.type !== 'mail' || typeof topic !== 'string' || !topics.has(topic) || !Array.isArray(items))
        return;
      for (const item of items)
        if (isObject(item) && typeof item.blob === 'string') emit('blob', topic, item.blob);
    },
    ping: { ask: { type: 'ping' }, isAnswer: (message) => isObject(message) && message.type === 'pong' },
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
      socket.send({ type: 'fetch', topic, watch: true });
      socket.count(topics.size);
    },
    unwatch: (topic: string) => {
      if (!topics.delete(topic)) return;
      socket.send({ type: 'unwatch', topic });
      socket.count(topics.size);
    },
    publish: (topic: string, blob: string) => socket.send({ type: 'drop', topic, blob, ttl: 0 }),
    requestIce: () => socket.send({ type: 'ice' }),
    isConnected: socket.isConnected,
    status: socket.status,
    on,
    off,
  });
}

/** At most this many pages per fetch: 16 blobs each, and an inbox holds 64 */
const MAX_PAGES = 8;

/** A Minca relay's mailbox: each call opens its own short-lived socket, so the relay can't tie it to a peer */
export function createMincaMailbox(options: MailboxOptions = {}): MailboxClient {
  const talk = {
    timeoutMs: options.timeoutMs ?? 8000,
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  };

  /** Sends one message, and resolves with the first answer `pick` accepts */
  const ask = <T>(
    relay: string,
    message: unknown,
    pick: (answer: Record<string, unknown>) => T | undefined,
  ) =>
    converse(
      relay,
      talk,
      (send) => send(message),
      (answer) => (isObject(answer) ? pick(answer) : undefined),
    );

  const client: MailboxClient = {
    drop(relay: string, topic: string, blob: string, ttlSeconds?: number) {
      return ask(
        relay,
        { type: 'drop', topic, blob, ...(ttlSeconds ? { ttl: ttlSeconds } : {}) },
        (answer) => {
          if (answer.topic !== topic) return undefined;
          if (answer.type === 'dropped' && typeof answer.id === 'string') return answer.id;
          if (answer.type === 'refused') throw new Error(`${relay} refused it: ${reasonOf(answer)}`);
          return undefined;
        },
      );
    },

    async fetch(relay: string, topic: string, after = 0, pages = MAX_PAGES) {
      const found: MailItem[] = [];
      let from = after;
      for (let page = 0; page < pages; page++) {
        const { items, more } = await ask(relay, { type: 'fetch', topic, after: from }, (answer) =>
          answer.type === 'mail' && answer.topic === topic && Array.isArray(answer.items)
            ? { items: answer.items.filter(isMailItem), more: answer.more === true }
            : undefined,
        );
        found.push(...items);
        if (!more || items.length === 0) break;
        from = Math.max(...items.map((item) => item.seq));
      }
      return found;
    },

    purge(relay, topic, sign, ids, signChallenge) {
      return converse(
        relay,
        talk,
        (send) => send({ type: 'challenge' }),
        async (answer, send) => {
          if (!isObject(answer)) return undefined;
          if (answer.type === 'challenge' && typeof answer.nonce === 'string') {
            const sig = await signChallenge(answer.nonce);
            send({ type: 'purge', topic, sign, sig, ...(ids ? { ids: [...ids] } : {}) });
            return undefined;
          }
          if (answer.topic !== topic) return undefined;
          if (answer.type === 'purged' && typeof answer.count === 'number') return answer.count;
          if (answer.type === 'refused')
            throw new Error(`${relay} refused to clear the inbox: ${reasonOf(answer)}`);
          return undefined;
        },
      );
    },
  };
  return Object.freeze(client);
}

function isMailItem(value: unknown): value is MailItem {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.seq) &&
    typeof value.id === 'string' &&
    typeof value.blob === 'string'
  );
}

function reasonOf(answer: Record<string, unknown>): string {
  return typeof answer.reason === 'string' ? answer.reason.slice(0, 200) : 'no reason given';
}
