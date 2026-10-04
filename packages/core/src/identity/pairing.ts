/**
 * @module pairing
 * Handing an account to a phone. The QR code carries a one-time secret and
 * nothing about the account. Both devices meet in a room named after the
 * secret, run an ephemeral key exchange bound to it, and show the same short
 * code; the seed is sent only on that channel, after the person says the codes
 * match.
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode, concatBytes } from '../utils/encoding.js';
import { cidFromBytes, sha256 } from '../utils/hash.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource, isRecord } from '../utils/guards.js';
import { hkdf, hkdfAesKey } from './hkdf.js';
import { aesOpen, aesSeal, NONCE_BYTES } from './aes.js';

/** Bytes of a pairing secret */
const PAIRING_SECRET_BYTES = 16;
/** Bytes of an uncompressed P-256 point, the form ephemeral keys travel in */
const POINT_BYTES = 65;

const PAIRING_ROOM_LABEL = utf8Encode('weave/pairing-room/v2');
const PAIRING_KEY_LABEL = 'weave/pairing-key/v2';
const PAIRING_CODE_LABEL = 'weave/pairing-code/v2';

/** What the QR code carries */
export interface PairingTicket {
  readonly v: 2;
  /** The one-time secret, base64url. Says nothing about the account. */
  readonly secret: string;
  /** Where to meet. Must be an address the phone can actually reach. */
  readonly relay: string;
}

/** A new one-time secret, for one offer */
export function newPairingSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES));
}

/**
 * The room both devices meet in: a hash of the secret, so only someone who saw
 * the QR code can find it, and a relay sees a new name every time.
 */
export async function pairingRoomId(secret: Uint8Array): Promise<string> {
  return cidFromBytes(concatBytes(PAIRING_ROOM_LABEL, secret));
}

/** An ephemeral ECDH key for one exchange, and its public point */
export async function pairingKeyPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly point: Uint8Array;
}> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  const point = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, point };
}

/**
 * What the phone sends before it sees the offering device's key: a hash of its
 * own. Neither side can then pick its key to steer the short code.
 */
export async function pairingCommitment(point: Uint8Array): Promise<string> {
  return base64UrlEncode(await sha256(point));
}

/** What both sides end up with: the key the handover is sealed with, and the code people compare */
export interface PairingChannel {
  readonly key: CryptoKey;
  /** Six digits */
  readonly code: string;
}

const notAKey = () => protocolError('PAIRING_TICKET_UNREADABLE', 'That device sent a key that is not one.');

/**
 * The channel, from this side's private key, both public points and the secret.
 *
 * The secret goes into the key, so someone who never saw the QR code gets a
 * different channel; both points go into the labels, so a handover sealed for
 * one exchange opens in no other.
 */
export async function derivePairingChannel(params: {
  readonly secret: Uint8Array;
  readonly privateKey: CryptoKey;
  /** The offering device's point */
  readonly offer: Uint8Array;
  /** The phone's point */
  readonly phone: Uint8Array;
  /** The other side's point: `offer` or `phone` */
  readonly peer: Uint8Array;
}): Promise<PairingChannel> {
  for (const point of [params.offer, params.phone]) {
    if (point.length !== POINT_BYTES || point[0] !== 0x04) throw notAKey();
  }
  let shared: Uint8Array;
  try {
    const peer = await globalThis.crypto.subtle.importKey(
      'raw',
      bufferSource(params.peer),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    shared = new Uint8Array(
      await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, params.privateKey, 256),
    );
  } catch {
    throw notAKey();
  }
  const ikm = concatBytes(params.secret, shared);
  const transcript = `|${base64UrlEncode(params.offer)}|${base64UrlEncode(params.phone)}`;
  const key = await hkdfAesKey(ikm, utf8Encode(PAIRING_KEY_LABEL + transcript));
  const digits = await hkdf(ikm, utf8Encode(PAIRING_CODE_LABEL + transcript), 4);
  const value = new DataView(digits.buffer, digits.byteOffset, 4).getUint32(0) % 1_000_000;
  return { key, code: String(value).padStart(6, '0') };
}

/**
 * Packs a ticket for a URL fragment.
 *
 * A fragment, because browsers never put one in a request, so the secret
 * reaches the phone without passing through the server hosting the page.
 */
export function encodePairingTicket(ticket: PairingTicket): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(ticket)));
}

function isPairingTicket(value: unknown): value is PairingTicket {
  return (
    isRecord(value) &&
    value.v === 2 &&
    typeof value.secret === 'string' &&
    typeof value.relay === 'string' &&
    base64UrlDecode(value.secret).length === PAIRING_SECRET_BYTES
  );
}

/** Unpacks a ticket from a URL fragment. */
export function decodePairingTicket(encoded: string): PairingTicket {
  try {
    const ticket: unknown = JSON.parse(utf8Decode(base64UrlDecode(encoded.trim())));
    if (!isPairingTicket(ticket)) throw new Error('unexpected shape');
    return ticket;
  } catch {
    throw protocolError(
      'PAIRING_TICKET_UNREADABLE',
      'That pairing link could not be read.',
      'It may have been truncated, or made by an older version. Show a new code.',
    );
  }
}

/** Encrypts a handover message: nonce, then ciphertext */
export async function sealPairingPayload(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  return aesSeal(key, plaintext);
}

/** Decrypts a handover message */
export async function openPairingPayload(sealed: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (sealed.length <= NONCE_BYTES) {
    throw protocolError('PAIRING_TICKET_UNREADABLE', 'That handover was too short to be real.');
  }
  try {
    return await aesOpen(key, sealed);
  } catch {
    // Someone else in the room, or a handover from another exchange.
    throw protocolError('PAIRING_TICKET_UNREADABLE', 'That handover was not meant for this phone.');
  }
}
