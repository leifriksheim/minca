/**
 * The relay: a mailbox that understands none of what it carries. Run on its
 * own by `signaling-server.mjs`, and inside every always-on node
 * (`packages/cli/src/serve.ts`), so both are the same relay. Blobs dropped
 * under a topic with `ttl: 0` go to whoever watches it and are kept by
 * nobody, which is how peers meet; blobs dropped with a ttl are kept for
 * inboxes and short links. Specified in spec/04-network.md §1.
 *
 * It is public, so it assumes nobody is polite: every socket gets a size cap,
 * a message budget and a heartbeat, and each IP, topic and the process as a
 * whole a ceiling. Framing is the `ws` server the caller brings: this file has
 * no dependencies.
 */

import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';

// Limits. A peer's message is a sealed offer at most (a few KB), so these are
// generous for real peers and tight for anyone trying to fill a 256 MB VM.
/** Give the `ws` server this as its `maxPayload` */
export const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 5_000;
const MAX_CONNECTIONS_PER_IP = 32;
/** Topics watched at once, across every socket */
const MAX_WATCHED_TOPICS = 10_000;
/** Sockets watching one topic: a room's peers */
const MAX_WATCHERS_PER_TOPIC = 64;
/** Topics one socket watches: one per room it is in */
const MAX_WATCHES_PER_SOCKET = 256;
/** Token bucket per socket: refills this many messages a second, up to the burst. */
const RATE_PER_SECOND = 50;
const RATE_BURST = 100;
/** A peer that misses a ping for this long is gone; its watches are freed. */
const HEARTBEAT_MS = 15_000;
/** A peer that cannot keep up with what it is sent is dropped, not buffered for. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Addresses holding a TURN password at once; past this, new ones get none until old ones expire. */
const MAX_TURN_ADDRESSES = 20_000;

// Mailbox limits. A knock is an invite and a short note, sealed: a few KB.
const MAX_BLOB_LENGTH = 12_000;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MAIL_PER_TOPIC = 64;
const RESERVED_PER_TOPIC = 2;
const DROP_WINDOW_MS = 3600_000;
/** The mailbox's limits; a relay's operator may tighten or loosen them (`createRelay({ mailbox })`). */
export const MAILBOX_LIMITS = Object.freeze({
  /** Topics held at once */
  maxTopics: 50_000,
  /** Everything held at once, in blob characters */
  maxChars: 64 * 1024 * 1024,
  /**
   * Past `maxChars`, a reserve only topics holding fewer than two knocks may
   * use: a mailbox someone filled still takes a knock or two on every inbox.
   */
  reserveChars: 8 * 1024 * 1024,
  /** How long a knock is kept. A client may ask for less, never more. */
  ttlSeconds: 14 * 24 * 3600,
  /** Drops one address may make into one topic per hour: filling an inbox takes many addresses */
  dropsPerNetworkPerTopic: 4,
  /** Drops one address may make in all, per hour: filling the mailbox takes very many */
  dropsPerNetwork: 30,
});
const PURGE_SPKI_PREFIX = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
/** One `mail` message stays well under what a client will take in one frame */
const MAX_PAGE_ITEMS = 16;
const MAX_PAGE_CHARS = 48 * 1024;

/**
 * TURN settings from the environment, or undefined when there are none.
 * @param {Record<string, string | undefined>} env
 * @returns {{ secret: string, urls: string[], ttlSeconds: number } | undefined}
 */
