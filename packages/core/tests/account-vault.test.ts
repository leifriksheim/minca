/**
 * Vault tests — the lock on a data folder.
 *
 * The property that matters most is the last one in this file: several wraps
 * over one seed all unlock the same identity, which is what makes "bind a second
 * key to my account" a matter of appending to a file rather than signing a
 * delegation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { hasPassphraseWrap, withoutWrap } from './helpers/vault.js';
import {
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  unwrapSeedWithPassphrase,
  deriveLocalKey,
  deriveAccountKey,
  deviceWrapsFor,
  withWrap,
  createVault,
} from '../src/identity/account-vault.js';
import { accountDataPath, createFolderAccountStore, newAccountId } from '../src/identity/account-store.js';
import { createEncryptedAdapter } from '../src/storage/encrypted-adapter.js';
import { createSpaceManager } from '../src/space/space-manager.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { generateSeed, seedToRecoveryCode } from '../src/identity/recovery-code.js';
import { bytesToHex, hexToBytes, utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import { hkdf, hkdfAesKey } from '../src/identity/hkdf.js';
import { deriveMemberKeyBytes } from '../src/identity/contact-key.js';
import { deriveAccountRegistry, deriveContactsSpace } from '../src/space/account-registry.js';
import { isProtocolError } from '../src/utils/errors.js';
import { team } from '../src/space/presets.js';

const manager = createIdentityManager();
const didOf = async (seed: Uint8Array) => (await manager.fromSeed(seed)).did;

/** A device key, as `createDeviceKey` would make one — without the storage. */
async function deviceKey(id: string) {
  return {
    id,
    key: await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  };
}

