/**
 * Nostr relays as a kind of relay (spec 04 §1.5): peers meet through one with
 * nothing else, and an inbox's or a short link's blobs wait on one. Run
 * against a NIP-01 relay in the test (`helpers/nostr-relay.ts`) that checks
 * every event's id and signature.
 */
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMesh } from '../src/network/mesh.js';
import { createMailboxClient } from '../src/network/relays.js';
import { NOSTR_EPHEMERAL_KIND, NOSTR_HELD_KIND } from '../src/network/relay-nostr.js';
import { sha256 } from '../src/utils/hash.js';
import { base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';
import type { NetworkManager } from '../src/network/network-manager.js';
import type { NetworkMessage } from '../src/types.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { startNostrRelay, type TestNostrRelay } from './helpers/nostr-relay.js';
import { until } from './helpers/until.js';
import { sessionsInOrder, type Session } from './helpers/sessions.js';

const [A, B] = await sessionsInOrder(2);
const TOPIC = 'n'.repeat(43);
const opened: { disconnect(): void }[] = [];
afterEach(() => {
  for (const held of opened.splice(0)) held.disconnect();
});

let open: TestNostrRelay;
let guarded: TestNostrRelay;
before(async () => {
  open = await startNostrRelay();
  guarded = await startNostrRelay({ requireAuth: true });
});
after(() => {
  open.close();
  guarded.close();
});

/** Two peers in one room through `relay` alone, and what B heard */
async function meet(relay: string, namespace: string) {
  const hub = createFakeHub();
  const room = (who: Session): NetworkManager => {
    const net = createMesh({
      did: who.did,
      key: who.key,
      relays: [relay],
      createTransport: () => hub.signalled(who.did, namespace),
    }).join('nostr room');
    opened.push(net);
    return net;
  };
  const a = room(A);
  const b = room(B);
  const heard: NetworkMessage[] = [];
  b.on('message', (message: NetworkMessage) => heard.push(message));
  await b.connect();
  await a.connect();
  await until(() => a.getPeers().length === 1 && b.getPeers().length === 1, 3000, 'the two to meet');
  a.send(B.did, { type: 'hi', from: A.did, payload: 1 });
  await until(() => heard.length === 1, 2000, 'a message');
  return heard;
}

describe('peers meet through a Nostr relay', () => {
  test('alone, with no Minca relay at all', async () => {
    assert.deepEqual(await meet(open.url, 'open'), [{ type: 'hi', from: A.did, payload: 1 }]);
    const events = open.taken().filter((event) => event.kind === NOSTR_EPHEMERAL_KIND);
    assert.ok(events.length >= 3, 'hellos, an offer and an answer went through it');
    assert.equal(open.kept().filter((event) => event.kind === NOSTR_EPHEMERAL_KIND).length, 0, 'none kept');
    for (const event of events) assert.ok(!event.content.includes('did:key'), 'nobody named in the clear');
  });

  test('through a relay that wants authentication first', async () => {
    assert.equal((await meet(guarded.url, 'guarded')).length, 1);
  });
});

describe('a Nostr relay as a mailbox', () => {
  const mailbox = createMailboxClient();

  test('a dropped blob is kept, fetched once however often it is dropped, and gone once it expires', async () => {
    const blob = base64UrlEncode(utf8Encode('a sealed knock'));
    const id = await mailbox.drop(open.url, TOPIC, blob, 3600);
    assert.equal(id, base64UrlEncode(await sha256(utf8Encode(blob))));
    await mailbox.drop(open.url, TOPIC, blob, 3600);
    const items = await mailbox.fetch(open.url, TOPIC);
    assert.deepEqual(
      items.map((item) => [item.id, item.blob]),
      [[id, blob]],
    );
    const event = open.kept().find((held) => held.kind === NOSTR_HELD_KIND);
    assert.ok(event?.tags.some((tag) => tag[0] === 'expiration'));

    const brief = base64UrlEncode(utf8Encode('gone soon'));
    await mailbox.drop(open.url, `${TOPIC.slice(1)}b`, brief, 1);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.deepEqual(await mailbox.fetch(open.url, `${TOPIC.slice(1)}b`), []);
  });

  test('works where the relay wants authentication first', async () => {
    const blob = base64UrlEncode(utf8Encode('behind a door'));
    await mailbox.drop(guarded.url, TOPIC, blob);
    assert.deepEqual(
      (await mailbox.fetch(guarded.url, TOPIC)).map((item) => item.blob),
      [blob],
    );
  });

  test("can't be cleared: Nostr lets nobody delete what others left", async () => {
    await assert.rejects(
      mailbox.purge(open.url, TOPIC, 'key', null, async () => 'sig'),
      /can't clear/,
    );
  });
});
