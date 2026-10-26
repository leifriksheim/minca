/**
 * A relay's socket reconnects: a relay that goes away for a while is found
 * again, however long it was gone, and until the link is let go of.
 *
 * A fake WebSocket stands in for the relay, and the clock is mocked, so a
 * minute of backoff takes no time.
 */
import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocket as WsSocket, WebSocketServer } from 'ws';

import { p256 } from '@noble/curves/nist.js';
import { createMincaLink } from '../src/network/relay-minca.js';
import type { RelayLink } from '../src/network/relays.js';
import { rendezvousKeys } from '../src/network/rendezvous.js';
import { base64UrlEncode } from '../src/utils/encoding.js';
import { createMesh } from '../src/network/mesh.js';
import { createRelay, MAX_MESSAGE_BYTES } from '../../relay/relay.mjs';
import { portOf, textOf } from './helpers/net.js';
import type { PeerTransportEvents, SignalledTransport } from '../src/network/transport.js';
import { createEmitter } from '../src/utils/events.js';
import { sessionsInOrder, signedHello, type Session } from './helpers/sessions.js';

// Real sessions, since hellos are signed; `me` is the lower, so it offers.
const [me, them] = await sessionsInOrder(2);

/** Whether the pretend relay answers */
let relayUp = true;
/** Whether the pretend relay answers pings (an older one doesn't) */
let answersPings = false;
let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  readonly url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      if (!relayUp) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }

  /** The relay is gone, but nothing told this end: what is sent goes nowhere, and nothing comes back */
  deaf = false;

  send = (data: string) => {
    this.sent.push(data);
    if (this.deaf || !answersPings || !data.includes('"type":"ping"')) return;
    queueMicrotask(() => this.onmessage?.({ data: '{"type":"pong"}' }));
  };

  close = () => this.drop(1000);

  /** The relay, or the network, ends it. */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

const global: { WebSocket?: unknown } = globalThis;
const realWebSocket = global.WebSocket;
let client: RelayLink;

/** Lets queued socket events run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Moves the mocked clock on, a second at a time, letting sockets open and close as it goes. */
async function pass(ms: number): Promise<void> {
  for (let gone = 0; gone < ms; gone += 1000) {
    mock.timers.tick(1000);
    await settle();
  }
}

const opened = () => sockets.filter((socket) => socket.readyState === 1);

/** Whether a socket asked to watch a topic */
const watches = (socket: FakeWebSocket, topic: string) =>
  socket.sent.some((message) => message.includes('"watch":true') && message.includes(`"topic":"${topic}"`));

