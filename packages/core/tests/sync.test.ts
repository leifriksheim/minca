/**
 * Sync tests — two peers reconciling by Negentropy, with the
 * version check acting as gatekeeper on everything that arrives.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { until } from './helpers/until.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { issueDelegation } from '../src/identity/ucan.js';
import { writeRequirement } from '../src/identity/abilities.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createVersionCheck } from '../src/validation/check-version.js';
import { createSyncEngine } from '../src/sync/sync-engine.js';
import type { SyncMessage } from '../src/sync/sync-messages.js';
import type { Version } from '../src/types.js';
import { makeKey } from './helpers/person.js';

const provider = createP256Provider();
const signer = createSigner(provider);

const COLLECTION = 'app.test.note';
/** A note's terms: writing records in the space named after the collection */
const WRITE = { command: '/record/write', subject: `space:${COLLECTION}` } as const;

/** A storage provider plus the validating sync engine in front of it. */
function createPeer(send: (peerId: string, message: SyncMessage) => void, self?: string) {
  const storage = createStorageProvider(createMemoryAdapter());

  const check = createVersionCheck({
    provider,
    required: (version) => writeRequirement(COLLECTION, version.collection),
  });

  const sync = createSyncEngine({
    storageProvider: storage,
    sendToPeer: send,
    ...(self !== undefined ? { self } : {}),
    validate: async (version) => {
      const result = await check(version);
      return { valid: result.passed, reason: result.reason };
    },
  });

  return { storage, sync };
}

/** Two peers wired directly to each other, with deterministic message delivery. */
function createPair() {
  const inFlight: Promise<void>[] = [];
  const a = createPeer((_peerId, message) => {
    inFlight.push(b.sync.handleMessage('a', message));
  });
  const b = createPeer((_peerId, message) => {
    inFlight.push(a.sync.handleMessage('b', message));
  });

  a.sync.addPeer('b');
  b.sync.addPeer('a');

  /**
   * Runs the exchange to completion. Some sends are queued from promise
   * callbacks, so this keeps turning the event loop until two quiet rounds —
   * each a few milliseconds of real time — pass with nothing left to deliver.
   */
  const settle = async () => {
    let idleRounds = 0;
    for (let round = 0; round < 50 && idleRounds < 2; round++) {
      // Nothing to deliver: wait a little real time too. A hello goes out only after its
      // fingerprints are hashed, which on a busy machine takes longer than a turn or two.
      await new Promise((resolve) => setTimeout(resolve, inFlight.length > 0 ? 0 : 25));
      if (inFlight.length === 0) {
        idleRounds++;
        continue;
      }
      idleRounds = 0;
      await Promise.all(inFlight.splice(0, inFlight.length));
    }
  };

  return { a, b, settle };
}

/** Signs a note carrying a UCAN from `root` to the signing key. */
async function delegatedNote(
  root: { did: string; privateKey: CryptoKey },
  text: string,
  collection = COLLECTION,
) {
  const session = await makeKey();
  const ucan = await issueDelegation({ issuer: root, audience: session.did, ...WRITE }, provider);
  const unsigned = createVersion({
    author: session.did,
    collection,
    body: { text },
    proof: ucan,
  });
  return await signer.sign(unsigned, session.privateKey);
}

