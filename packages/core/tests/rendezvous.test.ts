/**
 * Meeting through relays (spec 04 §2–§3): a room is a topic, everything said
 * there is sealed, offers and answers are sealed again to the one peer they
 * are for, and the same message coming through several relays counts once.
 * Also the relay's side: a blob dropped with `ttl: 0` is handed on and kept by
 * nobody.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE_BYTES } from '../../relay/relay.mjs';
import { createRendezvous, rendezvousKeys } from '../src/network/rendezvous.js';
import { createMailboxClient, createRelayLink } from '../src/network/relays.js';
import { openValue, sealValue } from '../src/identity/envelope.js';
import { checkRelays } from '../src/space/roles.js';
import { isObject } from '../src/utils/guards.js';
import { contactKeyPair, contactPublicKey } from '../src/identity/contact-key.js';
import { openValueFrom } from '../src/identity/hpke.js';
import { p256 } from '@noble/curves/nist.js';
import { createMesh } from '../src/network/mesh.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { portOf } from './helpers/net.js';
import { until } from './helpers/until.js';
import { sealedSigned, session, sessionsInOrder, signedHello, type Session } from './helpers/sessions.js';

async function startRelay() {
  const relay = createRelay({});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${portOf(server)}`,
    close: () => {
      relay.close();
      server.close();
    },
  };
}

// Real sessions, since every message is signed: A < B < C, so A offers to B.
const [A, B, C] = await sessionsInOrder(3);
const OFFER = { type: 'offer', sdp: 'v=0 a secret address' };

/** Everything a test opened, closed after it whether it passed or not */
const opened: { disconnect(): void }[] = [];
afterEach(() => {
  for (const held of opened.splice(0)) held.disconnect();
});

let one: Awaited<ReturnType<typeof startRelay>>;
let two: Awaited<ReturnType<typeof startRelay>>;
before(async () => {
  one = await startRelay();
  two = await startRelay();
});
after(() => {
  one.close();
  two.close();
});

/** A rendezvous, and what it heard */
async function peer(who: Session, relays: string[], room = 'room') {
  const rendezvous = createRendezvous(relays, who);
  opened.push(rendezvous);
  const joined: string[] = [];
  const signals: { type: string; from: string; payload: unknown; room: string; box: string }[] = [];
  rendezvous.on('peer-joined', (from) => joined.push(from));
  rendezvous.on('signal', (message) => signals.push(message));
  await rendezvous.connect();
  rendezvous.join(room);
  return { rendezvous, joined, signals };
}

/** A socket watching a room's topic as a relay sees it: blobs only */
async function eavesdrop(url: string, room = 'room') {
  const { topic } = await rendezvousKeys(room);
  const link = createRelayLink(url)!;
  opened.push(link);
  const blobs: string[] = [];
  link.on('blob', (_topic, blob) => blobs.push(blob));
  await link.connect();
  link.watch(topic);
  return { link, blobs, topic };
}

