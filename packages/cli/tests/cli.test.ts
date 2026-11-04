/**
 * CLI and daemon tests: the disk-backed folder, accounts, MCP, and the one
 * that matters — two devices that are never online together converging through
 * an always-on node.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { openFsDirectory } from '../src/fs-directory.js';
import { openHome, createAccount, unlock, chooseAccount, localPath, nodeFor } from '../src/home.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import { enableWebRTC, holdEverySpace } from '../src/agent.js';
import { mcpTools, toolInstructions } from '../src/mcp.js';
import { aNode, tempDir } from './helpers/nodes.js';
import { createNode } from '../../core/src/node/node.js';
import type { P2PNode } from '../../core/src/node/types.js';
import { createFolderAdapter } from '../../core/src/storage/folder-adapter.js';
import { createStorageProvider } from '../../core/src/storage/storage-provider.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { createSigner } from '../../core/src/schema/signer.js';
import { createVersion } from '../../core/src/schema/version.js';
import { generateSeed, recoveryCodeToSeed } from '../../core/src/identity/recovery-code.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { NODE_ACTIONS, PERSON_ONLY } from '../../core/src/node/actions.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { team } from '../../core/src/space/presets.js';
import { hold } from '../../core/tests/helpers/hold.js';
import { joined } from '../../core/tests/helpers/joined.js';
import { createFakeHub } from '../../core/tests/helpers/fake-transport.js';
import { createMesh } from '../../core/src/network/mesh.js';
import { at } from './helpers/json.js';
import { until } from '../../core/tests/helpers/until.js';
import { sessionsInOrder, type Session } from '../../core/tests/helpers/sessions.js';

describe('a folder on disk', () => {
  test('is a drop-in for a browser directory handle', async () => {
    const dir = await openFsDirectory(await tempDir());
    const manager = createIdentityManager();
    const me = await manager.fromSeed(new Uint8Array(16).fill(7));
    const signed = await createSigner(manager.getProvider()).sign(
      createVersion({ author: me.did, collection: 'app.note', body: { text: 'on disk' } }),
      me.privateKey,
    );

    const first = createStorageProvider(await createFolderAdapter(dir, 'stores/one'));
    await first.addVersion(signed);

    // A second process opening the same folder sees it.
    const second = createStorageProvider(await createFolderAdapter(dir, 'stores/one'));
    assert.deepEqual(await second.getVersion(signed.id), signed);
    assert.equal(await second.fingerprint(), await first.fingerprint());
  });

  test('a file another writer deletes first is not found, as in a browser', async () => {
    const dir = await openFsDirectory(await tempDir());
    const adapter = await createFolderAdapter(dir, 'stores/one');
    for (let round = 0; round < 20; round++) {
      await adapter.put('gone', new Uint8Array([1]));
      // Both find it, then each deletes it: the second must not fail.
      const other = await createFolderAdapter(dir, 'stores/one');
      await Promise.all([adapter.delete('gone'), other.delete('gone')]);
    }
    const handle = await (
      await (await dir.getDirectoryHandle('stores')).getDirectoryHandle('one')
    )
      .getDirectoryHandle('kv')
      .then((kv) => kv.getFileHandle('late', { create: true }));
    await assert.rejects(handle.getFile(), { name: 'NotFoundError' });
  });
});

describe('accounts in a home', () => {
  test('keep what this computer holds, and its writer keys, outside the home a browser or a sync service may share', async () => {
    const home = await openHome(await tempDir());
    const { account, code } = await createAccount(home, { name: 'Ada' });
    const node = await nodeFor(await unlock(home, account, { code: code! }), { watchIntervalMs: 0 });
    const space = await node.spaces.create({ name: 'Notes', ...team, visibility: 'public' });
    await node.records.put(space.id, 'app.note', { text: 'kept here' });
    await node.close();

    const inHome = (await readdir(home.path, { recursive: true })).map(String);
    assert.ok(
      !inHome.some((file) => file.includes('/kv/r%2F') || file.includes('heads')),
      'no index or key place in the home',
    );
    assert.ok(
      inHome.some((file) => file.endsWith('.seg')),
      'the space is in the home as segments',
    );
    const local = (await readdir(localPath(home.path, account.id), { recursive: true })).map(String);
    assert.ok(
      local.includes('writer-keys') &&
        !local.includes('writers') &&
        local.some((file) => file.startsWith('stores')),
    );
  });

  test('create, then unlock with the code or the passphrase — never anything else', async () => {
    const home = await openHome(await tempDir());
    const { account, code } = await createAccount(home, { name: 'Leif', passphrase: 'correct horse' });
    assert.ok(code);

    const byCode = await unlock(home, account, { code });
    const byPassphrase = await unlock(home, account, { passphrase: 'correct horse' });
    assert.equal(byCode.signer.did, account.did);
    assert.equal(byPassphrase.signer.did, account.did);

    await assert.rejects(unlock(home, account, { passphrase: 'wrong' }), /does not open/);
    await assert.rejects(unlock(home, account, {}), /needs the recovery code/);

    const other = await createAccount(await openHome(await tempDir()), { name: 'Other' });
    await assert.rejects(unlock(home, account, { code: other.code! }), /different account/);
  });

  test('the seed is never written in the clear', async () => {
    const where = await tempDir();
    const home = await openHome(where);
    const { code } = await createAccount(home, { name: 'Leif', passphrase: 'pw' });
    const seedHex = Buffer.from(recoveryCodeToSeed(code!)).toString('hex');

    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(where);
    for (const file of files) {
      const text = (await import('node:fs/promises')).readFile(file, 'utf8');
      const content = await text;
      assert.equal(content.includes(code!), false, `${file} holds the code`);
      assert.equal(content.includes(seedHex), false, `${file} holds the seed`);
    }
  });
});

describe('the daemon', () => {
  let daemon: Daemon;
  let code: string;
  let signer: Awaited<ReturnType<typeof unlock>>['signer'];
  let peerUrl: string;

  before(async () => {
    const home = await openHome(await tempDir());
    const created = await createAccount(home, { name: 'Leif' });
    assert.ok(created.code);
    code = created.code;
    const unlocked = await unlock(home, await chooseAccount(home), { code });
    signer = unlocked.signer;
    daemon = await startDaemon({ unlocked, port: 0, host: '127.0.0.1', rescanMs: 100 });
    peerUrl = `ws://127.0.0.1:${daemon.port}/peer`;
  });

  after(async () => {
    await daemon.close();
  });

  test('answers /health, and says nothing about whose node it is', async () => {
    const health: unknown = await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json();
    assert.deepEqual(health, { ok: true });
  });

  test('is a relay too: peers meet through it, in several spaces over one socket', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const meshOf = (who: Session) =>
      createMesh({
        did: who.did,
        key: who.key,
        relays: [`ws://127.0.0.1:${daemon.port}`],
        createTransport: () => hub.signalled(who.did, 'daemon-relay'),
      });
    const [first, second] = await sessionsInOrder(2);
    const [a, b] = [meshOf(first), meshOf(second)];
    const rooms = [a.join('one'), a.join('two'), b.join('one'), b.join('two')];
    const met = rooms.map(() => 0);
    rooms.forEach((room, i) => room.on('peer-connected', () => (met[i] = met[i]! + 1)));
    await Promise.all(rooms.map((room) => room.connect()));
    await until(() => met.every((n) => n === 1), 5000, 'both to meet in both spaces');
    for (const room of rooms) room.disconnect();
  });

  test('two devices that are never online together converge through it', async () => {
    const deviceStores = { a: memoryStores(), b: memoryStores() };
    const device = (stores: ReturnType<typeof memoryStores>) =>
      createNode({ signer, stores, watchIntervalMs: 0, network: { nodes: [peerUrl] } });

    // Device A makes a space and hands it to the daemon.
    let a: P2PNode = await device(deviceStores.a);
    const space = await a.spaces.create({ name: 'Shared', ...team, visibility: 'private' });
    const invite = await a.spaces.invite(space.id);
    await daemon.node.spaces.join(invite);
    await until(
      async () => (await daemon.node.spaces.status(space.id)).connection !== 'offline',
      3000,
      'daemon to open the space',
    );

    // 1. A writes ten, and goes away.
    await hold(a, space.id);
    for (let i = 0; i < 10; i++) await a.records.put(space.id, 'app.todo.item', { text: `from A ${i}` });
    await until(
      async () => (await daemon.node.records.list(space.id)).length === 10,
      5000,
      'daemon to hold A’s ten',
    );
    await a.close();

    // 2. B turns up with A long gone, and gets all ten.
    const b = await device(deviceStores.b);
    await b.spaces.join(invite);
    await hold(b, space.id);
    await until(async () => (await b.records.list(space.id)).length === 10, 5000, 'B to receive A’s ten');

    // 3. B writes five, and goes away.
    for (let i = 0; i < 5; i++) await b.records.put(space.id, 'app.todo.item', { text: `from B ${i}` });
    await until(
      async () => (await daemon.node.records.list(space.id)).length === 15,
      5000,
      'daemon to hold B’s five',
    );
    await b.close();

    // 4. A comes back and receives B's five.
    a = await device(deviceStores.a);
    await hold(a, space.id);
    await until(async () => (await a.records.list(space.id)).length === 15, 5000, 'A to receive B’s five');
    const texts = (await a.records.list<{ text: string }>(space.id)).map((r) => r.body?.text);
    assert.ok(texts.includes('from B 4'));
    await a.close();
  });

  test('a device that pins the node by its account reaches it; one that pins another key never does', async () => {
    const pinnedTo = (did: string) =>
      createNode({
        signer,
        stores: memoryStores(),
        watchIntervalMs: 0,
        network: { nodes: [`${peerUrl}#${did}`] },
      });
    const right = await pinnedTo(daemon.node.did);
    const wrong = await pinnedTo('did:key:zDnaeSomeoneElse');
    const space = await right.spaces.create({ name: 'Pinned', ...team, visibility: 'public' });
    await wrong.spaces.join(await right.spaces.invite(space.id, { write: false }));
    await daemon.node.spaces.join(await right.spaces.invite(space.id));

    for (const device of [right, wrong]) await hold(device, space.id);
    await until(
      async () => (await right.spaces.status(space.id)).peers.length > 0,
      5000,
      'the pinned device to connect',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await wrong.spaces.status(space.id)).peers, []);
    await right.close();
    await wrong.close();
  });

  test('serves a space the account created elsewhere, without being told', async () => {
    // A laptop of the same account, following the registry through the node.
    const laptop = await createNode({
      signer,
      stores: memoryStores(),
      accountKey: await deriveAccountKey(recoveryCodeToSeed(code)),
      watchIntervalMs: 0,
      network: { nodes: [peerUrl] },
    });
    const space = await laptop.spaces.create({ name: 'Found by itself', visibility: 'private' });
    const written = await laptop.records.put(space.id, 'app.note', { text: 'the node never saw an invite' });

    await until(
      async () => (await daemon.node.spaces.get(space.id)) !== null,
      5000,
      'the node to join through the registry',
    );
    await until(
      async () => (await daemon.node.records.get(space.id, written.key)) !== null,
      5000,
      'the note to reach the node',
    );
    await laptop.close();
  });

  test('given relays, a fresh copy of the account finds a space made on another device, over WebRTC', async (t) => {
    await enableWebRTC();
    const relays = [`ws://127.0.0.1:${daemon.port}`];
    // A browser of the same account, reached only through the relay: nothing points at the new node.
    const browser = await createNode({
      signer,
      stores: memoryStores(),
      accountKey: await deriveAccountKey(recoveryCodeToSeed(code)),
      watchIntervalMs: 0,
      network: { relays },
    });
    t.after(() => browser.close());
    const space = await browser.spaces.create({ name: 'Made in a browser', visibility: 'private' });

    // `minca init --existing`, then `minca run`, on a laptop.
    const home = await openHome(await tempDir());
    await createAccount(home, { name: 'Leif', code });
    const laptop = await startDaemon({
      unlocked: await unlock(home, await chooseAccount(home), { code }),
      port: 0,
      host: '127.0.0.1',
      relays,
      rescanMs: 100,
    });
    t.after(() => laptop.close());
    await until(
      async () => (await laptop.node.spaces.get(space.id)) !== null,
      20000,
      'the laptop to find the space through the relay',
    );
  });

  test('lets go of someone removed from a private space once the key changes, and never lets them back', async (t) => {
    const space = (await daemon.node.spaces.create({ name: 'Crew', ...team, visibility: 'private' })).id;
    const nodes: P2PNode[] = [];
    t.after(() => Promise.all(nodes.map((node) => node.close())));
    const person = async () => {
      const manager = createIdentityManager();
      const seed = generateSeed();
      const me = await manager.fromSeed(seed);
      // With the account key, so each has a member key the new space key is sealed to.
      const node = await createNode({
        signer: createLocalRootSigner(me, manager.getProvider()),
        accountKey: await deriveAccountKey(seed),
        stores: memoryStores(),
        watchIntervalMs: 0,
        network: { nodes: [peerUrl] },
      });
      nodes.push(node);
      await node.spaces.join(await daemon.node.spaces.invite(space));
      await hold(node, space);
      await joined(node, space);
      const heard: unknown[] = [];
      node.subscribe((event) => {
        if (event.type === 'message' && event.space === space) heard.push(event.message);
      });
      return { node, heard };
    };
    const [bob, carol] = [await person(), await person()];
    const served = async () => Object.values((await daemon.node.spaces.status(space)).accounts);
    const members = async () => (await daemon.node.spaces.access(space)).members.map((held) => held.did);
    await until(
      async () => (await members()).includes(bob.node.did) && (await members()).includes(carol.node.did),
      5000,
      'both to be members, as the node sees it',
    );
    await until(
      async () => (await served()).includes(bob.node.did) && (await served()).includes(carol.node.did),
      5000,
      'the node to serve both',
    );

    await daemon.node.spaces.removeMember(space, carol.node.did);
    await until(async () => (await daemon.node.spaces.access(space)).key?.changes === 1, 5000, 'a new key');
    await until(async () => !(await served()).includes(carol.node.did), 5000, 'the node to let Carol go');
    assert.ok((await served()).includes(bob.node.did), 'Bob, still a member, stays');

    await daemon.node.records.put(space, 'app.note', { text: 'after' });
    await daemon.node.spaces.send(space, 'who is here?');
    await until(() => bob.heard.includes('who is here?'), 5000, 'Bob to hear it');
    await until(
      async () =>
        (await bob.node.records.list<{ text: string }>(space, { collection: 'app.note' })).some(
          (note) => note.body?.text === 'after',
        ),
      5000,
      'Bob to read the note',
    );
    // Carol's socket redials, proves the old key with her note, and is refused.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await served()).includes(carol.node.did), false);
    assert.deepEqual(carol.heard, []);
    assert.equal(
      (await carol.node.records.list(space, { collection: 'app.note' })).length,
      0,
      'not even the ciphertext',
    );
  });

  test('refuses a stranger to a private space, before sending anything', async () => {
    const space = await daemon.node.spaces.create({ name: 'Members only', ...team, visibility: 'private' });
    const socket = new WebSocket(`${peerUrl}?space=${space.id}`);
    const frames: string[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(String(event.data));
      if (at(JSON.parse(String(event.data)), 'type') === 'challenge')
        socket.send(JSON.stringify({ type: 'hello', did: 'did:key:zStranger', nonce: 'n', sig: 'forged' }));
    });
    const closed = await new Promise<number>((resolve) =>
      socket.addEventListener('close', (event) => resolve(event.code)),
    );
    assert.equal(closed, 4003);
    assert.equal(frames.length, 1); // the challenge, and nothing of the space
  });

  test('refuses a peer for a space it does not hold — exactly as it refuses a stranger', async () => {
    // Challenged first either way, then the same close: a page cannot ask which spaces it holds.
    const socket = new WebSocket(`${peerUrl}?space=nope`);
    let challenged = false;
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener('close', (event) => resolve(event.code)),
    );
    socket.addEventListener('message', (event) => {
      challenged ||= at(JSON.parse(String(event.data)), 'type') === 'challenge';
      socket.send(JSON.stringify({ type: 'hello', did: 'did:key:zStranger', nonce: 'n' }));
    });
    assert.equal(await closed, 4003);
    assert.equal(challenged, true);
  });
});

describe('MCP tools', () => {
  test('every node action is a tool, with its title and what it may change', () => {
    const tools = mcpTools();
    assert.equal(tools.length, NODE_ACTIONS.length);
    const query = tools.find((tool) => tool.name === 'records_query');
    assert.equal(query?.annotations.readOnlyHint, true);
    assert.equal(query?.title, 'Find records');
    assert.equal(tools.find((tool) => tool.name === 'records_delete')?.annotations.destructiveHint, true);
  });

  test('an agent is not offered what needs a person, and is told to propose apps instead', () => {
    const agent = { agent: true };
    assert.match(toolInstructions({ did: 'did:key:z' }, agent), /collections_propose/);
    const names = mcpTools(agent).map((tool) => tool.name);
    for (const name of PERSON_ONLY) assert.ok(!names.includes(name), `${name} is not offered`);
    assert.ok(names.includes('collections_propose') && names.includes('records_put'));
  });
});

describe('holding every space', () => {
  test('holds a space joined after it started, as an agent running for a while needs, and lets go of one left', async () => {
    const node = await aNode(41);
    const before = await node.spaces.create({ name: 'Before', visibility: 'public' });
    const held: string[] = [];
    const released: string[] = [];
    const stop = await holdEverySpace(node, {
      onHold: (id) => held.push(id),
      onRelease: (id) => released.push(id),
    });
    assert.deepEqual(held, [before.id]);
    const later = await node.spaces.create({ name: 'Later', visibility: 'public' });
    await until(async () => held.includes(later.id), 5000, 'the space made later to be held');
    await node.spaces.leave(before.id);
    await until(async () => released.includes(before.id), 5000, 'the space left to be let go');
    stop();
  });
});
