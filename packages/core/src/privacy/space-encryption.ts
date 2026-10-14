/**
 * @module privacy/space-encryption
 * A private space's key, and the record bodies sealed under it (spec 03 §8).
 *
 * The 32 random bytes of a space key are only ever a root: the AES key that
 * seals, the key id, the read key and the topic key are each derived from
 * them under a label of their own, so publishing one says nothing of another.
 */
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { hkdf, hkdfAesKey } from '../identity/hkdf.js';
import { openEnvelope, sealEnvelope } from '../identity/envelope.js';
import { isRecord } from '../utils/guards.js';

const SPACE_KEY_BYTES = 32;
const SEAL_INFO = utf8Encode('minca/space-seal/v1');
const KEY_ID_INFO = utf8Encode('minca/space-key-id/v1');
const KEY_ID_BYTES = 16;

/** The envelope label of a record body; bound to `{ space, collection, key, keyId }` */
const RECORD_BODY_LABEL = 'minca/record-body/v1';
/** The envelope label of the earlier keys a `sys.key` carries; bound to `{ space, keyId }` */
export const EARLIER_KEYS_LABEL = 'minca/earlier-keys/v1';
/** The envelope label of a reader's note, sealed for a connection; bound to `{ space }` */
export const MEMBERSHIP_LABEL = 'minca/membership/v1';

/** A key of a private space */
export interface SpaceKey {
  /** `base64url(HKDF(K, "minca/space-key-id/v1", 16))`: names the key without giving it away */
  readonly id: string;
  /** K, the 32 random bytes. Only ever key material for HKDF, never a key itself. */
  readonly raw: Uint8Array;
  /** `HKDF(K, "minca/space-seal/v1")`: the AES-256-GCM key every envelope under this space key uses */
  readonly seal: CryptoKey;
  readonly createdAt: string;
  readonly version: number;
}

/** A record body sealed under a space key */
export interface EncryptedVersionBody {
  /** base64url of the envelope (spec 01 §9.1) */
  readonly sealed: string;
  readonly keyId: string;
}

/** Where a sealed body belongs: what a reader knows of the version before opening it */
export interface BodyPlace {
  readonly space: string;
  readonly collection: string;
  /** The record key */
  readonly key: string;
}

/** A space key's id, from its raw bytes */
async function spaceKeyId(raw: Uint8Array): Promise<string> {
  return base64UrlEncode(await hkdf(raw, KEY_ID_INFO, KEY_ID_BYTES));
}

/**
 * A space key from its raw bytes. Its id is derived from them, so a key
 * handed over (in an invite, a box) can be checked against the id a space or
 * its history names.
 */
export async function spaceKeyFromRaw(
  raw: Uint8Array,
  createdAt = new Date().toISOString(),
): Promise<SpaceKey> {
  if (raw.length !== SPACE_KEY_BYTES) throw new Error('A space key is 32 bytes');
  const bytes = new Uint8Array(raw);
  return Object.freeze({
    id: await spaceKeyId(bytes),
    raw: bytes,
    seal: await hkdfAesKey(bytes, SEAL_INFO),
    createdAt,
    version: 1,
  });
}

/** A new random space key */
export function generateSpaceKey(): Promise<SpaceKey> {
  return spaceKeyFromRaw(globalThis.crypto.getRandomValues(new Uint8Array(SPACE_KEY_BYTES)));
}

const bodyBound = (place: BodyPlace, keyId: string) => ({
  space: place.space,
  collection: place.collection,
  key: place.key,
  keyId,
});

/**
 * Seals a version's content (`{ body }`, or `{ body, links }`) for one record:
 * opened anywhere else, under another key id, or changed, it does not open.
 */
export async function sealBody(
  content: unknown,
  spaceKey: SpaceKey,
  place: BodyPlace,
): Promise<EncryptedVersionBody> {
  const sealed = await sealEnvelope(
    spaceKey.seal,
    RECORD_BODY_LABEL,
    bodyBound(place, spaceKey.id),
    utf8Encode(JSON.stringify(content)),
  );
  return Object.freeze({ sealed: base64UrlEncode(sealed), keyId: spaceKey.id });
}

/** Whether a body is a sealed one: `{ sealed, keyId }`, both strings */
export function isSealedBody(body: unknown): body is EncryptedVersionBody {
  return isRecord(body) && typeof body.sealed === 'string' && typeof body.keyId === 'string';
}

/**
 * Opens a sealed body with the key it names.
 * @returns The content, or null when the key is not the one it names, it was
 *   sealed for another record, or anything changed
 */
export async function openBody(body: unknown, spaceKey: SpaceKey, place: BodyPlace): Promise<unknown> {
  if (!isSealedBody(body) || body.keyId !== spaceKey.id) return null;
  try {
    const plain = await openEnvelope(
      spaceKey.seal,
      RECORD_BODY_LABEL,
      bodyBound(place, body.keyId),
      base64UrlDecode(body.sealed),
    );
    if (!plain) return null;
    const content: unknown = JSON.parse(utf8Decode(plain));
    return content;
  } catch {
    return null;
  }
}
