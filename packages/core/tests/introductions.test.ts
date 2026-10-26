/**
 * Introduction tests — the rules that let peers bring each other in, so a relay
 * is only needed for the first connection.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
} from '../src/network/introductions.js';
import { createRendezvous, rendezvousKeys, type Rendezvous } from '../src/network/rendezvous.js';
import { isRecord } from '../src/utils/guards.js';
import { until } from './helpers/until.js';
import { session } from './helpers/sessions.js';

/** A fresh id for the seen-set tests */
const someId = () => crypto.randomUUID();

describe('who opens the connection', () => {
  test('exactly one side of any pair initiates', () => {
    const peers = ['did:key:zAlice', 'did:key:zBob', 'did:key:zCarol'];

    for (const a of peers) {
      for (const b of peers) {
        if (a === b) continue;
        // Both are told about each other at the same moment. Without a rule
        // both would offer, leaving two half-open connections to unpick.
        assert.notEqual(
          shouldInitiate(a, b),
          shouldInitiate(b, a),
          `${a} and ${b} disagreed about who offers`,
        );
      }
    }
  });

  test('a peer never initiates to itself', () => {
    assert.equal(shouldInitiate('did:key:zAlice', 'did:key:zAlice'), false);
  });
});

describe('mesh housekeeping', () => {
  test('control messages are recognised and ordinary ones are not', () => {
    assert.equal(isControlMessage(PEERS_MESSAGE), true);
    assert.equal(isControlMessage(SIGNAL_MESSAGE), true);
    // Anything the application sends must reach it untouched.
    assert.equal(isControlMessage('sync'), false);
    assert.equal(isControlMessage('pair'), false);
  });

  test('a flooded signal is acted on once', () => {
    const seen = createSeenSignals();
    const id = someId();

    assert.equal(seen.accept(id), true);
    // The same signal arriving by a second route.
    assert.equal(seen.accept(id), false);
    assert.equal(seen.accept(someId()), true);
  });

  test('the record of seen signals stays bounded', () => {
    const seen = createSeenSignals(4);
    const ids = Array.from({ length: 4 }, someId);
    for (const id of ids) seen.accept(id);

    // Pushing past the limit forgets the oldest — unbounded memory fed by the
    // network would be a way for a peer to take this tab down.
    seen.accept(someId());
    assert.equal(seen.accept(ids[0]!), true, 'the oldest id should have been forgotten');
    assert.equal(seen.accept(ids[3]!), false, 'a recent id should still be remembered');
  });
});

// ─── Several relays at once ────────────────────────────────────────────

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  sent: string[];
  send(data: string): void;
  close(): void;
}

let sockets: FakeSocket[] = [];
/** The global the relay links open sockets with, swapped for the fake */
const global: { WebSocket?: unknown } = globalThis;
const realWebSocket = global.WebSocket;

/**
 * Rendezvous to shut down after each test.
 *
 * A closed socket schedules a reconnect with backoff, so one left running
 * keeps timers alive and holds the test process open long after its assertions
 * have passed.
 */
let created: Rendezvous[] = [];

const me = await session();

function makeRendezvous(urls: ReadonlyArray<string>): Rendezvous {
  const rendezvous = createRendezvous(urls, me);
  created.push(rendezvous);
  return rendezvous;
}

/** A WebSocket that opens immediately and records what it was told to send. */
class FakeWebSocket implements FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send = (data: string) => void this.sent.push(data);

  close = () => {
    this.readyState = 3;
    this.onclose?.();
  };
}

/** What a socket was told to send, read back */
const sentOn = (socket: FakeSocket) => socket.sent.map((m): unknown => JSON.parse(m)).filter(isRecord);

/** The topics a socket asked to watch */
const watched = (socket: FakeSocket) =>
  sentOn(socket)
    .filter((m) => m.type === 'fetch' && m.watch === true)
    .map((m) => m.topic);

describe('several relays at once', () => {
  beforeEach(() => {
    created = [];
    sockets = [];
    global.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    for (const rendezvous of created) rendezvous.disconnect();
    global.WebSocket = realWebSocket;
  });

  test('connects to every relay', async () => {
    const rendezvous = makeRendezvous(['ws://a.example', 'ws://b.example']);
    await rendezvous.connect();

    assert.deepEqual(
      sockets.map((socket) => socket.url),
      ['ws://a.example', 'ws://b.example'],
    );
    assert.equal(rendezvous.isConnected(), true);
  });

  test('one relay being down is survivable', async () => {
    const rendezvous = makeRendezvous(['ws://a.example', 'ws://b.example']);
    await rendezvous.connect();

    sockets[0]!.close();

    assert.equal(rendezvous.isConnected(), true, 'the other relay is still up');
    assert.deepEqual(
      rendezvous.relays().map((relay) => relay.state),
      ['waiting', 'open'],
    );
  });

  test('rooms are watched on every relay, before or after connecting', async () => {
    const rendezvous = makeRendezvous(['ws://a.example', 'ws://b.example']);
    const [r1, r2] = await Promise.all([rendezvousKeys('r1'), rendezvousKeys('r2')]);
    rendezvous.join('r1');
    await rendezvous.connect();
    rendezvous.join('r2');
    await until(() => sockets.every((socket) => watched(socket).length === 2), 1000, 'both rooms watched');
    for (const socket of sockets) assert.deepEqual(watched(socket).sort(), [r1.topic, r2.topic].sort());

    rendezvous.leave('r1');
    await until(
      () => sentOn(sockets[0]!).some((m) => m.type === 'unwatch' && m.topic === r1.topic),
      1000,
      'the room let go of',
    );
  });

  test('configuring no relay at all is refused', () => {
    assert.throws(() => makeRendezvous([]), /at least one relay/i);
  });
});
