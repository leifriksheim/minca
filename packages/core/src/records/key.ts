/**
 * Record keys: their shape, and whose they are (spec 02 §4.1).
 *
 * Outside `sys.*`, a record's first version must be at a key of one of two
 * kinds, so that whose a record is, and which collection it is in, can be
 * read from its key, and no member can take over another's:
 *
 * - **owned**, `<owner>.<name>`: `<owner>` is a hash of the creator's account
 *   and the collection, so only that account can write a first version there,
 *   and only in that collection. A fresh key is an owned key with a random
 *   name; a key an app chooses (`profile`, a line) is an owned key with that
 *   name.
 * - **shared**, `one:<tag>.<hex>`: a `onePer` key that does not name its
 *   author (one decision per proposal), anyone's to write first. `<tag>` is a
 *   hash of the collection.
 *
 * On its own so that `version` and `links` can both check a key's shape
 * without importing each other.
 */
import { base32Encode, sha256 } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';

/** What any record key looks like: `profile`, `collection:app.todo.item`, an owned key */
export const RECORD_KEY_PATTERN = /^[a-z0-9:._-]{1,128}$/;

/** Characters of the owner part of an owned key, and of a shared key's tag: 16 bytes of hash, base32 */
const TAG_LENGTH = 26;
/** An owned key: the owner part, a dot, and a name of 1–101 key characters */
const OWNED_KEY_PATTERN = /^[a-z2-7]{26}\.[a-z0-9:._-]{1,101}$/;
/** A shared `onePer` key: `one:`, the collection's tag, a dot, and 20 bytes of HMAC in hex */
const SHARED_KEY_PATTERN = /^one:[a-z2-7]{26}\.[0-9a-f]{40}$/;
/** Where a shared key's tag starts, after `one:` */
const SHARED_TAG_START = 4;

/** A line's key: `<owner>.line` ({@link lineKey}) */
const LINE_KEY_PATTERN = /^[a-z2-7]{26}\.line$/;

/** Whether a key has a line key's form, whoever's line and whichever collection's it is */
export const hasLineKeyForm = (key: string): boolean => LINE_KEY_PATTERN.test(key);

/** Which kind a key is, or null when it is neither (and so no first version outside `sys.*` may use it) */
export function keyKind(key: string): 'owned' | 'shared' | null {
  return OWNED_KEY_PATTERN.test(key) ? 'owned' : SHARED_KEY_PATTERN.test(key) ? 'shared' : null;
}

/** The first 16 bytes of SHA-256 over `input`, in base32 */
async function tagOf(input: string): Promise<string> {
  return base32Encode((await sha256(utf8Encode(input))).subarray(0, 16));
}

/**
 * The owner part of every key an account owns in a collection. Root DIDs are
 * not lower case, so a key names a hash of one; they hold no `|`, so the
 * input reads one way.
 */
export function ownerTag(root: string, collection: string): Promise<string> {
  return tagOf(`minca/record-owner/v2|${root}|${collection}`);
}

/** The tag that names a collection in its shared keys */
function sharedKeyTag(collection: string): Promise<string> {
  return tagOf(`minca/shared-key/v1|${collection}`);
}

/** The key `name` has in `root`'s namespace in a collection: `<owner>.<name>` */
export async function ownedKey(root: string, collection: string, name: string): Promise<string> {
  const key = `${await ownerTag(root, collection)}.${name}`;
  if (!OWNED_KEY_PATTERN.test(key))
    throw new Error('A record key name is 1–101 characters of a–z, 0–9 and : . _ -');
  return key;
}

/** A shared key of a collection's, for a `onePer` HMAC in hex: `one:<tag>.<hex>` */
export async function sharedKey(collection: string, hex: string): Promise<string> {
  return `one:${await sharedKeyTag(collection)}.${hex}`;
}

/** A fresh key of `root`'s in a collection: 128 random bits as its name. Random rather than time-based, so it says nothing about when. */
export function newRecordKey(root: string, collection: string): Promise<string> {
  return ownedKey(root, collection, base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(16))));
}

/** Whether `key` is an owned key of `root`'s in `collection` */
export async function ownsKey(key: string, root: string, collection: string): Promise<boolean> {
  return keyKind(key) === 'owned' && key.slice(0, TAG_LENGTH) === (await ownerTag(root, collection));
}

/** Whether `key` is a shared key of `collection`'s */
export async function isSharedKeyOf(key: string, collection: string): Promise<boolean> {
  return (
    keyKind(key) === 'shared' &&
    key.slice(SHARED_TAG_START, SHARED_TAG_START + TAG_LENGTH) === (await sharedKeyTag(collection))
  );
}

/**
 * The key of an account's line in a collection (`spec/09-contracts.md`): an
 * owned key, so only that account can write a version in it.
 */
export function lineKey(root: string, collection: string): Promise<string> {
  return ownedKey(root, collection, 'line');
}
