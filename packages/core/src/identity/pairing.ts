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
import { openEnvelope, sealEnvelope } from './envelope.js';

/** Bytes of a pairing secret */
const PAIRING_SECRET_BYTES = 16;
/** Bytes of an uncompressed P-256 point, the form ephemeral keys travel in */
const POINT_BYTES = 65;

const PAIRING_ROOM_LABEL = utf8Encode('weave/pairing-room/v1');
const PAIRING_KEY_LABEL = 'weave/pairing-key/v1';
const PAIRING_CODE_LABEL = 'weave/pairing-code/v1';
/** The envelope label of a sealed pairing message; bound to `{ type, seq }` */
const PAIRING_MESSAGE_LABEL = 'weave/pairing/v1';

/** Which device: the one offering the account, or the phone taking it */
export type PairingSide = 'offer' | 'phone';

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

/**
 * What both sides end up with: the code people compare, and the sealed
 * channel. Each direction has its own key, and each message is bound to its
 * type and to its place in its direction (`seq`, from 0), so a message sent
 * back to its sender, relabelled, replayed or reordered does not open.
 */
export interface PairingChannel {
  /** Six digits */
  readonly code: string;
  /** Seals this side's next message: base64url of an envelope */
  seal(type: string, plaintext: Uint8Array): Promise<string>;
  /** Opens the other side's next message; null for anything else, which leaves the count where it was */
  open(type: string, sealed: unknown): Promise<Uint8Array | null>;
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
  /** Which of the two this side is */
  readonly side: PairingSide;
}): Promise<PairingChannel> {
  for (const point of [params.offer, params.phone]) {
    if (point.length !== POINT_BYTES || point[0] !== 0x04) throw notAKey();
  }
  let shared: Uint8Array;
  try {
    const peer = await globalThis.crypto.subtle.importKey(
      'raw',
      bufferSource(params.side === 'offer' ? params.phone : params.offer),
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
  const other: PairingSide = params.side === 'offer' ? 'phone' : 'offer';
  const sendKey = await hkdfAesKey(ikm, utf8Encode(`${PAIRING_KEY_LABEL}|${params.side}${transcript}`));
  const receiveKey = await hkdfAesKey(ikm, utf8Encode(`${PAIRING_KEY_LABEL}|${other}${transcript}`));
  const digits = await hkdf(ikm, utf8Encode(PAIRING_CODE_LABEL + transcript), 4);
  const value = new DataView(digits.buffer, digits.byteOffset, 4).getUint32(0) % 1_000_000;

  let sent = 0;
  let received = 0;
  // One open at a time, so two messages arriving together are each tried at the count they should have.
  let opening: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    code: String(value).padStart(6, '0'),
    async seal(type: string, plaintext: Uint8Array): Promise<string> {
      const seq = sent;
      sent += 1;
      return base64UrlEncode(await sealEnvelope(sendKey, PAIRING_MESSAGE_LABEL, { type, seq }, plaintext));
    },
    open(type: string, sealed: unknown): Promise<Uint8Array | null> {
      const result = opening.then(async () => {
        if (typeof sealed !== 'string' || sealed.length > 1_000_000) return null;
        let bytes: Uint8Array;
        try {
          bytes = base64UrlDecode(sealed);
        } catch {
          return null;
        }
        const plain = await openEnvelope(receiveKey, PAIRING_MESSAGE_LABEL, { type, seq: received }, bytes);
        if (plain) received += 1;
        return plain;
      });
      opening = result;
      return result;
    },
  });
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
