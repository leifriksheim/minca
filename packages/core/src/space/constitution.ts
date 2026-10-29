/**
 * @module space/constitution
 * A space's constitution: what it is, fixed at creation (spec 03 §1).
 *
 * The constitution names its format, the space's name and visibility, the
 * algorithm that resolves changes made apart (`resolver`), who sits at the
 * top (its founders, or no one), the roles it is founded with and their
 * grants, the roles it assigns at the start, and the space it succeeds, if
 * any. Its hash is the space id, so nobody who hands a space on can change
 * any of it. A peer that doesn't know a constitution's format, its resolver
 * or one of its fields doesn't judge the space at all: it would judge it
 * differently from those who do.
 */
import type { Space, SpaceTop } from '../types.js';
import { canonicalize } from '../schema/version.js';
import { cidDigest, cidFromBytes, cidOfDigest } from '../utils/hash.js';
import { utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { didToPublicKey, P256_MULTICODEC } from '../identity/did.js';
import { checkFoundingRoles } from './grants.js';
import { RESOLVERS, type AccessGenesis } from './roles.js';

/** The constitution's format */
export const CONSTITUTION = 'constitution/1';

/** How many founders a space may name */
const MAX_FOUNDERS = 16;
/** How many accounts a constitution may assign roles to */
const MAX_ASSIGNED = 64;
/** How many roles it may assign one account */
const MAX_ASSIGNED_ROLES = 16;
/** How long a space's name may be, in code points */
const MAX_NAME = 100;

/** What the space id is the hash of */
export type Constitution = Omit<Space, 'id'>;

const FIELDS: ReadonlySet<string> = new Set([
  'minca',
  'name',
  'visibility',
  'resolver',
  'top',
  'roles',
  'assigned',
  'succeeds',
  'createdAt',
  'nonce',
  'readKey',
  'encryptionKeyId',
]);

/** A space's constitution: the space without its id, each optional field only when present */
export function constitutionOf(space: Constitution): Constitution {
  return {
    minca: space.minca,
    name: space.name,
    visibility: space.visibility,
    resolver: space.resolver,
    top: space.top,
    roles: space.roles,
    ...(space.assigned !== undefined ? { assigned: space.assigned } : {}),
    ...(space.succeeds !== undefined ? { succeeds: space.succeeds } : {}),
    createdAt: space.createdAt,
    nonce: space.nonce,
    ...(space.readKey !== undefined ? { readKey: space.readKey } : {}),
    ...(space.encryptionKeyId !== undefined ? { encryptionKeyId: space.encryptionKeyId } : {}),
  };
}

/** base64url of 12 bytes */
const NONCE = /^[A-Za-z0-9_-]{16}$/;
/** A space key's id: base64url of 16 bytes (spec 03 §8.1) */
const KEY_ID = /^[A-Za-z0-9_-]{22}$/;
/** ISO 8601, as `Date.prototype.toISOString` writes it */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && ISO_TIME.test(value) && new Date(value).toISOString() === value;

/** Whether a string is a P-256 `did:key` */
function isKeyDid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const { publicKeyBytes, multicodecPrefix } = didToPublicKey(value);
    return (
      publicKeyBytes.length === 33 &&
      multicodecPrefix.length === P256_MULTICODEC.length &&
      multicodecPrefix.every((byte, i) => byte === P256_MULTICODEC[i])
    );
  } catch {
    return false;
  }
}

/** The id a space with this constitution has: the CID of its canonical JSON */
export function spaceIdOf(constitution: Constitution): Promise<string> {
  return cidFromBytes(utf8Encode(canonicalize(constitutionOf(constitution))));
}

/** Whether a string is a space id: a CID, in its one spelling */
export function isSpaceId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const digest = cidDigest(value);
  return digest !== null && cidOfDigest(digest) === value;
}

const isAccount = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('did:key:') && value.length <= 200;

/** The founders a space names: none under `top: "none"` */
export function foundersOf(space: { readonly top: SpaceTop }): ReadonlyArray<string> {
  return space.top === 'none' ? [] : space.top.founders;
}

/**
 * The one account a space is founded by and for, or null: one founder and
 * nothing assigned. What a space for two, or a carry space, must be when
 * it arrives: its maker its only member (spec 03 §14, 07).
 */
export function soleFounder(space: Pick<Space, 'top' | 'assigned'>): string | null {
  const founders = foundersOf(space);
  return founders.length === 1 && space.assigned === undefined ? founders[0]! : null;
}

/** Why a `top` is malformed, or null */
function topProblem(top: unknown): string | null {
  if (top === 'none') return null;
  if (!isRecord(top) || Object.keys(top).length !== 1 || !Array.isArray(top.founders))
    return 'Its top is "none" or { founders }';
  const founders: unknown[] = top.founders;
  if (founders.length === 0 || founders.length > MAX_FOUNDERS)
    return `A space has 1 to ${MAX_FOUNDERS} founders, or none at the top`;
  if (!founders.every(isAccount)) return 'A founder is named by its did:key';
  return new Set(founders).size === founders.length ? null : 'A founder is named twice';
}

