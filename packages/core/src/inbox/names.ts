/**
 * Usernames: `leif@minca.social`, a name at a domain that leads to an inbox
 * code (spec 07 §9). The domain answers with the code; the code is signed by
 * the inbox's own key, so the domain can hand out another inbox but can't
 * change where this one's knocks go. A name never leads to the account's DID.
 *
 * ```
 * lookup = GET https://<domain>/.well-known/minca.json?name=<name>
 *        → { names: { <name>: <inbox code> }, claim?: <URL>, work?: <bits> }
 * ```
 *
 * How a name is claimed is the domain's business. `claimUsername` speaks the
 * name service in `packages/names`, which minca.social runs
 * (`packages/core/docs/usernames.md`).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { CryptoProvider } from '../types.js';
import {
  contactPublicKey,
  deriveInboxSignKeyBytes,
  deriveNameKeyBytes,
  signWithScalar,
} from '../identity/contact-key.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { isObject } from '../utils/guards.js';
import { utf8Encode } from '../utils/encoding.js';
import { readInbox, type InboxBody } from './inbox.js';

/** A name at a domain, both in lower case */
export interface Username {
  readonly name: string;
  readonly domain: string;
}

const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** The last label of a hostname has a letter: `10.0.0.1` is an address, not a domain */
const TOP = `(?=[a-z0-9-]*[a-z])${LABEL}`;
/** A hostname with at least one dot, or `localhost` with a port, for trying it out */
const DOMAIN = new RegExp(`^(?:(?:${LABEL}\\.)+${TOP}|localhost(?::\\d{1,5})?)$`);
const LOCAL = /^localhost(?::\d{1,5})?$/;
/** Where a domain answers for its names */
const WELL_KNOWN = '/.well-known/minca.json';
/** An answer larger than this is refused (spec 07 §9): a few hundred inbox codes */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** How long a domain has to answer */
const LOOKUP_TIMEOUT_MS = 10_000;

/** A username from what someone typed, `leif@minca.social` or `@leif@minca.social`, or null */
export function parseUsername(text: string): Username | null {
  const found = /^@?([^@\s]+)@([^@\s]+)$/.exec(text.trim().toLowerCase());
  if (!found) return null;
  const [, name = '', domain = ''] = found;
  return NAME.test(name) && DOMAIN.test(domain) && domain.length <= 253
    ? Object.freeze({ name, domain })
    : null;
}

export const formatUsername = ({ name, domain }: Username): string => `${name}@${domain}`;

/** The URL a domain answers a name at: https, or http on this machine */
export function usernameUrl({ name, domain }: Username): string {
  const scheme = LOCAL.test(domain) ? 'http' : 'https';
  return `${scheme}://${domain}${WELL_KNOWN}?name=${encodeURIComponent(name)}`;
}

/** What a username leads to: the inbox code as the domain gave it, checked */
export interface ResolvedUsername {
  readonly code: string;
  readonly inbox: InboxBody;
}

/**
 * Asks a username's domain for its inbox code, and checks the code as any
 * other (spec 07 §3). The domain must answer itself: a redirect is refused.
 * @throws When the name isn't one, the domain doesn't know it, or its code doesn't check out
 */
