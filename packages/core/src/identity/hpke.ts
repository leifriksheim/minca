/**
 * @module identity/hpke
 * Sealing to a public key: HPKE (RFC 9180) in base mode, single-shot, with
 * DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-GCM (spec 01 §9.2).
 *
 * Web Crypto does the ECDH, the HMAC and the AES. HKDF's two halves are
 * needed apart here, which Web Crypto's HKDF doesn't offer, so they are
 * written out over its HMAC. Minca's own wrapper, `sealTo`, puts a label and
 * the fields that say where the sealed thing belongs into HPKE's `info`.
 *
 * ```
 * sealed = 0x01 ‖ enc(65) ‖ ct        // base64url
 * info   = UTF-8(label) ‖ 0x00 ‖ UTF-8(canonical(bound)),  aad = empty
 * ```
 */
import { p256 } from '@noble/curves/nist.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { boundContext, ENVELOPE_VERSION, type Bound } from './envelope.js';

/** AES-128-GCM (0x0001) or AES-256-GCM (0x0002); Minca seals only with the second */
export type HpkeAead = 0x0001 | 0x0002;

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const POINT_BYTES = 65;
const N_SECRET = 32;
const N_NONCE = 12;
const TAG_BYTES = 16;
const MAX_TEXT = 1_000_000;
const HASH_BYTES = 32;

const i2osp = (value: number, length: number) => {
  const out = new Uint8Array(length);
  for (let i = length - 1, v = value; i >= 0; i -= 1, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
};

const KEM_SUITE = concatBytes(utf8Encode('KEM'), i2osp(KEM_ID, 2));
const hpkeSuite = (aead: HpkeAead) =>
  concatBytes(utf8Encode('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead, 2));
const HPKE_V1 = utf8Encode('HPKE-v1');
const EMPTY = new Uint8Array(0);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // An empty HMAC key is the same as a hash-length run of zeros, and Web Crypto refuses empty keys.
  const material = key.length ? key : new Uint8Array(HASH_BYTES);
  const imported = await globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', imported, bufferSource(data)));
}

/** HKDF-Expand (RFC 5869 §2.3) */
async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(length);
  let block: Uint8Array = EMPTY;
  for (let filled = 0, i = 1; filled < length; i += 1) {
    block = await hmac(prk, concatBytes(block, info, new Uint8Array([i])));
    out.set(block.subarray(0, Math.min(block.length, length - filled)), filled);
    filled += block.length;
  }
  return out;
}

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  hmac(salt, concatBytes(HPKE_V1, suite, utf8Encode(label), ikm));

const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(prk, concatBytes(i2osp(length, 2), HPKE_V1, suite, utf8Encode(label), info), length);

/** The 32-byte x-coordinate of ECDH between a private key and a public point */
async function dh(privateKey: CryptoKey, point: Uint8Array): Promise<Uint8Array> {
  const publicKey = await globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(point),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256),
  );
}

/** DHKEM's ExtractAndExpand: the shared secret, bound to both points */
async function sharedSecret(dhBytes: Uint8Array, enc: Uint8Array, recipient: Uint8Array) {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dhBytes);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', concatBytes(enc, recipient), N_SECRET);
}

/** The base-mode key schedule: the AEAD key and the nonce of the one message */
async function keySchedule(aead: HpkeAead, shared: Uint8Array, info: Uint8Array) {
  const suite = hpkeSuite(aead);
  const pskIdHash = await labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(suite, EMPTY, 'info_hash', info);
  const context = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = await labeledExtract(suite, shared, 'secret', EMPTY);
  const key = await labeledExpand(suite, secret, 'key', context, aead === 0x0001 ? 16 : 32);
  const nonce = await labeledExpand(suite, secret, 'base_nonce', context, N_NONCE);
  const aesKey = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { key: aesKey, nonce };
}

const isPoint = (bytes: Uint8Array) => bytes.length === POINT_BYTES && bytes[0] === 0x04;

/**
 * HPKE base mode, single-shot: seals one message to a public key.
 * @param params.publicKey The recipient's uncompressed point (65 bytes)
 * @param params.ephemeral A fixed ephemeral key, for test vectors only
 * @returns `enc`, the ephemeral public point, and the ciphertext with its tag
 */