describe('a relay link reconnects', () => {
  beforeEach(() => {
    relayUp = true;
    answersPings = false;
    sockets = [];
    global.WebSocket = FakeWebSocket;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    client = createMincaLink('ws://relay.example');
  });

  afterEach(() => {
    client.disconnect();
    mock.timers.reset();
    global.WebSocket = realWebSocket;
  });

  test('comes back after a relay is gone for minutes, not five tries', async () => {
    await client.connect();
    client.watch('topic-a');
    assert.equal(client.status().state, 'open');

    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    assert.equal(client.status().state, 'waiting');

    // Ten minutes of the relay being unreachable: far more than five attempts.
    await pass(10 * 60_000);
    assert.ok(sockets.length > 10, `tried ${sockets.length - 1} times`);
    assert.equal(client.status().state, 'waiting');
    assert.ok(client.status().failures > 5);

    relayUp = true;
    // The longest wait between tries: 30 s, spread by up to a quarter either way (`backoff`).
    await pass(40_000);
    assert.equal(client.status().state, 'open');
    assert.equal(client.status().failures, 0);
    // And the topic is watched again on the new socket.
    const watching = opened()[0]!
      .sent.filter((message) => message.includes('"watch":true'))
      .map((message): unknown => JSON.parse(message));
    assert.deepEqual(watching, [{ type: 'fetch', topic: 'topic-a', watch: true }]);
  });

  test('never waits more than about 30 seconds between tries', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    await pass(5 * 60_000);
    const status = client.status();
    assert.ok(status.retryAt !== null && status.retryAt - Date.now() <= 36_000);
  });

  test('reconnects after a disconnect and a fresh connect', async () => {
    // The mesh lets go when its last room closes, and connects again for the next.
    await client.connect();
    client.disconnect();
    assert.equal(client.status().state, 'stopped');

    await client.connect();
    sockets.at(-1)!.drop();
    await settle();
    assert.equal(client.status().state, 'waiting');
    await pass(5_000);
    assert.equal(client.status().state, 'open');
  });

  test('stops trying once let go of', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    client.disconnect();
    const tried = sockets.length;
    await pass(5 * 60_000);
    assert.equal(sockets.length, tried);
    assert.equal(client.status().state, 'stopped');
  });

  test('a late close from a replaced socket leaves the new one alone', async () => {
    await client.connect();
    const old = sockets.at(-1)!;
    const onclose = old.onclose;
    old.drop();
    await settle();
    await pass(3_000);
    assert.equal(client.status().state, 'open');
    // The old socket's handler, called again, is ignored.
    onclose?.({ code: 1006, reason: '' });
    assert.equal(client.status().state, 'open');
  });

  test('reconnect() tries at once instead of waiting', async () => {
    await client.connect();
    relayUp = false;
    sockets.at(-1)!.drop();
    await settle();
    await pass(2 * 60_000);
    relayUp = true;
    client.reconnect();
    await settle();
    assert.equal(client.status().state, 'open');
  });

  test('waking from a sleep dials again, with nothing asked of the relay', async () => {
    // A laptop asleep: the relay dropped its socket and what it watched, and no close ever came.
    await client.connect();
    client.watch('topic-a');
    const dead = sockets.at(-1)!;
    dead.deaf = true;
    // Asleep for ten minutes: the clock moves on, and no timer fires.
    mock.timers.setTime(Date.now() + 10 * 60_000);
    await pass(5_000);
    const live = sockets.at(-1)!;
    assert.notEqual(live, dead);
    assert.equal(client.status().state, 'open');
    assert.ok(watches(live, 'topic-a'), 'the topic is watched again');
  });

  test('a socket that dies while awake is found out by a relay that answers pings', async () => {
    answersPings = true;
    await client.connect();
    client.watch('topic-a');
    await pass(2 * 60_000);
    assert.equal(client.status().state, 'open', 'a relay that answers keeps its socket');
    assert.equal(sockets.length, 1);

    const dead = sockets.at(-1)!;
    dead.deaf = true;
    await pass(3 * 60_000);
    const live = sockets.at(-1)!;
    assert.notEqual(live, dead);
    assert.equal(client.status().state, 'open');
    assert.ok(watches(live, 'topic-a'), 'the topic is watched again');
  });

  test('a relay that never answers pings is not held to them', async () => {
    await client.connect();
    const first = sockets.at(-1)!;
    await pass(5 * 60_000);
    assert.equal(sockets.at(-1), first);
    assert.equal(client.status().state, 'open');
    assert.ok(first.sent.some((message) => message.includes('"ping"')));
  });
});

/**
 * A transport whose offers are never answered: the connection neither opens
 * nor fails, the way a WebRTC connection sits when the other side never heard.
 */
function silentTransport() {
  const offers: string[] = [];
  const closed: string[] = [];
  const events = createEmitter<PeerTransportEvents>();
  const transport: SignalledTransport = {
    createOffer: (peer) => {
      offers.push(peer);
      return Promise.resolve({ type: 'offer', sdp: 'v=0' });
    },
    handleOffer: () => Promise.resolve({ type: 'answer', sdp: 'v=0' }),
    handleAnswer: () => Promise.resolve(),
    send: () => {},
    close: (peer) => void closed.push(peer),
    closeAll: () => {},
    on: events.on,
    off: events.off,
  };
  return { transport, offers, closed, events };
}

/** A relay message, as if it had arrived on the first socket */
const fromRelay = (message: object) => sockets[0]!.onmessage?.({ data: JSON.stringify(message) });

/** Lets crypto finish, which runs off the mocked clock, until `done` holds */
async function crunch(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), 'gave up waiting');
}

