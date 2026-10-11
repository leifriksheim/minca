/**
 * Lasting writer keys on disk: one key per slot, never two processes on one
 * slot, and places kept beside the key (spec 02 §4.10).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fileWriterKeys, holdLock } from '../src/writer-keys.js';
import { openHome, createAccount, unlock, chooseAccount, nodeFor } from '../src/home.js';
import { tempDir } from './helpers/nodes.js';

const localKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
  'encrypt',
  'decrypt',
]);

const ACCOUNT = 'did:key:zAccount';

const didOf = async (keys: CryptoKeyPair) =>
  Buffer.from(await globalThis.crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');

describe('writer keys on disk', () => {
  test('a slot gives the same key each time, and only to one holder at once', async () => {
    const dir = await tempDir();
    const source = fileWriterKeys(dir, localKey, ACCOUNT);
    const first = (await source.claim())!;
    const second = (await source.claim())!;
    assert.notEqual(await didOf(first.keys), await didOf(second.keys), 'the slot is taken: another one');

    const kept = await didOf(first.keys);
    await first.release();
    const again = (await source.claim())!;
    assert.equal(await didOf(again.keys), kept);
    await again.release();
    await second.release();
  });

  test('a lock left by a process that is gone is taken over', async () => {
    const dir = await tempDir();
    const source = fileWriterKeys(dir, localKey, ACCOUNT);
    const first = (await source.claim())!;
    const kept = await didOf(first.keys);
    // As if it crashed: the lock stays, naming a process that no longer runs.
    await writeFile(path.join(dir, 'slot-0', 'lock'), '2147483646');
    const again = (await source.claim())!;
    assert.equal(await didOf(again.keys), kept);
    await again.release();
  });

  test('places are kept beside the key', async () => {
    const dir = await tempDir();
    const source = fileWriterKeys(dir, localKey, ACCOUNT);
    const first = (await source.claim())!;
    await first.heads.put('head/did:key:z/space', new TextEncoder().encode('{"n":4,"id":"b"}'));
    await first.release();
    const again = (await source.claim())!;
    assert.equal(
      new TextDecoder().decode((await again.heads.get('head/did:key:z/space'))!),
      '{"n":4,"id":"b"}',
    );
    assert.equal(await again.heads.get('head/other'), null);
    await again.release();
  });

  test("a key on disk is sealed: a copy of the files without the local key can't sign", async () => {
    const dir = await tempDir();
    const claimed = (await fileWriterKeys(dir, localKey, ACCOUNT).claim())!;
    await claimed.release();
    const text = await readFile(path.join(dir, 'slot-0', 'key.sealed'), 'latin1');
    assert.equal(text.includes('"kty"'), false, 'no key in the clear');
    const other = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await assert.rejects(fileWriterKeys(dir, other, ACCOUNT).claim());
  });

  test('a key file moved to another slot, or to another account, does not open', async () => {
    const dir = await tempDir();
    const source = fileWriterKeys(dir, localKey, ACCOUNT);
    const first = (await source.claim())!;
    const second = (await source.claim())!;
    await first.release();
    await second.release();
    // Slot 1's file copied over slot 0's: it is bound to slot 1, so slot 0 refuses it.
    await writeFile(
      path.join(dir, 'slot-0', 'key.sealed'),
      await readFile(path.join(dir, 'slot-1', 'key.sealed')),
    );
    await assert.rejects(source.claim(), /slot 0/);
    // The same files, read as another account's under the same local key.
    await assert.rejects(fileWriterKeys(dir, localKey, 'did:key:zSomeoneElse').claim());
  });

  test('a lock is held by one at a time, and let go of by the holder (as an agent holds its key)', async () => {
    const file = path.join(await tempDir(), 'lock');
    const release = await holdLock(file);
    assert.ok(release);
    assert.equal(await holdLock(file), null, 'held: a second agent is turned away');
    await release();
    const again = await holdLock(file);
    assert.ok(again);
    await again();
  });

  test('the private key can sign, and is not given out', async () => {
    const source = fileWriterKeys(await tempDir(), localKey, ACCOUNT);
    const claimed = (await source.claim())!;
    assert.equal(claimed.keys.privateKey.extractable, false);
    await claimed.release();
  });

  test('a node of the account signs with the same key run after run, and two at once with two', async () => {
    const home = await openHome(await tempDir());
    const { code } = await createAccount(home, { name: 'Leif' });
    const unlocked = await unlock(home, await chooseAccount(home), { code: code! });

    const first = await nodeFor(unlocked);
    const did = first.sessionDid;
    const alongside = await nodeFor(unlocked);
    assert.notEqual(alongside.sessionDid, did);
    await alongside.close();
    await first.close();

    const later = await nodeFor(unlocked);
    assert.equal(later.sessionDid, did);
    await later.close();
  });
});
