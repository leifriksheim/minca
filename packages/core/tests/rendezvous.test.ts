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
import { contactPublicKey } from '../src/identity/contact-key.js';
import { p256 } from '@noble/curves/nist.js';
import { createMesh } from '../src/network/mesh.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { portOf } from './helpers/net.js';
import { until } from './helpers/until.js';

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

const A = 'did:key:zA';
const B = 'did:key:zB';
const C = 'did:key:zC';
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
async function peer(did: string, relays: string[], room = 'room') {
  const rendezvous = createRendezvous(relays, did);
  opened.push(rendezvous);
  const joined: string[] = [];
  const signals: { type: string; from: string; payload: unknown }[] = [];
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
    await until(() => a.joined.includes(B) && b.joined.includes(A), 2000, 'hellos');
    // Each hello came through both relays; the second copy changes nothing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(b.joined, [A]);
    assert.deepEqual(a.joined, [B]);
    const before = b.joined.length;

    a.rendezvous.signal('offer', B, OFFER);
    await until(() => b.signals.length > 0, 2000, 'the offer');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(b.signals.length, 1, 'one offer, though both relays carried it');
    assert.deepEqual(b.signals[0], { type: 'offer', from: A, payload: OFFER });
    assert.equal(b.joined.length, before);
    a.rendezvous.disconnect();
    b.rendezvous.disconnect();
  });

  test('a relay, or anyone on the topic, sees neither who meets nor their addresses', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => a.joined.includes(B), 2000, 'hello');
    a.rendezvous.signal('offer', B, OFFER);
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
    await until(() => a.joined.includes(B) && c.joined.includes(A), 2000, 'hellos');
    a.rendezvous.signal('offer', B, OFFER);
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
    const hello = (at: number, id: string) =>
      sealValue(key, 'minca/rendezvous/v1', { topic }, { kind: 'hello', id, at, from: A, box });
    // Not sealed at all, sealed under another room's key, and older than two minutes.
    sender.link.publish(topic, 'bm90IHNlYWxlZA');
    const other = await rendezvousKeys('another room');
    sender.link.publish(
      topic,
      await sealValue(
        other.key,
        'minca/rendezvous/v1',
        { topic },
        { kind: 'hello', id: 'x', at: Date.now(), from: A, box },
      ),
    );
    sender.link.publish(topic, await hello(Date.now() - 5 * 60_000, 'old'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(b.joined, []);
    // The same, sealed under the room's key and fresh, is heard.
    sender.link.publish(topic, await hello(Date.now(), 'fresh'));
    await until(() => b.joined.length > 0, 2000, 'the good hello');
    assert.deepEqual(b.joined, [A]);
    b.rendezvous.disconnect();
    sender.link.disconnect();
  });

  test('a replayed hello counts once', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => b.joined.includes(A) && watcher.blobs.length > 0, 2000, 'hello');
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

describe('what a hello can cost', () => {
  test('hellos under 90 made-up names start no more than 64 connections', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const offered = new Set<string>();
    const mesh = createMesh({
      did: A,
      relays: [one.url],
      createTransport: () => {
        const transport = hub.signalled(A, 'flood');
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
    const { key } = await rendezvousKeys('flooded');
    const box = contactPublicKey(p256.utils.randomSecretKey());
    for (let i = 0; i < 90; i++)
      sender.link.publish(
        sender.topic,
        await sealValue(
          key,
          'minca/rendezvous/v1',
          { topic: sender.topic },
          {
            kind: 'hello',
            id: `made-up-${i}`,
            at: Date.now(),
            from: `did:key:zZ${'abcdefghijk'[i % 11]}${String(i).replace(/0/g, 'o')}`,
            box,
          },
        ),
      );
    // Paced at 20 a second, the 90 take four and a half.
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

  test('an offer re-wrapped with another box opens nothing', async () => {
    const watcher = await eavesdrop(one.url);
    const b = await peer(B, [one.url]);
    const a = await peer(A, [one.url]);
    await until(() => a.joined.includes(B), 2000, 'hello');
    a.rendezvous.signal('offer', B, OFFER);
    await until(() => b.signals.length === 1, 2000, 'the offer');
    // Someone who knows the room seals it again, with a box of their own for the answer to go to.
    const { key, topic } = await rendezvousKeys('room');
    for (const blob of watcher.blobs) {
      const message = await openValue(key, 'minca/rendezvous/v1', { topic }, blob);
      if (!isObject(message) || message.kind !== 'offer') continue;
      const box = contactPublicKey(p256.utils.randomSecretKey());
      watcher.link.publish(
        topic,
        await sealValue(
          key,
          'minca/rendezvous/v1',
          { topic },
          { ...message, id: 'rewrapped', at: Date.now(), box },
        ),
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
