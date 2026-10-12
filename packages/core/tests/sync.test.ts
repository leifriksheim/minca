/**
 * Sync tests — two peers reconciling by Negentropy, with the
 * version check acting as gatekeeper on everything that arrives.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
function createPeer(send: (peerId: string, message: SyncMessage) => void) {
  const storage = createStorageProvider(createMemoryAdapter());

  const check = createVersionCheck({
    provider,
    required: (version) => writeRequirement(COLLECTION, version.collection),
  });

  const sync = createSyncEngine({
    storageProvider: storage,
    sendToPeer: send,
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
async function delegatedNote(root: { did: string; privateKey: CryptoKey }, text: string) {
  const session = await makeKey();
  const ucan = await issueDelegation({ issuer: root, audience: session.did, ...WRITE }, provider);
  const unsigned = createVersion({
    author: session.did,
    collection: COLLECTION,
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
});
