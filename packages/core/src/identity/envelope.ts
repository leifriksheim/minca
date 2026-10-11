/**
 * @module identity/envelope
 * The one symmetric envelope (spec 01 §9.1): AES-256-GCM under a fresh
 * 96-bit nonce, with a label and the fields that say where the sealed thing
 * belongs bound in as additional data. Something sealed for one place opens
 * nowhere else: not under another label, not with another field, not with
 * one more or one fewer.
 *
 * ```
 * envelope = 0x01 ‖ nonce(12) ‖ AES-256-GCM(key, nonce, plaintext, aad)
 * aad      = 0x01 ‖ UTF-8(label) ‖ 0x00 ‖ UTF-8(canonical(bound))
 * ```
 */
import { canonicalize } from '../schema/version.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';

/** The first byte of every envelope, and of its additional data */
export const ENVELOPE_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The shortest envelope: version, nonce and tag around an empty plaintext */
export const MIN_ENVELOPE_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
/** Envelopes travelling as text longer than this are not tried */
const MAX_TEXT = 1_000_000;

/** What an envelope is bound to: a flat object of strings and numbers */
export type Bound = Readonly<Record<string, string | number>>;

/**
 * The bytes that say what a sealed thing is and where it belongs:
 * `UTF-8(label) ‖ 0x00 ‖ UTF-8(canonical JSON of bound)`. The envelope's
 * additional data is these after its version byte; HPKE's `info` is these
 * alone (`identity/hpke.ts`).
 */
export function boundContext(label: string, bound: Bound): Uint8Array<ArrayBuffer> {
  return concatBytes(utf8Encode(label), new Uint8Array([0]), utf8Encode(canonicalize(bound)));
}

const additionalData = (label: string, bound: Bound) =>
  concatBytes(new Uint8Array([ENVELOPE_VERSION]), boundContext(label, bound));

/** Seals bytes under an AES-256-GCM key, for one label and one place */
export async function sealEnvelope(
  key: CryptoKey,
  label: string,
  bound: Bound,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: bufferSource(additionalData(label, bound)) },
    key,
    bufferSource(plaintext),
  );
  return concatBytes(new Uint8Array([ENVELOPE_VERSION]), nonce, new Uint8Array(ciphertext));
}

/**
 * Opens what `sealEnvelope` sealed.
 * @returns The plaintext, or null for an unknown version, too few bytes, the
 *   wrong key, label or bound, or anything changed
 */
export async function openEnvelope(
  key: CryptoKey,
  label: string,
  bound: Bound,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (sealed.length < MIN_ENVELOPE_BYTES || sealed[0] !== ENVELOPE_VERSION) return null;
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(sealed.subarray(1, 1 + NONCE_BYTES)),
        additionalData: bufferSource(additionalData(label, bound)),
      },
      key,
      bufferSource(sealed.subarray(1 + NONCE_BYTES)),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/** Seals a JSON value, as base64url text */
export async function sealValue(
  key: CryptoKey,
  label: string,
  bound: Bound,
  value: unknown,
): Promise<string> {
  return base64UrlEncode(await sealEnvelope(key, label, bound, utf8Encode(JSON.stringify(value))));
}

/** Opens what `sealValue` sealed; null when it doesn't open, or isn't JSON */
export async function openValue(
  key: CryptoKey,
  label: string,
  bound: Bound,
  sealed: unknown,
): Promise<unknown> {
  if (typeof sealed !== 'string' || sealed.length > MAX_TEXT) return null;
  try {
    const plain = await openEnvelope(key, label, bound, base64UrlDecode(sealed));
    return plain ? JSON.parse(utf8Decode(plain)) : null;
  } catch {
    return null;
  }
}
