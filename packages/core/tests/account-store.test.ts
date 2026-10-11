/**
 * Account store tests — several accounts in one place.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryDirectory } from './helpers/memory-directory.js';
import {
  createFolderAccountStore,
  accountDataPath,
  newAccountId,
  type AccountSummary,
} from '../src/identity/account-store.js';
import { createVault, wrapSeedWithPassphrase } from '../src/identity/account-vault.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { utf8Decode } from '../src/utils/encoding.js';

const manager = createIdentityManager();

/** An account ready to be filed, with a wrap that actually opens. */
async function makeAccount(name: string, when?: string) {
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  const id = newAccountId();

  const summary: AccountSummary = {
    id,
    name,
    did: identity.did,
    createdAt: when ?? new Date().toISOString(),
    dataPath: accountDataPath(id),
  };

  const vault = createVault({
    did: identity.did,
    label: name,
    wraps: [await wrapSeedWithPassphrase(seed, 'a passphrase')],
  });

  return { summary, vault, seed };
}

describe('several accounts in one folder', () => {
  test('files an account and reads its keys back', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());
    const { summary, vault } = await makeAccount('Leif');

    await store.write(summary, vault);

    assert.deepEqual(
      (await store.list()).map((a) => a.name),
      ['Leif'],
    );
    assert.equal((await store.read(summary.id))?.did, summary.did);
  });

  test('keeps accounts apart, each with its own subtree', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());

    const work = await makeAccount('Work');
    const personal = await makeAccount('Personal');
    await store.write(work.summary, work.vault);
    await store.write(personal.summary, personal.vault);

    assert.equal((await store.list()).length, 2);
    assert.equal((await store.read(work.summary.id))?.did, work.summary.did);
    assert.equal((await store.read(personal.summary.id))?.did, personal.summary.did);
    assert.notEqual(work.summary.dataPath, personal.summary.dataPath);
  });

  test('the list is readable without opening anything, and the keys are not', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());
    const { summary, vault, seed } = await makeAccount('Leif');
    await store.write(summary, vault);

    const file = await folder.open().getFileHandle('accounts.json');
    const listed = utf8Decode(new Uint8Array(await (await file.getFile()).arrayBuffer()));

    // Offering a choice of accounts means knowing their names, so a folder
    // says who has an account in it. It must not say more than that.
    assert.ok(listed.includes('Leif'));
    assert.ok(listed.includes(summary.did));
    assert.ok(!listed.includes(Buffer.from(seed).toString('base64')));
  });

  test('most recently used comes first', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());

    const older = await makeAccount('Older', '2026-01-01T00:00:00.000Z');
    const newer = await makeAccount('Newer', '2026-02-01T00:00:00.000Z');
    await store.write(newer.summary, newer.vault);
    await store.write(older.summary, older.vault);

    assert.deepEqual(
      (await store.list()).map((a) => a.name),
      ['Newer', 'Older'],
    );

    // Signing in updates the order the picker opens on.
    await store.write({ ...older.summary, lastUsedAt: '2026-03-01T00:00:00.000Z' }, older.vault);
    assert.deepEqual(
      (await store.list()).map((a) => a.name),
      ['Older', 'Newer'],
    );
  });

  test('rewriting an account replaces it rather than duplicating', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());
    const { summary, vault } = await makeAccount('Leif');

    await store.write(summary, vault);
    await store.write({ ...summary, name: 'Leif (renamed)' }, vault);

    assert.deepEqual(
      (await store.list()).map((a) => a.name),
      ['Leif (renamed)'],
    );
  });

  test('removing an account takes its keys with it', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());
    const { summary, vault } = await makeAccount('Leif');
    await store.write(summary, vault);

    await store.remove(summary.id);

    assert.deepEqual(await store.list(), []);
    assert.equal(await store.read(summary.id), null);
  });

  test('one identity never appears twice', async () => {
    const folder = createMemoryDirectory();
    const store = createFolderAccountStore(folder.open());
    const first = await makeAccount('Leif');

    // The same person filed again under a fresh row id — what happens when an
    // account is moved, or signed into by a path that did not recognise it.
    const second = {
      summary: { ...first.summary, id: newAccountId(), lastUsedAt: '2030-01-01T00:00:00.000Z' },
      vault: first.vault,
    };

    await store.write(first.summary, first.vault);
    await store.write(second.summary, second.vault);

    const listed = await store.list();
    assert.equal(listed.length, 1, 'a picker must not offer the same person twice');
    assert.equal(listed[0]!.id, second.summary.id, 'the most recently used row wins');
  });

  test('a folder that is gone says so, and what to do', async () => {
    const gone = Object.assign(new Error('gone'), { name: 'NotFoundError' });
    const vanished = {
      ...createMemoryDirectory().open(),
      getDirectoryHandle: async () => {
        throw gone;
      },
    };
    const store = createFolderAccountStore(vanished);
    const { summary, vault } = await makeAccount('Leif');
    await assert.rejects(store.write(summary, vault), { code: 'FOLDER_GONE', message: /could not be found/ });
  });

  test('an unknown account reads as nothing, not as an error', async () => {
    const store = createFolderAccountStore(createMemoryDirectory().open());
    assert.equal(await store.read('nope'), null);
  });
});