export async function resolveUsername(
  text: string,
  provider: CryptoProvider,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ResolvedUsername> {
  const username = parseUsername(text);
  if (!username) throw new Error('That is not a username, like leif@minca.social');
  const json = await lookUp(username, fetcher);
  const names = isObject(json) ? json.names : null;
  const code = isObject(names) ? names[username.name] : null;
  if (typeof code !== 'string')
    throw new Error(`${username.domain} doesn't know ${formatUsername(username)}`);
  return Object.freeze({ code, inbox: await readInbox(code, provider) });
}

/**
 * Whether a username can be claimed, as its domain answers: nobody holds it,
 * and the service doesn't keep it back (`reserved`). Null when it couldn't say
 * (down, slow, or not a name service), so a caller never takes an outage for a
 * free name.
 */
export async function usernameFree(
  text: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<boolean | null> {
  const username = parseUsername(text);
  if (!username) return null;
  // A name nobody has is answered 404, with the service's answer all the same.
  const json = await lookUp(username, fetcher, true);
  if (!isObject(json) || !isObject(json.names)) return null;
  // A name nobody holds may still be one the service keeps back.
  return typeof json.names[username.name] !== 'string' && json.reserved !== true;
}

/**
 * The domain's answer for a name, or null when it gave none worth reading: no
 * 2xx, a redirect, too slow, or too large. A 404 is read too, for where claims go.
 */
async function lookUp(username: Username, fetcher: typeof fetch, take404 = false): Promise<unknown> {
  const answer = await fetcher(usernameUrl(username), {
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!answer || !(answer.ok || (take404 && answer.status === 404))) return null;
  const body = await readCapped(answer, MAX_ANSWER_BYTES).catch(() => null);
  return body === null ? null : parseJson(body);
}

/** A response's body as text, or null once it passes `max` bytes */
async function readCapped(answer: Response, max: number): Promise<string | null> {
  if (!answer.body) return '';
  const reader = answer.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Claiming, on a Minca name service (a convention, not protocol) ──

/** The most work a claim will do: 2^24 hashes, several seconds on a phone */
const MAX_WORK_BITS = 24;

/** What an inbox's signing key signs, so a name leads only to an inbox whose owner chose it */
export const bindMessage = (username: Username) =>
  utf8Encode(`minca/name-bind/v1|${formatUsername(username)}`);

/** What a name key signs to claim a username, give it a new code, or (with no code) give it up */
export const claimMessage = (username: Username, at: number, code: string | null) =>
  utf8Encode(`minca/name-claim/v1|${formatUsername(username)}|${at}|${code ?? ''}`);

/** The hash a claim's work is judged by */
const workHash = (username: Username, key: string, at: number, work: number) =>
  sha256(utf8Encode(`minca/name-work/v1|${formatUsername(username)}|${key}|${at}|${work}`));

/** Whether a hash starts with this many zero bits */
function hasZeroBits(hash: Uint8Array, bits: number): boolean {
  for (let i = 0; i < bits; i++) if ((hash[i >> 3]! >> (7 - (i & 7))) & 1) return false;
  return true;
}

/** Finds a work counter for a claim, yielding now and then so a page stays responsive */
async function doWork(username: Username, key: string, at: number, bits: number): Promise<number> {
  for (let work = 0; ; work++) {
    if (hasZeroBits(workHash(username, key, at, work), bits)) return work;
    if (work % 20_000 === 19_999) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Claims a username on its domain's name service, pointing it at an inbox
 * code, or gives it up with `code` null. Claiming again renews it. Only the
 * name key that holds a name can change it; it is derived here, from the
 * name as parsed, so every device and every spelling signs with the same one.
 * @param contactKey The contact key's private scalar
 * @returns When the name lapses unless claimed again, ms
 * @throws When the domain names no name service, or the service refuses
 */
export async function claimUsername(
  text: string,
  contactKey: Uint8Array,
  code: string | null,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<number> {
  const username = parseUsername(text);
  if (!username) throw new Error('That is not a username, like leif@minca.social');
  if (code === '') throw new Error('An empty code is no inbox: give the name up with null');
  const shown = formatUsername(username);
  const nameKey = await deriveNameKeyBytes(contactKey, shown);
  const bind = code === null ? null : await bindTo(username, contactKey, code);
  const found = await lookUp(username, fetcher, true);
  const service = isObject(found) && typeof found.claim === 'string' ? found.claim : null;
  const bits = isObject(found) ? found.work : null;
  if (!service || typeof bits !== 'number' || !Number.isInteger(bits) || bits < 0 || bits > MAX_WORK_BITS)
    throw new Error(`${username.domain} takes no claims for ${shown}`);

  const key = contactPublicKey(nameKey);
  const at = Date.now();
  const work = await doWork(username, key, at, bits);
  const sig = await signWithScalar(nameKey, claimMessage(username, at, code));
  const answer = await fetcher(service, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    body: JSON.stringify({
      name: username.name,
      key,
      at,
      work,
      sig,
      ...(code && bind ? { code, bind } : {}),
    }),
  });
  const reply = await readCapped(answer, MAX_ANSWER_BYTES).catch(() => null);
  const json = reply === null ? null : parseJson(reply);
  if (answer.ok && isObject(json) && typeof json.until === 'number') return json.until;
  const reason = isObject(json) && typeof json.error === 'string' ? json.error.slice(0, 200) : answer.status;
  throw new Error(`${username.domain} refused ${shown}: ${reason}`);
}

/**
 * The inbox's own signature over the username: the code must be this
 * account's, from the same contact key, so nobody names someone else's inbox.
 */
async function bindTo(username: Username, contactKey: Uint8Array, code: string): Promise<string> {
  const inbox = await readInbox(code, createP256Provider());
  const signKey = await deriveInboxSignKeyBytes(contactKey, inbox.gen);
  if (contactPublicKey(signKey) !== inbox.sign) throw new Error('That inbox code is not this account’s');
  return signWithScalar(signKey, bindMessage(username));
}

/** Letters NFKD leaves whole, as they are usually written in ASCII */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  æ: 'ae',
  ø: 'o',
  ß: 'ss',
  đ: 'd',
  ł: 'l',
  þ: 'th',
};

/**
 * Names to offer someone called `name`, best first: their first name, the
 * whole of it, then the first name with a number.
 */
export function usernameIdeas(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[æøßđłþ]/g, (letter) => TRANSLITERATED[letter] ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const first = words[0]?.slice(0, 30);
  if (!first) return [];
  // The same number for the same name, so the ideas don't change while it is typed.
  const number = 10 + ([...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90);
  // Cut to length, a name may end on a dot: it must end on a letter or digit.
  const whole = words
    .join('.')
    .slice(0, 64)
    .replace(/[._-]+$/, '');
  return [...new Set([first, whole, `${first}${number}`])];
}

const ADJECTIVES = [
  'brave',
  'bright',
  'calm',
  'clever',
  'cosy',
  'eager',
  'gentle',
  'happy',
  'kind',
  'lively',
  'lucky',
  'merry',
  'quiet',
  'sunny',
  'swift',
  'warm',
];
const ANIMALS = [
  'badger',
  'crane',
  'dolphin',
  'falcon',
  'fox',
  'hare',
  'heron',
  'koala',
  'lynx',
  'otter',
  'owl',
  'panda',
  'puffin',
  'robin',
  'seal',
  'wren',
];

/** A name to show for an account made without a username, until it is given its own: Swift Otter */
export function adHocName(): string {
  const [a = 0, b = 0] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return nameFromUsername(`${ADJECTIVES[a % ADJECTIVES.length]!}.${ANIMALS[b % ANIMALS.length]!}`);
}

/** The name an account takes from its username until it is given one: `leif.r` is Leif R */
export function nameFromUsername(name: string): string {
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
