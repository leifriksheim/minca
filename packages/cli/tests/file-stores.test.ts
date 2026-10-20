/**
 * Stores on disk, one log file each: what lands, what a crash leaves, what a
 * second process sees, and a store in the former layout brought over.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fileStores, openFileStore } from '../src/file-stores.js';
import { openFsDirectory } from '../src/fs-directory.js';
import { tempDir } from './helpers/nodes.js';
import { isRecord } from '../src/json.js';
import { createAccount, localPath, nodeFor, openHome, unlock } from '../src/home.js';
import { team } from '../../core/src/space/presets.js';
import { createFolderAdapter } from '../../core/src/storage/folder-adapter.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createSigner } from '../../core/src/schema/signer.js';
import { createVersion } from '../../core/src/schema/version.js';
import type { Version } from '../../core/src/types.js';

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
const bytes = (value: string) => new TextEncoder().encode(value);

async function aVersion(body: string): Promise<Version> {
  const manager = createIdentityManager();
  const me = await manager.fromSeed(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  return createSigner(manager.getProvider()).sign(
    createVersion({ author: me.did, collection: 'app.note', body: { text: body } }),
    me.privateKey,
  );
}

/** Every file under a directory, relative to it */
async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
  return out.sort();
}

describe('a store on disk', () => {
  test('is one file, and holds entries and versions across a reopen', async () => {
    const root = await tempDir();
    const version = await aVersion('kept');
    const store = await fileStores(root)('spaces/abc');
    await store.put('r/k', bytes('one'));
    await store.commit!({
      store: [version],
      ops: [{ type: 'put', key: 'i/x', value: bytes('two') }],
      remove: [],
    });
    await store.delete('r/k');
    await store.close();

    assert.deepEqual(await files(root), ['spaces/abc.log']);
    const again = await fileStores(root)('spaces/abc');
    assert.equal(await again.get('r/k'), null);
    assert.equal(text(await again.get('i/x')), 'two');
    assert.deepEqual(await again.getVersion(version.id), version);
  });

  test('a second process sees the first one’s writes, and says it did once', async () => {
    const file = path.join(await tempDir(), 'one.log');
    const daemon = await openFileStore(file);
    const command = await openFileStore(file);

    await command.put('cache', bytes('from the command'));
    assert.equal(await daemon.refresh!(), true);
    assert.equal(text(await daemon.get('cache')), 'from the command');
    assert.equal(await daemon.refresh!(), false);

    await daemon.put('other', bytes('from the daemon'));
    assert.equal(text(await command.get('other')), 'from the daemon');
    assert.equal(text(await command.get('cache')), 'from the command');
  });

  test('a line a crash cut off counts for nothing, and the next write is not lost to it', async () => {
    const file = path.join(await tempDir(), 'one.log');
    const store = await openFileStore(file);
    await store.put('a', bytes('1'));
    await appendFile(file, '[["put","b","Mg');

    const reopened = await openFileStore(file);
    assert.equal(await reopened.get('b'), null);
    await reopened.put('c', bytes('3'));

    const last = await openFileStore(file);
    assert.equal(text(await last.get('a')), '1');
    assert.equal(await last.get('b'), null);
    assert.equal(text(await last.get('c')), '3');
  });

  test('is rewritten as a snapshot once it holds far more writes than things, and others follow', async () => {
    const file = path.join(await tempDir(), 'one.log');
    const store = await openFileStore(file);
    const other = await openFileStore(file);
    for (let i = 0; i < 1100; i++) await store.put('counter', bytes(String(i)));

    // A line per write is about 25 bytes: past the first thousand, only the writes since are left.
    assert.ok((await stat(file)).size < 5000, 'the first thousand writes of one entry were folded into one');
    assert.equal(text(await other.get('counter')), '1099');
    await other.put('after', bytes('yes'));
    assert.equal(text(await store.get('after')), 'yes');
  });

  test('a lock left by a process that is gone is taken over', async () => {
    const file = path.join(await tempDir(), 'one.log');
    const store = await openFileStore(file);
    await writeFile(`${file}.lock`, '999999');
    await store.put('a', bytes('1'));
    assert.equal(text(await store.get('a')), '1');
  });

  test('a store in the former layout is read into its file, and its folder goes', async () => {
    const root = await tempDir();
    const version = await aVersion('from before');
    const former = await createFolderAdapter(await openFsDirectory(root), 'spaces/abc');
    await former.put('r/k', bytes(version.id));
    await former.putVersion(version);

    const store = await fileStores(root)('spaces/abc');
    assert.equal(text(await store.get('r/k')), version.id);
    assert.deepEqual(await store.getVersion(version.id), version);
    assert.deepEqual(await files(root), ['spaces/abc.log']);
  });

  test('the registry is sealed when a local key is given', async () => {
    const root = await tempDir();
    const localKey = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const registry = await fileStores(root, { localKey })('registry', { seal: true });
    await registry.put('spacekey:abc', bytes('the secret key'));

    assert.equal(text(await registry.get('spacekey:abc')), 'the secret key');
    const raw = await readFile(path.join(root, 'registry.log'), 'utf8');
    assert.ok(!raw.includes(Buffer.from('the secret key').toString('base64url')));
  });
});

