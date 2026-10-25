/**
 * Short invite links (spec 03 §7.7): a link carries a secret and the hash
 * of one sealed invite, and names the mailboxes it is kept in. Everything
 * the long invite carried sits in that sealed invite instead, so the link
 * stays short however large the space's constitution is.
 *
 *   code  = base64url(S ‖ pin)                       — 43 characters
 *   link  = code [ "@" place [ "," place ] ]
 *   pin   = SHA-256(UTF-8(blob))[0..16)              — the blob, exactly as kept
 *   topic = base64url(SHA-256("minca/invite-topic/v1|" + base64url(pin)))
 *
 * The pin is what makes a link fixed: whoever holds `S` can seal other
 * blobs, but only the inviter's hashes to the pin, so only it is taken.
 */
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { bufferSource, isRecord } from '../utils/guards.js';
import { sha256 } from '../utils/hash.js';
import { expandSecret } from './space-access.js';
import { checkRelays } from './roles.js';
import { nodeAddress } from '../network/ws-transport.js';
import type { Version } from '../types.js';

/** The secret's length: 128 bits, out of reach of offline guessing */
const LINK_SECRET_BYTES = 16;
/** The pin's length: a second blob with the same pin is a 128-bit second preimage */
const LINK_PIN_BYTES = 16;
/** At most this many places in a link, and asked of one */
export const MAX_LINK_PLACES = 2;
/** A sealed invite opens to at most this much */
const MAX_SEALED_INVITE_BYTES = 64 * 1024;
/** A mailbox blob's limit (spec 07 §5): a sealed invite must fit it */
const MAX_SEALED_BLOB_CHARS = 12_000;

const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A short link, read */
export interface InviteLink {
  readonly secret: Uint8Array;
  readonly pin: Uint8Array;
  /** Mailbox URLs the link names, at most two, each passing `checkRelays` */
  readonly places: ReadonlyArray<string>;
}

/** What is derived from a link's secret and pin */
export interface InviteLinkKeys {
  /** The 32-byte invite secret of spec 03 §7.1 */
  readonly inviteSecret: Uint8Array;
  readonly sealKey: CryptoKey;
  readonly topic: string;
}

/** What a sealed invite holds: the signed invitation (spec 03 §7.4), whose secret the link gives */
export interface SealedInvite {
  readonly invite: Version;
  /** When the inviter stops serving it, ms; nothing a peer enforces */
  readonly until?: number;
}

/** At most this many always-on nodes in an invite */
export const MAX_INVITE_NODES = 8;

/**
 * An invite's nodes as a joiner may dial them, or null when the list is not
 * one: at most eight node URLs (spec 04 §5.2), each pinned by a DID, so a
 * socket to one is refused unless it is the node the inviter named.
 */
export function checkInviteNodes(nodes: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(nodes) || nodes.length > MAX_INVITE_NODES) return null;
  for (const node of nodes) {
    if (typeof node !== 'string' || node.length > 512) return null;
    const address = nodeAddress(node);
    if (typeof address === 'string' || address.pin === null) return null;
  }
  return nodes.length === new Set(nodes).size ? nodes : null;
}

/** The mailbox of the node at a `/peer` address: its relay, on the same address */
export function relayOfNode(node: string): string {
  const url = new URL(node);
  url.hash = '';
  url.search = '';
  url.pathname = '/';
  return url.href;
}

/** Whether a string, bare, is a short link rather than a long invite */
export function isShortInvite(value: string): boolean {
  return CODE.test(value.trim().split('@')[0] ?? '');
}

/** A place as a link writes it: no scheme for wss://, nor for ws:// on this machine */
function writePlace(url: string): string {
  const parsed = new URL(url);
  const bare = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  const plain = parsed.protocol === 'wss:' ? !LOOPBACK.has(parsed.hostname) : LOOPBACK.has(parsed.hostname);
  return (plain ? bare : url).replace(
    /[%@,#&\s]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** A place as a link wrote it, or null for one that is no usable mailbox */
function readPlace(written: string): string | null {
  let text: string;
  try {
    text = decodeURIComponent(written);
  } catch {
    return null;
  }
  if (!text) return null;
  let url = text;
  if (!text.includes('://')) {
    const host = text.split('/')[0]!.replace(/:\d+$/, '');
    url = `${LOOPBACK.has(host) ? 'ws' : 'wss'}://${text}`;
  }
  return checkRelays([url]) === null ? url : null;
}

/** Writes a short link's text: what goes after `#invite=` */
export function encodeInviteLink(link: InviteLink): string {
  if (link.secret.length !== LINK_SECRET_BYTES || link.pin.length !== LINK_PIN_BYTES)
    throw new Error('A short invite is a 16-byte secret and a 16-byte pin');
  const code = base64UrlEncode(new Uint8Array([...link.secret, ...link.pin]));
  const places = link.places.slice(0, MAX_LINK_PLACES).map(writePlace);
  return places.length ? `${code}@${places.join(',')}` : code;
}

/** Reads a short link's text; places that are no usable mailbox are left out */
export function parseInviteLink(value: string): InviteLink {
  const [code = '', written = ''] = value.trim().split('@', 2);
  if (!CODE.test(code))
    throw new Error('That invite could not be read — it may be truncated or from another app.');
  const bytes = base64UrlDecode(code);
  const places = written
    .split(',')
    .slice(0, MAX_LINK_PLACES)
    .map(readPlace)
    .filter((url): url is string => url !== null);
  return {
    secret: bytes.slice(0, LINK_SECRET_BYTES),
    pin: bytes.slice(LINK_SECRET_BYTES),
    places: [...new Set(places)],
  };
}

/** The mailbox topic of a pin */
export async function linkTopic(pin: Uint8Array): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(`minca/invite-topic/v1|${base64UrlEncode(pin)}`)));
}

