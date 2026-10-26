/**
 * @module inbox
 * The inbox: how someone you share no space with can ask to become your
 * contact, and the knock they leave there (spec 07).
 *
 * A DID is a name, not an address — knowing it must not be enough to reach
 * you. An account's **inbox** is an address it hands out on purpose: a key
 * knocks are sealed to, a signing key that proves the inbox is its own, and
 * up to three mailboxes that hold knocks. Both keys are derived from the
 * contact key and a generation, `gen`, so every device opens the same inbox,
 * and a new `gen` is a new inbox nobody can tie to the old one. Neither is the
 * contact key, whose public half is on the account's profile in every space:
 * an inbox says nothing about the account behind it.
 *
 * It travels as a **`sys.inbox`** loose version (spec 02 §3.5), signed by its
 * own signing key, in a link, a QR code or a bio. Someone with it **knocks**:
 * makes a private space for the two of them and leaves a **`sys.knock`**,
 * signed under their account's note and carrying the signed invitation to
 * that space, sealed to the inbox key. The same knock, sealed to the contact
 * key instead, goes in a `std.contact-request` in a space both belong to
 * (`packages/core/docs/contacts.md`).
 * Joining the space is the answer: only the holder of the key could open it.
 *
 * ```
 * inbox  = sys.inbox { key, sign, gen, places, name? }       — author: did:key of sign
 * knock  = sys.knock { invite, secret, name, note? }, to     — under a note with /account/write
 * sealed = HPKE(to, "minca/mail/v1", { to }, JSON(knock))
 * topic  = base64url(SHA-256("minca/inbox-topic/v1|" + sign))
 * ```
 */
import type { CryptoProvider, Version } from '../types.js';
import {
  contactKeyPair,
  contactPublicKey,
  isContactPublicKey,
  signWithScalar,
  signingKeyOf,
} from '../identity/contact-key.js';
import { openValueFrom, sealValueTo } from '../identity/hpke.js';
import { publicKeyToDid, P256_MULTICODEC } from '../identity/did.js';
import { noteCovers, UCAN_CLOCK_SKEW_SECONDS } from '../identity/ucan.js';
import { ACCOUNT_REQUIREMENT } from '../identity/abilities.js';
import { checkLoose, decodeLoose, encodeLoose, signLoose, type LooseSigner } from '../records/loose.js';
import { checkInvitation, invitedByOf, writeInvitation, type InvitationBody } from '../space/invitation.js';
import { checkSpace, soleFounder } from '../space/constitution.js';
import { checkRelays } from '../space/roles.js';
import { sha256 } from '../utils/hash.js';
import { isRecord } from '../utils/guards.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';

/** The collection an inbox is a loose version in */
export const INBOX_COLLECTION = 'sys.inbox';
/** The collection a knock is a loose version in */
export const KNOCK_COLLECTION = 'sys.knock';

/** An inbox names at most this many mailboxes: enough that one going away doesn't matter */
export const MAX_INBOX_PLACES = 3;
/** How long a knock waits in a mailbox, and so how old one may be when opened */
export const KNOCK_TTL_SECONDS = 14 * 24 * 3600;
/**
 * How far a knock's own time may be before when the relay took it. A knock is
 * dropped as soon as it is signed, so its time is checked against the relay's
 * — which the knocker can't choose — and a note that ran out can't be used by
 * dating a knock back to when it was good.
 */
export const KNOCK_DROP_WINDOW_SECONDS = 600;
const MAX_NAME = 64;
const MAX_NOTE = 2000;

/** The HPKE label a knock is sealed under; bound to `{ to }`, the key it is sealed to */
const MAIL_LABEL = 'minca/mail/v1';

/** What an inbox says: where to knock, and who the owner says they are */
export interface InboxBody {
  /** The inbox key's public half: a compressed P-256 point, base64url. Knocks are sealed to it. */
  readonly key: string;
  /** The inbox's signing key's public half, likewise. It signs the inbox; its hash is the topic. */
  readonly sign: string;
  /** Which inbox of the account this is: a new one is a new number */
  readonly gen: number;
  /** Mailboxes that hold its knocks, 1–3 */
  readonly places: ReadonlyArray<string>;
  /** Who the owner says they are — shown to the knocker, and proves nothing */
  readonly name?: string;
}

/** What a knock carries */
export interface KnockBody {
  /** The signed invitation to the space for two (spec 03 §7.4) */
  readonly invite: Version;
  /** Its invite secret, base64url: it opens the editor role there */
  readonly secret: string;
  /** The name the knocker gives; nothing vouches for it */
  readonly name: string;
  readonly note?: string;
}