describe('an account in a home', () => {
  test('keeps what this computer holds outside the home, which a browser or a sync service may share', async () => {
    const home = await openHome(await tempDir());
    const { account, code } = await createAccount(home, { name: 'Ada' });
    const unlocked = await unlock(home, account, { code: code! });
    const space = await unlocked.stores('spaces/abc');
    await space.put('r/k', bytes('kept here'));
    await (await unlocked.stores('writers')).put('lines/x', bytes('{}'));

    const local = localPath(home.path, account.id);
    assert.ok(path.relative(home.path, local).startsWith('..'), 'not inside the home');
    assert.ok(!(await files(home.path)).some((file) => file.endsWith('.log')), 'no store file in the home');
    assert.deepEqual(await files(local), ['spaces/abc.log', 'writers.log']);
  });
});

describe('a writer key of an account in a home', () => {
  test('keeps its places outside the home, so whoever writes the folder can’t make it sign at one twice', async () => {
    const home = await openHome(await tempDir());
    const { account, code } = await createAccount(home, { name: 'Ada' });
    let node = await nodeFor(await unlock(home, account, { code: code! }), { watchIntervalMs: 0 });
    const space = await node.spaces.create({ name: 'Notes', ...team, visibility: 'public' });
    await node.records.put(space.id, 'app.test.note', { text: 'first' });
    await node.close();

    assert.ok(!(await files(home.path)).some((file) => file.includes('heads')), 'no key place in the home');
    // Whoever writes the folder clears what it can reach.
    await rm(path.join(home.path, 'writers'), { recursive: true, force: true });
    node = await nodeFor(await unlock(home, account, { code: code! }), { watchIntervalMs: 0 });
    await node.records.put(space.id, 'app.test.note', { text: 'second' });
    await node.close();

    const places = new Map<string, number>();
    const spaces = path.join(localPath(home.path, account.id), 'spaces');
    for (const log of await readdir(spaces))
      for (const line of (await readFile(path.join(spaces, log), 'utf8')).split('\n')) {
        const ops: unknown = line ? JSON.parse(line) : [];
        for (const op of Array.isArray(ops) ? ops : []) {
          const parts: readonly unknown[] = Array.isArray(op) ? op : [];
          const version = parts[1];
          if (parts[0] !== 'ver' || !isRecord(version) || version.collection !== 'app.test.note') continue;
          const at = `${String(version.author)}:${String(isRecord(version.log) ? version.log.n : '')}`;
          places.set(at, (places.get(at) ?? 0) + 1);
        }
      }
    assert.equal(places.size, 2, 'two notes at two places');
    assert.ok(
      [...places.values()].every((count) => count === 1),
      'no place taken twice',
    );
  });
});
