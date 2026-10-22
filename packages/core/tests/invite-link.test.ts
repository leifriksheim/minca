/**
 * Short invite links: the code, its places, what the secret derives, and the
 * sealed invite a link names by its hash — which nobody else can stand in for.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { createRelay, MAX_MESSAGE_BYTES, type MailboxLimits } from '../../relay/relay.mjs';
import type { InviteOptions } from '../src/node/types.js';
import { team } from '../src/space/presets.js';
import { bareInvite, parseSpaceInvite } from '../src/space/space-manager.js';
import { createMailboxClient } from '../src/network/mailbox.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { person } from './helpers/person.js';
import { joined } from './helpers/joined.js';
import { portOf } from './helpers/net.js';
import { until } from './helpers/until.js';

import {
  encodeInviteLink,
  inviteLinkKeys,
  isShortInvite,
  linkTopic,
  openInvite,
  parseInviteLink,
  pinOf,
  sealInvite,
} from '../src/space/invite-link.js';
import { expandSecret } from '../src/space/space-access.js';
import { base64UrlEncode } from '../src/utils/encoding.js';
import { bufferSource } from '../src/utils/guards.js';

const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
const pin = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);

describe('the link', () => {
  test('is 43 characters, then its places', () => {
    const text = encodeInviteLink({
      secret,
      pin,
      places: ['wss://host.example/', 'wss://relay.example/minca'],
    });
    assert.equal(text, 'AAECAwQFBgcICQoLDA0OD_Dx8vP09fb3-Pn6-_z9_v8@host.example,relay.example/minca');
    assert.equal(isShortInvite(text), true);
    const read = parseInviteLink(text);
    assert.deepEqual([...read.secret], [...secret]);
    assert.deepEqual([...read.pin], [...pin]);
    assert.deepEqual(read.places, ['wss://host.example', 'wss://relay.example/minca']);
  });

  test('a place on this machine is plain ws://, and one elsewhere never is', () => {
    const text = encodeInviteLink({ secret, pin, places: ['ws://localhost:8787'] });
    assert.ok(text.endsWith('@localhost:8787'));
    assert.deepEqual(parseInviteLink(text).places, ['ws://localhost:8787']);
    // Written with its scheme, plain ws:// elsewhere is no place at all.
    const code = text.split('@')[0]!;
    assert.deepEqual(parseInviteLink(`${code}@ws%3A%2F%2Fevil.example`).places, []);
    assert.deepEqual(parseInviteLink(`${code}@javascript:alert(1)`).places, []);
  });

  test('at most two places are read', () => {
    const code = encodeInviteLink({ secret, pin, places: [] });
    assert.equal(parseInviteLink(`${code}@a.example,b.example,c.example`).places.length, 2);
  });

  test('a long invite is not a short one', () => {
    assert.equal(
      isShortInvite('eyJzcGFjZSI6eyJpZCI6ImJ2dno3dTd3NGp2bHp6YmtrYXFzNGVtN2FodnhtaG5zcmpxbnVwcTQ3NXds'),
      false,
    );
    assert.throws(() => parseInviteLink('not a link'));
  });

  test('the secret derives the invite secret, and the pin the topic', async () => {
    const keys = await inviteLinkKeys(secret, pin);
    assert.equal(
      base64UrlEncode(keys.inviteSecret),
      base64UrlEncode(await expandSecret(secret, 'minca/invite-link/v1|secret')),
    );
    assert.equal(keys.inviteSecret.length, 32);
    assert.equal(keys.topic, await linkTopic(pin));
    assert.equal(keys.topic.length, 43);
    // Fixed, so another implementation can check its own.
    assert.equal(keys.topic, 'ex_E83cHgNjstsHBJeImIx_l0G71b0ivofu6MOcfu6I');
  });
});

describe('the sealed invite', () => {
  const invite = { space: { id: 'abc', name: 'Chess club' }, relays: ['wss://relay.example'] };

  test('opens with the link that names it, and with nothing else', async () => {
    const sealed = await sealInvite(secret, { invite, until: 1_790_000_000_000 });
    assert.deepEqual([...sealed.pin], [...(await pinOf(sealed.blob))]);
    const link = { secret, pin: sealed.pin, places: [] };
    assert.deepEqual(await openInvite(link, sealed.blob), { invite, until: 1_790_000_000_000 });

    // Another blob sealed under the same secret — by anyone who holds the link — is not this link's.
    const other = await sealInvite(secret, { invite: { ...invite, relays: ['wss://evil.example'] } });
    assert.equal(await openInvite(link, other.blob), null);
    // Nor is one under another secret that happens to be filed with it.
    assert.equal(await openInvite({ ...link, secret: new Uint8Array(16) }, sealed.blob), null);
    // Nor a blob changed in one character.
    const flipped = sealed.blob.slice(0, -1) + (sealed.blob.endsWith('A') ? 'B' : 'A');
    assert.equal(await openInvite(link, flipped), null);
  });

  test('one that inflates past the limit is refused', async () => {
    // Sealed by hand, as only someone holding the secret could: a megabyte of zeros.
    const raw = await expandSecret(secret, 'minca/invite-link/v1|seal');
    const key = await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const json = new TextEncoder().encode(`{"v":1,"invite":{"x":"${'0'.repeat(1 << 20)}"}}`);
    const compressed = new Uint8Array(
      await new Response(
        new Blob([json]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
    const nonce = new Uint8Array(12);
    const cipher = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bufferSource(compressed)),
    );
    const blob = base64UrlEncode(new Uint8Array([...nonce, ...cipher]));
    assert.ok(blob.length < 12_000);
    assert.equal(await openInvite({ secret, pin: await pinOf(blob), places: [] }, blob), null);
  });

  test('one too large for a mailbox is not made', async () => {
    const noise = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(20_000)));
    await assert.rejects(sealInvite(secret, { invite: { noise } }), /too large/);
  });
});

// ─── Between nodes, through a real relay's mailbox ─────────────────

describe('short links between nodes', () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  before(async () => {
    relay = await startRelay({ dropsPerNetwork: 10_000, dropsPerNetworkPerTopic: 10_000 });
  });
  after(() => relay.close());

  const inviteLink = (invite: string) => `https://app.example/#invite=${invite}`;

  /** Alice's private club, a note in it, and a link to it */
  async function club(options: InviteOptions = { role: 'editor', short: true }) {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = (await person(hub, { relays: [relay.url], accountKey: true })).node;
    const space = await alice.spaces.create({ name: 'Chess club', ...team, visibility: 'private' });
    await alice.records.put(space.id, 'note', { text: 'openings on Tuesday' });
    const link = inviteLink(await alice.spaces.invite(space.id, options));
    return { hub, alice, space, link };
  }

  /** The invite a short link's blob holds, as anyone holding the link can read it */
  async function sealedOf(link: string): Promise<Readonly<Record<string, unknown>>> {
    const parsed = parseInviteLink(bareInvite(link));
    for (const item of await createMailboxClient().fetch(relay.url, await linkTopic(parsed.pin))) {
      const opened = await openInvite(parsed, item.blob);
      if (opened) return opened.invite;
    }
    throw new Error('not found');
  }

  test('is short, names where it is kept, and joins with its role', async () => {
    const { hub, space, link } = await club();
    const bare = bareInvite(link);
    assert.equal(isShortInvite(bare), true);
    assert.ok(bare.length < 70, bare);

    // Bob's app knows no relay at all: the link says where to look.
    const bob = (await person(hub, { accountKey: true })).node;
    const preview = await bob.spaces.preview(link);
    assert.equal(preview.space.name, 'Chess club');
    assert.equal(preview.role, 'editor');
    assert.equal(preview.carriesKey, true);
    await bob.spaces.join(link);
    await joined(bob, space.id);
    await until(async () => (await bob.records.list(space.id)).length === 1, 5000, 'the note to reach Bob');
    await until(async () => bob.spaces.holdsRole(space.id, 'editor'), 5000, 'Bob to hold the role');
  });

  test("a link holder's own blob, with a junk key and its own node, is ignored", async () => {
    const { hub, space, link } = await club();
    const { secret: held, pin: named } = parseInviteLink(bareInvite(link));
    // Mallory holds the link, so she can seal what she likes under its secret, and leave it where the link looks.
    const real = await sealedOf(link);
    const junk = await sealInvite(held, {
      invite: {
        ...real,
        key: base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32))),
        nodes: ['wss://mallory.example/peer#did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
      },
    });
    const topic = await linkTopic(named);
    for (let i = 0; i < 3; i++) await createMailboxClient().drop(relay.url, topic, `${junk.blob}`);

    const bob = (await person(hub, { accountKey: true })).node;
    await bob.spaces.join(link);
    await until(async () => (await bob.records.list(space.id)).length === 1, 5000, 'the note to reach Bob');
    assert.equal((await bob.spaces.get(space.id))?.id, space.id);
  });

  test('nobody can clear it, and a flood of large blobs does not hide it', async () => {
    const { hub, space, link } = await club();
    const topic = await linkTopic(parseInviteLink(bareInvite(link)).pin);
    const mailbox = createMailboxClient();
    // No key hashes to the topic, so a purge is refused whoever asks.
    const signer = await provider.generateKeyPair();
    const sign = base64UrlEncode(await provider.exportPublicKey(signer.publicKey));
    await assert.rejects(
      mailbox.purge(relay.url, topic, sign, null, async () => 'AAAA'),
      /refused/,
    );
    // At another relay, large blobs fill more than eight pages before the real one is dropped
    // again there — after a restart, say. The joiner reads every page.
    const other = await startRelay({ dropsPerNetwork: 10_000, dropsPerNetworkPerTopic: 10_000 });
    try {
      for (let i = 0; i < 40; i++)
        await mailbox.drop(
          other.url,
          topic,
          base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(8_900))),
        );
      const parsed = parseInviteLink(bareInvite(link));
      const [real] = (await mailbox.fetch(relay.url, topic)).filter((item) => item.blob.length < 8_000);
      await mailbox.drop(other.url, topic, real!.blob);
      const there = encodeInviteLink({ ...parsed, places: [other.url] });
      const bob = (await person(hub, { accountKey: true })).node;
      await bob.spaces.join(there);
      await until(async () => (await bob.records.list(space.id)).length === 1, 5000, 'the note to reach Bob');
    } finally {
      other.close();
    }
  });

  test('a view-only link reads, and gives no role', async () => {
    const { hub, space, link } = await club({ write: false, short: true });
    const bob = (await person(hub, { accountKey: true })).node;
    const preview = await bob.spaces.preview(link);
    assert.deepEqual(
      { carriesWrite: preview.carriesWrite, role: preview.role },
      { carriesWrite: false, role: null },
    );
    await bob.spaces.join(link);
    await until(async () => (await bob.records.list(space.id)).length === 1, 5000, 'the note to reach Bob');
  });

  test('closed by its link, it lets nobody else join', async () => {
    const { hub, alice, space, link } = await club();
    await alice.spaces.closeInvite(space.id, link);
    const bob = (await person(hub, { accountKey: true })).node;
    await bob.spaces.join(link);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await bob.spaces.holdsRole(space.id, 'editor'), false);
  });

  test('with no mailbox to keep it, the long invite is given, and works the same', async () => {
    const alice = (await person(createFakeHub(), { accountKey: true })).node;
    const space = await alice.spaces.create({ name: 'Offline', visibility: 'private' });
    const invite = await alice.spaces.invite(space.id, { write: false, short: true });
    assert.equal(isShortInvite(invite), false);
    assert.equal(parseSpaceInvite(invite).space.id, space.id);
  });

  test('a link whose invite is nowhere says so', async () => {
    const bob = (await person(createFakeHub(), { accountKey: true })).node;
    await assert.rejects(
      bob.spaces.preview(encodeInviteLink({ secret, pin, places: [relay.url] })),
      /not found/,
    );
  });
});

const provider = createP256Provider();

/** A relay on a free port, for its mailbox */
async function startRelay(mailbox: Partial<MailboxLimits> = {}) {
  const relay = createRelay({ mailbox });
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