export function turnFromEnv(env) {
  const secret = env.TURN_SECRET ?? '';
  const urls = (env.TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (!secret || urls.length === 0) return undefined;
  return { secret, urls, ttlSeconds: Number(env.TURN_TTL_SECONDS ?? 4 * 3600) };
}

/**
 * A relay. Hand it upgrade requests: it refuses what it must before a socket
 * is opened, and otherwise opens one with the `ws` server given.
 *
 * @param {{
 *   turn?: { secret: string, urls: string[], ttlSeconds: number },
 *   mailbox?: Partial<typeof MAILBOX_LIMITS>,
 *   mailboxFrom?: (topic: string) => ReadonlyArray<string>,
 * }} [options]
 */
export function createRelay(options = {}) {
  const { turn } = options;
  const limits = { ...MAILBOX_LIMITS, ...options.mailbox };

  /** Every open socket */
  const clients = new Set();
  /** ip -> number of open sockets */
  const perIp = new Map();
  /** network -> the TURN password its sockets share: { username, credential, expires } */
  const turnByNetwork = new Map();
  /** topic -> its blobs, oldest first: [{ seq, id, expires, blob }] */
  const mailbox = new Map();
  /** topic -> sockets watching it */
  const watchers = new Map();
  /** `network|topic`, and `network` alone -> { count, since }: drops in the current hour */
  const dropsBy = new Map();
  let mailChars = 0;
  let mailSeq = 0;

  /** What each message type does; the mailbox's take a topic */
  const handlers = new Map([
    // A browser can't see WebSocket pings, so a client asks in a message whether its socket still reaches us.
    ['ping', (client) => send(client, '{"type":"pong"}')],
    // TURN is for peers meeting here: sockets that watch a topic.
    ['ice', (client) => client.watching.size > 0 && offerTurn(client)],
    ['challenge', challenge],
    ['fetch', withTopic(fetchMail)],
    ['drop', withTopic(dropMail)],
    ['unwatch', withTopic((client, { topic }) => unwatch(client, topic))],
    ['purge', withTopic(purge)],
  ]);

  /** Admits one socket. It never says who it is. */
  function accept(ws, ip) {
    const client = {
      ws,
      ip,
      watching: new Set(),
      nonce: null,
      alive: true,
      tokens: RATE_BURST,
      refilled: Date.now(),
    };
    clients.add(client);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      if (!withinBudget(client)) return ws.terminate(); // a flood gets no goodbye
      if (!isBinary) handleMessage(client, data.toString('utf8'));
    });
    // `ws` closes the socket itself on an oversized or malformed frame; both paths end here.
    ws.once('close', () => forget(client));
    ws.on('error', () => ws.terminate());
  }

  function forget(client) {
    clients.delete(client);
    const left = (perIp.get(client.ip) ?? 1) - 1;
    if (left > 0) perIp.set(client.ip, left);
    else perIp.delete(client.ip);
    for (const topic of [...client.watching]) unwatch(client, topic);
  }

  function handleMessage(client, raw) {
    const message = parseJson(raw);
    if (typeof message?.type !== 'string') return;
    handlers.get(message.type)?.(client, message);
  }

  function challenge(client) {
    client.nonce = randomBytes(18).toString('base64url');
    reply(client, { type: 'challenge', nonce: client.nonce });
  }

  /**
   * Reads a topic's kept blobs after a sequence number, a page at a time; with
   * `watch`, hears of new ones as they come.
   */
  function fetchMail(client, message) {
    const { topic } = message;
    const after = Number.isSafeInteger(message.after) ? message.after : 0;
    if (message.watch === true) watch(client, topic);
    // What a host keeps under the topic for its accounts comes first, on the first page, as sequence 0.
    const hosted = after === 0 ? (options.mailboxFrom?.(topic) ?? []) : [];
    const items = hosted.map((blob) => ({ seq: 0, id: hashOf(blob), blob }));
    let chars = sumChars(items);
    let more = false;
    const now = Date.now();
    for (const item of mailbox.get(topic) ?? []) {
      if (item.seq <= after || item.expires <= now) continue;
      if (items.length >= MAX_PAGE_ITEMS || chars + item.blob.length > MAX_PAGE_CHARS) {
        more = true;
        break;
      }
      items.push(mailItem(item));
      chars += item.blob.length;
    }
    reply(client, { type: 'mail', topic, items, more });
  }

  /**
   * Leaves a sealed blob under a topic: kept for its ttl, or with `ttl: 0`
   * only handed to whoever watches the topic now.
   */
  function dropMail(client, { topic, blob, ttl }) {
    const refuse = (reason) => reply(client, { type: 'refused', topic, reason });
    if (!isBlob(blob)) return refuse('A blob is base64url, at most 12000 characters');
    // Only from a socket watching the topic, so a sender takes one of its 64 places.
    if (ttl === 0) return client.watching.has(topic) && tellWatchers(client, topic, [{ blob }]);

    const id = hashOf(blob);
    const held = mailbox.get(topic) ?? [];
    const now = Date.now();
    // The same knock twice is one knock, so a retry costs nothing. An expired copy is not held.
    if (held.some((item) => item.id === id && item.expires > now))
      return reply(client, { type: 'dropped', topic, id });
    const refusal = dropRefusal(client, topic, blob, held, now);
    if (refusal) return refuse(refusal);

    const item = { seq: ++mailSeq, id, expires: now + keptFor(ttl) * 1000, blob };
    mailbox.set(topic, [...held, item]);
    mailChars += blob.length;
    const network = networkOf(client.ip);
    counted(`${network}|${topic}`, now);
    counted(network, now);
    reply(client, { type: 'dropped', topic, id });
    tellWatchers(client, topic, [mailItem(item)]);
  }

  /** Why a drop can't be kept, if it can't */
  function dropRefusal(client, topic, blob, held, now) {
    const network = networkOf(client.ip);
    if (countOf(`${network}|${topic}`, now) >= limits.dropsPerNetworkPerTopic)
      return 'Too many knocks on this inbox from here; try later';
    if (countOf(network, now) >= limits.dropsPerNetwork) return 'Too many knocks from here; try later';
    if (held.length >= MAX_MAIL_PER_TOPIC) return 'This inbox is full';
    if (!mailbox.has(topic) && mailbox.size >= limits.maxTopics) return 'The mailbox is full';
    // A reserve past `maxChars` keeps a knock or two open on every inbox.
    const room = held.length < RESERVED_PER_TOPIC ? limits.maxChars + limits.reserveChars : limits.maxChars;
    if (mailChars + blob.length > room) return 'The mailbox is full';
    return null;
  }

  /** A client may ask to keep a blob for less than the limit, never more */
  function keptFor(ttl) {
    return Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, limits.ttlSeconds) : limits.ttlSeconds;
  }

  function tellWatchers(sender, topic, items) {
    const news = JSON.stringify({ type: 'mail', topic, items, more: false });
    for (const watcher of watchers.get(topic) ?? []) if (watcher !== sender) send(watcher, news);
  }

  /** Drops counted under a key in the current hour */
  function countOf(key, now) {
    const recent = dropsBy.get(key);
    return recent && now - recent.since < DROP_WINDOW_MS ? recent.count : 0;
  }

  function counted(key, now) {
    const recent = dropsBy.get(key);
    if (recent && now - recent.since < DROP_WINDOW_MS) recent.count += 1;
    else dropsBy.set(key, { count: 1, since: now });
  }

  /**
   * Clears a topic's knocks, all or some, for whoever proves they own the
   * inbox: the signing key they show hashes to the topic, and they signed this
   * socket's challenge with it. The challenge is used up either way.
   */
  function purge(client, message) {
    const { topic, sign, sig } = message;
    const ids = message.ids ?? null;
    const refuse = (reason) => reply(client, { type: 'refused', topic, reason });
    const nonce = client.nonce;
    client.nonce = null;
    if (!nonce) return refuse('Ask for a challenge first');
    if (!isPurge(sign, sig, ids)) return refuse('Not a purge');
    if (hashOf(`minca/inbox-topic/v1|${sign}`) !== topic) return refuse('That key is not this inbox’s');
    const signed = `minca/inbox-purge/v1|${topic}|${nonce}|${ids ? [...ids].sort().join(',') : '*'}`;
    if (!verifiesP256(sign, signed, sig)) return refuse('The signature does not check out');

    const held = mailbox.get(topic) ?? [];
    const goes = (item) => ids === null || ids.includes(item.id);
    const gone = held.filter(goes);
    const kept = held.filter((item) => !goes(item));
    mailChars -= sumChars(gone);
    if (kept.length === 0) mailbox.delete(topic);
    else mailbox.set(topic, kept);
    reply(client, { type: 'purged', topic, count: gone.length });
  }

  /** Hears of what is dropped under a topic from now on; the first watch also offers TURN */
  function watch(client, topic) {
    if (client.watching.has(topic) || client.watching.size >= MAX_WATCHES_PER_SOCKET) return;
    const watching = watchers.get(topic);
    if (watching ? watching.size >= MAX_WATCHERS_PER_TOPIC : watchers.size >= MAX_WATCHED_TOPICS) return;
    const first = client.watching.size === 0;
    client.watching.add(topic);
    if (watching) watching.add(client);
    else watchers.set(topic, new Set([client]));
    if (first) offerTurn(client);
  }

  function unwatch(client, topic) {
    client.watching.delete(topic);
    const watching = watchers.get(topic);
    watching?.delete(client);
    if (watching?.size === 0) watchers.delete(topic);
  }

  /** Lets go of knocks past their time, of drop counts past their hour, and of expired TURN passwords */
  function sweep() {
    const now = Date.now();
    for (const [topic, held] of mailbox) {
      const kept = held.filter((item) => item.expires > now);
      mailChars -= sumChars(held) - sumChars(kept);
      if (kept.length === 0) mailbox.delete(topic);
      else if (kept.length !== held.length) mailbox.set(topic, kept);
    }
    for (const [key, recent] of dropsBy) if (now - recent.since >= DROP_WINDOW_MS) dropsBy.delete(key);
    for (const [network, held] of turnByNetwork)
      if (held.expires <= now / 1000) turnByNetwork.delete(network);
  }

  /**
   * Sends a socket TURN servers, with the password its address already holds
   * while that has more than half its time left, and a new one otherwise.
   */
  function offerTurn(client) {
    if (!turn) return;
    const network = networkOf(client.ip);
    const now = Math.floor(Date.now() / 1000);
    let held = turnByNetwork.get(network);
    if (!held || held.expires - now < turn.ttlSeconds / 2) {
      if (!held && turnByNetwork.size >= MAX_TURN_ADDRESSES) return;
      held = turnPassword(turn, now + turn.ttlSeconds);
      turnByNetwork.set(network, held);
    }
    const { username, credential, expires } = held;
    const servers = [{ urls: turn.urls, username, credential }];
    reply(client, { type: 'ice', payload: { servers, expiresAt: expires * 1000 } });
  }

  const reply = (client, message) => send(client, JSON.stringify(message));

  function send(peer, text) {
    if (peer.ws.readyState !== peer.ws.OPEN) return;
    if (peer.ws.bufferedAmount > MAX_BUFFERED_BYTES) return peer.ws.terminate();
    peer.ws.send(text);
  }

  /** Spends one token from the socket's bucket; false once it is empty. */
  function withinBudget(client) {
    const now = Date.now();
    client.tokens = Math.min(RATE_BURST, client.tokens + ((now - client.refilled) / 1000) * RATE_PER_SECOND);
    client.refilled = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  /** The refusal for a new socket from this address, if any */
  function refusalFor(ip) {
    if (clients.size >= MAX_CONNECTIONS) return '503 Relay full';
    if ((perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) return '429 Too many connections';
    return null;
  }

  // Ping everyone, and drop whoever did not answer the last ping: this also
  // frees watches held by sockets that died without a close.
  const heartbeat = setInterval(() => {
    sweep();
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /**
     * Takes an HTTP upgrade request. Everything that can be refused is refused
     * here, before a socket is opened.
     *
     * @param {import('ws').WebSocketServer} wss A `ws` server made with `noServer: true` and `maxPayload: MAX_MESSAGE_BYTES`
     */
    upgrade(wss, req, socket, head) {
      socket.on('error', () => socket.destroy());
      const ip = clientIp(req);
      const refusal = refusalFor(ip);
      if (refusal) {
        socket.end(`HTTP/1.1 ${refusal}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ip));
    },

    /** Drops every socket and stops the heartbeat */
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.terminate();
    },
  };
}

/** Wraps a mailbox handler so it only sees messages naming a well-formed topic */
function withTopic(handler) {
  return (client, message) => {
    if (typeof message.topic === 'string' && TOPIC_PATTERN.test(message.topic)) handler(client, message);
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const hashOf = (text) => createHash('sha256').update(text).digest('base64url');
const sumChars = (items) => items.reduce((sum, item) => sum + item.blob.length, 0);
const mailItem = ({ seq, id, blob }) => ({ seq, id, blob });

function isBlob(blob) {
  return (
    typeof blob === 'string' &&
    blob.length > 0 &&
    blob.length <= MAX_BLOB_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(blob)
  );
}

/** A purge's shape: a compressed P-256 key, a signature, and all ids or a list of some */
function isPurge(sign, sig, ids) {
  const isId = (id) => typeof id === 'string' && id.length <= 64;
  const idsOk = ids === null || (Array.isArray(ids) && ids.length <= MAX_MAIL_PER_TOPIC && ids.every(isId));
  return (
    typeof sign === 'string' &&
    /^[A-Za-z0-9_-]{44}$/.test(sign) &&
    typeof sig === 'string' &&
    sig.length <= 200 &&
    idsOk
  );
}

/** Whether `sig` is a P-256 signature of `text` by the compressed key `sign` (both base64url) */
function verifiesP256(sign, text, sig) {
  try {
    const der = Buffer.concat([PURGE_SPKI_PREFIX, Buffer.from(sign, 'base64url')]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return verify(
      'sha256',
      Buffer.from(text),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** A coturn REST password: coturn reads the part before the colon as the expiry; the rest names the holder, not who they are. */
function turnPassword(turn, expires) {
  const username = `${expires}:${randomBytes(9).toString('base64url')}`;
  const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
  return { username, credential, expires };
}

/**
 * Behind Fly's proxy every socket comes from the proxy, and Fly names the real
 * client in a header. Anywhere else that header is whatever the client says,
 * so it is only believed on Fly.
 */
function clientIp(req) {
  const forwarded = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : undefined;
  return (typeof forwarded === 'string' && forwarded) || req.socket.remoteAddress || 'unknown';
}

/**
 * What one household or phone holds: an IPv4 address, or an IPv6 /64, since
 * one IPv6 connection is usually handed a whole /64 to pick addresses from.
 */
function networkOf(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
