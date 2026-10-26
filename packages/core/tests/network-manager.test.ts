/**
 * Network manager tests — the transport seam. Everything here runs in one
 * process: in-memory transports stand in for WebRTC and for a socket to a node,
 * and the real relay runs as a child process where signalling is under test.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createFakeHub } from './helpers/fake-transport.js';
import { createEmitter } from '../src/utils/events.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createNetworkManager, type NetworkManager } from '../src/network/network-manager.js';
import { createMesh } from '../src/network/mesh.js';
import type { PeerTransport, PeerTransportEvents } from '../src/network/transport.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, didToPublicKey, P256_MULTICODEC } from '../src/identity/did.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createSyncEngine } from '../src/sync/sync-engine.js';
import type { NetworkMessage, PeerInfo } from '../src/types.js';
import { createMeshAuth, type ReadAccess } from '../src/network/peer-auth.js';
import { generateSpaceKey, MEMBERSHIP_LABEL } from '../src/privacy/space-encryption.js';
import { openValue, sealValue } from '../src/identity/envelope.js';
import { deriveReadKey } from '../src/space/space-access.js';
import { until } from './helpers/until.js';
import { sessionsInOrder, type Session } from './helpers/sessions.js';
import { base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';

// Real sessions where peers meet through relays, which sign what they say there: A < B < C.
const [A, B, C] = await sessionsInOrder(3);

/** Resolves when `predicate` holds, polling; fails the test after `ms`. */

function collect(manager: NetworkManager) {
  const messages: NetworkMessage[] = [];
  const connected: string[] = [];
  const disconnected: string[] = [];
  const errors: Error[] = [];
  manager.on('message', (m: NetworkMessage) => messages.push(m));
  manager.on('peer-connected', (p: PeerInfo) => connected.push(p.did));
  manager.on('peer-disconnected', (p: PeerInfo) => disconnected.push(p.did));
  manager.on('error', (e: Error) => errors.push(e));
  return { messages, connected, disconnected, errors };
}

describe('choosing a transport', () => {
  test('the mesh is WebRTC, which needs a relay', () => {
    assert.throws(() => createMesh({ ...A, relays: [] }), /at least one relay/i);
    // With a relay it constructs — nothing dials until a room is joined.
    const room = createMesh({ ...A, relays: ['ws://127.0.0.1:1'] }).join('r');
    assert.equal(room.isConnected(), false);
  });

  test('a transport that dials on its own needs no relay', () => {
    const hub = createFakeHub();
    const manager = createNetworkManager({
      did: 'did:key:zA',
      createTransport: () => hub.transport('did:key:zA'),
    });
    assert.equal(manager.isConnected(), false);
  });
});

describe('over an unsignalled transport', () => {
  test('two managers meet and exchange messages', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenA = collect(a);
    const seenB = collect(b);

    await a.connect();
    await b.connect();
    await until(
      () => seenA.connected.includes('did:key:zB') && seenB.connected.includes('did:key:zA'),
      1000,
      'both sides connected',
    );

    a.send('did:key:zB', { type: 'hello', from: 'did:key:zA', payload: { n: 1 } });
    await until(() => seenB.messages.length === 1, 1000, 'message');
    assert.deepEqual(seenB.messages[0], { type: 'hello', from: 'did:key:zA', payload: { n: 1 } });
    assert.equal(a.isConnected(), true);
  });

  test('a message is attributed to the connection it arrived on, not to its claim', async () => {
    const hub = createFakeHub();
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenB = collect(b);
    await a.connect();
    await b.connect();
    await until(() => seenB.connected.length === 1, 1000, 'connection');

    a.send('did:key:zB', { type: 'hello', from: 'did:key:zSomebodyElse', payload: null });
    await until(() => seenB.messages.length === 1, 1000, 'message');
    assert.equal(seenB.messages[0]!.from, 'did:key:zA');
  });

  test('losing a link surfaces as peer-disconnected', async () => {
    const hub = createFakeHub();
    const a = createNetworkManager({ did: 'did:key:zA', createTransport: () => hub.transport('did:key:zA') });
    const b = createNetworkManager({ did: 'did:key:zB', createTransport: () => hub.transport('did:key:zB') });
    const seenA = collect(a);
    await a.connect();
    await b.connect();
    await until(() => seenA.connected.length === 1, 1000, 'connection');

    hub.cut('did:key:zA', 'did:key:zB');
    await until(() => seenA.disconnected.includes('did:key:zB'), 1000, 'disconnect');
    assert.deepEqual(a.getPeers(), []);
  });

  test('a transport error becomes a manager error event, not a throw', async () => {
    const events = createEmitter<PeerTransportEvents>();
    const broken: PeerTransport = {
      send: () => {},
      close: () => {},
      closeAll: () => {},
      on: (event, callback) => events.on(event, callback),
      off: (event, callback) => events.off(event, callback),
    };
    const manager = createNetworkManager({ did: 'did:key:zA', createTransport: () => broken });
    const seen = collect(manager);

    events.emit('error', 'did:key:zB', new Error('wire fell out'));
    assert.equal(seen.errors.length, 1);
    assert.match(seen.errors[0]!.message, /wire fell out/);
  });
});

