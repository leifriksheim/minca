/**
 * @module identity/channel
 * A sealed channel between two programs that share a one-time secret and
 * nothing else: handing an account to a phone (pairing), and connecting a
 * program by code. Both meet in a room named after the secret, swap ephemeral
 * P-256 keys, and derive a key for each direction from the secret and the
 * shared point together. Someone who later learns the secret, holding a
 * recording of the room, still lacks the shared point.
 *
 * Each message is an envelope bound to its type and its place in its
 * direction, so a message sent back to its sender, relabelled, replayed or
 * reordered does not open.
 */

import { base64UrlDecode, base64UrlEncode, utf8Encode, concatBytes } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource } from '../utils/guards.js';
import { hkdf, hkdfAesKey } from './hkdf.js';
import { openEnvelope, sealEnvelope } from './envelope.js';

/** Bytes of an uncompressed P-256 point, the form ephemeral keys travel in */
const POINT_BYTES = 65;
/** Sealed messages longer than this are not tried */
const MAX_SEALED = 1_000_000;

/** The labels one kind of exchange uses, so no exchange of one kind opens as the other */
export interface ChannelKind {
  /** The room: a CID of this label and the secret */
  readonly room: string;
  /** Each direction's key: `<key>|<side>|<O>|<J>` */
  readonly key: string;
  /** The envelope label of a sealed message, bound to `{ type, seq }` */
  readonly message: string;
}

/** Handing an account to a phone (`identity/pairing.ts`) */
export const PAIRING_CHANNEL: ChannelKind = Object.freeze({
  room: 'weave/pairing-room/v1',
  key: 'weave/pairing-key/v1',
  message: 'weave/pairing/v1',
});

/** Connecting a program by a pasted code (`session/connect-code.ts`) */
export const CODE_CHANNEL: ChannelKind = Object.freeze({
  room: 'weave/code-room/v1',
  key: 'weave/code-key/v1',
  message: 'weave/code/v1',
});

/** Which side: the one that made the secret and shows it, or the one that joins with it */
export type ChannelSide = 'offer' | 'join';

/**
 * The room both sides meet in: a hash of the secret, so only someone who has
 * the secret can find it, and a relay sees a new name every time.
 */
export async function channelRoom(kind: ChannelKind, secret: Uint8Array): Promise<string> {
  return cidFromBytes(concatBytes(utf8Encode(kind.room), secret));
}

/** An ephemeral ECDH key for one exchange, and its public point */
export async function channelKeyPair(): Promise<{
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
 * Both sides' sealed channel. Each direction has its own key, and each message
 * is bound to its type and to its place in its direction (`seq`, from 0).
 */
export interface Channel {
  /** Seals this side's next message: base64url of an envelope */
  seal(type: string, plaintext: Uint8Array): Promise<string>;
  /** Opens the other side's next message; null for anything else, which leaves the count where it was */
  open(type: string, sealed: unknown): Promise<Uint8Array | null>;
  /** Bytes only this exchange gives, under `label` with the transcript appended: pairing's short code */
  derive(label: string, length: number): Promise<Uint8Array>;
}

const notAKey = () => protocolError('PAIRING_TICKET_UNREADABLE', 'That device sent a key that is not one.');

/**
 * The channel, from this side's private key, both public points and the secret.
 *
 * The secret goes into the key, so someone who never had it gets a different
 * channel; the shared point goes in too, so a recording opens nothing to
 * someone who learns the secret later; both points go into the labels, so a
 * message sealed for one exchange opens in no other.
 */
export async function deriveChannel(params: {
  readonly kind: ChannelKind;
  readonly secret: Uint8Array;
  readonly privateKey: CryptoKey;
  /** The offering side's point */
  readonly offer: Uint8Array;
  /** The joining side's point */
  readonly join: Uint8Array;
  /** Which of the two this side is */
  readonly side: ChannelSide;
}): Promise<Channel> {
  for (const point of [params.offer, params.join]) {
    if (point.length !== POINT_BYTES || point[0] !== 0x04) throw notAKey();
  }
  let shared: Uint8Array;
  try {
    const peer = await globalThis.crypto.subtle.importKey(
      'raw',
      bufferSource(params.side === 'offer' ? params.join : params.offer),
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
  const { kind } = params;
  const ikm = concatBytes(params.secret, shared);
  const transcript = `|${base64UrlEncode(params.offer)}|${base64UrlEncode(params.join)}`;
  const other: ChannelSide = params.side === 'offer' ? 'join' : 'offer';
  const sendKey = await hkdfAesKey(ikm, utf8Encode(`${kind.key}|${params.side}${transcript}`));
  const receiveKey = await hkdfAesKey(ikm, utf8Encode(`${kind.key}|${other}${transcript}`));

  let sent = 0;
  let received = 0;
  // One open at a time, so two messages arriving together are each tried at the count they should have.
  let opening: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    async seal(type: string, plaintext: Uint8Array): Promise<string> {
      const seq = sent;
      sent += 1;
      return base64UrlEncode(await sealEnvelope(sendKey, kind.message, { type, seq }, plaintext));
    },
    open(type: string, sealed: unknown): Promise<Uint8Array | null> {
      const result = opening.then(async () => {
        if (typeof sealed !== 'string' || sealed.length > MAX_SEALED) return null;
        let bytes: Uint8Array;
        try {
          bytes = base64UrlDecode(sealed);
        } catch {
          return null;
        }
        const plain = await openEnvelope(receiveKey, kind.message, { type, seq: received }, bytes);
        if (plain) received += 1;
        return plain;
      });
      opening = result;
      return result;
    },
    derive: (label: string, length: number) => hkdf(ikm, utf8Encode(label + transcript), length),
  });
}
