/**
 * What a collection's definition asks of its records, besides their shape:
 * what must be unique, which fields are fixed at creation, and whether a
 * record is written once. Who may write is not the definition's to say: it
 * is the space's grants (`space/grants.ts`), held by roles.
 *
 * "At most one per…" is not checked against other records (no peer ever holds
 * them all). It is made true by construction: the record's key is derived from
 * what must be unique, so a second vote *is* the first one's next version.
 *
 * What these can't say, a contract can: conditions over the body, the version
 * before and versions it cites. It is the definition's `contract`, apart from
 * these, because readers judge it and peers don't (`records/contracts.ts`).
 */
import { ownedKey } from './key.js';
import { canonicalize } from '../schema/version.js';
import { bytesToHex, utf8Encode } from '../utils/encoding.js';
import { isRecord, readField } from '../utils/guards.js';
import { hkdfHmacKey, hmacPrefix } from '../utils/hmac.js';
import type { Link } from '../types.js';

export interface CollectionRules {
  /**
   * At most one record per combination of these — by construction: the key is
   * derived from them. `@author` is the writer's identity, `link:<rel>` the
   * record a link points at, anything else a field of the body.
   * `['@author', 'link:about']` is one vote per person per poll.
   */
  readonly onePer?: ReadonlyArray<string>;
  /** Fields that keep the value the record was created with */
  readonly fixed?: ReadonlyArray<string>;
  /**
   * Records are written once: no edit and no delete, by anyone. A vote, a
   * ballot or a proof that others count on stays what it was.
   */
  readonly final?: true;
}

const RULES = ['onePer', 'fixed', 'final'];
/** Rules that moved elsewhere, and where to */
const GONE: Readonly<Record<string, string>> = {
  create: "who may write is the space's grants (spec 02 §7)",
  edit: "who may write is the space's grants (spec 02 §7)",
  delete: "who may write is the space's grants (spec 02 §7)",
  check: "a contract is the definition's contract.check (spec 09 §1)",
};

/** Why a set of rules is malformed, or null when it is not */
export function checkRules(rules: unknown, at = 'rules'): string | null {
  if (rules === undefined) return null;
  if (!isRecord(rules)) return `${at} must be an object`;
  for (const key of Object.keys(rules)) {
    const gone = Object.hasOwn(GONE, key) ? GONE[key] : undefined;
    if (gone) return `${at}.${key} is gone: ${gone}`;
    if (!RULES.includes(key)) return `${at}.${key} is not a rule (use onePer, fixed, final)`;
  }
  if (rules.final !== undefined && rules.final !== true) return `${at}.final must be true`;
  for (const list of ['onePer', 'fixed']) {
    const value = rules[list];
    if (value !== undefined && !isNameList(value)) return `${at}.${list} must be a non-empty list of names`;
  }
  return null;
}

const isNameList = (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0);

/**
 * What a space's `onePer` keys are keyed with (spec 02 §7.3): from its first
 * space key in a private space, which every reader holds and which never
 * changes, so only readers can compute or test a key; from its id in a
 * public one, where anyone can.
 */
export async function onePerSecret(
  material: { readonly spaceKey: Uint8Array } | { readonly spaceId: string },
): Promise<CryptoKey> {
  const secret =
    'spaceKey' in material ? material.spaceKey : utf8Encode(`minca/public-one-per/v1|${material.spaceId}`);
  return hkdfHmacKey(secret, 'minca/one-per/v1');
}

/**
 * The key a record must have under `onePer`, or null when something it names
 * is missing (no such link, no such field). With `@author` among the parts,
 * an owned key of the author's (`records/key.ts`), so no one else can write
 * its first version; without, a shared `one:` key.
 */
export async function onePerKey(
  secret: CryptoKey,
  collection: string,
  onePer: ReadonlyArray<string>,
  record: { root: string; links: ReadonlyArray<Link>; body: unknown },
): Promise<string | null> {
  const parts = onePer.map((part) => onePerPart(part, record));
  if (parts.includes(null)) return null;
  const mac = await hmacPrefix(secret, [collection, ...parts].join('\n'), 20);
  const name = `one:${bytesToHex(mac)}`;
  return onePer.includes('@author') ? ownedKey(record.root, name) : name;
}

/** One part of a `onePer` key's input: `<part>=<value>`, or null when the record has no value for it */
function onePerPart(
  part: string,
  record: { root: string; links: ReadonlyArray<Link>; body: unknown },
): string | null {
  if (part === '@author') return `@author=${record.root}`;
  if (part.startsWith('link:')) {
    const link = record.links.find((l) => l.rel === part.slice(5));
    return link ? `${part}=${link.to}` : null;
  }
  const value = readField(record.body, part);
  return value === undefined ? null : `${part}=${canonicalize(value)}`;
}

/** The first fixed field whose value differs from the record's first version, or null */
export function changedFixedField(
  fixed: ReadonlyArray<string> | undefined,
  first: unknown,
  next: unknown,
): string | null {
  return fixed?.find((field) => !sameValue(readField(first, field), readField(next, field))) ?? null;
}

/** Canonical, so a reordered object is the same value; absent is absent on both sides alike */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalize(a) === canonicalize(b);
}
