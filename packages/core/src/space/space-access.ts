/**
 * What a space is, fixed at creation — and the keys around it that anyone can
 * check without holding a secret.
 *
 * What a space is, fixed at creation, is its constitution
 * (`space/constitution.ts`), whose hash is the space id. Everything after
 * that — definitions, assignments, invites — is records in the space's
 * access history (`space/roles.ts`); their keys are made here.
 *
 * A private space's **read key pair** is derived from its AES key, so everyone
 * who can read already has it. A node checks a connecting reader against its
 * public half — without the space key.
 *
 * An **invite link** carries a random secret. Its public half is written into
 * the space as an invite record, for one role. Whoever holds the secret joins
 * by writing their own member record, signed a second time by the secret over
 * the space and their identity — so the signature cannot be moved to anyone
 * else, or another space. Deleting the invite record closes the link.
 */
import type { CryptoProvider } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { hashedKey } from '../utils/hash.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../utils/encoding.js';
import { bufferSource } from '../utils/guards.js';
import { didOf, didToPublicKey } from '../identity/did.js';

const READ_INFO = 'minca/space-read/v1';
const INVITE_INFO = 'minca/space-invite/v1';

/** A key pair belonging to a space, and its public half as a did:key */
export interface SpaceKeyPair {
  readonly did: string;
  readonly privateKey: CryptoKey;
}

/** A fresh secret for an invite link */
export function generateInviteSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** 32 bytes from a secret under a label: HKDF-SHA-256 with an empty salt. */
export async function expandSecret(secret: Uint8Array, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = await globalThis.crypto.subtle.importKey('raw', bufferSource(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode(info) },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * A key pair from a secret, for one purpose. The secret is expanded under its
 * own label first, so no two uses of one secret — nor an account seed that
 * happened to equal it — ever give the same key.
 */
async function derivePair(secret: Uint8Array, info: string, provider: CryptoProvider): Promise<SpaceKeyPair> {
  const pair = await provider.deriveKeyPairFromSeed(await expandSecret(secret, info));
  const did = await didOf(pair.publicKey, provider);
  return Object.freeze({ did, privateKey: pair.privateKey });
}

/** The key pair an invite link's secret stands for */
export function deriveInviteKey(secret: Uint8Array, provider: CryptoProvider): Promise<SpaceKeyPair> {
  return derivePair(secret, INVITE_INFO, provider);
}

/** The read key pair of a private space, from its AES key */
export async function deriveReadKey(spaceKey: SpaceKey, provider: CryptoProvider): Promise<SpaceKeyPair> {
  return readKeyFromSeed(await deriveReadSeed(spaceKey), provider);
}

/**
 * What the read key pair is made from — one way from the space key, so
 * holding it proves you may read without letting you decrypt anything. It is
 * what a pass hands a node that carries a space it cannot read (`space/pass.ts`).
 */
export async function deriveReadSeed(spaceKey: SpaceKey): Promise<Uint8Array> {
  return expandSecret(spaceKey.raw, READ_INFO);
}

/** The read key pair, from its seed */
export async function readKeyFromSeed(seed: Uint8Array, provider: CryptoProvider): Promise<SpaceKeyPair> {
  const pair = await provider.deriveKeyPairFromSeed(seed);
  const did = await didOf(pair.publicKey, provider);
  return Object.freeze({ did, privateKey: pair.privateKey });
}

// ─── Record keys in the access history ────────────────────────────────
//
// Record keys are lower case; DIDs and CIDs are not. So a key names a hash of
// the thing, and the record's body names the thing itself.

/** The key of the record assigning a role to an account, or taking it away */
export const assignKey = (did: string, role: string) => hashedKey('assign', `${did}|${role}`);
/** The key of the record removing an account from the space */
export const removalKey = (did: string) => hashedKey('remove', did);
/** The key of an invite's record, from its public key */
export const inviteKey = (inviteDid: string) => hashedKey('invite', inviteDid);
/** The key of an account's record revoking one of its keys: naming both, so no one else's can take its place */
export const revokeKey = (keyDid: string, accountDid: string) =>
  hashedKey('revoke', `${keyDid}|${accountDid}`);
/**
 * Where proof that an account broke the protocol's rules is kept, one record
 * per offending version and writer: `{ kind, evidence }`. A standard
 * collection, not protocol: a warrant stands like any record, and each peer
 * checks its proof only to decide whether to show a flag (docs/warrants.md).
 */
export const WARRANT_COLLECTION = 'std.warrant';
/** The key of the record proving a writer's log forked, from the writer's key */
export const forkKey = (writerDid: string) => hashedKey('fork', writerDid);
/** The key of the record by which a founder steps down, keeping its roles */
export const stepDownKey = (did: string) => hashedKey('stepdown', did);
/** The key of the record naming a successor space, from the successor's id */
export const succeedKey = (spaceId: string) => hashedKey('succeed', spaceId);
/** The key of a role's record */
export const roleKey = (name: string) => `role:${name}`;
/**
 * Where each member says, in the clear, which member key a new space key
 * should be sealed to: `{ key }`, one record per account. In the clear so
 * someone holding only an older key of the space can still write it.
 */
export const MEMBER_KEY_COLLECTION = 'sys.memberkey';
/** The key of an account's member key record */
export const memberKeyRecordKey = (did: string) => hashedKey('memberkey', did);
/** Where the sealed copies of a changed space key live, one per member: `{ keyId, to, sealed }` */
export const BOX_COLLECTION = 'sys.box';
/** The one record key the space's relay list is a version of */
export const SPACE_RELAYS_RECORD = 'relays:space';
/** The one record key the space's list of keepers is a version of */
export const SPACE_KEEPERS_RECORD = 'keepers:space';
/** The one record key every change of a private space's key is a version of — so two made apart are rivals, and one wins */
export const SPACE_KEY_RECORD = 'key:space';
/** The key of a sealed copy of a space key: one per key, recipient and sender */
export const boxKey = (keyId: string, to: string, from: string) => hashedKey('box', `${keyId}|${to}|${from}`);
/** The HPKE label a box is sealed under (spec 01 §9.3; spec 03 §9.4) */
export const BOX_LABEL = 'minca/space-key-box/v1';
/** What a box is bound to, so one moved to another space, key or person doesn't open */
export const boxBound = (space: string, keyId: string, to: string) => ({ space, keyId, to });

const inviteLabel = (spaceId: string, did: string) => utf8Encode(`${INVITE_INFO}|${spaceId}|${did}`);

/** An invite key's signature, letting `did` join `spaceId` — what a member record carries when it joins by invite */
export async function signInvite(
  spaceId: string,
  did: string,
  invite: SpaceKeyPair,
  provider: CryptoProvider,
): Promise<string> {
  return base64UrlEncode(await provider.sign(invite.privateKey, inviteLabel(spaceId, did)));
}

/** Whether an invite key signed for `did` to join `spaceId` */
export async function verifyInvite(
  spaceId: string,
  did: string,
  inviteDid: string,
  signature: string,
  provider: CryptoProvider,
): Promise<boolean> {
  try {
    const publicKey = await provider.importPublicKey(didToPublicKey(inviteDid).publicKeyBytes);
    return await provider.verify(publicKey, base64UrlDecode(signature), inviteLabel(spaceId, did));
  } catch {
    return false;
  }
}