/** Why the roles a constitution assigns are malformed, or null. With no founders, someone must be assigned. */
function assignedProblem(assigned: unknown, top: unknown, roles: unknown): string | null {
  if (assigned === undefined)
    return top === 'none' ? 'With no founders, it must assign someone a role' : null;
  if (!isRecord(assigned)) return 'What it assigns is a map from account to role names';
  const accounts = Object.keys(assigned);
  if (accounts.length === 0 || accounts.length > MAX_ASSIGNED)
    return `It assigns roles to 1 to ${MAX_ASSIGNED} accounts, or leaves assigned out`;
  const founded = new Set(
    Array.isArray(roles) ? roles.map((role: { readonly name: string }) => role.name) : [],
  );
  for (const account of accounts) {
    if (!isAccount(account)) return 'An account is assigned by its did:key';
    const names: unknown = assigned[account];
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_ASSIGNED_ROLES)
      return `It assigns an account 1 to ${MAX_ASSIGNED_ROLES} roles`;
    const list: unknown[] = names;
    if (!list.every((name) => typeof name === 'string' && founded.has(name)))
      return 'It assigns only roles it founds';
    if (new Set(list).size !== list.length) return 'It assigns an account a role once';
  }
  return null;
}

/** Why a space's read key and first key don't fit its visibility, or null */
function keysProblem(
  visibility: 'public' | 'private',
  readKey: unknown,
  encryptionKeyId: unknown,
): string | null {
  if (visibility === 'public')
    return readKey !== undefined || encryptionKeyId !== undefined ? 'A public space has no read key' : null;
  return isKeyDid(readKey) && typeof encryptionKeyId === 'string' && KEY_ID.test(encryptionKeyId)
    ? null
    : 'A private space must name its read key, a did:key, and its first key, by id';
}

/**
 * Why a constitution can't be judged here, or null when it can. A format or a
 * resolver this peer doesn't know, or a field it doesn't, leaves the space
 * unjudged: the reason says so.
 */
export function constitutionProblem(constitution: unknown): string | null {
  if (!isRecord(constitution)) return 'A constitution is an object';
  if (constitution.minca !== CONSTITUTION)
    return `It is not a ${CONSTITUTION} this peer knows, so it can't judge the space`;
  if (typeof constitution.resolver !== 'string' || !RESOLVERS.has(constitution.resolver))
    return 'It names a resolver this peer doesn’t know, so it can’t judge the space';
  const unknown = Object.keys(constitution).find((field) => !FIELDS.has(field));
  if (unknown !== undefined)
    return `It has a field this peer doesn’t know, ${unknown}, so it can’t judge the space`;
  const { name, visibility, top, roles, assigned, succeeds } = constitution;
  if (typeof name !== 'string' || Array.from(name).length > MAX_NAME)
    return `Its name is text of at most ${MAX_NAME} characters`;
  if (visibility !== 'public' && visibility !== 'private') return 'Its visibility is not public or private';
  if (!isTime(constitution.createdAt)) return 'Its createdAt is an ISO 8601 time, as toISOString writes it';
  if (typeof constitution.nonce !== 'string' || !NONCE.test(constitution.nonce))
    return 'Its nonce is 16 base64url characters';
  return (
    topProblem(top) ??
    checkFoundingRoles(roles) ??
    assignedProblem(assigned, top, roles) ??
    (succeeds !== undefined && !isSpaceId(succeeds) ? 'It succeeds a space, named by its id' : null) ??
    keysProblem(visibility, constitution.readKey, constitution.encryptionKeyId)
  );
}

/**
 * Why a space someone handed over can't be trusted, or null when it can: its
 * constitution must be one this peer judges, and its id the hash of it.
 */
export async function checkSpace(space: unknown): Promise<string | null> {
  if (!isRecord(space) || typeof space.id !== 'string') return 'It is missing what identifies it';
  const { id, ...rest } = space;
  const problem = constitutionProblem(rest);
  if (problem) return problem;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- constitutionProblem checked every field
  const constitution = rest as unknown as Constitution;
  return (await spaceIdOf(constitution)) === id ? null : 'Its id does not match what it says about itself';
}

/** What the replay starts from: the space's founders, roles and first assignments */
export function accessGenesisOf(space: Space): AccessGenesis {
  return {
    id: space.id,
    resolver: space.resolver,
    founders: foundersOf(space),
    roles: space.roles,
    ...(space.assigned !== undefined ? { assigned: space.assigned } : {}),
    ...(space.visibility === 'private' && space.encryptionKeyId !== undefined && space.readKey !== undefined
      ? { key: { keyId: space.encryptionKeyId, readKey: space.readKey } }
      : {}),
  };
}
