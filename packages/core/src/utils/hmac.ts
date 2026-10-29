/**
 * HMAC-SHA256 keys derived by HKDF-SHA256, for tags and keys a keeper can
 * compare but not reverse.
 * @module hmac
 */
import { utf8Encode } from './encoding.js';
import { bufferSource } from './guards.js';

/** A signing-only HMAC-SHA256 key, derived from `secret` by HKDF-SHA256 with an empty salt */
export async function hkdfHmacKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await globalThis.crypto.subtle.importKey('raw', bufferSource(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** The first `length` bytes of HMAC over a text */
export async function hmacPrefix(key: CryptoKey, text: string, length: number): Promise<Uint8Array> {
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, utf8Encode(text));
  return new Uint8Array(mac).subarray(0, length);
}