describe('sync through a transport', () => {
  test('two peers converge with the network manager in the middle', async () => {
    const provider = createP256Provider();
    const signer = createSigner(provider);
    const hub = createFakeHub({ latencyMs: 1 });

    const makePeer = (did: string) => {
      const network = createNetworkManager({ did, createTransport: () => hub.transport(did) });
      const storage = createStorageProvider(createMemoryAdapter());
      const cryptoGate = createCryptoGate(provider);
      const sync = createSyncEngine({
        storageProvider: storage,
        heartbeatInterval: 60_000,
        sendToPeer: (peerId, message) => network.send(peerId, { type: 'sync', from: did, payload: message }),
        validate: async (version) => {
          const result = await cryptoGate.validate(version, async (did) =>
            provider.importPublicKey(didToPublicKey(did).publicKeyBytes),
          );
          return { valid: result.passed, reason: result.reason };
        },
      });
      network.on('message', (message: NetworkMessage) => {
        if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
      });
      network.on('peer-connected', (info: PeerInfo) => {
        sync.addPeer(info.did);
        sync.notifyPeers([info.did]);
      });
      return { network, storage, sync };
    };

    const a = makePeer('did:key:zA');
    const b = makePeer('did:key:zB');

    const pair = await provider.generateKeyPair();
    const author = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
    for (const text of ['one', 'two', 'three']) {
      const signed = await signer.sign(
        createVersion({ author, collection: 'app.test.note', body: { text } }),
        pair.privateKey,
      );
      await a.storage.addVersion(signed);
    }

    await a.network.connect();
    await b.network.connect();

    await until(() => hub.delivered() > 0, 1000, 'first frame');
    const rootA = await a.storage.fingerprint();
    let rootB = '';
    const deadline = Date.now() + 3000;
    while (rootB !== rootA && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rootB = await b.storage.fingerprint();
    }
    assert.equal(rootB, rootA);
    assert.equal((await b.storage.queryVersions('app.test.note')).length, 3);

    a.sync.stop();
    b.sync.stop();
    a.network.disconnect();
    b.network.disconnect();
  });
});