export async function hpkeSeal(params: {
  readonly publicKey: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly aead?: HpkeAead;
  readonly ephemeral?: { readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };
}): Promise<{ readonly enc: Uint8Array; readonly ciphertext: Uint8Array }> {
  if (!isPoint(params.publicKey)) throw new Error('Not an uncompressed P-256 point');
  const aead = params.aead ?? 0x0002;
  const ephemeral =
    params.ephemeral ??
    (await (async () => {
      const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ]);
      const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
      return { privateKey: pair.privateKey, publicKey };
    })());
  const enc = ephemeral.publicKey;
  const shared = await sharedSecret(await dh(ephemeral.privateKey, params.publicKey), enc, params.publicKey);
  const { key, nonce } = await keySchedule(aead, shared, params.info);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: bufferSource(params.aad) },
    key,
    bufferSource(params.plaintext),
  );
  return { enc, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Opens what `hpkeSeal` sealed.
 * @param params.recipient The private key, and its uncompressed public point
 * @returns The plaintext, or null when it does not open
 */
export async function hpkeOpen(params: {
  readonly recipient: { readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };
  readonly enc: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly aead?: HpkeAead;
}): Promise<Uint8Array | null> {
  if (!isPoint(params.enc) || !isPoint(params.recipient.publicKey)) return null;
  try {
    const shared = await sharedSecret(
      await dh(params.recipient.privateKey, params.enc),
      params.enc,
      params.recipient.publicKey,
    );
    const { key, nonce } = await keySchedule(params.aead ?? 0x0002, shared, params.info);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: bufferSource(params.aad) },
      key,
      bufferSource(params.ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/**
 * DHKEM(P-256)'s DeriveKeyPair (RFC 9180 §7.1.3): what the test vectors make
 * their keys with. Minca's own keys come from elsewhere.
 * @returns The private scalar (32 bytes) and the uncompressed public point
 */
export async function hpkeDeriveKeyPair(
  ikm: Uint8Array,
): Promise<{ readonly privateKey: Uint8Array; readonly publicKey: Uint8Array }> {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm);
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = await labeledExpand(KEM_SUITE, prk, 'candidate', new Uint8Array([counter]), 32);
    const scalar = BigInt(`0x${Array.from(candidate, (b) => b.toString(16).padStart(2, '0')).join('')}`);
    if (scalar !== 0n && scalar < p256.Point.CURVE().n)
      return { privateKey: candidate, publicKey: p256.getPublicKey(candidate, false) };
  }
  throw new Error('DeriveKeyPairError');
}

const uncompressed = (publicKey: string) => p256.Point.fromBytes(base64UrlDecode(publicKey)).toBytes(false);

/**
 * Seals bytes to a P-256 key (a contact, member or inbox key), for one label
 * and one place.
 * @param publicKey The compressed point, base64url, as profiles carry it
 * @returns base64url of `0x01 ‖ enc ‖ ct`
 */
export async function sealTo(
  publicKey: string,
  label: string,
  bound: Bound,
  plaintext: Uint8Array,
): Promise<string> {
  const { enc, ciphertext } = await hpkeSeal({
    publicKey: uncompressed(publicKey),
    info: boundContext(label, bound),
    aad: EMPTY,
    plaintext,
  });
  return base64UrlEncode(concatBytes(new Uint8Array([ENVELOPE_VERSION]), enc, ciphertext));
}

/**
 * Opens what `sealTo` sealed.
 * @param recipient The key pair it was sealed to (`contactKeyPair`)
 * @returns The plaintext, or null for an unknown version, too few bytes, the
 *   wrong key, label or bound, or anything changed
 */
export async function openFrom(
  recipient: { readonly privateKey: CryptoKey; readonly publicKey: string },
  label: string,
  bound: Bound,
  sealed: unknown,
): Promise<Uint8Array | null> {
  if (typeof sealed !== 'string' || sealed.length > MAX_TEXT) return null;
  try {
    const bytes = base64UrlDecode(sealed);
    if (bytes.length < 1 + POINT_BYTES + TAG_BYTES || bytes[0] !== ENVELOPE_VERSION) return null;
    return await hpkeOpen({
      recipient: { privateKey: recipient.privateKey, publicKey: uncompressed(recipient.publicKey) },
      enc: bytes.subarray(1, 1 + POINT_BYTES),
      info: boundContext(label, bound),
      aad: EMPTY,
      ciphertext: bytes.subarray(1 + POINT_BYTES),
    });
  } catch {
    return null;
  }
}

/** Seals a JSON value to a P-256 key */
export function sealValueTo(publicKey: string, label: string, bound: Bound, value: unknown): Promise<string> {
  return sealTo(publicKey, label, bound, utf8Encode(JSON.stringify(value)));
}

/** Opens what `sealValueTo` sealed; null when it doesn't open, or isn't JSON */
export async function openValueFrom(
  recipient: { readonly privateKey: CryptoKey; readonly publicKey: string },
  label: string,
  bound: Bound,
  sealed: unknown,
): Promise<unknown> {
  const plain = await openFrom(recipient, label, bound, sealed);
  if (!plain) return null;
  try {
    return JSON.parse(utf8Decode(plain));
  } catch {
    return null;
  }
}
