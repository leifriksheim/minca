/**
 * @module account-vault
 * The lock on a data folder: the seed is never stored, only wrapped copies of
 * it, one per way of unlocking (a device key gated by a passkey, or a
 * passphrase). The recovery code needs no wrap: it is the seed.
 */

import { base64UrlEncode, base64UrlDecode, utf8Encode } from '../utils/encoding.js';
import { protocolError } from '../utils/errors.js';
import { bufferSource, isRecord } from '../utils/guards.js';
import { hkdf, hkdfAesKey } from './hkdf.js';
import { openEnvelope, sealEnvelope, type Bound } from './envelope.js';
import { createIdentityManager } from './identity-manager.js';
import { RECOVERY_SEED_BYTES } from './recovery-code.js';

const SALT_BYTES = 16;

/** PBKDF2 rounds for a passphrase wrap: about a quarter-second in a browser, once per unlock */
export const PASSPHRASE_ITERATIONS = 600_000;
/** More rounds than this are refused: a vault file edited to a huge count would hang the page */
const MAX_ITERATIONS = 10_000_000;

const LOCAL_KEY_INFO = utf8Encode('minca/local-key/v1');
const ACCOUNT_KEY_INFO = utf8Encode('minca/account-key/v1');
/** The envelope label of a wrap; bound to `{ did, id, kind }`, and a passphrase wrap's `salt` and `iterations` */
const WRAP_LABEL = 'minca/vault-wrap/v1';

/** Fields every wrap carries, whatever unlocks it */
interface WrapBase {
  /** Distinguishes wraps within one file */
  readonly id: string;
  /** Shown when asking which one to use */
  readonly label: string;
  readonly addedAt: string;
  /** base64url of the envelope around the seed (spec 01 §9.1) */
  readonly sealed: string;
}

/** A seed wrapped under a random key in one origin's storage, gated by a passkey ({@link module:device-key}) */
export interface DeviceWrap extends WrapBase {
  readonly kind: 'device';
  /** The origin whose storage holds its key; no other origin can open it */
  readonly rpId: string;
  /** Which local key opens it. Missing from this device means unopenable here. */
  readonly deviceKeyId: string;
  /** The passkey that gates it, when one was used */
  readonly credentialId?: string;
  /** That passkey's user handle, base64url — what renaming its label needs */
  readonly userHandle?: string;
}

/** A seed wrapped under a passphrase */
export interface PassphraseWrap extends WrapBase {
  readonly kind: 'passphrase';
  /** base64url of 16 random bytes */
  readonly salt: string;
  readonly iterations: number;
}

export type SeedWrap = DeviceWrap | PassphraseWrap;

/** The account file at the root of a data folder, in its locked form */
export interface AccountVault {
  readonly version: 1;
  readonly label: string;
  /** The DID the seed derives. Public, and useful for recognising the folder. */
  readonly did: string;
  readonly createdAt: string;
  readonly wraps: ReadonlyArray<SeedWrap>;
}

/** Whether parsed JSON is a vault. Loose on purpose: each wrap is checked when opened. */
export function isAccountVault(value: unknown): value is AccountVault {
  return isRecord(value) && value.version === 1 && Array.isArray(value.wraps);
}

/** Wraps a seed under this device's key; the passkey recorded beside it is a gate, not the key's source */
export async function wrapSeedWithDeviceKey(
  seed: Uint8Array,
  deviceKey: { id: string; key: CryptoKey },
  meta: { rpId: string; credentialId?: string; userHandle?: string; label?: string },
): Promise<DeviceWrap> {
  const id = wrapId();
  const bound = wrapBound(await didOfSeed(seed), { id, kind: 'device' });
  return {
    kind: 'device',
    id,
    label: meta.label ?? meta.rpId,
    rpId: meta.rpId,
    deviceKeyId: deviceKey.id,
    ...(meta.credentialId ? { credentialId: meta.credentialId } : {}),
    ...(meta.userHandle ? { userHandle: meta.userHandle } : {}),
    addedAt: new Date().toISOString(),
    sealed: base64UrlEncode(await sealEnvelope(deviceKey.key, WRAP_LABEL, bound, seed)),
  };
}

/**
 * Opens a device wrap.
 * @param did The vault's DID: the seed inside must derive it
 */
export async function unwrapSeedWithDeviceKey(
  wrap: DeviceWrap,
  deviceKey: CryptoKey,
  did: string,
): Promise<Uint8Array> {
  return open(wrap, deviceKey, did);
}

