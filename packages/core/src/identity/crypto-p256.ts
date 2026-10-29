import { CryptoProvider, CryptoKeyPairResult } from '../types.js';
import { base64UrlEncode, bytesToHex, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { hkdf } from './hkdf.js';
import { p256 } from '@noble/curves/nist.js';

/** Domain separation for identity keys. Changing it changes every derived DID. */
const P256_KEY_INFO = utf8Encode('minca/p256-identity-key/v1');

/** 48 bytes: the 32-byte group order plus 16 more, so reducing mod n is unbiased */
const P256_SEED_BYTES = 48;

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: { name: 'SHA-256' } } as const;

/** Public keys imported for verifying, by their bytes as hex; the oldest let go first */
const publicKeys = new Map<string, Promise<CryptoKey>>();
const MAX_PUBLIC_KEYS = 1000;

/** Creates a CryptoProvider using the Web Crypto API with ECDSA P-256. */
export function createP256Provider(): CryptoProvider {
  return Object.freeze({
    algorithm: 'ECDSA-P256',

    async generateKeyPair(): Promise<CryptoKeyPairResult> {
      // Not extractable: a script in the page can sign while there, but can't carry the key off.
      const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey(ECDSA, false, [
        'sign',
        'verify',
      ]);
      return Object.freeze({ publicKey, privateKey });
    },

    async deriveKeyPairFromSeed(seed: Uint8Array): Promise<CryptoKeyPairResult> {
      // FIPS 186-5 A.2. Web Crypto can't compute a scalar's public point; noble does that step.
      const secretKey = p256.utils.randomSecretKey(await hkdf(seed, P256_KEY_INFO, P256_SEED_BYTES));
      const point = p256.getPublicKey(secretKey, false); // 0x04 ‖ x ‖ y
      const x = base64UrlEncode(point.subarray(1, 33));
      const y = base64UrlEncode(point.subarray(33, 65));
      const d = base64UrlEncode(secretKey);
      const privateKey = await importJwk({ x, y, d, ext: false, key_ops: ['sign'] }, false, ['sign']);
      const publicKey = await importJwk({ x, y, ext: true, key_ops: ['verify'] }, true, ['verify']);
      return Object.freeze({ publicKey, privateKey });
    },

    async sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await globalThis.crypto.subtle.sign(SIGNING, privateKey, bufferSource(data)));
    },

    verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
      return globalThis.crypto.subtle.verify(SIGNING, publicKey, bufferSource(signature), bufferSource(data));
    },

    /** The 33-byte compressed point — the form did:key specifies for P-256. */
    async exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
      const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key));
      return p256.Point.fromBytes(raw).toBytes(true);
    },

    /** Accepts a compressed or uncompressed point, and imports each key once: decompressing costs a square root. */
    importPublicKey(bytes: Uint8Array): Promise<CryptoKey> {
      const id = bytesToHex(bytes);
      const cached = publicKeys.get(id);
      if (cached) return cached;
      const uncompressed = p256.Point.fromBytes(bytes).toBytes(false);
      const imported = globalThis.crypto.subtle.importKey('raw', bufferSource(uncompressed), ECDSA, true, [
        'verify',
      ]);
      remember(id, imported);
      return imported;
    },

    importPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
      return globalThis.crypto.subtle.importKey('pkcs8', bufferSource(bytes), ECDSA, false, ['sign']);
    },
  });
}

function importJwk(fields: JsonWebKey, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', ...fields },
    ECDSA,
    extractable,
    usages,
  );
}

function remember(id: string, key: Promise<CryptoKey>): void {
  publicKeys.set(id, key);
  key.catch(() => publicKeys.delete(id));
  if (publicKeys.size > MAX_PUBLIC_KEYS) publicKeys.delete(publicKeys.keys().next().value!);
}