describe('the mesh, through real relays', () => {
  const randomPort = () => 20_000 + Math.floor(Math.random() * 20_000);
  const ports = [randomPort(), randomPort()] as const;
  const relay = `ws://127.0.0.1:${ports[0]}`;
  const otherRelay = `ws://127.0.0.1:${ports[1]}`;
  let servers: ChildProcess[] = [];

  before(async () => {
    const script = fileURLToPath(new URL('../../relay/signaling-server.mjs', import.meta.url));
    servers = ports.map((port) => spawn(process.execPath, [script, String(port)], { stdio: 'ignore' }));
    for (const port of ports) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error('relay did not start');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  after(() => {
    for (const server of servers) server.kill();
  });

  const hub = createFakeHub({ latencyMs: 1 });
  /** A mesh whose connections are counted as they open */
  const mesh = (
    who: Session,
    relays: string[],
    namespace: string,
    options: { authTimeoutMs?: number } = {},
  ) => {
    const opened: string[] = [];
    const created = createMesh({
      did: who.did,
      key: who.key,
      relays,
      createTransport: () => {
        const transport = hub.signalled(who.did, namespace);
        transport.on('connected', (peer) => opened.push(peer));
        return transport;
      },
      ...options,
    });
    return Object.assign(created, { opened });
  };

  test('a relay connects the first pair, and a peer introduces the rest', async () => {
    // A and C are on different relays, so no relay can introduce them. B is
    // on both, and has to do it.
    const a = mesh(A, [relay], 'intro').join('shared');
    const b = mesh(B, [relay, otherRelay], 'intro').join('shared');
    const c = mesh(C, [otherRelay], 'intro').join('shared');
    const seenA = collect(a);
    const seenC = collect(c);

    await b.connect();
    await a.connect();
    await c.connect();

    await until(() => seenA.connected.includes(C.did), 5000, 'A to meet C through B');
    await until(() => seenC.connected.includes(A.did), 5000, 'C to meet A through B');

    // And the introduced link carries data like any other.
    a.send(C.did, { type: 'hello', from: A.did, payload: 'via the mesh' });
    await until(
      () => seenC.messages.some((m) => m.payload === 'via the mesh'),
      2000,
      'message over introduced link',
    );

    for (const room of [a, b, c]) room.disconnect();
  });

  /** A mesh whose transport says whom it offers to or answers, and lets the test send frames of its own */
  const watched = (who: Session, namespace: string) => {
    const dialled: string[] = [];
    let raw: PeerTransport | null = null;
    const created = createMesh({
      did: who.did,
      key: who.key,
      relays: [relay],
      createTransport: () => {
        const transport = hub.signalled(who.did, namespace);
        raw = transport;
        return Object.freeze({
          ...transport,
          createOffer: (peer: string) => (dialled.push(peer), transport.createOffer(peer)),
          handleOffer: (peer: string, offer: RTCSessionDescriptionInit) => (
            dialled.push(peer),
            transport.handleOffer(peer, offer)
          ),
        });
      },
    });
    const send = (to: string, frame: object) =>
      raw!.send(to, utf8Encode(JSON.stringify({ ...frame, from: who.did })));
    return { mesh: created, dialled, send };
  };

  /** A relayed signal as spec 04 §8 has it, signed by `signer` */
  const relayed = async (
    room: string,
    signer: Session,
    fields: { origin: string; target: string; at: number; sdp: string; id?: string },
  ) => {
    const { origin, target, at, sdp } = fields;
    const label = utf8Encode(`minca/introduction/v1|${room}|${origin}|${target}|offer|${at}|${sdp}`);
    const sig = base64UrlEncode(await createP256Provider().sign(signer.key, label));
    const id = fields.id ?? 'a1b2c3d4e5f60718';
    return { id, origin, target, kind: 'offer', data: { type: 'offer', sdp }, at, sig, hops: 1 };
  };

  test('a signal passed on in someone else’s name is ignored, and a genuine one is acted on once', async () => {
    const [mallory] = await sessionsInOrder(1);
    const a = watched(A, 'signed-intro');
    const m = watched(mallory, 'signed-intro');
    const roomA = a.mesh.join('signed');
    const roomM = m.mesh.join('signed');
    const seenA = collect(roomA);
    await roomA.connect();
    await roomM.connect();
    await until(() => seenA.connected.includes(mallory.did), 5000, 'A to meet Mallory');
    // An offer from B, signed by Mallory.
    const at = Date.now();
    const forged = await relayed('signed', mallory, {
      origin: B.did,
      target: A.did,
      at,
      sdp: `offer:${B.did}->${A.did}`,
    });
    m.send(A.did, { room: 'signed', type: '__signal', payload: forged });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!a.dialled.includes(B.did), 'A did not answer Mallory’s offer in B’s name');
    // An offer C signed, passed on by Mallory: taken, once, however often it comes.
    const genuine = await relayed('signed', C, {
      origin: C.did,
      target: A.did,
      at,
      sdp: `offer:${C.did}->${A.did}`,
    });
    m.send(A.did, { room: 'signed', type: '__signal', payload: genuine });
    m.send(A.did, { room: 'signed', type: '__signal', payload: { ...genuine, id: 'another' } });
    await until(() => a.dialled.includes(C.did), 2000, 'A to answer C');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(a.dialled.filter((peer) => peer === C.did).length, 1);
    roomA.disconnect();
    roomM.disconnect();
  });

  test('a signal stays in its room: not taken from a peer who isn’t there, nor passed to one', async () => {
    const [mallory] = await sessionsInOrder(1);
    const a = watched(A, 'room-intro');
    const m = watched(mallory, 'room-intro');
    // Mallory shares a public room with A, not the private one.
    const publicA = a.mesh.join('public');
    a.mesh.join('private');
    const publicM = m.mesh.join('public');
    const seenA = collect(publicA);
    await publicA.connect();
    await publicM.connect();
    await until(() => seenA.connected.includes(mallory.did), 5000, 'A to meet Mallory');
    const offer = await relayed('private', C, {
      origin: C.did,
      target: A.did,
      at: Date.now(),
      sdp: `offer:${C.did}->${A.did}`,
    });
    m.send(A.did, { room: 'private', type: '__signal', payload: offer });
    // And with the room left off, as signals used to travel.
    m.send(A.did, { type: '__signal', payload: offer });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!a.dialled.includes(C.did), 'A took no signal from a peer outside its room');
    publicA.disconnect();
    publicM.disconnect();
  });

  test('a room that names its own relay: two peers on different relays meet there, with nobody to introduce them', async () => {
    const meshA = mesh(A, [relay], 'own-relay');
    const meshC = mesh(C, [otherRelay], 'own-relay');
    // The space names the relay C uses; A joins its room there as well as on its own.
    meshA.useRelays('named', [otherRelay]);
    const a = meshA.join('named');
    const c = meshC.join('named');
    const seenA = collect(a);
    await a.connect();
    await c.connect();
    await until(() => seenA.connected.includes(C.did), 5000, "A to meet C on the room's relay");

    // A room that names no relay of its own stays on A's relays alone: C is not met there.
    const plainA = meshA.join('plain');
    const plainC = meshC.join('plain');
    const seenPlain = collect(plainA);
    await plainA.connect();
    await plainC.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(seenPlain.connected.includes(C.did), false);
    for (const room of [a, c, plainA, plainC]) room.disconnect();
  });

  test('two spaces shared by two devices use one connection', async () => {
    const [meshA, meshB] = [mesh(A, [relay], 'shared-link'), mesh(B, [relay], 'shared-link')];
    const [a1, a2, b1, b2] = [meshA.join('one'), meshA.join('two'), meshB.join('one'), meshB.join('two')];
    const seen = { a1: collect(a1), a2: collect(a2), b1: collect(b1), b2: collect(b2) };
    for (const room of [a1, a2, b1, b2]) await room.connect();
    await until(
      () => Object.values(seen).every((room) => room.connected.length === 1),
      5000,
      'both rooms to meet, on both sides',
    );

    assert.deepEqual(meshA.opened, [B.did]);
    assert.deepEqual(meshB.opened, [A.did]);

    // Each room's messages stay in that room.
    a2.send(B.did, { type: 'note', from: A.did, payload: 'for two' });
    await until(() => seen.b2.messages.length === 1, 2000, 'the message in room two');
    assert.equal(seen.b1.messages.length, 0);
    for (const room of [a1, a2, b1, b2]) room.disconnect();
  });

  test('a peer is a peer only in the rooms it shares, and leaving one keeps the others', async () => {
    const [meshA, meshB] = [mesh(A, [relay], 'leaving'), mesh(B, [relay], 'leaving')];
    const [a1, a2, a3, b1, b2] = [
      meshA.join('l1'),
      meshA.join('l2'),
      meshA.join('l3'),
      meshB.join('l1'),
      meshB.join('l2'),
    ];
    const seen = { a1: collect(a1), a2: collect(a2), a3: collect(a3), b1: collect(b1) };
    for (const room of [a1, a2, a3, b1, b2]) await room.connect();
    await until(
      () =>
        seen.a1.connected.length === 1 && seen.a2.connected.length === 1 && seen.b1.connected.length === 1,
      5000,
      'the shared rooms to meet',
    );
    assert.deepEqual(a3.getPeers(), []);

    b2.disconnect();
    await until(() => seen.a2.disconnected.includes(B.did), 2000, 'B to leave room two');
    b1.send(A.did, { type: 'note', from: B.did, payload: 'still here' });
    await until(() => seen.a1.messages.some((m) => m.payload === 'still here'), 2000, 'room one to carry on');
    assert.deepEqual(meshA.opened, [B.did], 'over the same connection');
    for (const room of [a1, a2, a3, b1]) room.disconnect();
  });

  test('letting a peer go in one room keeps it in the others, over the same connection', async () => {
    const [meshA, meshB] = [mesh(A, [relay], 'letting-go'), mesh(B, [relay], 'letting-go')];
    const [a1, a2, b1, b2] = [meshA.join('g1'), meshA.join('g2'), meshB.join('g1'), meshB.join('g2')];
    const seen = { a1: collect(a1), a2: collect(a2), b1: collect(b1), b2: collect(b2) };
    for (const room of [a1, a2, b1, b2]) await room.connect();
    await until(
      () => Object.values(seen).every((room) => room.connected.length === 1),
      5000,
      'both rooms to meet, on both sides',
    );

    a2.drop(B.did);
    await until(() => seen.b2.disconnected.includes(A.did), 2000, 'B to be told it was let go in room two');
    assert.deepEqual(a2.getPeers(), []);
    b1.send(A.did, { type: 'note', from: B.did, payload: 'still here' });
    await until(() => seen.a1.messages.some((m) => m.payload === 'still here'), 2000, 'room one to carry on');
    assert.deepEqual(meshA.opened, [B.did], 'over the same connection');
    for (const room of [a1, a2, b1, b2]) room.disconnect();
  });

  describe('every peer proves who it is, in every room', () => {
    const provider = createP256Provider();
    const identity = async () => {
      const pair = await provider.generateKeyPair();
      return {
        did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC),
        key: pair.privateKey,
      };
    };
    type Read = Parameters<typeof createMeshAuth>[2];
    /** A peer in `room`, which signs its proofs with `signWith` — its own key, unless it is lying */
    const peer = (
      room: string,
      who: { did: string; key: CryptoKey },
      read: Read = null,
      signWith = who.key,
      authTimeoutMs = 1000,
    ) =>
      // Its hellos are signed with `who.key`, so a lie in `signWith` is left for the room's proof to catch.
      mesh(who, [relay], room, { authTimeoutMs }).join(
        room,
        createMeshAuth(room, { did: who.did, key: signWith }, read, provider),
      );

    test('two peers who can prove their names meet and talk', async () => {
      const [alice, bob] = [await identity(), await identity()];
      const a = peer('proved', alice);
      const b = peer('proved', bob);
      const seenA = collect(a);
      const seenB = collect(b);
      await a.connect();
      await b.connect();
      // Each side checks the other on its own: Alice sends only once she has checked Bob too.
      await until(() => seenB.connected.includes(alice.did), 5000, 'Bob to meet Alice');
      await until(() => seenA.connected.includes(bob.did), 5000, 'Alice to meet Bob');
      a.send(bob.did, { type: 'hello', from: alice.did, payload: 'proved' });
      await until(() => seenB.messages.some((m) => m.payload === 'proved'), 2000, 'the message');
      a.disconnect();
      b.disconnect();
    });

    test("a peer using someone else's name never becomes a peer", async () => {
      const [alice, victim, impostor] = [await identity(), await identity(), await identity()];
      // Nobody here can prove anything, so a short wait for proof loses nothing.
      const a = peer('impostor', alice, null, alice.key, 300);
      const liar = peer('impostor', victim, null, impostor.key, 300);
      const seenA = collect(a);
      await a.connect();
      await liar.connect();
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(seenA.connected, []);
      a.disconnect();
      liar.disconnect();
    });

    test('in a private space, a peer without its key never becomes a peer', async () => {
      const key = await generateSpaceKey();
      const readKey = await deriveReadKey(key, provider);
      const read: Read = { key: readKey, publicDid: readKey.did };
      const stranger: Read = {
        key: await deriveReadKey(await generateSpaceKey(), provider),
        publicDid: readKey.did,
      };
      const [alice, bob, eve] = [await identity(), await identity(), await identity()];
      const a = peer('private', alice, read);
      const b = peer('private', bob, read);
      const e = peer('private', eve, stranger);
      const seenA = collect(a);
      await a.connect();
      await e.connect();
      await b.connect();
      await until(() => seenA.connected.includes(bob.did), 5000, 'Alice to meet Bob');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.deepEqual(seenA.connected, [bob.did]);
      for (const room of [a, b, e]) room.disconnect();
    });

    describe('after the space key changed', () => {
      /**
       * The key went K0 → K1 → K2. Alice was there for all of it and holds
       * every key. Bob was away: he holds only K0 and believes it current.
       * Carol was removed at K1: she holds K0 and K1, but no one still in
       * vouches for her note.
       */
      const changed = async () => {
        const keys = [await generateSpaceKey(), await generateSpaceKey(), await generateSpaceKey()];
        const reads = await Promise.all(keys.map((key) => deriveReadKey(key, provider)));
        const members = new Set<string>();
        const bound = { space: 'changed' };
        const note = (who: string) => `the note of ${who}`;
        /** Who holds `held` (newest last) and calls `current` the space's key */
        const access = (who: { did: string }, held: number[], current: number): ReadAccess => ({
          key: async () => reads[held.at(-1)!]!,
          current: () => reads[current]!.did,
          earlier: async () =>
            held
              .slice(0, -1)
              .reverse()
              .map((i) => reads[i]!),
          membership: async () => sealValue(keys[held.at(-1)!]!.seal, MEMBERSHIP_LABEL, bound, note(who.did)),
          // A peer proving an older key gets in when its note opens with that key and names someone still a member.
          admits: async (peerDid, readKey, membership) => {
            const i = reads.findIndex((read) => read.did === readKey);
            return (
              i >= 0 &&
              held.includes(i) &&
              members.has(peerDid) &&
              (await openValue(keys[i]!.seal, MEMBERSHIP_LABEL, bound, membership)) === note(peerDid)
            );
          },
        });
        return { access, members, reads };
      };

      test('a peer that missed it and one that did not still meet, whoever greets first', async () => {
        const { access, members } = await changed();
        const [alice, bob] = [await identity(), await identity()];
        members.add(alice.did).add(bob.did);
        const a = peer('behind', alice, access(alice, [0, 1, 2], 2));
        const b = peer('behind', bob, access(bob, [0], 0));
        const [seenA, seenB] = [collect(a), collect(b)];
        await b.connect();
        await a.connect();
        await until(
          () => seenA.connected.includes(bob.did) && seenB.connected.includes(alice.did),
          5000,
          'Alice and Bob to meet',
        );
        a.disconnect();
        b.disconnect();
      });

      test('the key each peer was let in on is told: the current one, or the older one a member proved', async () => {
        const { access, members, reads } = await changed();
        const [alice, bob, dave] = [await identity(), await identity(), await identity()];
        members.add(alice.did).add(bob.did).add(dave.did);
        const told = new Map<string, string>();
        const a = peer('told', alice, {
          ...access(alice, [0, 1, 2], 2),
          admitted: (did, readKey) => told.set(did, readKey),
        });
        const b = peer('told', bob, access(bob, [0], 0));
        const d = peer('told', dave, access(dave, [0, 1, 2], 2));
        const seenA = collect(a);
        for (const room of [a, b, d]) await room.connect();
        await until(() => seenA.connected.length === 2, 5000, 'Alice to meet both');
        assert.equal(told.get(bob.did), reads[0]!.did, 'Bob, behind, on the old key his note vouched for');
        assert.equal(told.get(dave.did), reads[2]!.did, 'Dave on the current one');
        for (const room of [a, b, d]) room.disconnect();
      });

      test('someone removed still never becomes a peer of those who moved on', async () => {
        const { access, members } = await changed();
        const [alice, carol] = [await identity(), await identity()];
        members.add(alice.did);
        // Carol can't prove she reads the current key, so a short wait for proof loses nothing.
        const a = peer('removed', alice, access(alice, [0, 1, 2], 2), alice.key, 300);
        const c = peer('removed', carol, access(carol, [0, 1], 1), carol.key, 300);
        const seenA = collect(a);
        await a.connect();
        await c.connect();
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.deepEqual(seenA.connected, []);
        a.disconnect();
        c.disconnect();
      });
    });

    test('failing to prove it in one room costs nothing in another', async () => {
      const key = await generateSpaceKey();
      const readKey = await deriveReadKey(key, provider);
      const [alice, bob] = [await identity(), await identity()];
      const [meshA, meshB] = [
        mesh(alice, [relay], 'mixed', { authTimeoutMs: 1000 }),
        mesh(bob, [relay], 'mixed', { authTimeoutMs: 1000 }),
      ];
      const open = meshA.join('open', createMeshAuth('open', alice, null, provider));
      const secret = meshA.join(
        'secret',
        createMeshAuth('secret', alice, { key: readKey, publicDid: readKey.did }, provider),
      );
      const bobOpen = meshB.join('open', createMeshAuth('open', bob, null, provider));
      const bobSecret = meshB.join(
        'secret',
        createMeshAuth(
          'secret',
          bob,
          { key: await deriveReadKey(await generateSpaceKey(), provider), publicDid: readKey.did },
          provider,
        ),
      );
      const seen = { open: collect(open), secret: collect(secret) };
      for (const room of [open, secret, bobOpen, bobSecret]) await room.connect();
      await until(() => seen.open.connected.includes(bob.did), 5000, 'the open room to meet');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.deepEqual(seen.secret.connected, []);
      bobOpen.send(alice.did, { type: 'note', from: bob.did, payload: 'still talking' });
      await until(
        () => seen.open.messages.some((m) => m.payload === 'still talking'),
        2000,
        'the open room to carry on',
      );
      for (const room of [open, secret, bobOpen, bobSecret]) room.disconnect();
    });
  });
});
