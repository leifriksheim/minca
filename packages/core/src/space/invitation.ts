/**
 * Invitations (spec 03 §7.4): an invite to a space, signed.
 *
 * An invitation is a loose version (02 §3.5) in `sys.invitation`, signed by
 * the inviter's key under its account's note. So who invited, and the relays
 * and nodes it names, are the inviter's word, signed, and nobody passing the
 * link on can change them. An invite secret is never in it: it rides beside,
 * so the same invitation serves a long link and a short one (§7.7), whose
 * secret is derived from the link's own.
 *
 * ```
 * invite = base64url(canonical(invitation)) [ "." base64url(secret) ]
 * body   = { space, key?, role?, relays?, nodes? }
 * ```
 */
import type { CryptoProvider, Space, Version } from '../types.js';
import { checkLoose, decodeLoose, encodeLoose, signLoose, type LooseSigner } from '../records/loose.js';
import { ACCESS_COMMAND, READ_COMMAND } from '../identity/abilities.js';
import { noteCovers, parseDelegation } from '../identity/ucan.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { INVITE_COLLECTION } from './roles.js';

/** The collection an invitation is a loose version in */
export const INVITATION_COLLECTION = 'sys.invitation';

/** What an invitation's body says */
export interface InvitationBody {
  readonly space: Space;
  /** Raw AES key material, base64url: present only for a private space */
  readonly key?: string;
  /** The role its secret opens, for showing before joining; the space's invite record is what counts */
  readonly role?: string;
  /** Where the space's members meet */
  readonly relays?: ReadonlyArray<string>;
  /** Always-on nodes that hold the space, pinned by DID */
  readonly nodes?: ReadonlyArray<string>;
}

/** An invite string, read */
export interface ReadInvitation {
  /** The invitation as it came, not yet checked */
  readonly version: Version & { readonly body: InvitationBody };
  /** The invite secret beside it, base64url, when it opens a role */
  readonly secret?: string;
}

/** Signs an invitation, and writes it with its secret, if any, as an invite string */
export async function encodeInvitation(
  signer: LooseSigner,
  body: InvitationBody,
  provider: CryptoProvider,
  secret?: Uint8Array,
): Promise<string> {
  const version = await signLoose(signer, INVITATION_COLLECTION, body, provider);
  return writeInvitation(version, secret);
}

/** An invitation already signed, with a secret beside it */
export function writeInvitation(version: Version, secret?: Uint8Array): string {
  return secret ? `${encodeLoose(version)}.${base64UrlEncode(secret)}` : encodeLoose(version);
}

/**
 * Reads an invite string, checking only that it is an invitation with a space
 * in it; whether it is signed as it says is {@link checkInvitation}'s question.
 * @throws When it isn't one
 */
export function readInvitation(text: string): ReadInvitation {
  const [encoded = '', secret, ...rest] = text.trim().split('.');
  const version = decodeLoose(encoded);
  if (
    rest.length > 0 ||
    !isRecord(version) ||
    version.collection !== INVITATION_COLLECTION ||
    !isRecord(version.body) ||
    !isRecord(version.body.space) ||
    typeof version.body.space.id !== 'string' ||
    typeof version.body.space.name !== 'string' ||
    (secret !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(secret))
  )
    throw new Error('That invite could not be read — it may be truncated or from another app.');
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- its space is checked above; checkInvitation checks the signature and the rest
  const signed = version as unknown as ReadInvitation['version'];
  return secret !== undefined ? { version: signed, secret } : { version: signed };
}

/** Whether a value is 32 bytes, base64url: what a space key is carried as */
function isSpaceKey(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return base64UrlDecode(value).length === 32;
}

/** The account an invitation says it is from, unchecked: its note's issuer, or its author */
export function invitedByOf(version: Version): string {
  return parseDelegation(version.proof)?.payload.iss ?? version.author;
}

/**
 * Why an invitation is not one its account signed, or null when it is: a
 * loose version in `sys.invitation`, its body well formed, and its note one
 * that lets the key act in that space: to change who may do what there when
 * it opens a role, to read there when it only shares it.
 */
export async function checkInvitation(version: unknown, provider: CryptoProvider): Promise<string | null> {
  const checked = await checkLoose(version, INVITATION_COLLECTION, provider);
  if (!checked) return 'it is not signed by the account it names';
  const body = checked.version.body;
  if (!isRecord(body) || !isRecord(body.space) || typeof body.space.id !== 'string')
    return 'it names no space';
  for (const member of Object.keys(body))
    if (!['space', 'key', 'role', 'relays', 'nodes'].includes(member))
      return `it has a ${member} it shouldn't`;
  if (body.key !== undefined && !isSpaceKey(body.key)) return 'its key is not a space key';
  if (body.role !== undefined && (typeof body.role !== 'string' || body.role.length > 64))
    return 'its role is not a role name';
  for (const list of [body.relays, body.nodes])
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string')))
      return 'its relays and nodes are lists of addresses';
  if (checked.note) {
    const space = body.space.id;
    const required =
      body.role !== undefined
        ? { space, cmd: ACCESS_COMMAND, args: { collection: INVITE_COLLECTION, space } }
        : { space, cmd: READ_COMMAND, args: { space } };
    if (!noteCovers(checked.note, required)) return "its key's note doesn't let it invite to that space";
  }
  return null;
}
