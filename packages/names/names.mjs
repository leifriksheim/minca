/**
 * A name service: the usernames of one domain, `leif@minca.social`, each
 * leading to an inbox code. How a name is looked up is protocol (spec 07 §9);
 * how one is claimed here is this service's own
 * (packages/core/docs/usernames.md).
 *
 *   GET  /.well-known/minca.json?name=leif  → { names: { leif: <code> }, claim, work }
 *   POST /.well-known/minca.json  { name, key, at, work, code?, bind?, sig }  → { until } | { error }
 *
 * A claim is signed by the name key over the name, its time and its code, and
 * carries a little proof of work; and the inbox's own signing key signs the
 * name, so nobody points a name at someone else's inbox. The first key to claim a name holds it for a
 * year, renewed by claiming again; with no code it gives the name up.
 *
 * It is public, so it assumes nobody is polite: a claim is small, each name is
 * a file of its own (no store grows in memory, nothing large is rewritten),
 * and each address claims only a few new names a day. This file has no
 * dependencies.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a domain answers for its names */
export const NAMES_PATH = '/.well-known/minca.json';

/** The service's limits; an operator may change them (`createNames({ limits })`) */
export const NAMES_LIMITS = Object.freeze({
  /**
   * Names held at once, given up ones for a few minutes included. Each is a
   * file of up to 8 KB on disk, so a 1 GB volume holds this many with room,
   * inodes included.
   */
  maxNames: 50_000,
  /** New names one address may claim a day: claiming many takes many addresses */
  newNamesPerNetwork: 3,
  /** Leading zero bits a claim's work must reach, said in every answer: about a second on a phone */
  workBits: 18,
  /** How long a claim holds a name */
  lifetimeMs: 365 * 24 * 3600_000,
  /** How far a claim's time may be from ours */
  clockSkewMs: 10 * 60_000,
});

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{44}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
/** An inbox code with three places and a long name is under 3,000 characters */
const MAX_CODE_LENGTH = 4096;
const MAX_BODY_BYTES = 8192;
const DAY_MS = 24 * 3600_000;
/** Names nobody may claim, so nobody passes for whoever runs the service */
const RESERVED_NAMES = new Set([
  'abuse',
  'admin',
  'administrator',
  'help',
  'hostmaster',
  'minca',
  'postmaster',
  'root',
  'security',
  'support',
  'webmaster',
]);
const P256_SPKI_PREFIX = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');

/**
 * Name settings from the environment: `NAMES_DOMAIN` it answers for,
 * `NAMES_CLAIM_URL` where claims go, `NAMES_DIR` where names are kept, and
 * `NAMES_NEW_PER_DAY` to change how many new names an address may claim a day
 * (a development service, where every tester is one address).
 * @param {Record<string, string | undefined>} env
 */
export function namesFromEnv(env) {
  const domain = env.NAMES_DOMAIN?.trim().toLowerCase() ?? '';
  const claim = env.NAMES_CLAIM_URL?.trim() ?? '';
  const dir = env.NAMES_DIR?.trim() ?? '';
  if (!domain || !claim || !dir) throw new Error('Set NAMES_DOMAIN, NAMES_CLAIM_URL and NAMES_DIR');
  const perDay = Number(env.NAMES_NEW_PER_DAY);
  return { domain, claim, dir, ...(perDay > 0 ? { limits: { newNamesPerNetwork: perDay } } : {}) };
}

/**
 * A name service.
 * @param {{ domain: string, claim: string, dir: string, limits?: Partial<typeof NAMES_LIMITS> }} options
 */
