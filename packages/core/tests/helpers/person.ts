/**
 * A person on a fake hub: their own seed, identity and node, closed after each
 * test. And the hand-signed versions and bare keys tests forge with.
 */
import { afterEach } from 'node:test';

import { createNode } from '../../src/node/node.js';
import { createIdentityManager } from '../../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../src/identity/root-signer.js';
import { createP256Provider } from '../../src/identity/crypto-p256.js';
import { generateSeed } from '../../src/identity/recovery-code.js';
import { didOf, publicKeyToDid, P256_MULTICODEC } from '../../src/identity/did.js';
import { keyProof, requestTerms } from '../../src/session/connect.js';
import { deriveAccountKey } from '../../src/identity/account-vault.js';
import { deriveContactKeyBytes } from '../../src/identity/contact-key.js';
import { createSigner } from '../../src/schema/signer.js';
import { createVersion, type CreateVersionParams } from '../../src/schema/version.js';
import { newRecordKey } from '../../src/records/key.js';
import { createStorageProvider } from '../../src/storage/storage-provider.js';
import type { StoreFactory } from '../../src/node/stores.js';
import type { Version } from '../../src/types.js';
import type { FakeHub } from './fake-transport.js';
import { memoryStores } from './memory-stores.js';
import { seenBy } from './as-member.js';

/** Everything a test opened, closed after it */
export const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

export const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PersonOptions {
  readonly seed?: Uint8Array;
  readonly stores?: StoreFactory;
  /** Give the node the account key derived from the seed */
  readonly accountKey?: boolean;
  /** Give the node the contact key derived from the seed */
  readonly contactKey?: boolean;
  readonly relays?: string[];
  /** Set as the account's name once the node is open */
  readonly name?: string;
}

/** A node of a new account, on the hub when there is one */
export async function person(hub?: FakeHub, options: PersonOptions = {}) {
  const seed = options.seed ?? generateSeed();
  const manager = createIdentityManager();
  const me = await manager.fromSeed(seed);
  const stores = options.stores ?? memoryStores();
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores,
    watchIntervalMs: 0,
    ...(options.accountKey ? { accountKey: await deriveAccountKey(seed) } : {}),
    ...(options.contactKey ? { contactKey: await deriveContactKeyBytes(seed) } : {}),
    ...(hub
      ? {
          network: {
            ...(options.relays ? { relays: options.relays } : {}),
            transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
          },
        }
      : {}),
  });
  open.push(node);
  if (options.name) await node.account.setName(options.name);
  return { node, me, manager, stores, seed };
}
export type Person = Awaited<ReturnType<typeof person>>;

type ForgedFields = Omit<CreateVersionParams<unknown>, 'author' | 'space' | 'proof'> &
  Partial<Pick<CreateVersionParams<unknown>, 'author' | 'space' | 'proof'>>;

/**
 * Signs a version by hand, as a modified app or an attacker could, under a
 * key the person delegated to. Unless `keep` is false it is slipped into the
 * writer's own copy of the space, from where it syncs. `seen` defaults to
 * what the writer's node has seen.
 */
export async function forge(
  who: Person,
  space: string,
  fields: ForgedFields,
  { keep = true } = {},
): Promise<Version> {
  const provider = who.manager.getProvider();
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const ucan = await createLocalRootSigner(who.me, provider).delegate({
    audience: keyDid,
    command: '/',
    subject: `space:${space}`,
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const signed = await createSigner(provider).sign(
    createVersion({
      seen: fields.seen ?? (await seenBy(who.node, space)),
      // A fresh key: its first place in its log here.
      log: fields.log ?? { n: 0 },
      // A new record at a key of the person's own, unless the test names one.
      version: fields.version ?? { key: await newRecordKey(who.node.did), seq: 0 },
      ...fields,
      author: keyDid,
      space,
      proof: ucan,
    }),
    pair.privateKey,
  );
  if (keep) await createStorageProvider(await who.stores(`spaces/${space}`)).addVersion(signed);
  return signed;
}

const provider = createP256Provider();

/** A bare P-256 key and its did:key */
export async function makeKey() {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return { did, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

const namedKeys = new Map<string, Promise<{ keys: CryptoKeyPair; did: string }>>();

/** A real key for a name a test uses as an app's or a program's key, the same one each time */
export function testAppKey(name: string): Promise<{ keys: CryptoKeyPair; did: string }> {
  let key = namedKeys.get(name);
  if (!key) {
    key = (async () => {
      const keys = await createP256Provider().generateKeyPair();
      return { keys, did: await didOf(keys.publicKey) };
    })();
    namedKeys.set(name, key);
  }
  return key;
}

/**
 * A connect request as an app would send it: the named key swapped for a real
 * one, with its proof. One with `via: code` needs the origin of the app it
 * goes through, which its proof names.
 */
export async function asked<
  T extends { readonly audience: string; readonly via?: 'code'; readonly recordsOnly?: boolean },
>(
  request: T,
  key?: { readonly keys: CryptoKeyPair; readonly did: string },
  origin?: string,
): Promise<T & { readonly proof: string }> {
  if (request.via === 'code' && !origin) throw new Error('A request via code needs the app’s origin.');
  const signer = key ?? (await testAppKey(request.audience));
  const proof = await keyProof(signer, requestTerms(request, origin ?? ''));
  return { ...request, audience: signer.did, proof };
}