/** A knock that opened and checked out */
export interface OpenedKnock {
  /** The knocker's account */
  readonly from: string;
  readonly name: string;
  readonly note?: string;
  /** The invite to the space for two, with its secret: what accepting joins */
  readonly invite: string;
  /** The id of the space for two */
  readonly pairSpace: string;
  /** When it was signed, ms */
  readonly at: number;
}

/** Cuts text to at most `max` characters without splitting one (a surrogate pair stays whole) */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** The did:key of an inbox's signing key: who an inbox is signed by */
export const inboxAuthor = (sign: string): string => publicKeyToDid(base64UrlDecode(sign), P256_MULTICODEC);

/** Why an inbox's body is not one, or null */
export function inboxProblem(body: unknown): string | null {
  if (!isRecord(body)) return 'it is not an inbox';
  for (const member of Object.keys(body))
    if (!['key', 'sign', 'gen', 'places', 'name'].includes(member)) return `it has a ${member} it shouldn't`;
  if (!isContactPublicKey(body.key)) return 'its key is not a P-256 public key';
  if (!isContactPublicKey(body.sign) || body.sign === body.key)
    return 'its signing key is not a P-256 public key of its own';
  if (typeof body.gen !== 'number' || !Number.isSafeInteger(body.gen) || body.gen < 0)
    return 'its gen is a whole number from 0';
  if (!Array.isArray(body.places) || body.places.length === 0 || body.places.length > MAX_INBOX_PLACES)
    return `it names 1–${MAX_INBOX_PLACES} mailboxes`;
  const places = checkRelays(body.places);
  if (places) return places;
  if (body.name !== undefined && (typeof body.name !== 'string' || Array.from(body.name).length > MAX_NAME))
    return `its name is text of at most ${MAX_NAME} characters`;
  return null;
}

const isInboxBody = (value: unknown): value is InboxBody => inboxProblem(value) === null;

/**
 * Signs an inbox with its own signing key, which signs for itself: no note,
 * so nothing in it names the account.
 * @param signKey The signing key's private scalar
 * @returns The inbox as its code: what goes in a link or a QR code
 */
export async function encodeInbox(
  signKey: Uint8Array,
  body: InboxBody,
  provider: CryptoProvider,
): Promise<string> {
  const problem = inboxProblem(body);
  if (problem) throw new Error(problem);
  const sign = contactPublicKey(signKey);
  if (sign !== body.sign) throw new Error('An inbox is signed by its own signing key');
  const signer: LooseSigner = { did: inboxAuthor(sign), key: await signingKeyOf(signKey) };
  return encodeLoose(
    await signLoose(signer, INBOX_COLLECTION, { ...body, places: [...body.places] }, provider),
  );
}

/**
 * Reads an inbox's code, or a link carrying one after `#inbox=` or `inbox=`,
 * and checks it: signed by the signing key it names, and well formed.
 * @throws When it isn't one, saying why
 */
export async function readInbox(text: string, provider: CryptoProvider): Promise<InboxBody> {
  const trimmed = text.trim();
  const found = /(?:^|[#?&])inbox=([A-Za-z0-9_-]+)/.exec(trimmed);
  const version = decodeLoose(found ? found[1]! : trimmed);
  if (!isRecord(version)) throw new Error('That is not an inbox code — it may be cut short.');
  const body = version.body;
  if (!isInboxBody(body)) throw new Error(`That inbox code doesn't work: ${inboxProblem(body)}`);
  const checked = await checkLoose(version, INBOX_COLLECTION, provider);
  // Signed by its own signing key, for itself: not by an account, so no account is named.
  if (!checked || checked.note || checked.root !== inboxAuthor(body.sign))
    throw new Error("That inbox code doesn't work: it is not signed by its own key");
  return Object.freeze({
    key: body.key,
    sign: body.sign,
    gen: body.gen,
    places: Object.freeze([...body.places]),
    ...(body.name ? { name: body.name } : {}),
  });
}

/**
 * The mailbox topic of an inbox: a hash of its signing key. A relay can't tell
 * whose inbox it is, and can check that whoever clears it holds that key.
 */
export async function inboxTopic(sign: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(`minca/inbox-topic/v1|${sign}`)));
}

/**
 * What an inbox's owner signs to clear knocks from a relay's mailbox: the
 * topic, the relay's one-time challenge, and which knocks (`*` for all).
 */
export const purgeMessage = (topic: string, nonce: string, ids: ReadonlyArray<string> | null) =>
  utf8Encode(`minca/inbox-purge/v1|${topic}|${nonce}|${ids ? [...ids].sort().join(',') : '*'}`);