/** The first 16 bytes of a blob's hash, the one a relay files it under */
export async function pinOf(blob: string): Promise<Uint8Array> {
  return (await sha256(utf8Encode(blob))).slice(0, LINK_PIN_BYTES);
}

/** The invite secret, seal key and topic a link's secret and pin give */
export async function inviteLinkKeys(secret: Uint8Array, pin: Uint8Array): Promise<InviteLinkKeys> {
  return {
    inviteSecret: await linkInviteSecret(secret),
    sealKey: await sealKeyOf(secret),
    topic: await linkTopic(pin),
  };
}

async function sealKeyOf(secret: Uint8Array): Promise<CryptoKey> {
  const raw = await expandSecret(secret, 'minca/invite-link/v1|seal');
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A fresh link secret */
export function generateLinkSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
}

/** The invite secret a link's secret stands for, which the invite record is opened with */
export function linkInviteSecret(secret: Uint8Array): Promise<Uint8Array> {
  return expandSecret(secret, 'minca/invite-link/v1|secret');
}

async function pipe(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array> {
  const reader = new Blob([bufferSource(bytes)]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    // Stop as soon as it is too large: a small blob can inflate to a great deal.
    if (size > limit) {
      await reader.cancel();
      throw new Error('That invite opens to more than an invite can be');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Seals an invite under a link's secret: `nonce(12) ‖ AES-256-GCM(deflate(JSON))`,
 * base64url. Returns the blob and the pin a link names it by.
 */
export async function sealInvite(
  secret: Uint8Array,
  sealed: SealedInvite,
): Promise<{ readonly blob: string; readonly pin: Uint8Array }> {
  const json = utf8Encode(JSON.stringify({ v: 2, ...sealed }));
  if (json.length > MAX_SEALED_INVITE_BYTES) throw new Error('That invite is too large for a short link');
  const plain = await pipe(json, new CompressionStream('deflate'), MAX_SEALED_INVITE_BYTES);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await sealKeyOf(secret);
  const cipher = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bufferSource(plain)),
  );
  const blob = base64UrlEncode(new Uint8Array([...nonce, ...cipher]));
  if (blob.length > MAX_SEALED_BLOB_CHARS) throw new Error('That invite is too large for a short link');
  return { blob, pin: await pinOf(blob) };
}

/**
 * Opens a blob a link names, or null when it is not that link's: its hash
 * doesn't start with the pin, or it doesn't open. The pin is checked first,
 * so a stranger's blob is never decrypted, let alone inflated.
 */
export async function openInvite(link: InviteLink, blob: string): Promise<SealedInvite | null> {
  if (blob.length > MAX_SEALED_BLOB_CHARS || !/^[A-Za-z0-9_-]+$/.test(blob)) return null;
  const pin = await pinOf(blob);
  if (!pin.every((byte, i) => byte === link.pin[i])) return null;
  const bytes = base64UrlDecode(blob);
  if (bytes.length < 12 + 16) return null;
  const sealKey = await sealKeyOf(link.secret);
  let json: unknown;
  try {
    const plain = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bufferSource(bytes.slice(0, 12)) },
        sealKey,
        bufferSource(bytes.slice(12)),
      ),
    );
    json = JSON.parse(
      utf8Decode(await pipe(plain, new DecompressionStream('deflate'), MAX_SEALED_INVITE_BYTES)),
    );
  } catch {
    return null;
  }
  if (!isRecord(json) || json.v !== 2 || !isRecord(json.invite)) return null;
  const until = typeof json.until === 'number' && Number.isFinite(json.until) ? json.until : undefined;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- an object; whoever joins with it reads it as an invitation and checks its signature
  return { invite: json.invite as unknown as Version, ...(until !== undefined ? { until } : {}) };
}
