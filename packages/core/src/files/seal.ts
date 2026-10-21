/**
 * A file's bytes, sealed: the records of RFC 8188's `aes128gcm` content
 * coding, without its header (spec 05 §16.6). The key and salt it would carry
 * are in the body instead, so records line up with chunks: record `i` is
 * chunk `i`. Every file is sealed, in a public space too, under a key of its
 * own.
 */
import { CHUNK } from './file-id.js';
import { bufferSource } from '../utils/guards.js';
import { base64UrlDecode, base64UrlEncode, concatBytes, utf8Encode } from '../utils/encoding.js';

/** What opens a sealed file: carried in the body, never on the outside */
export interface FileKey {
  /** 16 random bytes, base64url: RFC 8188's input keying material */
  readonly key: string;
  /** 16 random bytes, base64url */
  readonly salt: string;
}

const subtle = () => globalThis.crypto.subtle;

/** RFC 8188 §2.2 and §2.3: the content-encryption key and the base nonce, by HKDF-SHA-256 */
async function derive(key: FileKey): Promise<{ cek: CryptoKey; nonce: Uint8Array }> {
  const ikm = await subtle().importKey('raw', bufferSource(base64UrlDecode(key.key)), 'HKDF', false, [
    'deriveBits',
  ]);
  const salt = bufferSource(base64UrlDecode(key.salt));
  const bits = (info: string, length: number) =>
    subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8Encode(info) }, ikm, length);
  const cek = await subtle().importKey(
    'raw',
    await bits('Content-Encoding: aes128gcm\0', 128),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
  return { cek, nonce: new Uint8Array(await bits('Content-Encoding: nonce\0', 96)) };
}

/** The nonce of record `index`: the base nonce XOR the index, big-endian */
function nonceFor(base: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(base);
  let rest = index;
  for (let i = nonce.length - 1; i >= 0 && rest > 0; i--) {
    nonce[i]! ^= rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return nonce;
}

/** Plaintext bytes in a full record: the record, less the tag and the delimiter */
const plainPerRecord = (rs: number) => rs - 17;

/** Seals a file under a fresh key and salt. `rs` is RFC 8188's record size; files use `CHUNK`. */
export async function sealFile(
  plain: Uint8Array,
  rs: number = CHUNK,
  key: FileKey = {
    key: base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16))),
    salt: base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16))),
  },
): Promise<{ readonly bytes: Uint8Array; readonly key: FileKey }> {
  const { cek, nonce } = await derive(key);
  const per = plainPerRecord(rs);
  const count = Math.max(1, Math.ceil(plain.length / per));
  const records: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const piece = concatBytes(plain.subarray(i * per, (i + 1) * per), new Uint8Array([last ? 2 : 1]));
    records.push(
      new Uint8Array(
        await subtle().encrypt({ name: 'AES-GCM', iv: nonceFor(nonce, i) }, cek, bufferSource(piece)),
      ),
    );
  }
  return { bytes: concatBytes(...records), key };
}

/**
 * Opens records of a sealed file, one at a time, in any order: what a reader
 * seeking in a video needs. Throws for a record that is not that one, whole.
 */
export function fileOpener(
  key: FileKey,
): (record: Uint8Array, index: number, last: boolean) => Promise<Uint8Array> {
  const derived = derive(key);
  return async (record, index, last) => {
    const { cek, nonce } = await derived;
    const piece = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: nonceFor(nonce, index) }, cek, bufferSource(record)),
    );
    // The delimiter: 2 on the last record, 1 on every other, with only zeros (padding) after it.
    let end = piece.length - 1;
    while (end >= 0 && piece[end] === 0) end--;
    if (end < 0 || piece[end] !== (last ? 2 : 1)) throw new Error('Not this file’s record');
    return piece.subarray(0, end);
  };
}

/** Opens a whole sealed file */
export async function openFile(bytes: Uint8Array, key: FileKey, rs: number = CHUNK): Promise<Uint8Array> {
  const open = fileOpener(key);
  const count = Math.max(1, Math.ceil(bytes.length / rs));
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < count; i++)
    pieces.push(await open(bytes.subarray(i * rs, (i + 1) * rs), i, i === count - 1));
  return concatBytes(...pieces);
}