/** Signs a relay's purge challenge with the inbox's signing key */
export function signPurge(
  signKey: Uint8Array,
  topic: string,
  nonce: string,
  ids: ReadonlyArray<string> | null,
): Promise<string> {
  return signWithScalar(signKey, purgeMessage(topic, nonce, ids));
}

/** A mailbox knock's id: the hash of its sealed blob, as relays file it */
export async function knockId(blob: string): Promise<string> {
  return base64UrlEncode(await sha256(utf8Encode(blob)));
}

/**
 * Makes a knock: signed by the session key under its account's note, and
 * sealed to `to`, an inbox key or a contact key.
 * @param invite The signed invitation to the space for two, and its secret
 * @returns The sealed blob, for a mailbox or a contact request
 */
export async function sealKnock(
  to: string,
  knock: {
    readonly invite: Version;
    readonly secret: Uint8Array;
    readonly name: string;
    readonly note?: string;
  },
  signer: LooseSigner,
  provider: CryptoProvider,
): Promise<string> {
  const note = knock.note ? clip(knock.note.trim(), MAX_NOTE) : undefined;
  const body: KnockBody = {
    invite: knock.invite,
    secret: base64UrlEncode(knock.secret),
    name: clip(knock.name.trim(), MAX_NAME) || 'Someone',
    ...(note ? { note } : {}),
  };
  const version = await signLoose(signer, KNOCK_COLLECTION, body, provider, { to });
  return sealValueTo(to, MAIL_LABEL, { to }, version);
}

/**
 * Opens a knock and checks it through (spec 07 §6): sealed to one of these
 * keys and naming it; signed under a note from its account that may write for
 * the whole account, valid when it was signed; recent; and carrying a signed
 * invitation from the same account to a private space that account alone
 * founded.
 * @param keys The private scalars it may be sealed to: the inbox keys, or the contact key
 * @param receivedAt For a mailbox, when the relay took it, ms; null for a contact request
 * @returns The knock, or null when it is anything less
 */
export async function openKnock(
  keys: ReadonlyArray<Uint8Array>,
  blob: string,
  receivedAt: number | null,
  provider: CryptoProvider,
): Promise<OpenedKnock | null> {
  let opened: unknown = null;
  let to = '';
  for (const key of keys) {
    to = contactPublicKey(key);
    opened = await openValueFrom(await contactKeyPair(key), MAIL_LABEL, { to }, blob);
    if (opened !== null) break;
  }
  if (!isRecord(opened) || opened.to !== to) return null;
  const checked = await checkLoose(opened, KNOCK_COLLECTION, provider);
  if (!checked) return null;
  // Knocking makes a space and hands out its invite: only the account, or a
  // note that may write for the whole account, may. An app given one space,
  // or a key the account trusts less, may not.
  if (checked.note && !noteCovers(checked.note, ACCOUNT_REQUIREMENT)) return null;

  // Recent; and from a mailbox, signed when it was dropped, not dated back to when a note was still good.
  const at = Math.floor(checked.at / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (at < now - KNOCK_TTL_SECONDS) return null;
  if (receivedAt !== null) {
    if (!Number.isFinite(receivedAt)) return null;
    const dropped = Math.floor(receivedAt / 1000);
    if (at > dropped + UCAN_CLOCK_SKEW_SECONDS || at < dropped - KNOCK_DROP_WINDOW_SECONDS) return null;
  }

  const body = checked.version.body;
  if (!isRecord(body)) return null;
  if (typeof body.name !== 'string' || Array.from(body.name).length > MAX_NAME) return null;
  if (body.note !== undefined && (typeof body.note !== 'string' || Array.from(body.note).length > MAX_NOTE))
    return null;
  if (typeof body.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.secret)) return null;

  // An invitation from the same account, to a private space it alone founded, with its key and a role.
  if ((await checkInvitation(body.invite, provider, body.secret)) !== null || !isRecord(body.invite))
    return null;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checkInvitation checked it through
  const invite = body.invite as unknown as Version & { readonly body: InvitationBody };
  const { space, key, role } = invite.body;
  if (invitedByOf(invite) !== checked.root) return null;
  if (soleFounder(space) !== checked.root || space.visibility !== 'private' || !key || !role) return null;
  if ((await checkSpace(space)) !== null) return null;

  return Object.freeze({
    from: checked.root,
    name: clip(body.name, MAX_NAME) || 'Someone',
    ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}),
    invite: writeInvitation(invite, base64UrlDecode(body.secret)),
    pairSpace: space.id,
    at: checked.at,
  });
}