/** Wraps a seed under a passphrase — the portable way back in. */
export async function wrapSeedWithPassphrase(
  seed: Uint8Array,
  passphrase: string,
  label = 'Passphrase',
): Promise<PassphraseWrap> {
  const salt = randomBytes(SALT_BYTES);
  const key = await passphraseWrappingKey(passphrase, salt, PASSPHRASE_ITERATIONS);
  const unsealed = {
    kind: 'passphrase' as const,
    id: wrapId(),
    label,
    addedAt: new Date().toISOString(),
    salt: base64UrlEncode(salt),
    iterations: PASSPHRASE_ITERATIONS,
  };
  const bound = wrapBound(await didOfSeed(seed), unsealed);
  return { ...unsealed, sealed: base64UrlEncode(await sealEnvelope(key, WRAP_LABEL, bound, seed)) };
}

/**
 * Opens a passphrase wrap. Its salt and rounds are bound into the envelope, so
 * an edited wrap does not open; too few or too many rounds are refused before any run.
 * @param did The vault's DID: the seed inside must derive it
 */
export async function unwrapSeedWithPassphrase(
  wrap: PassphraseWrap,
  passphrase: string,
  did: string,
): Promise<Uint8Array> {
  const { iterations } = wrap;
  if (!Number.isSafeInteger(iterations) || iterations < PASSPHRASE_ITERATIONS || iterations > MAX_ITERATIONS)
    throw unlockFailed();
  const key = await passphraseWrappingKey(passphrase, base64UrlDecode(wrap.salt), iterations);
  return open(wrap, key, did);
}

/**
 * The local key: seals this account's data on this device, never leaves it,
 * and isn't extractable. Its own label, so the account key derives nothing that opens it.
 */
export function deriveLocalKey(seed: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(seed, LOCAL_KEY_INFO);
}

/** The account key, 32 bytes: the root of member keys and the account's own spaces */
export function deriveAccountKey(seed: Uint8Array): Promise<Uint8Array> {
  return hkdf(seed, ACCOUNT_KEY_INFO, 32);
}

/** The device wraps this origin can attempt: only its own storage holds their keys */
export function deviceWrapsFor(vault: AccountVault, rpId: string): ReadonlyArray<DeviceWrap> {
  return vault.wraps.filter((wrap): wrap is DeviceWrap => wrap.kind === 'device' && wrap.rpId === rpId);
}

/** The label of the passphrase the CLI unlocks with unattended, apart from the account's own */
export const CLI_PASSPHRASE_LABEL = 'CLI passphrase';

/** Adds a wrap, replacing an earlier device wrap for the same origin */
export function withWrap(vault: AccountVault, wrap: SeedWrap): AccountVault {
  const superseded = (existing: SeedWrap): boolean =>
    existing.kind === 'device' && wrap.kind === 'device' && existing.rpId === wrap.rpId;
  return { ...vault, wraps: [...vault.wraps.filter((existing) => !superseded(existing)), wrap] };
}

/**
 * Assembles a fresh locked account; generates nothing and writes nothing.
 * @param params.wraps May be empty: the recovery code is the seed, and opens it with nothing stored
 */
export function createVault(params: {
  did: string;
  wraps: ReadonlyArray<SeedWrap>;
  label?: string;
}): AccountVault {
  return {
    version: 1,
    label: params.label ?? 'My data',
    did: params.did,
    createdAt: new Date().toISOString(),
    wraps: params.wraps,
  };
}

const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const wrapId = () => base64UrlEncode(randomBytes(8));
const didOfSeed = async (seed: Uint8Array) => (await createIdentityManager().fromSeed(seed)).did;

/** What a wrap's envelope is bound to: whose seed, which wrap, and how it opens */
function wrapBound(
  did: string,
  wrap: {
    readonly id: string;
    readonly kind: SeedWrap['kind'];
    readonly salt?: string;
    readonly iterations?: number;
  },
): Bound {
  return wrap.kind === 'passphrase'
    ? { did, id: wrap.id, kind: wrap.kind, salt: wrap.salt ?? '', iterations: wrap.iterations ?? 0 }
    : { did, id: wrap.id, kind: wrap.kind };
}

const unlockFailed = () =>
  protocolError(
    'VAULT_UNLOCK_FAILED',
    'That did not unlock the folder.',
    'Check the passphrase, or use your recovery code instead.',
  );

/** Opens a wrap, refusing one whose seed doesn't derive `did`: copied from another vault, or edited */
async function open(wrap: SeedWrap, key: CryptoKey, did: string): Promise<Uint8Array> {
  const seed = await openSealed(wrap, key, did);
  if (!seed || seed.length !== RECOVERY_SEED_BYTES || (await didOfSeed(seed)) !== did) throw unlockFailed();
  return seed;
}

async function openSealed(wrap: SeedWrap, key: CryptoKey, did: string): Promise<Uint8Array | null> {
  try {
    return await openEnvelope(key, WRAP_LABEL, wrapBound(did, wrap), base64UrlDecode(wrap.sealed));
  } catch {
    return null;
  }
}

/** Stretches a passphrase into the key that wraps a seed; `iterations` come from the wrap */
async function passphraseWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    bufferSource(utf8Encode(passphrase.normalize('NFKC'))),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferSource(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
