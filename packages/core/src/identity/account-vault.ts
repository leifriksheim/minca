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

/**
 * PBKDF2 rounds for a passphrase wrap.
 *
 * Tuned to roughly a quarter-second in a browser, on the reasoning that this
 * runs once per unlock and the thing it guards is an identity rather than a
 * session.
 */
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

/**
 * A seed wrapped under a key held on one device.
 *
 * The key is not derived from the passkey — a passkey only yields key material
 * through the PRF extension, which several widely used providers do not
 * implement. It is a random key in this origin's storage, and the passkey in
 * front of it is a user-verification gate rather than the source of the
 * secret. See {@link module:device-key} for what that does and does not
 * protect against.
 */
export interface DeviceWrap extends WrapBase {
  readonly kind: 'device';
  /**
   * The origin this belongs to. The key it names lives in that origin's
   * storage, so a wrap from another app is not merely likely to fail — it is
   * unreachable from here.
   */
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

/**
 * Whether parsed JSON is a vault. Loose on purpose: the version and a list of
 * wraps; each wrap is checked when something tries to open it.
 */
export function isAccountVault(value: unknown): value is AccountVault {
  return isRecord(value) && value.version === 1 && Array.isArray(value.wraps);
}

/** Random bytes as base64url, for salts and nonces. */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A short opaque id for a wrap. */
function wrapId(): string {
  return base64UrlEncode(randomBytes(8));
}

/** The DID a seed derives */
async function didOfSeed(seed: Uint8Array): Promise<string> {
  return (await createIdentityManager().fromSeed(seed)).did;
}

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

/**
 * Opens a wrap, and checks what is inside is the seed of `did`: a wrap copied
 * in from another account's vault, or edited, is refused.
 */
async function open(wrap: SeedWrap, key: CryptoKey, did: string): Promise<Uint8Array> {
  let seed: Uint8Array | null = null;
  try {
    seed = await openEnvelope(key, WRAP_LABEL, wrapBound(did, wrap), base64UrlDecode(wrap.sealed));
  } catch {
    seed = null;
  }
  // AES-GCM authenticates, so a failure is the wrong key, account or wrap rather than corruption.
  if (!seed || seed.length !== RECOVERY_SEED_BYTES || (await didOfSeed(seed)) !== did) throw unlockFailed();
  return seed;
}

/**
 * Stretches a passphrase into the key that wraps a seed.
 * @param iterations PBKDF2 rounds, read from the wrap so old ones stay openable
 */
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

/**
 * Wraps a seed under this device's key.
 *
 * The key is random and lives in this origin's storage; the passkey recorded
 * alongside is the gate in front of it, not the source of it. See
 * {@link module:device-key}.
 */
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
 * Opens a passphrase wrap. Its `salt` and `iterations` are bound into the
 * envelope, so a wrap edited to fewer rounds does not open; fewer than
 * {@link PASSPHRASE_ITERATIONS} are refused before any are run.
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
 * The **local key**: what seals this account's data on this device (the
 * registry at rest, the CLI's writer keys). Never handed to anyone, and not
 * extractable, so a page can use it without being able to leak it.
 *
 * Derived from the seed under its own label, beside the account key, so an
 * app given the account key derives nothing that opens local storage.
 */
export async function deriveLocalKey(seed: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(seed, LOCAL_KEY_INFO);
}

/**
 * The **account key**, 32 bytes: the root of the member keys and of the
 * account's own spaces (the registry, the contacts). What an app given the
 * whole account receives, and a node that follows the registry is given.
 */
export async function deriveAccountKey(seed: Uint8Array): Promise<Uint8Array> {
  return hkdf(seed, ACCOUNT_KEY_INFO, 32);
}

/**
 * The device wraps this origin could actually attempt.
 *
 * The key a wrap names lives in the storage of the origin that made it, so one
 * from another app is not merely likely to fail — it is unreachable from here.
 */
export function deviceWrapsFor(vault: AccountVault, rpId: string): ReadonlyArray<DeviceWrap> {
  return vault.wraps.filter((wrap): wrap is DeviceWrap => wrap.kind === 'device' && wrap.rpId === rpId);
}

/**
 * What the CLI labels the passphrase it unlocks with unattended. Kept apart
 * from the account's password, so changing one does not remove the other.
 */
export const CLI_PASSPHRASE_LABEL = 'CLI passphrase';

/**
 * Adds a wrap, replacing any earlier one for the same passkey.
 *
 * Re-registering on an origin should leave one usable wrap rather than a pile of
 * stale ones, and a wrap whose credential is gone is only clutter.
 */
export function withWrap(vault: AccountVault, wrap: SeedWrap): AccountVault {
  // One device wrap per origin: re-adding the shortcut should replace it, not
  // leave an older one pointing at a key nobody will use again.
  const superseded = (existing: SeedWrap): boolean =>
    existing.kind === 'device' && wrap.kind === 'device' && existing.rpId === wrap.rpId;

  return { ...vault, wraps: [...vault.wraps.filter((existing) => !superseded(existing)), wrap] };
}

/**
 * Assembles a fresh locked account.
 *
 * Pure — it neither generates the seed nor touches the disk, so a caller stays
 * in charge of both the entropy and when it lands.
 *
 * @param params.wraps Shortcuts for getting in. May be empty: the account code
 *   is the seed written out, so it opens the account with nothing stored —
 *   which is exactly what a brand new account has.
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