describe('meeting through relays', () => {
  test('two peers on two shared relays hear each other once, and an offer arrives once, opened', async () => {
    // B is there first, so it hears A's hello, and says hello back since A is the one to offer.
    const b = await peer(B, [one.url, two.url]);
    const a = await peer(A, [one.url, two.url]);
    await until(() => a.joined.includes(B.did) && b.joined.includes(A.did), 2000, 'hellos');
    // Each hello came through both relays; the second copy changes nothing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(b.joined, [A.did]);
    assert.deepEqual(a.joined, [B.did]);
    const before = b.joined.length;

    a.rendezvous.signal('offer', B.did, OFFER, 'room');
    await until(() => b.signals.length > 0, 2000, 'the offer');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(b.signals.length, 1, 'one offer, though both relays carried it');
    assert.deepEqual(
      { ...b.signals[0], box: undefined },
      { type: 'offer', from: A.did, payload: OFFER, room: 'room', box: undefined },
    );
    assert.equal(b.joined.length, before);
    a.rendezvous.disconnect();
    b.rendezvous.disconnect();
  });

  test('a relay, or anyone on the topic, sees neither who meets nor their addresses', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => a.joined.includes(B.did), 2000, 'hello');
    a.rendezvous.signal('offer', B.did, OFFER, 'room');
    await until(() => b.signals.length > 0, 2000, 'the offer');
    await until(() => watcher.blobs.length >= 3, 2000, 'blobs on the wire');
    for (const blob of watcher.blobs) {
      assert.ok(!blob.includes('did:key'), 'no DID in the clear');
      assert.ok(!blob.includes('secret address'), 'no address in the clear');
    }
    a.rendezvous.disconnect();
    b.rendezvous.disconnect();
    watcher.link.disconnect();
  });

  test('a third peer in the room hears the offer pass but cannot open it', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const c = await peer(C, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => a.joined.includes(B.did) && c.joined.includes(A.did), 2000, 'hellos');
    a.rendezvous.signal('offer', B.did, OFFER, 'room');
    await until(() => b.signals.length > 0, 2000, 'the offer');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(c.signals.length, 0, 'C is not who it was for');
    // Someone holding the room's key opens the envelope, and finds the offer sealed again.
    const { key, topic } = await rendezvousKeys('room');
    const opened = await Promise.all(
      watcher.blobs.map((blob) => openValue(key, 'minca/rendezvous/v1', { topic }, blob)),
    );
    const offer = opened.find((message) => isObject(message) && message.kind === 'offer');
    assert.ok(isObject(offer) && typeof offer.sdp === 'string');
    assert.ok(!offer.sdp.includes('secret address'));
    for (const p of [a, b, c]) p.rendezvous.disconnect();
    watcher.link.disconnect();
  });

  test('a blob that does not open under the room key, or is stale, or comes again, is ignored', async () => {
    const b = await peer(B, [one.url]);
    const sender = await eavesdrop(one.url);
    const { key, topic } = await rendezvousKeys('room');
    const box = contactPublicKey(p256.utils.randomSecretKey());
    // Each signed by A, so only the sealing or the time is wrong.
    const hello = (at: number, id: string) => signedHello('room', A, box, { at, id });
    // Not sealed at all, sealed under another room's key, and older than two minutes.
    sender.link.publish(topic, 'bm90IHNlYWxlZA');
    const other = await rendezvousKeys('another room');
    const signed = await openValue(key, 'minca/rendezvous/v1', { topic }, await hello(Date.now(), 'x'));
    sender.link.publish(topic, await sealValue(other.key, 'minca/rendezvous/v1', { topic }, signed));
    sender.link.publish(topic, await hello(Date.now() - 5 * 60_000, 'old'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(b.joined, []);
    // The same, sealed under the room's key and fresh, is heard.
    sender.link.publish(topic, await hello(Date.now(), 'fresh'));
    await until(() => b.joined.length > 0, 2000, 'the good hello');
    assert.deepEqual(b.joined, [A.did]);
    b.rendezvous.disconnect();
    sender.link.disconnect();
  });

  test('a replayed hello counts once', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => b.joined.includes(A.did) && watcher.blobs.length > 0, 2000, 'hello');
    const heard = b.joined.length;
    for (const blob of watcher.blobs) watcher.link.publish(watcher.topic, blob);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(b.joined.length, heard);
    a.rendezvous.disconnect();
    b.rendezvous.disconnect();
    watcher.link.disconnect();
  });

  test('a relay of a kind this library does not speak is passed over', () => {
    assert.equal(
      checkRelays(['wss://relay.example', 'nostr+wss://relay.example', 'tracker+wss://t.example']),
      null,
    );
    assert.match(checkRelays(['nostr+ws://relay.example']) ?? '', /wss/);
    assert.throws(() => createRendezvous(['tracker+wss://t.example'], A), /at least one relay/i);
    const rendezvous = createRendezvous(['tracker+wss://t.example', one.url], A);
    assert.deepEqual(
      rendezvous.relays().map((relay) => relay.url),
      [one.url],
    );
  });
});