export function createNames({ domain, claim, dir, limits: given }) {
  const limits = { ...NAMES_LIMITS, ...given };
  mkdirSync(dir, { recursive: true });
  /** network -> { count, since }: new names claimed in the current day */
  const claimsBy = new Map();

  const pathOf = (name) => join(dir, `${name}.json`);

  function read(name) {
    try {
      return JSON.parse(readFileSync(pathOf(name), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Writes through a file beside it, so a crash leaves the old one or the new one */
  function write(name, entry) {
    writeFileSync(`${pathOf(name)}.tmp`, JSON.stringify(entry));
    renameSync(`${pathOf(name)}.tmp`, pathOf(name));
  }

  /** Deletes the names whose time is up, and counts the rest */
  function sweep() {
    const now = Date.now();
    let count = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      const entry = read(name);
      if (entry && entry.until > now) count += 1;
      else unlinkSync(pathOf(name));
    }
    for (const [network, recent] of claimsBy) if (now - recent.since >= DAY_MS) claimsBy.delete(network);
    return count;
  }

  function spendClaim(network, now) {
    const recent = claimsBy.get(network);
    if (!recent || now - recent.since >= DAY_MS) {
      claimsBy.set(network, { count: 1, since: now });
      return true;
    }
    if (recent.count >= limits.newNamesPerNetwork) return false;
    recent.count += 1;
    return true;
  }

  /**
   * Takes a name, points it at a new code, renews it, or (with no code) gives
   * it up, for whoever signs with the key that holds it, or with any key when
   * nobody does. A name given up stays with its key for as long as a claim's
   * time may be off, so no earlier claim can be replayed to take it back.
   * @returns {{ status: number, body: object }}
   */
  function claimName(message, network, now) {
    const refuse = (status, error) => ({ status, body: { error } });
    if (!isClaim(message)) return refuse(400, 'Not a claim');
    const { name, key, at, work, code, sig } = message;
    if (Math.abs(now - at) > limits.clockSkewMs) return refuse(400, 'The claim’s time is too far from ours');
    const username = `${name}@${domain}`;
    if (!hasZeroBits(hashOf(`minca/name-work/v1|${username}|${key}|${at}|${work}`), limits.workBits))
      return refuse(400, 'Not enough work');
    if (!verifiesP256(key, `minca/name-claim/v1|${username}|${at}|${code ?? ''}`, sig))
      return refuse(400, 'The signature does not check out');
    if (
      code !== undefined &&
      !verifiesP256(inboxSignOf(code), `minca/name-bind/v1|${username}`, message.bind)
    )
      return refuse(400, 'That inbox did not choose this name');

    const entry = read(name);
    const live = entry !== null && entry.until > now;
    if (live && entry.key !== key) return refuse(409, 'That name is taken');
    // Even once lapsed or given up: a key's earlier claim is never taken again.
    if (entry?.key === key && at <= entry.at) return refuse(409, 'A newer claim is already held');
    if (!live) {
      if (code === undefined) return refuse(404, 'That name is not held');
      if (RESERVED_NAMES.has(name)) return refuse(409, 'That name is taken');
      if (!entry && held >= limits.maxNames) return refuse(507, 'No more names here');
      if (!spendClaim(network, now)) return refuse(429, 'Too many new names from this address today');
      if (!entry) held += 1;
    }
    const until = code === undefined ? now + limits.clockSkewMs : now + limits.lifetimeMs;
    write(name, { key, at, until, ...(code === undefined ? {} : { code }) });
    return { status: 200, body: { until: code === undefined ? 0 : until } };
  }

  /** The name's code, while it is held and not given up */
  function codeOf(name, now) {
    if (!NAME_PATTERN.test(name)) return null;
    const entry = read(name);
    return entry && entry.until > now && typeof entry.code === 'string' ? entry.code : null;
  }

  /** Names held, as of the last sweep and the claims since */
  let held = sweep();
  const daily = setInterval(() => (held = sweep()), DAY_MS);
  daily.unref();

  return {
    /**
     * Answers `/.well-known/minca.json`: lookups from anyone, from any page,
     * and claims.
     * @returns {boolean} false for any other path, which the caller answers
     */
    handle(req, res) {
      // Only the path and the one query parameter are read, by hand: a request
      // target `new URL` can't parse must not throw.
      const [path = '', query = ''] = (req.url ?? '').split('?', 2);
      if (path !== NAMES_PATH) return false;
      const send = (status, body) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'content-type',
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      // Whatever goes wrong answers this request, and never stops the service.
      const failed = () => send(500, { error: 'Something went wrong here' });
      try {
        if (req.method === 'OPTIONS') send(204);
        else if (req.method === 'GET') {
          const name = new URLSearchParams(query).get('name') ?? '';
          const code = codeOf(name, Date.now());
          send(code ? 200 : 404, { names: code ? { [name]: code } : {}, claim, work: limits.workBits });
        } else if (req.method === 'POST')
          readBody(req)
            .then((text) => {
              const message = text === null ? null : parseJson(text);
              const { status, body } = claimName(message, networkOf(clientIp(req)), Date.now());
              send(status, body);
            })
            .catch(failed);
        else send(405, { error: 'GET or POST' });
      } catch {
        failed();
      }
      return true;
    },

    close() {
      clearInterval(daily);
    },
  };
}

/** A request's body as text, or null when it is larger than a claim can be */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** A claim's shape: a name, a compressed P-256 key, a time, a work counter, a code or none, and a signature */
function isClaim(message) {
  if (message === null || typeof message !== 'object') return false;
  const { name, key, at, work, code, sig } = message;
  return (
    typeof name === 'string' &&
    NAME_PATTERN.test(name) &&
    typeof key === 'string' &&
    KEY_PATTERN.test(key) &&
    Number.isSafeInteger(at) &&
    Number.isSafeInteger(work) &&
    work >= 0 &&
    (code === undefined ||
      (typeof code === 'string' &&
        code.length <= MAX_CODE_LENGTH &&
        CODE_PATTERN.test(code) &&
        typeof message.bind === 'string' &&
        message.bind.length <= 200)) &&
    typeof sig === 'string' &&
    sig.length <= 200
  );
}

/** The inbox signing key a code names, or '' when it names none */
function inboxSignOf(code) {
  const sign = parseJson(Buffer.from(code, 'base64url').toString('utf8'))?.body?.sign;
  return typeof sign === 'string' && KEY_PATTERN.test(sign) ? sign : '';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const hashOf = (text) => createHash('sha256').update(text).digest();

function hasZeroBits(hash, bits) {
  for (let i = 0; i < bits; i++) if ((hash[i >> 3] >> (7 - (i & 7))) & 1) return false;
  return true;
}

/** Whether `sig` is a P-256 signature of `text` by the compressed key `key` (both base64url) */
function verifiesP256(key, text, sig) {
  try {
    const der = Buffer.concat([P256_SPKI_PREFIX, Buffer.from(key, 'base64url')]);
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return verify(
      'sha256',
      Buffer.from(text),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

/**
 * Behind Fly's proxy every request comes from the proxy, and Fly names the
 * real client in a header. Anywhere else that header is whatever the client
 * says, so it is only believed on Fly.
 */
function clientIp(req) {
  const forwarded = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : undefined;
  return (typeof forwarded === 'string' && forwarded) || req.socket.remoteAddress || 'unknown';
}

/**
 * What one household or one customer holds: an IPv4 address, or an IPv6 /48,
 * the most a provider usually hands one customer.
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
    .slice(0, 3)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/48`;
}