describe('wrapping a seed', () => {
  test('a device wrap round-trips', async () => {
    const seed = generateSeed();
    const key = await deviceKey('k1');
    const wrap = await wrapSeedWithDeviceKey(seed, key, {
      rpId: 'app-a.example',
      credentialId: 'cred-a',
    });

    assert.deepEqual(await unwrapSeedWithDeviceKey(wrap, key.key, await didOf(seed)), seed);
    // The seed must not be recoverable from the file itself.
    assert.ok(!JSON.stringify(wrap).includes(seedToRecoveryCode(seed).replace(/-/g, '')));
    // Which key opens it has to be recorded, or another browser cannot tell
    // that this wrap is not for it.
    assert.equal(wrap.deviceKeyId, 'k1');
  });

  test('another device\u2019s key does not open it', async () => {
    const seed = generateSeed();
    const wrap = await wrapSeedWithDeviceKey(seed, await deviceKey('k1'), {
      rpId: 'app-a.example',
      credentialId: 'cred-a',
    });

    const stranger = await deviceKey('k2');
    await assert.rejects(
      async () => unwrapSeedWithDeviceKey(wrap, stranger.key, await didOf(seed)),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });

  test('a passphrase wrap round-trips, and the wrong one does not', async () => {
    const seed = generateSeed();
    const wrap = await wrapSeedWithPassphrase(seed, 'correct horse battery staple');

    const did = await didOf(seed);
    assert.deepEqual(await unwrapSeedWithPassphrase(wrap, 'correct horse battery staple', did), seed);
    await assert.rejects(
      () => unwrapSeedWithPassphrase(wrap, 'correct horse battery stapler', did),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });

  test('wrapping the same seed twice produces different ciphertext', async () => {
    const seed = generateSeed();
    const key = await deviceKey('k1');
    const first = await wrapSeedWithDeviceKey(seed, key, { rpId: 'a' });
    const second = await wrapSeedWithDeviceKey(seed, key, { rpId: 'a' });

    assert.notEqual(first.sealed, second.sealed, 'the nonce must be fresh each time');
    assert.deepEqual(await unwrapSeedWithDeviceKey(second, key.key, await didOf(seed)), seed);
  });

  test('a wrap from another account does not open as this one', async () => {
    // Someone who can write the vault copies in a wrap of their own account,
    // under a passphrase they know: it must not open as the account the vault names.
    const mine = generateSeed();
    const theirs = generateSeed();
    const planted = await wrapSeedWithPassphrase(theirs, 'their passphrase');
    await assert.rejects(
      async () => unwrapSeedWithPassphrase(planted, 'their passphrase', await didOf(mine)),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
    const key = await deviceKey('k');
    const device = await wrapSeedWithDeviceKey(theirs, key, { rpId: 'a.example' });
    await assert.rejects(
      async () => unwrapSeedWithDeviceKey(device, key.key, await didOf(mine)),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });

  test('a passphrase wrap edited to fewer rounds, another salt or another id does not open', async () => {
    const seed = generateSeed();
    const did = await didOf(seed);
    const wrap = await wrapSeedWithPassphrase(seed, 'a passphrase');
    // Below the floor: refused before any rounds are run.
    for (const iterations of [1, 1000, 599_999, 1.5, Number.NaN, 1e12])
      await assert.rejects(
        () => unwrapSeedWithPassphrase({ ...wrap, iterations }, 'a passphrase', did),
        (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
      );
    // Within the bounds but not what it was sealed with: the envelope is bound to it.
    for (const edited of [
      { ...wrap, iterations: 600_001 },
      { ...wrap, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { ...wrap, id: 'AAAAAAAAAAA' },
    ])
      await assert.rejects(
        () => unwrapSeedWithPassphrase(edited, 'a passphrase', did),
        (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
      );
  });

  test('the example passphrase wrap of spec 01 §11.2 opens to the seed of §3.3', async () => {
    const wrap = {
      kind: 'passphrase' as const,
      id: '3FhYYIDMZJI',
      label: 'Passphrase',
      addedAt: '2026-10-11T10:15:34.694Z',
      salt: '9ae06Gjd9kltZrGo6jupLQ',
      iterations: 600000,
      sealed: 'AWFF7dAydbB7LQNVyPYX5ohUGrCi-n3UnxgyuWup2zlu1qBLRwtVYQft-BBr',
    };
    const did = 'did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr';
    const seed = await unwrapSeedWithPassphrase(wrap, 'hunter2 hunter2', did);
    assert.equal(bytesToHex(seed), '00112233445566778899aabbccddeeff');
  });

  test('a device wrap relabelled as another wrap does not open', async () => {
    const seed = generateSeed();
    const key = await deviceKey('k');
    const wrap = await wrapSeedWithDeviceKey(seed, key, { rpId: 'a.example' });
    await assert.rejects(
      async () => unwrapSeedWithDeviceKey({ ...wrap, id: 'AAAAAAAAAAA' }, key.key, await didOf(seed)),
      (error: unknown) => isProtocolError(error, 'VAULT_UNLOCK_FAILED'),
    );
  });
});

describe('the set of wraps', () => {
  test('several wraps over one seed all reach the same identity', async () => {
    // The whole point: a shortcut on one app, a shortcut on another, and a
    // passphrase are three doors into one account — no delegation involved.
    const seed = generateSeed();
    const expected = (await manager.fromSeed(seed)).did;

    const keyA = await deviceKey('ka');
    const keyB = await deviceKey('kb');
    const onA = await wrapSeedWithDeviceKey(seed, keyA, { rpId: 'app-a.example' });
    const onB = await wrapSeedWithDeviceKey(seed, keyB, { rpId: 'app-b.example' });
    const byPhrase = await wrapSeedWithPassphrase(seed, 'a passphrase');

    const fromA = await manager.fromSeed(await unwrapSeedWithDeviceKey(onA, keyA.key, expected));
    const fromB = await manager.fromSeed(await unwrapSeedWithDeviceKey(onB, keyB.key, expected));
    const fromPhrase = await manager.fromSeed(
      await unwrapSeedWithPassphrase(byPhrase, 'a passphrase', expected),
    );
    // And the code, which needs no wrap because it is the seed.
    const fromCode = await manager.fromRecoveryCode(seedToRecoveryCode(seed));

    for (const identity of [fromA, fromB, fromPhrase, fromCode]) {
      assert.equal(identity.did, expected);
    }
  });

  test('only this origin’s shortcuts are offered', async () => {
    const seed = generateSeed();
    const vault = createVault({
      did: (await manager.fromSeed(seed)).did,
      wraps: [
        await wrapSeedWithDeviceKey(seed, await deviceKey('ka'), { rpId: 'app-a.example' }),
        await wrapSeedWithDeviceKey(seed, await deviceKey('kb'), { rpId: 'app-b.example' }),
        await wrapSeedWithPassphrase(seed, 'phrase'),
      ],
    });

    // The key a wrap names lives in the storage of the origin that made it, so
    // another app's wrap is not merely likely to fail — it is unreachable.
    assert.deepEqual(
      deviceWrapsFor(vault, 'app-a.example').map((wrap) => wrap.deviceKeyId),
      ['ka'],
    );
    assert.deepEqual(deviceWrapsFor(vault, 'app-c.example'), []);
    assert.equal(hasPassphraseWrap(vault), true);
  });

  test('setting up a shortcut again replaces it rather than piling up', async () => {
    const seed = generateSeed();
    let vault = createVault({
      did: (await manager.fromSeed(seed)).did,
      wraps: [await wrapSeedWithDeviceKey(seed, await deviceKey('old'), { rpId: 'a.example' })],
    });

    const replacement = await deviceKey('new');
    vault = withWrap(vault, await wrapSeedWithDeviceKey(seed, replacement, { rpId: 'a.example' }));

    assert.equal(vault.wraps.length, 1);
    assert.deepEqual(
      await unwrapSeedWithDeviceKey(deviceWrapsFor(vault, 'a.example')[0]!, replacement.key, vault.did),
      seed,
    );
  });

  test('removing the last shortcut leaves the account openable by its code', async () => {
    const seed = generateSeed();
    const only = await wrapSeedWithDeviceKey(seed, await deviceKey('k'), { rpId: 'a.example' });
    const vault = createVault({ did: (await manager.fromSeed(seed)).did, wraps: [only] });

    // Wraps are shortcuts for one device, not the keys to the building — the
    // code is the seed written out and needs nothing stored to work.
    const stripped = withoutWrap(vault, only.id);
    assert.deepEqual(stripped.wraps, []);
    assert.equal((await manager.fromRecoveryCode(seedToRecoveryCode(seed))).did, stripped.did);
  });

  test('a new account starts with no shortcuts at all', () => {
    const vault = createVault({ did: 'did:key:zabc', wraps: [] });
    assert.deepEqual(vault.wraps, []);
    assert.equal(vault.did, 'did:key:zabc');
  });
});

describe('the account file', () => {
  test('writes a locked account and reads it back without the seed', async () => {
    const folder = createMemoryDirectory();
    const seed = generateSeed();
    const identity = await manager.fromSeed(seed);
    const id = newAccountId();

    const vault = createVault({
      did: identity.did,
      label: 'Work',
      wraps: [await wrapSeedWithDeviceKey(seed, await deviceKey('k'), { rpId: 'a.example' })],
    });
    const store = createFolderAccountStore(folder.open());
    await store.write(
      { id, name: 'Work', did: identity.did, createdAt: vault.createdAt, dataPath: accountDataPath(id) },
      vault,
    );

    assert.equal((await store.read(id))?.did, identity.did);

    // Nothing in the file may spell out the seed.
    const raw = utf8Decode(
      await folder
        .open()
        .getDirectoryHandle('accounts')
        .then((d) => d.getDirectoryHandle(id))
        .then((d) => d.getFileHandle('account.json'))
        .then((h) => h.getFile())
        .then((f) => f.arrayBuffer())
        .then((b) => new Uint8Array(b)),
    );
    assert.ok(!raw.includes(seedToRecoveryCode(seed).replace(/-/g, '')));
  });
});

describe('encryption at rest', () => {
  test('a space key is unreadable in the underlying store', async () => {
    const inner = createMemoryAdapter();
    const localKey = await deriveLocalKey(generateSeed());
    const spaces = createSpaceManager(createEncryptedAdapter(inner, localKey));

    const { space } = await spaces.create({
      name: 'Grocery list',
      visibility: 'private',
      creator: 'did:key:zowner',
    });

    // Through the adapter: ordinary reads.
    const reopened = await spaces.get(space.id);
    assert.equal(reopened?.space.name, 'Grocery list');
    assert.ok(reopened?.key, 'the space key should come back');

    // Underneath it: the name and the AES key are both sealed. This is the gap
    // that made private spaces readable to anyone holding the folder.
    const rawRecord = utf8Decode((await inner.get(`space:${space.id}`))!);
    const rawKey = utf8Decode((await inner.get(`spacekey:${space.id}`))!);
    assert.ok(!rawRecord.includes('Grocery list'));
    assert.ok(!rawKey.includes('"raw"'));
  });

  test('a different seed cannot read it', async () => {
    const inner = createMemoryAdapter();
    const spaces = createSpaceManager(createEncryptedAdapter(inner, await deriveLocalKey(generateSeed())));
    const { space } = await spaces.create({
      name: 'Private',
      visibility: 'private',
      creator: 'did:key:zowner',
    });

    const stranger = createSpaceManager(createEncryptedAdapter(inner, await deriveLocalKey(generateSeed())));
    await assert.rejects(() => stranger.get(space.id));
  });

  test('values outside the sealed prefixes pass straight through', async () => {
    const inner = createMemoryAdapter();
    const adapter = createEncryptedAdapter(inner, await deriveLocalKey(generateSeed()));

    // Keys outside the sealed prefixes — index entries, anything else — stay
    // as they were: cheap to read, and legible from outside.
    await adapter.put('bafyexamplenode', utf8Encode('node bytes'));
    assert.equal(utf8Decode((await inner.get('bafyexamplenode'))!), 'node bytes');
    assert.equal(utf8Decode((await adapter.get('bafyexamplenode'))!), 'node bytes');
  });

  test('a value under a sealed prefix that was not sealed is refused', async () => {
    const inner = createMemoryAdapter();
    // Planted by someone who can write the folder but does not hold the seed.
    await inner.put('space:planted', utf8Encode('{"name":"written in the clear"}'));

    const adapter = createEncryptedAdapter(inner, await deriveLocalKey(generateSeed()));
    await assert.rejects(() => adapter.get('space:planted'));
  });

  test('a member key and the relays are sealed too, and refused in the clear', async () => {
    const inner = createMemoryAdapter();
    const localKey = await deriveLocalKey(generateSeed());
    const memberKey = utf8Encode('{"memberKey":"c2VjcmV0LW1lbWJlci1rZXk"}');
    const adapter = createEncryptedAdapter(inner, localKey);
    await adapter.put('spacememberkey:a', memberKey);
    await adapter.put('spacerelays:a', utf8Encode('["wss://relay.example"]'));
    for (const entry of ['spacememberkey:a', 'spacerelays:a']) {
      const raw = utf8Decode((await inner.get(entry))!);
      assert.ok(!raw.includes('c2VjcmV0') && !raw.includes('relay.example'), `${entry} is sealed`);
    }
    assert.deepEqual(await adapter.get('spacememberkey:a'), memberKey);

    // One planted in the clear is refused like any other.
    await inner.put('spacememberkey:planted', memberKey);
    await inner.put('spacerelays:planted', utf8Encode('["wss://relay.example"]'));
    await assert.rejects(() => adapter.get('spacememberkey:planted'));
    await assert.rejects(() => adapter.get('spacerelays:planted'));
  });

  test('an invite secret waiting to be used is sealed too', async () => {
    const inner = createMemoryAdapter();
    const spaces = createSpaceManager(createEncryptedAdapter(inner, await deriveLocalKey(generateSeed())));
    const other = createSpaceManager(createMemoryAdapter());
    const made = await other.create({
      name: 'Team',
      ...team,
      visibility: 'private',
      creator: 'did:key:zowner',
    });
    await spaces.join(
      await other.createInvite(made.space.id, 'did:key:zowner', {
        secret: crypto.getRandomValues(new Uint8Array(32)),
        role: 'editor',
      }),
    );

    const entries = await inner.list();
    const waiting = entries.filter((key) => key.startsWith('spaceinvite:'));
    assert.equal(waiting.length, 1);
    // Every registry entry underneath is ciphertext, whatever its prefix.
    for (const key of entries.filter((key) => key.startsWith('space'))) {
      const raw = (await inner.get(key))!;
      assert.equal(raw[0], 0x01, `${key} is stored in the clear`);
      assert.ok(!utf8Decode(raw).includes('Team'), `${key} is stored in the clear`);
    }
  });

  test('a sealed value moved to another entry does not open', async () => {
    const inner = createMemoryAdapter();
    const adapter = createEncryptedAdapter(inner, await deriveLocalKey(generateSeed()));
    await adapter.put('spacekey:a', utf8Encode('key of a'));
    await inner.put('spacekey:b', (await inner.get('spacekey:a'))!);
    await assert.rejects(() => adapter.get('spacekey:b'));
  });

  test('one registry entry that does not open is left out of the list, not the end of it', async () => {
    const inner = createMemoryAdapter();
    const spaces = createSpaceManager(createEncryptedAdapter(inner, await deriveLocalKey(generateSeed())));
    const made = await spaces.create({
      name: 'Mine',
      ...team,
      visibility: 'private',
      creator: 'did:key:zowner',
    });
    // Planted by someone who can write the folder, or left in an older format.
    await inner.put('space:bjunk', utf8Encode('{"name":"written in the clear"}'));
    assert.deepEqual(
      (await spaces.list()).map((record) => record.space.id),
      [made.space.id],
    );
    await assert.rejects(() => spaces.get('bjunk'), 'still refused when asked for');
  });

  test("the account key does not open the registry store's sealed entries", async () => {
    // An app given the whole account holds the account key. Neither it, nor
    // anything derived from it under the local key's label, opens what this
    // device sealed in the registry store: the local key comes from the seed,
    // beside it. (It does open the account's spaces, which list every space key.)
    const seed = generateSeed();
    const inner = createMemoryAdapter();
    await createEncryptedAdapter(inner, await deriveLocalKey(seed)).put('space:x', utf8Encode('hello'));

    const accountKey = await deriveAccountKey(seed);
    const asIs = await globalThis.crypto.subtle.importKey(
      'raw',
      new Uint8Array(accountKey),
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const derived = await hkdfAesKey(accountKey, utf8Encode('weave/local-key/v1'));
    for (const key of [asIs, derived])
      await assert.rejects(() => createEncryptedAdapter(inner, key).get('space:x'));
  });

  test("the account key, and the spaces derived from it, match the spec's examples", async () => {
    const seed = hexToBytes('00112233445566778899aabbccddeeff');
    assert.equal(
      bytesToHex(await deriveAccountKey(seed)),
      'f9b921c105dcc1f1f13b4d643cfe961701b733d3be473c1d0e416db233c5d598',
    );
    assert.equal(
      bytesToHex(await deriveMemberKeyBytes(await deriveAccountKey(seed), 'bexample')),
      'd6e2d8fba5a6ad5e3e1484236c85c0313a01414bf9bc95fd44e4664946fb8a48',
    );
    // The local key never leaves Web Crypto; its bytes are HKDF under its own label.
    assert.equal(
      bytesToHex(await hkdf(seed, utf8Encode('weave/local-key/v1'), 32)),
      '26e6f39b9eeff4676d4efac5cfc6d075fb3becb6ceb13f9e03f6bc3d11d34fa9',
    );
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', await deriveLocalKey(seed)));

    const other = new Uint8Array(16).map((_, i) => i + 1);
    const did = (await manager.fromSeed(other)).did;
    const registry = await deriveAccountRegistry(await deriveAccountKey(other), did);
    assert.equal(registry.space.id, 'bedvg3woledl6e5w4kj3okq2yxdmz77s4adfmegkj2n3kjavydfia');
    assert.equal(registry.space.nonce, 'Jx8Oo78z30WwKl1X');
    assert.equal(
      (await deriveContactsSpace(await deriveAccountKey(other), did)).space.id,
      'b43ypkcbueug6yc6fnoumjtzit53yphcv5l5o42l2mqlce7fgnpfa',
    );
  });

  test('the local key is deterministic, and distinct per seed', async () => {
    const seed = generateSeed();
    const inner = createMemoryAdapter();

    await createEncryptedAdapter(inner, await deriveLocalKey(seed)).put('space:x', utf8Encode('hello'));
    const again = createEncryptedAdapter(inner, await deriveLocalKey(seed));
    assert.equal(utf8Decode((await again.get('space:x'))!), 'hello');
  });
});