/** A peer's signed, sealed hello in a room, as the relay hands it to watchers */
async function helloFrom(peer: Session, room: string): Promise<object> {
  const { topic } = await rendezvousKeys(room);
  const box = base64UrlEncode(p256.getPublicKey(p256.utils.randomSecretKey(), true));
  const blob = await signedHello(room, peer, box);
  return { type: 'mail', topic, items: [{ blob }], more: false };
}

describe('the mesh offers again', () => {
  beforeEach(() => {
    relayUp = true;
    answersPings = false;
    sockets = [];
    global.WebSocket = FakeWebSocket;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  });

  afterEach(() => {
    mock.timers.reset();
    global.WebSocket = realWebSocket;
  });

  const meshWith = (transport: SignalledTransport) =>
    createMesh({
      did: me.did,
      key: me.key,
      relays: ['ws://relay.example'],
      createTransport: () => transport,
    });

  test('when an offer is never answered, it is given up, and made again on the next hello', async () => {
    const fake = silentTransport();
    const mesh = meshWith(fake.transport);
    const room = mesh.join('room-a');
    await room.connect();

    const { topic } = await rendezvousKeys('room-a');
    await crunch(() => watches(sockets[0]!, topic));
    fromRelay(await helloFrom(them, 'room-a'));
    await crunch(() => fake.offers.length > 0);
    assert.deepEqual(fake.offers, [them.did]);
    assert.equal(mesh.status().connecting.length, 1);

    // Unanswered, it is given up rather than waited on for ever, and made
    // again when the peer next says hello.
    await pass(21_000);
    assert.deepEqual(fake.closed, [them.did]);
    assert.equal(fake.offers.length, 1);
    assert.equal(mesh.status().connecting.length, 0);
    fromRelay(await helloFrom(them, 'room-a'));
    await crunch(() => fake.offers.length === 2);
    assert.equal(mesh.status().connecting[0]?.tries, 1);

    // Each wait is longer than the last: still open at 30 s, given up by 41 s.
    await pass(30_000);
    assert.equal(fake.closed.length, 1);
    await pass(11_000);
    assert.equal(fake.closed.length, 2);

    // The room let go of: a hello there starts nothing.
    room.disconnect();
    fromRelay(await helloFrom(them, 'room-a'));
    await pass(1000);
    assert.equal(fake.offers.length, 2);
    assert.equal(mesh.status().connecting.length, 0);
  });

  test('a connection that opens stops the clock', async () => {
    const fake = silentTransport();
    const mesh = meshWith(fake.transport);
    const room = mesh.join('room-a');
    await room.connect();
    const { topic } = await rendezvousKeys('room-a');
    await crunch(() => watches(sockets[0]!, topic));
    fromRelay(await helloFrom(them, 'room-a'));
    await crunch(() => fake.offers.length > 0);
    fake.events.emit('connected', them.did);
    assert.equal(mesh.status().connecting.length, 0);
    assert.deepEqual(mesh.status().links, [{ peer: them.did, rooms: 0 }]);
    await pass(60_000);
    assert.equal(fake.offers.length, 1);
    room.disconnect();
  });

  test('status carries every relay, and changes are heard', async () => {
    const mesh = meshWith(silentTransport().transport);
    let heard = 0;
    const stop = mesh.subscribe(() => heard++);
    const room = mesh.join('room-a');
    await room.connect();
    assert.equal(mesh.status().relays[0]?.state, 'open');
    assert.ok(heard > 0);

    relayUp = false;
    sockets[0]!.drop();
    await settle();
    assert.equal(mesh.status().relays[0]?.state, 'waiting');
    assert.equal(room.isConnected(), false);
    stop();
    room.disconnect();
  });
});

describe('a real relay', () => {
  const relay = createRelay({});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let server: Server;
  let url: string;

  before(async () => {
    server = createServer();
    server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${portOf(server)}`;
  });

  after(() => {
    relay.close();
    server.close();
  });

  test('answers a ping, watching or not, so a client can tell its socket still reaches it', async () => {
    const ws = new WsSocket(url);
    await new Promise((resolve) => ws.once('open', resolve));
    const answer = new Promise<string>((resolve) => ws.once('message', (data) => resolve(textOf(data))));
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal(await answer, '{"type":"pong"}');
    ws.close();
  });
});
