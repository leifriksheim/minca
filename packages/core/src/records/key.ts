/**
 * Record keys: their shape, and whose they are (spec 02 §4.1).
 *
 * Outside `sys.*`, a record's first version must be at a key of one of two
 * kinds, so that whose a record is can be read from its key and no member can
 * take over another's:
 *
 * - **owned**, `<owner>.<name>`: `<owner>` is a hash of the creator's account,
 *   so only that account can write a first version there. A fresh key is an
 *   owned key with a random name; a key an app chooses (`profile`, a line) is
 *   an owned key with that name.
 * - **shared**, `one:<hex>`: a `onePer` key that does not name its author
 *   (one decision per proposal), anyone's to write first.
 *
 * On its own so that `version` and `links` can both check a key's shape
 * without importing each other.
 */
import { base32Encode, sha256 } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';

/** What any record key looks like: `profile`, `collection:app.todo.item`, an owned key */
export const RECORD_KEY_PATTERN = /^[a-z0-9:._-]{1,128}$/;

/** Characters of the owner part of an owned key: 16 bytes of hash, base32 */
const OWNER_LENGTH = 26;
/** An owned key: the owner part, a dot, and a name of 1–101 key characters */
const OWNED_KEY_PATTERN = /^[a-z2-7]{26}\.[a-z0-9:._-]{1,101}$/;
/** A shared `onePer` key: `one:` and 20 bytes of HMAC, in hex */
const SHARED_KEY_PATTERN = /^one:[0-9a-f]{40}$/;

/** Which kind a key is, or null when it is neither (and so no first version outside `sys.*` may use it) */
export function keyKind(key: string): 'owned' | 'shared' | null {
  return OWNED_KEY_PATTERN.test(key) ? 'owned' : SHARED_KEY_PATTERN.test(key) ? 'shared' : null;
}

/**
 * The owner part of every key an account owns: the first 16 bytes of
 * SHA-256 over a label and its root DID, in base32. Root DIDs are not lower
 * case, so a key names a hash of one.
 */
export async function ownerTag(root: string): Promise<string> {
  const digest = await sha256(utf8Encode(`weave/record-owner/v1|${root}`));
  return base32Encode(digest.subarray(0, 16));
}

/** The key `name` has in `root`'s namespace: `<owner>.<name>` */
export async function ownedKey(root: string, name: string): Promise<string> {
  const key = `${await ownerTag(root)}.${name}`;
  if (!OWNED_KEY_PATTERN.test(key))
    throw new Error('A record key name is 1–101 characters of a–z, 0–9 and : . _ -');
  return key;
}

/** A fresh key of `root`'s: 128 random bits as its name. Random rather than time-based, so it says nothing about when. */
export async function newRecordKey(root: string): Promise<string> {
  return ownedKey(root, base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(16))));
}

/** Whether `key` is an owned key of `root`'s */
export async function ownsKey(key: string, root: string): Promise<boolean> {
  return keyKind(key) === 'owned' && key.slice(0, OWNER_LENGTH) === (await ownerTag(root));
}

/**
 * The key of an account's line in a collection (`spec/drafts/constitution-grants-contracts.md`
 * §3): an owned key, so only that account can write a version in it. The
 * collection is hashed, so a line has a key whatever the collection's name.
 */
export async function lineKey(root: string, collection: string): Promise<string> {
  const digest = await sha256(utf8Encode(collection));
  return ownedKey(root, `line:${base32Encode(digest.subarray(0, 16))}`);
}