describe('signals stay in their room', () => {
  test('someone posing as a peer in another room, or in this one, opens no answer meant for it', async () => {
    // B is in a private room with A, and a public one Eve knows too.
    const b = await peer(B, [one.url], 'private');
    b.rendezvous.join('public');
    const a = await peer(A, [one.url], 'private');
    await until(() => a.joined.includes(B.did), 2000, 'hello');
    const eve = await eavesdrop(one.url, 'public');
    const inPrivate = await eavesdrop(one.url, 'private');
    const secret = p256.utils.randomSecretKey();
    const evesBox = await contactKeyPair(secret);
    const evesKey = await session();
    // Eve can only sign with her own key, whatever name she gives.
    const posing = (room: string, id: string) =>
      signedHello(room, evesKey, evesBox.publicKey, { id, from: A.did });
    // Eve says hello as A in the public room, and then in the private one, between A's offer and B's answer.
    eve.link.publish(eve.topic, await posing('public', 'eve-public'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    a.rendezvous.signal('offer', B.did, OFFER, 'private');
    await until(() => b.signals.length === 1, 2000, 'the offer');
    inPrivate.link.publish(inPrivate.topic, await posing('private', 'eve-private'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const offer = b.signals[0]!;
    b.rendezvous.signal('answer', A.did, { type: 'answer', sdp: 'v=0 B answers' }, offer.room, offer.box);
    await until(() => a.signals.length === 1, 2000, 'the answer reaches A');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Nothing either room carried opens with Eve's box.
    for (const [room, blobs] of [
      ['public', eve.blobs],
      ['private', inPrivate.blobs],
    ] as const) {
      const { key, topic } = await rendezvousKeys(room);
      for (const blob of blobs) {
        const message = await openValue(key, 'minca/rendezvous/v1', { topic }, blob);
        if (
          !isObject(message) ||
          typeof message.sdp !== 'string' ||
          typeof message.box !== 'string' ||
          typeof message.from !== 'string'
        )
          continue;
        const opened = await openValueFrom(
          evesBox,
          'minca/rendezvous-signal/v1',
          { topic, from: message.from, to: A.did, box: message.box },
          message.sdp,
        );
        assert.equal(opened, null, `Eve opened a ${String(message.kind)} in ${room}`);
      }
    }
  });
});

describe('nobody speaks in another’s name', () => {
  test('a hello naming B but signed by another key is ignored', async () => {
    const a = await peer(A, [one.url]);
    const sender = await eavesdrop(one.url);
    const box = contactPublicKey(p256.utils.randomSecretKey());
    sender.link.publish(sender.topic, await signedHello('room', C, box, { from: B.did }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(a.joined, [], 'C posing as B was heard');
    // The same hello, signed by B's own key, is heard.
    sender.link.publish(sender.topic, await signedHello('room', B, box));
    await until(() => a.joined.length > 0, 2000, 'the real hello');
    assert.deepEqual(a.joined, [B.did]);
  });

  test('someone in only a public room cannot pose there as B to keep A and B apart in a private one', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const meshOf = (who: Session) =>
      createMesh({
        did: who.did,
        key: who.key,
        relays: [one.url],
        createTransport: () => hub.signalled(who.did, 'cross-room'),
      });
    const meshA = meshOf(A);
    const [publicA, privateA] = [meshA.join('public'), meshA.join('private')];
    opened.push(publicA, privateA);
    const met: string[] = [];
    privateA.on('peer-connected', (peer: { did: string }) => met.push(peer.did));
    await privateA.connect();
    await publicA.connect();

    // Mallory knows the public room alone, and keeps saying hello there as B,
    // with her own box: were A to take it, A would offer to B there and nowhere else.
    const mallory = await session();
    const box = await contactKeyPair(p256.utils.randomSecretKey());
    const inPublic = await eavesdrop(one.url, 'public');
    const inPrivate = await eavesdrop(one.url, 'private');
    const pose = async () =>
      inPublic.link.publish(
        inPublic.topic,
        await signedHello('public', mallory, box.publicKey, { from: B.did }),
      );
    await pose();
    const posing = setInterval(() => void pose(), 1000);
    opened.push({ disconnect: () => clearInterval(posing) });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const privateB = meshOf(B).join('private');
    opened.push(privateB);
    await privateB.connect();
    await until(() => met.includes(B.did), 5000, 'A and B to meet in the private room');

    // A offered to B, and no offer in either room opens with Mallory's box.
    let offers = 0;
    for (const [room, blobs] of [
      ['public', inPublic.blobs],
      ['private', inPrivate.blobs],
    ] as const) {
      const { key, topic } = await rendezvousKeys(room);
      for (const blob of blobs) {
        const message = await openValue(key, 'minca/rendezvous/v1', { topic }, blob);
        if (!isObject(message) || message.kind !== 'offer' || message.from !== A.did) continue;
        if (typeof message.sdp !== 'string' || typeof message.box !== 'string') continue;
        offers++;
        const opened = await openValueFrom(
          box,
          'minca/rendezvous-signal/v1',
          { topic, from: A.did, to: B.did, box: message.box },
          message.sdp,
        );
        assert.equal(opened, null, `A's offer in ${room} was sealed to Mallory`);
      }
    }
    assert.ok(offers > 0, 'A made an offer');
  });
});

describe('what a hello can cost', () => {
  test('hellos under 90 made-up names start no more than 64 connections', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const offered = new Set<string>();
    // The lowest of 91 is the victim, so it is the one to offer to each of the other 90.
    const [victim, ...attackers] = await sessionsInOrder(91);
    const mesh = createMesh({
      did: victim.did,
      key: victim.key,
      relays: [one.url],
      createTransport: () => {
        const transport = hub.signalled(victim.did, 'flood');
        return Object.freeze({
          ...transport,
          createOffer: (to: string) => {
            offered.add(to);
            return transport.createOffer(to);
          },
        });
      },
    });
    const net = mesh.join('flooded');
    opened.push(net);
    await net.connect();
    const sender = await eavesdrop(one.url, 'flooded');
    const box = contactPublicKey(p256.utils.randomSecretKey());
    for (const [i, attacker] of attackers.entries())
      sender.link.publish(sender.topic, await signedHello('flooded', attacker, box, { id: `made-up-${i}` }));
    // However fast they come, the room holds 64.
    await until(() => offered.size >= 64, 10_000, 'the room to fill');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(offered.size, 64);
  });

  test('a node in 60 rooms keeps its relay: watching them all again and saying hello in each is paced', async () => {
    const rendezvous = createRendezvous([one.url], A);
    opened.push(rendezvous);
    const states: string[] = [];
    rendezvous.on('status', (relays) => states.push(...relays.map((relay) => relay.state)));
    for (let i = 0; i < 60; i++) rendezvous.join(`room ${i}`);
    await rendezvous.connect();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.ok(!states.includes('waiting'), `the relay let go: ${[...new Set(states)].join(', ')}`);
    assert.equal(rendezvous.relays()[0]?.state, 'open');
  });

  test('a node in 16 rooms of 12 members each keeps its relay', async () => {
    // Twelve members, each watching all sixteen rooms, as the relay sees them.
    const topics = await Promise.all(Array.from({ length: 16 }, (_, i) => rendezvousKeys(`busy ${i}`)));
    const members: WebSocket[] = [];
    for (let m = 0; m < 12; m++) {
      const ws = new WebSocket(one.url);
      await new Promise((resolve) => (ws.onopen = resolve));
      for (const { topic } of topics) ws.send(JSON.stringify({ type: 'fetch', topic, watch: true }));
      members.push(ws);
    }
    opened.push({ disconnect: () => members.forEach((ws) => ws.close()) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rendezvous = createRendezvous([one.url], A);
    opened.push(rendezvous);
    const states: string[] = [];
    rendezvous.on('status', (relays) => states.push(...relays.map((relay) => relay.state)));
    for (let i = 0; i < 16; i++) rendezvous.join(`busy ${i}`);
    await rendezvous.connect();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(!states.includes('waiting'), `the relay let go: ${[...new Set(states)].join(', ')}`);
  });

  test('an offer re-wrapped with another box opens nothing', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => a.joined.includes(B.did), 2000, 'hello');
    a.rendezvous.signal('offer', B.did, OFFER, 'room');
    await until(() => b.signals.length === 1, 2000, 'the offer');
    // The offer sealed again, with another box for the answer to go to, and
    // signed afresh by A's own key: still its description opens only with the box it was sealed for.
    const { key, topic } = await rendezvousKeys('room');
    for (const blob of watcher.blobs) {
      const message = await openValue(key, 'minca/rendezvous/v1', { topic }, blob);
      if (!isObject(message) || message.kind !== 'offer') continue;
      const box = contactPublicKey(p256.utils.randomSecretKey());
      watcher.link.publish(
        topic,
        await sealedSigned('room', A, {
          kind: 'offer',
          id: 'rewrapped',
          at: Date.now(),
          from: A.did,
          to: B.did,
          box,
          sdp: message.sdp,
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.signals.length, 1);
  });
});

describe('the relay keeps nothing dropped with ttl 0', () => {
  test('a watcher gets it, a fetch finds nothing, and the dropper hears nothing back', async () => {
    const watcher = await eavesdrop(one.url, 'ephemeral');
    const answers: unknown[] = [];
    const ws = new WebSocket(one.url);
    await new Promise((resolve) => (ws.onopen = resolve));
    // Only a socket watching the topic may publish to it.
    ws.send(JSON.stringify({ type: 'drop', topic: watcher.topic, blob: 'bm90IHdhdGNoaW5n', ttl: 0 }));
    ws.send(JSON.stringify({ type: 'fetch', topic: watcher.topic, watch: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.onmessage = (event) => answers.push(JSON.parse(String(event.data)));
    ws.send(JSON.stringify({ type: 'drop', topic: watcher.topic, blob: 'aGVsbG8', ttl: 0 }));
    await until(() => watcher.blobs.length === 1, 2000, 'the watcher hears it');
    assert.deepEqual(watcher.blobs, ['aGVsbG8']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(answers, []);
    ws.close();
    assert.deepEqual(await createMailboxClient().fetch(one.url, watcher.topic), []);
    watcher.link.disconnect();
  });
});
