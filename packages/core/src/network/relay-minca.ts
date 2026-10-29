/**
 * A Minca relay (`packages/relay/relay.mjs`; spec 04 §1.4, 07 §5): one
 * mailbox, spoken in JSON text frames. A blob dropped with `ttl: 0` goes to
 * whoever watches its topic and is kept by nobody, which is how peers meet; a
 * blob dropped with a ttl is kept, which is how inboxes and short links work.
 * Beyond that, an inbox's owner can purge it, and the relay may hand out TURN
 * passwords.
 *
 *   client → { type: 'drop', topic, blob, ttl? }       relay → { type: 'dropped', topic, id } | { type: 'refused', topic, reason }  (nothing for ttl 0)
 *   client → { type: 'fetch', topic, after?, watch? }  relay → { type: 'mail', topic, items: [{ seq?, id?, blob }], more }
 *   client → { type: 'unwatch', topic }
 *   client → { type: 'challenge' }                     relay → { type: 'challenge', nonce }
 *   client → { type: 'purge', topic, sign, ids?, sig } relay → { type: 'purged', topic, count } | { type: 'refused', topic, reason }
 *   client → { type: 'ice' }                           relay → { type: 'ice', payload: { servers, expiresAt } }
 *   client → { type: 'ping' }                          relay → { type: 'pong' }
 */
import { isObject } from '../utils/guards.js';
import { createTopicLink } from './relay-link.js';
import { converse, iceFrom } from './relay-socket.js';
import type { MailboxClient, MailboxOptions, MailItem, RelayLink } from './relays.js';

/** A socket to a Minca relay, watching the topics of the rooms this node is in */
export function createMincaLink(url: string): RelayLink {
  return createTopicLink(url, {
    dial: url,
    watch: (send, topic) => send({ type: 'fetch', topic, watch: true }),
    unwatch: (send, topic) => send({ type: 'unwatch', topic }),
    publish: (topic, blob) => ({ type: 'drop', topic, blob, ttl: 0 }),
    heard: (message, { emit, watching }) => {
      if (!isObject(message)) return;
      if (message.type === 'ice') {
        const offered = iceFrom(message.payload);
        if (offered) emit('ice', offered.servers, offered.expiresAt);
        return;
      }
      const { topic, items } = message;
      if (message.type !== 'mail' || typeof topic !== 'string' || !watching(topic) || !Array.isArray(items))
        return;
      for (const item of items)
        if (isObject(item) && typeof item.blob === 'string') emit('blob', topic, item.blob);
    },
    ping: { ask: { type: 'ping' }, isAnswer: (message) => isObject(message) && message.type === 'pong' },
    askIce: { type: 'ice' },
  });
}

/** At most this many pages per fetch: a topic holds 64 blobs, and a page at least four */
const MAX_PAGES = 16;

/** A Minca relay's mailbox: each call opens its own short-lived socket, so the relay can't tie it to a peer */
function createMincaMailbox(options: MailboxOptions = {}): MailboxClient {
  /** Sends one message, and resolves with the first answer `pick` accepts */
  const ask = <T>(
    relay: string,
    message: unknown,
    pick: (answer: Record<string, unknown>) => T | undefined,
  ) =>
    converse(
      relay,
      options,
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

    async fetch(relay: string, topic: string, after = 0) {
      const found: MailItem[] = [];
      let from = after;
      for (let page = 0; page < MAX_PAGES; page++) {
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
        options,
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

/** `wss://`, or `ws://` on this machine (spec 04 §1.4) */
export const mincaRelay = Object.freeze({
  schemes: Object.freeze(['wss', 'ws']),
  link: createMincaLink,
  mailbox: createMincaMailbox,
  can: Object.freeze({ purge: true, ice: true }),
});
