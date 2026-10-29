/**
 * @module identity/contact-key
 * The contact key: a P-256 ECDH key pair, derived from the seed under its own
 * label, that lets someone seal a message only you can open while you are
 * offline. Not the root key (apps never hold the seed, and one key should not
 * both sign and decrypt), and not a session key (those change every hour).
 *
 * Its public half goes on the account's profile (`sys.profile`); sealing to it
 * is HPKE (`identity/hpke.ts`). Member and inbox keys are derived the same way.
 */
import { p256 } from '@noble/curves/nist.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { hkdf } from './hkdf.js';

/** Domain separation. Changing a label changes every key derived under it. */
const CONTACT_KEY_INFO = 'minca/p256-contact-key/v1';
const MEMBER_KEY_INFO = 'minca/p256-member-key/v1';
const INBOX_KEY_INFO = 'minca/p256-inbox-key/v1';
const INBOX_SIGN_KEY_INFO = 'minca/p256-inbox-sign-key/v1';

/** 48 bytes reduce to a P-256 scalar without bias, as for the root key (`crypto-p256.ts`) */
const P256_SEED_BYTES = 48;

export interface ContactKeyPair {
  /** The public half: a compressed P-256 point, base64url. What goes on a profile. */
  readonly publicKey: string;
  /** The private half, for opening what was sealed to the public one. Not extractable. */
  readonly privateKey: CryptoKey;
}

/** A P-256 scalar from key material, under its own label */
async function deriveScalar(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  return p256.utils.randomSecretKey(await hkdf(ikm, utf8Encode(info), P256_SEED_BYTES));
}

/** A private scalar as a Web Crypto key; the JWK form needs its public point too */
function importScalar(
  secret: Uint8Array,
  algorithm: 'ECDSA' | 'ECDH',
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const point = p256.getPublicKey(secret, false);
  return globalThis.crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(point.subarray(1, 33)),
      y: base64UrlEncode(point.subarray(33, 65)),
      d: base64UrlEncode(secret),
      ext: false,
    },
    { name: algorithm, namedCurve: 'P-256' },
    false,
    usages,
  );
}

/** The contact key's 32-byte private scalar, from the seed: what an account home hands an app that handles contacts */
export function deriveContactKeyBytes(seed: Uint8Array): Promise<Uint8Array> {
  return deriveScalar(seed, CONTACT_KEY_INFO);
}

/**
 * The account's member key for one space, which new space keys are sealed to
 * (`sys.box`). One per space, so an app granted one space holds nothing that opens another.
 * @param accountKey The account key (`deriveAccountKey(seed)`)
 */
export function deriveMemberKeyBytes(accountKey: Uint8Array, spaceId: string): Promise<Uint8Array> {
  return deriveScalar(accountKey, `${MEMBER_KEY_INFO}|${spaceId}`);
}

/**
 * An inbox key, which knocks are sealed to (spec 07 §1). Not the contact key,
 * whose public half is on every profile: an inbox key says nothing about whose it is.
 * @param contactKey The contact key's private scalar (`deriveContactKeyBytes`)
 */
export function deriveInboxKeyBytes(contactKey: Uint8Array, gen: number): Promise<Uint8Array> {
  return deriveScalar(contactKey, `${INBOX_KEY_INFO}|${gen}`);
}

/** An inbox's signing key: signs the inbox and proves ownership to a relay. Separate, so no key both signs and decrypts. */
export function deriveInboxSignKeyBytes(contactKey: Uint8Array, gen: number): Promise<Uint8Array> {
  return deriveScalar(contactKey, `${INBOX_SIGN_KEY_INFO}|${gen}`);
}

/** A private scalar as an ECDSA signing key */
export function signingKeyOf(secret: Uint8Array): Promise<CryptoKey> {
  return importScalar(secret, 'ECDSA', ['sign']);
}

/** Signs with a P-256 private scalar: ECDSA over SHA-256, 64 bytes r ‖ s, base64url */
export async function signWithScalar(secret: Uint8Array, data: Uint8Array): Promise<string> {
  const key = await signingKeyOf(secret);
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bufferSource(data),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** The public half, from the private scalar */
export function contactPublicKey(secret: Uint8Array): string {
  return base64UrlEncode(p256.getPublicKey(secret, true));
}

/** Whether a string is a contact key's public half: a point on P-256 */
export function isContactPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    p256.Point.fromBytes(base64UrlDecode(value)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** The key pair, from the private scalar (`deriveContactKeyBytes`) */
export async function contactKeyPair(secret: Uint8Array): Promise<ContactKeyPair> {
  const privateKey = await importScalar(secret, 'ECDH', ['deriveBits']);
  return Object.freeze({ publicKey: contactPublicKey(secret), privateKey });
}
