/**
 * The account's own list of spaces, kept in a space.
 *
 * Without it, which spaces an account belongs to lives on each device alone: a
 * new phone, a new app or an always-on node has to be handed every invite. With
 * it, joining a space on one device writes a membership record into a private
 * space only the account can find, and every other device and node of the
 * account syncs that record and joins by itself.
 *
 * The registry's key and nonce are derived from the account key, and
 * its id is the hash of its constitution like any space's — so nothing needs to be
 * exchanged to find it, and nobody without the account can. The DID alone is
 * not enough: it appears in everything the account signs, and a room named
 * after it could be found by anyone who had seen its data.
 */
import type { CryptoProvider, Space } from '../types.js';
import type { SpaceRecord } from './space-manager.js';
import { spaceKeyFromRaw } from '../privacy/space-encryption.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { isObject } from '../utils/guards.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { deriveReadKey, expandSecret } from './space-access.js';
import { CONSTITUTION, spaceIdOf, type Constitution } from './constitution.js';
import { STRONG_REMOVE } from './roles.js';
import { solo } from './presets.js';
import { FOUNDER } from './space-manager.js';

/**
 * Where the account's list of spaces lives, one record per space it follows.
 * Not to be confused with `sys.member`, a space's own record of who holds
 * which role there.
 */
export const MEMBERSHIP_COLLECTION = 'sys.joined';

/**
 * The account's profile — what it is called — so a rename on one device or app
 * reaches the others. The newest record wins.
 */
export const PROFILE_COLLECTION = 'sys.profile';

/** The profile's record key — there is one profile per account */
export const PROFILE_KEY = 'profile';

export interface AccountProfile {
  readonly name: string;
  /** The account's picture, a file in the registry (`records.addFile`) */
  readonly avatar?: AvatarRef;
}

/** A picture, as a profile names it: the file, what it is, and, in a space, which registry file it is a copy of */
export interface AvatarRef {
  readonly hash: string;
  readonly size: number;
  readonly key: string;
  readonly salt: string;
  readonly mime: string;
  readonly source?: string;
}

/** Whether something is a picture a profile can name */
export function isAvatarRef(value: unknown): value is AvatarRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref: Record<string, unknown> = { ...value };
  return (
    typeof ref.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(ref.hash) &&
    typeof ref.size === 'number' &&
    typeof ref.key === 'string' &&
    typeof ref.salt === 'string' &&
    typeof ref.mime === 'string' &&
    ref.mime.startsWith('image/')
  );
}

/** A membership record's body. The invite carries a private space's key — the registry is encrypted. */
export interface Membership {
  readonly space: string;
  readonly invite: string;
}

/**
 * Short invite links the account keeps (spec 03 §13.2), one record each, key
 * `link:<hex of the pin>`. The sealed invite and what it is for, never the
 * link's secret: a device drops the blob again, and closes the invite when
 * it ends; a host serves it from the copy in its carry space.
 */
export const LINK_COLLECTION = 'sys.link';

/** A kept link's body */
export interface KeptLink {
  /** The space it is to */
  readonly space: string;
  /** The sealed invite, exactly as the link's pin names it */
  readonly blob: string;
  /** The invite's DID, for a role link: closed when the link ends */
  readonly invite?: string;
  /** The id of the space key the blob carries: a key change ends the link */
  readonly keyId?: string;
  /** When to stop serving it, ms */
  readonly until?: number;
}

/** Whether a body is a kept link's */
export function isKeptLink(body: unknown): body is KeptLink {
  return (
    isObject(body) &&
    typeof body.space === 'string' &&
    typeof body.blob === 'string' &&
    body.blob.length <= 12_000 &&
    (body.invite === undefined || typeof body.invite === 'string') &&
    (body.keyId === undefined || typeof body.keyId === 'string') &&
    (body.until === undefined || (typeof body.until === 'number' && Number.isFinite(body.until)))
  );
}

/**
 * Carriers the account uses — a browser extension keeping its spaces online,
 * say — one record each, key `carrier:<carry space id hash>`. Every device of
 * the account reads them and keeps each carrier's passes current (`space/pass.ts`).
 */
export const CARRIER_COLLECTION = 'sys.carrier';

/** A carrier record's body */
export interface Carrier {
  /** The carrier's own key, as it appears to peers */
  readonly did: string;
  /** What it called itself */
  readonly name: string;
  readonly since: string;
  /** How many times the account used it before: its carry space is derived from this and `did` */
  readonly gen?: number;
  /** When the account stopped using it. Kept, so adding it again takes a new carry space. */
  readonly removed?: string;
  /** Added before carry spaces were derived: the carry space made for it, and a view-only invite to it */
  readonly space?: string;
  readonly invite?: string;
}

/**
 * The account's registry space, derived — the same on every device.
 * @param accountKey The account's account key (`deriveAccountKey(seed)`)
 */
export function deriveAccountRegistry(
  accountKey: Uint8Array,
  owner: string,
  provider: CryptoProvider = createP256Provider(),
): Promise<SpaceRecord> {
  return deriveAccountSpace(accountKey, owner, 'minca/account-registry', 'Account registry', provider);
}

/**
 * The account's contacts space, derived the same way: one `std.contact` per
 * person (`schemas/contacts.ts`). Its own space, not part of the registry, so
 * an app can be given the contacts without the whole account.
 */
export function deriveContactsSpace(
  accountKey: Uint8Array,
  owner: string,
  provider: CryptoProvider = createP256Provider(),
): Promise<SpaceRecord> {
  return deriveAccountSpace(accountKey, owner, 'minca/contacts', 'Contacts', provider);
}

/**
 * A carrier's carry space, derived the same way and bound to its key: the
 * carrier is handed its key, so each carrier gets one of its own. `gen`
 * counts the times the account used it before, so one added again after a
 * removal is not handed the space that told it to forget.
 */
export function deriveCarrySpace(
  accountKey: Uint8Array,
  owner: string,
  carrier: string,
  gen: number,
  provider: CryptoProvider = createP256Provider(),
): Promise<SpaceRecord> {
  return deriveAccountSpace(accountKey, owner, 'minca/carry', 'Carry space', provider, `|${carrier}|${gen}`);
}

/** A private space only the account can find: its key and nonce derived from the account key under `label`. */
async function deriveAccountSpace(
  accountKey: Uint8Array,
  owner: string,
  label: string,
  name: string,
  provider: CryptoProvider,
  bound = '',
): Promise<SpaceRecord> {
  const nonce = base64UrlEncode(
    (await expandSecret(accountKey, `${label}/nonce/v1${bound}`)).subarray(0, 12),
  );
  const createdAt = new Date(0).toISOString(); // fixed, so every device derives the same record
  const key = await spaceKeyFromRaw(await expandSecret(accountKey, `${label}/key/v1${bound}`), createdAt);
  const fixed: Constitution = {
    minca: CONSTITUTION,
    name,
    visibility: 'private',
    resolver: STRONG_REMOVE,
    top: { founders: [owner] },
    roles: solo.roles,
    createdAt,
    nonce,
    readKey: (await deriveReadKey(key, provider)).did,
    encryptionKeyId: key.id,
  };
  const space: Space = Object.freeze({ id: await spaceIdOf(fixed), ...fixed });
  return { space, key, invite: null, role: FOUNDER };
}
