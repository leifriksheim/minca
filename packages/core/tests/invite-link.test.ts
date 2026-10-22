/**
 * Short invite links: the code, its places, what the secret derives, and the
 * sealed invite a link names by its hash — which nobody else can stand in for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