describe('sync engine', () => {
  test('pushes a local change to a peer', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    const note = await delegatedNote(root, 'pushed');
    await a.storage.addVersion(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.notEqual(await b.storage.getVersion(note.id), null);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  test('reconciles a peer that is behind', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    for (const text of ['first', 'second', 'third']) {
      await a.storage.addVersion(await delegatedNote(root, text));
    }

    // b asks a what it has, and pulls whatever it is missing
    b.sync.notifyPeers(['a']);
    await settle();

    const notes = await b.storage.queryVersions(COLLECTION);
    assert.equal(notes.length, 3);
    assert.equal(await b.storage.fingerprint(), await a.storage.fingerprint());
  });

  /** The order a peer holding these collections and a new one reconcile them in, `starts` naming who starts */
  async function reconcileOrder(starts: 'holder' | 'newcomer') {
    const reconciled: string[] = [];
    const note = (message: SyncMessage) => {
      if (message.type === 'reconcile' && !reconciled.includes(message.collection))
        reconciled.push(message.collection);
    };
    // Of two peers, the one whose id sorts first starts.
    const [holderId, newId] = starts === 'holder' ? ['a', 'b'] : ['b', 'a'];
    const holder = createPeer((_peerId, message) => {
      note(message);
      void newcomer.sync.handleMessage(holderId, message);
    }, holderId);
    const newcomer = createPeer((_peerId, message) => {
      note(message);
      void holder.sync.handleMessage(newId, message);
    }, newId);
    const root = await makeKey();
    const kept = { 'app.a-long-log': 6, 'app.b-profiles': 1, 'sys.role': 2, 'app.c-settings': 3 };
    for (const [collection, count] of Object.entries(kept))
      for (let i = 0; i < count; i++)
        await holder.storage.addVersion(await delegatedNote(root, `${i}`, collection));
    holder.sync.addPeer(newId);
    newcomer.sync.addPeer(holderId);
    newcomer.sync.notifyPeers([holderId]);
    await until(async () => reconciled.length === 4, 3000, 'every collection to be reconciled');
    return reconciled;
  }

  test('a holder that starts reconciling takes who may do what first, then the smallest collections', async () => {
    assert.deepEqual(await reconcileOrder('holder'), [
      'sys.role',
      'app.b-profiles',
      'app.c-settings',
      'app.a-long-log',
    ]);
  });

  test('a new peer that starts takes who may do what first, though it knows no sizes', async () => {
    assert.equal((await reconcileOrder('newcomer'))[0], 'sys.role');
  });

  test('drops a forged version instead of committing it', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();

    const note = await delegatedNote(root, 'honest');
    const forged = { ...note, body: { text: 'tampered in transit' } };

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _version: Version, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addVersion(forged);
    a.sync.onLocalChange(forged);
    await settle();

    assert.equal(await b.storage.getVersion(forged.id), null);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0] ?? '', /not the one it signed/i);
  });

  test('drops a version whose author holds no capability', async () => {
    const { a, b, settle } = createPair();

    // Signed correctly, but the session key presents no delegation at all and
    // is not writing for itself either — a stranger with a valid signature.
    const stranger = await makeKey();
    const root = await makeKey();
    const ucan = await issueDelegation(
      {
        issuer: root,
        audience: root.did, // issued to the root, not to the signer
        ...WRITE,
      },
      provider,
    );
    const unsigned = createVersion({
      author: stranger.did,
      collection: COLLECTION,
      body: { text: 'not mine to write' },
      proof: ucan,
    });
    const note = await signer.sign(unsigned, stranger.privateKey);

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _version: Version, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addVersion(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.equal(await b.storage.getVersion(note.id), null);
    assert.match(rejected[0] ?? '', /different key/i);
  });

  test('drops a malformed version, however well signed', async () => {
    const { a, b, settle } = createPair();
    const root = await makeKey();
    const session = await makeKey();

    const ucan = await issueDelegation({ issuer: root, audience: session.did, ...WRITE }, provider);
    const unsigned = createVersion({
      author: session.did,
      collection: COLLECTION,
      body: { text: 'fine' },
      proof: ucan,
    });
    const note = await signer.sign({ ...unsigned, key: 'Has Spaces' }, session.privateKey);

    const rejected: string[] = [];
    b.sync.on('rejected', (_peer: string, _version: Version, reason: string) => {
      rejected.push(reason);
    });

    await a.storage.addVersion(note);
    a.sync.onLocalChange(note);
    await settle();

    assert.equal(await b.storage.getVersion(note.id), null);
    assert.match(rejected[0] ?? '', /key is missing or malformed/);
  });

  test('a new peer takes in a record edited more times than it can hold back at once', async () => {
    // Each edit waits for the one before it, as a space holds back a version until its
    // chain is here: a long history arrives mostly ahead of its parents.
    const EDITS = 2500;
    const holderStorage = createStorageProvider(createMemoryAdapter());
    const newcomerStorage = createStorageProvider(createMemoryAdapter());
    const chainIsHere = async (version: Version) =>
      version.seq === 0 ||
      (!!(await newcomerStorage.getVersion(version.prev!)) &&
        !!(await newcomerStorage.getVersion(version.genesis!)));
    const holder: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: holderStorage,
      sendToPeer: (_peer, message) => void newcomer.handleMessage('a', message),
      self: 'a',
    });
    const newcomer: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: newcomerStorage,
      sendToPeer: (_peer, message) => void holder.handleMessage('b', message),
      self: 'b',
      validate: async (version) =>
        (await chainIsHere(version)) ? { valid: true } : { valid: false, later: true },
    });

    const author = await makeKey();
    let previous = await signer.sign(
      createVersion({ author: author.did, collection: COLLECTION, body: { edit: 0 } }),
      author.privateKey,
    );
    await holderStorage.addVersion(previous);
    const genesis = previous.id;
    for (let edit = 1; edit < EDITS; edit++) {
      previous = await signer.sign(
        createVersion({
          author: author.did,
          collection: COLLECTION,
          body: { edit },
          version: { key: previous.key, seq: edit, prev: previous.id, genesis },
        }),
        author.privateKey,
      );
      await holderStorage.addVersion(previous);
    }

    holder.addPeer('b');
    newcomer.addPeer('a');
    newcomer.notifyPeers(['a']);
    await until(() => newcomer.levelWith('a'), 60_000, 'the newcomer to be level with the holder');
    assert.equal((await newcomerStorage.sums()).get(COLLECTION)?.count, EDITS);
    assert.equal(await newcomerStorage.fingerprint(), await holderStorage.fingerprint());
  });

  test('a new peer that syncs shallow takes a record edited thousands of times as two versions', async () => {
    const EDITS = 2500;
    const holderStorage = createStorageProvider(createMemoryAdapter());
    const newcomerStorage = createStorageProvider(createMemoryAdapter());
    const sent: SyncMessage[] = [];
    const holder: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: holderStorage,
      sendToPeer: (_peer, message) => void newcomer.handleMessage('a', message),
      self: 'a',
    });
    const newcomer: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: newcomerStorage,
      sendToPeer: (_peer, message) => {
        sent.push(message);
        void holder.handleMessage('b', message);
      },
      self: 'b',
      shallowWith: () => true,
    });

    const author = await makeKey();
    let previous = await signer.sign(
      createVersion({ author: author.did, collection: COLLECTION, body: { edit: 0 } }),
      author.privateKey,
    );
    const genesis = previous;
    await holderStorage.addVersion(previous);
    for (let edit = 1; edit < EDITS; edit++) {
      previous = await signer.sign(
        createVersion({
          author: author.did,
          collection: COLLECTION,
          body: { edit },
          version: { key: previous.key, seq: edit, prev: previous.id, genesis: genesis.id },
        }),
        author.privateKey,
      );
      await holderStorage.addVersion(previous);
    }

    holder.addPeer('b');
    newcomer.addPeer('a');
    newcomer.notifyPeers(['a']);
    await until(() => newcomer.levelWith('a'), 10_000, 'the newcomer to be level with the holder');
    assert.equal((await newcomerStorage.sums()).get(COLLECTION)?.count, 2, 'its first and current version');
    assert.equal((await newcomerStorage.getCurrent(genesis.key))?.id, previous.id);
    assert.deepEqual(await newcomerStorage.shallowSums(), await holderStorage.shallowSums());
    assert.ok(sent.length < 20, `a handful of messages, not ${sent.length}`);
  });
});
