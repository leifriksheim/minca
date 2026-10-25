/**
 * Loose versions (spec 02 §3.5): signed versions that belong to no space.
 *
 * A loose version is a version of 02 §3 with no `space`, `log` or `seen`, at
 * `seq` 0. It is never stored in a space or synced: it is handed over, in a
 * link, a QR code, a mailbox or sealed inside a record. Its collection says
 * what it is (`sys.invitation`, `sys.inbox`, `sys.knock`), so a new kind is a
 * new collection name and is checked the same way.
 *
 * It is checked as any version is, its shape, id and signature, and its
 * `proof` against its `createdAt`. What a valid one counts as is its
 * collection's business; no space's history or rules are consulted.
 */
import type { CryptoProvider, Version } from '../types.js';
import { createVersion, canonicalize } from '../schema/version.js';
import { createSigner } from '../schema/signer.js';
import { checkVersionShape } from './version.js';
import { didToPublicKey } from '../identity/did.js';
import { verifyNote, UCAN_CLOCK_SKEW_SECONDS, type Delegation } from '../identity/ucan.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';

/** Who signs a loose version: a key, and the note that lets it act for its account (none when the account signs) */
export interface LooseSigner {
  readonly did: string;
  readonly key: CryptoKey;
  readonly proof?: Delegation;
}

/** A loose version that checked out */
export interface CheckedLoose<T = unknown> {
  readonly version: Version<T> & { readonly body: T };
  /** The account it speaks for: the note's issuer, or the author when there is none */
  readonly root: string;
  /** The note, when one was carried */
  readonly note: Delegation | null;
  /** `createdAt`, ms */
  readonly at: number;
}

/** Members a loose version never has */
const IN_A_SPACE = ['space', 'log', 'seen', 'prev', 'genesis', 'deleted', 'retain', 'links', 'tags'];

/** Signs a loose version */
export async function signLoose<T>(
  signer: LooseSigner,
  collection: string,
  body: T,
  provider: CryptoProvider,
  options: { readonly to?: string; readonly createdAt?: string } = {},
): Promise<Version<T> & { readonly body: T }> {
  const unsigned = createVersion({
    author: signer.did,
    collection,
    body,
    ...(options.to ? { to: options.to } : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    ...(signer.proof ? { proof: signer.proof } : {}),
  });
  return createSigner(provider).sign(unsigned, signer.key);
}

/** Why a value is not shaped as a loose version, or null */
export function looseShapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'It is not a version';
  for (const member of IN_A_SPACE) if (member in value) return `A loose version has no ${member}`;
  if (value.seq !== 0) return 'A loose version is a first version';
  if (typeof value.collection !== 'string' || value.collection.length === 0 || value.collection.length > 128)
    return 'It names no collection';
  if (typeof value.author !== 'string' || typeof value.signature !== 'string' || typeof value.id !== 'string')
    return 'It is not signed';
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))
    return 'It has no time';
  if (value.to !== undefined && (typeof value.to !== 'string' || value.to.length > 128))
    return 'Its to is not a key';
  if (!('body' in value)) return 'It has no body';
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- its members are checked one by one by checkVersionShape
  return checkVersionShape(value);
}

/**
 * Checks a loose version through: its shape, id, body and signature, and the
 * note it carries, valid at its `createdAt` and made out to its author.
 * @param collection The collection it must be in
 * @returns It, with the account it speaks for, or null when it is anything less
 */
export async function checkLoose(
  value: unknown,
  collection: string,
  provider: CryptoProvider,
): Promise<CheckedLoose | null> {
  if (looseShapeProblem(value) !== null || !isRecord(value) || value.collection !== collection) return null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shaped as one above; the signature decides the rest
  const version = value as unknown as Version & { readonly body: unknown };
  const at = Date.parse(version.createdAt);
  if (at > Date.now() + UCAN_CLOCK_SKEW_SECONDS * 1000) return null;
  try {
    const key = await provider.importPublicKey(didToPublicKey(version.author).publicKeyBytes);
    if (!(await createSigner(provider).verify(version, key))) return null;
  } catch {
    return null;
  }
  if (version.proof === undefined) return Object.freeze({ version, root: version.author, note: null, at });
  const checked = await verifyNote(version.proof, provider, { at: Math.floor(at / 1000) }).catch(() => null);
  if (!checked?.valid || checked.audience !== version.author) return null;
  return Object.freeze({ version, root: checked.root, note: checked.note, at });
}

/** A loose version as text: base64url of its canonical JSON */
export function encodeLoose(version: Version): string {
  return base64UrlEncode(utf8Encode(canonicalize(version)));
}

/** Reads what `encodeLoose` wrote, or null when it isn't JSON in base64url */
export function decodeLoose(text: string): unknown {
  try {
    return JSON.parse(utf8Decode(base64UrlDecode(text.trim())));
  } catch {
    return null;
  }
}
