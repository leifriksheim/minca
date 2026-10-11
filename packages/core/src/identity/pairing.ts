/**
 * @module pairing
 * Handing an account to a phone. The QR code carries a one-time secret and
 * nothing about the account. Both devices meet on the channel for that secret
 * (`identity/channel.ts`, `PAIRING_CHANNEL`) and show the same short code; the
 * seed is sent only on that channel, after the person says the codes match.
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode, utf8Decode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';
import { protocolError } from '../utils/errors.js';
import { isRecord } from '../utils/guards.js';
import type { Channel } from './channel.js';

/** Bytes of a pairing secret */
const PAIRING_SECRET_BYTES = 16;

const PAIRING_CODE_LABEL = 'weave/pairing-code/v1';

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
 * What the phone sends before it sees the offering device's key: a hash of its
 * own. Neither side can then pick its key to steer the short code.
 */
export async function pairingCommitment(point: Uint8Array): Promise<string> {
  return base64UrlEncode(await sha256(point));
}

/** The six digits both screens show, from the exchange's channel (`PAIRING_CHANNEL`) */
export async function pairingCode(channel: Channel): Promise<string> {
  const digits = await channel.derive(PAIRING_CODE_LABEL, 4);
  const value = new DataView(digits.buffer, digits.byteOffset, 4).getUint32(0) % 1_000_000;
  return String(value).padStart(6, '0');
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
