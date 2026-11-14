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
import { SYNC_PROTOCOL_VERSION, type SyncMessage } from '../src/sync/sync-messages.js';
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

  test('a peer taking a long history asks for no version twice, not even one waiting for the one below it', async () => {
    const EDITS = 2000;
    const holderStorage = createStorageProvider(createMemoryAdapter());
    const newcomerStorage = createStorageProvider(createMemoryAdapter());
    let shallow = true;
    const asked: string[] = [];
    const holder: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: holderStorage,
      sendToPeer: (_peer, message) => void newcomer.handleMessage('a', message),
      self: 'a',
    });
    const newcomer: ReturnType<typeof createSyncEngine> = createSyncEngine({
      storageProvider: newcomerStorage,
      sendToPeer: (_peer, message) => {
        if (message.type === 'want') asked.push(...message.ids);
        void holder.handleMessage('b', message);
      },
      self: 'b',
      shallowWith: () => shallow,
      // As a node's chain check: a version waits for the one before it, but a keeper's comes alone while shallow.
      validate: async (version) =>
        shallow || version.seq === 0 || (await newcomerStorage.getVersion(String(version.prev)))
          ? { valid: true }
          : { valid: false, later: true, reason: 'waits for the version before' },
    });

    const author = await makeKey();
    let previous = await signer.sign(
      createVersion({ author: author.did, collection: COLLECTION, body: { edit: 0 } }),
      author.privateKey,
    );
    const genesis = previous;
    const ids = [genesis.id];
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
      ids.push(previous.id);
    }
    holder.addPeer('b');
    newcomer.addPeer('a');
    newcomer.notifyPeers(['a']);
    await until(
      async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === 2,
      10_000,
      'the first and current version',
    );

    // Its current version is here. The rest come in no order (edits in one millisecond sort by id), most waiting a while.
    shallow = false;
    asked.length = 0;
    const inNoOrder = ids
      .map((id) => ({ id, order: Math.random() }))
      .sort((a, b) => a.order - b.order)
      .map(({ id }) => id);
    newcomer.ask(COLLECTION, inNoOrder);
    newcomer.notifyPeers(['a']);
    await until(
      async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === EDITS,
      30_000,
      'every version',
    );
    const askedTwice = asked.length - new Set(asked).size;
    assert.equal(askedTwice, 0, `${askedTwice} versions asked for again, of ${asked.length} asks`);
  });

  describe('large records', () => {
    const MB = 1024 * 1024;
    /** Text of about `length` characters that doesn't repeat */
    const filler = (length: number, salt: number) =>
      Array.from({ length: Math.ceil(length / 8) }, (_, i) =>
        ((salt * 7919 + i) * 2654435761).toString(36).slice(0, 8),
      )
        .join('')
        .slice(0, length);

    async function bigNotes(count: number, bytes: number): Promise<Version[]> {
      const author = await makeKey();
      const notes: Version[] = [];
      for (let n = 0; n < count; n++)
        notes.push(
          await signer.sign(
            createVersion({ author: author.did, collection: COLLECTION, body: { text: filler(bytes, n) } }),
            author.privateKey,
          ),
        );
      return notes;
    }

    /** Two engines that record the bytes of every `versions` message, and whose connections are backed up at will */
    function pair(options: { holderBacklog?: () => number } = {}) {
      const sizes: Array<{ bytes: number; answer: boolean; count: number }> = [];
      const holderStorage = createStorageProvider(createMemoryAdapter());
      const newcomerStorage = createStorageProvider(createMemoryAdapter());
      const record = (message: SyncMessage) => {
        if (message.type === 'versions')
          sizes.push({
            bytes: JSON.stringify(message).length,
            answer: message.id !== undefined,
            count: message.versions.length,
          });
      };
      const holder: ReturnType<typeof createSyncEngine> = createSyncEngine({
        storageProvider: holderStorage,
        sendToPeer: (_peer, message) => {
          record(message);
          void newcomer.handleMessage('a', message);
        },
        self: 'a',
        ...(options.holderBacklog ? { backlog: options.holderBacklog } : {}),
      });
      const newcomer: ReturnType<typeof createSyncEngine> = createSyncEngine({
        storageProvider: newcomerStorage,
        sendToPeer: (_peer, message) => {
          record(message);
          void holder.handleMessage('b', message);
        },
        self: 'b',
      });
      holder.addPeer('b');
      newcomer.addPeer('a');
      return { holder, newcomer, holderStorage, newcomerStorage, sizes };
    }

    test('a peer that lacks large records is sent them a message of about 1 MB at a time, and takes in all of them', async () => {
      const notes = await bigNotes(60, 100_000);
      const { holder, holderStorage, newcomerStorage, sizes } = pair();
      for (const note of notes) await holderStorage.addVersion(note);
      // The holder's id sorts first, so it starts, and sends what the newcomer lacks unasked.
      holder.notifyPeers(['b']);
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
        30_000,
        'every record to reach the newcomer',
      );
      assert.equal(await newcomerStorage.fingerprint(), await holderStorage.fingerprint());
      assert.ok(sizes.length >= 5, `${sizes.length} messages for 6 MB`);
      for (const { bytes } of sizes) assert.ok(bytes < MB + 120_000, `a message of ${bytes} bytes`);
    });

    test('a want for large records is answered a message at a time, and the asker asks again for the rest', async () => {
      const notes = await bigNotes(40, 100_000);
      const { newcomer, holderStorage, newcomerStorage, sizes } = pair();
      for (const note of notes) await holderStorage.addVersion(note);
      // Asked for all 40 by id: four messages' worth.
      newcomer.ask(
        COLLECTION,
        notes.map((note) => note.id),
      );
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
        30_000,
        'every record asked for to arrive',
      );
      const answers = sizes.filter((size) => size.answer);
      assert.ok(answers.length >= 4, `${answers.length} answers for 4 MB asked at once`);
      for (const { bytes } of answers) assert.ok(bytes < MB + 120_000, `an answer of ${bytes} bytes`);
    });

    test('a want is answered once the connection has room, not buffered for a peer that does not read', async () => {
      let backlog = 100 * MB;
      const notes = await bigNotes(5, 100_000);
      const { holder, newcomer, holderStorage, newcomerStorage, sizes } = pair({
        holderBacklog: () => backlog,
      });
      for (const note of notes) await holderStorage.addVersion(note);
      newcomer.ask(
        COLLECTION,
        notes.map((note) => note.id),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        sizes.filter((size) => size.answer).length,
        0,
        'nothing sent while the connection is full',
      );
      backlog = 0;
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
        5000,
        'the answer once it drained',
      );
      holder.removePeer('b');
    });

    test('an answer holding one version takes no other that would carry it past 1 MB', async () => {
      const [justUnder] = await bigNotes(1, MB - 3000);
      const [large] = await bigNotes(1, 3 * MB);
      const { newcomer, holderStorage, newcomerStorage, sizes } = pair();
      await holderStorage.addVersion(justUnder!);
      await holderStorage.addVersion(large!);
      newcomer.ask(COLLECTION, [justUnder!.id, large!.id]);
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === 2,
        10_000,
        'both, in two answers',
      );
      const answers = sizes.filter((size) => size.answer && size.count > 0);
      assert.deepEqual(
        answers.map((size) => size.count),
        [1, 1],
        'each alone',
      );
    });

    test('a peer that asks and does not read has only so many answers kept waiting', async () => {
      let backlog = 100 * MB;
      const notes = await bigNotes(30, 100);
      const { holder, holderStorage, sizes } = pair({ holderBacklog: () => backlog });
      for (const note of notes) await holderStorage.addVersion(note);
      // Wants straight off the wire, more than an honest peer keeps in flight.
      for (let n = 0; n < notes.length; n++)
        await holder.handleMessage('b', {
          v: SYNC_PROTOCOL_VERSION,
          type: 'want',
          id: 1000 + n,
          ids: [notes[n]!.id, 'not a version id'],
        });
      backlog = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const answered = sizes.filter((size) => size.answer).length;
      assert.equal(answered, 16, `${answered} answers kept for ${notes.length} wants`);
      holder.removePeer('b');
    });

    test('a node says it is level with a peer, or synced, only once it has sent what the peer lacks', async () => {
      // A keeper counts as having a write once level (spec 05 §9), and a node may close on that.
      const notes = await bigNotes(30, 1000);
      const { holder, holderStorage, newcomerStorage, sizes } = pair();
      for (const note of notes) await holderStorage.addVersion(note);
      const sent = () => sizes.filter((size) => !size.answer).reduce((n, size) => n + size.count, 0);
      let sentWhenLevel = -1;
      holder.on('level', (peer, collection) => {
        if (peer === 'b' && collection === COLLECTION && sentWhenLevel < 0) sentWhenLevel = sent();
      });
      const synced = new Promise<number>((resolve) =>
        holder.on('synced', (peer) => {
          if (peer !== 'b') return;
          const now = sent();
          holder.stop();
          resolve(now);
        }),
      );
      holder.notifyPeers(['b']);
      assert.equal(await synced, notes.length, 'synced before every version was sent');
      assert.equal(sentWhenLevel, notes.length, 'level before every version was sent');
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
        5000,
        'the peer to have them, though the node closed once synced',
      );
    });

    test('a peer on a slow link is sent each version it lacks once, however many rounds pass meanwhile', async () => {
      const notes = await bigNotes(60, 100_000);
      const holderStorage = createStorageProvider(createMemoryAdapter());
      const newcomerStorage = createStorageProvider(createMemoryAdapter());
      for (const note of notes) await holderStorage.addVersion(note);
      // Holder to newcomer over a link of 2 MB a second, first in first out.
      const link: Array<{ left: number; message: SyncMessage }> = [];
      const backlog = () => link.reduce((sum, m) => sum + m.left, 0);
      let sent = 0;
      const tick = setInterval(() => {
        let budget = 200_000;
        while (link.length > 0 && budget > 0) {
          const head = link[0]!;
          const take = Math.min(budget, head.left);
          head.left -= take;
          budget -= take;
          if (head.left > 0) break;
          link.shift();
          void newcomer.handleMessage('a', head.message);
        }
      }, 100);
      const holder: ReturnType<typeof createSyncEngine> = createSyncEngine({
        storageProvider: holderStorage,
        self: 'a',
        backlog,
        sendToPeer: (_peer, message) => {
          if (message.type === 'versions') sent += message.versions.length;
          const bytes = JSON.stringify(message).length;
          link.push({ left: bytes, message });
        },
      });
      const newcomer: ReturnType<typeof createSyncEngine> = createSyncEngine({
        storageProvider: newcomerStorage,
        self: 'b',
        sendToPeer: (_peer, message) => void holder.handleMessage('b', message),
      });
      // As a node does: having taken anything in, it says hello again soon.
      let announce: ReturnType<typeof setTimeout> | null = null;
      newcomer.on('received', () => {
        if (announce) return;
        announce = setTimeout(() => {
          announce = null;
          newcomer.notifyPeers(['a']);
        }, 100);
      });
      holder.addPeer('b');
      newcomer.addPeer('a');
      holder.notifyPeers(['b']);
      try {
        await until(
          async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
          60_000,
          'every record over the slow link',
        );
        await until(() => backlog() === 0, 30_000, 'the link to empty');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.ok(
          backlog() === 0 && sent <= notes.length * 1.1,
          `${sent} versions sent for ${notes.length} lacked`,
        );
      } finally {
        clearInterval(tick);
        if (announce) clearTimeout(announce);
        holder.stop();
        newcomer.stop();
      }
    });

    test('a sender waits while its connection is backed up, and goes on once it drains', async () => {
      let backlog = 10 * MB;
      const notes = await bigNotes(20, 100_000);
      const { holder, holderStorage, newcomerStorage, sizes } = pair({ holderBacklog: () => backlog });
      for (const note of notes) await holderStorage.addVersion(note);
      holder.notifyPeers(['b']);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(sizes.filter((size) => !size.answer).length, 0, 'nothing sent while backed up');
      backlog = 0;
      await until(
        async () => (await newcomerStorage.sums()).get(COLLECTION)?.count === notes.length,
        30_000,
        'every record to reach the newcomer once the connection drained',
      );
    });
  });
});
