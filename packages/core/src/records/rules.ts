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
import { bufferSource, isRecord, readField } from '../utils/guards.js';
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

/** Why a set of rules is malformed, or null when it is not */
export function checkRules(rules: unknown, at = 'rules'): string | null {
  if (rules === undefined) return null;
  if (!isRecord(rules)) return `${at} must be an object`;
  const r = rules;
  for (const key of Object.keys(r)) {
    if (['create', 'edit', 'delete'].includes(key))
      return `${at}.${key} is gone: who may write is the space's grants (spec 02 §7)`;
    // Where an older library kept a contract. Peers keep it unread, so onePer, fixed and final
    // still hold; readers leave the collection unjudged until it is defined again (spec 02 §7.6).
    if (key === 'check') continue;
    if (!['onePer', 'fixed', 'final'].includes(key))
      return `${at}.${key} is not a rule (use onePer, fixed, final)`;
  }
  if (r.final !== undefined && r.final !== true) return `${at}.final must be true`;
  for (const list of ['onePer', 'fixed']) {
    const value = r[list];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((v) => typeof v === 'string' && v.length > 0)
    ) {
      return `${at}.${list} must be a non-empty list of names`;
    }
  }
  return null;
}

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
    'spaceKey' in material
      ? bufferSource(material.spaceKey)
      : utf8Encode(`weave/public-one-per/v1|${material.spaceId}`);
  const base = await globalThis.crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode('weave/one-per/v1') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
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
  const parts: string[] = [collection];
  for (const part of onePer) {
    if (part === '@author') {
      parts.push(`@author=${record.root}`);
    } else if (part.startsWith('link:')) {
      const rel = part.slice(5);
      const link = record.links.find((l) => l.rel === rel);
      if (!link) return null;
      parts.push(`${part}=${link.to}`);
    } else {
      const value = readField(record.body, part);
      if (value === undefined) return null;
      parts.push(`${part}=${canonicalize(value)}`);
    }
  }
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', secret, utf8Encode(parts.join('\n'))),
  );
  const name = `one:${bytesToHex(mac.subarray(0, 20))}`;
  return onePer.includes('@author') ? ownedKey(record.root, name) : name;
}

/** The first fixed field whose value differs from the record's first version, or null */
export function changedFixedField(
  fixed: ReadonlyArray<string> | undefined,
  first: unknown,
  next: unknown,
): string | null {
  for (const field of fixed ?? []) {
    const a = readField(first, field);
    const b = readField(next, field);
    // Canonical, so a reordered object is the same value; `undefined` is absent on both sides alike.
    if ((a === undefined) !== (b === undefined) || (a !== undefined && canonicalize(a) !== canonicalize(b)))
      return field;
  }
  return null;
}
