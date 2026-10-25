/**
 * Loose versions (spec 02 §3.5) and invitations (spec 03 §7.4): an invite
 * signed by the inviter's key under its account's note, so whoever passes it
 * on can't change who invited, or the relays and nodes it names.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { checkLoose, decodeLoose, encodeLoose, signLoose, type LooseSigner } from '../src/records/loose.js';
import {
  checkInvitation,
  INVITATION_COLLECTION,
  readInvitation,
  writeInvitation,
} from '../src/space/invitation.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { team } from '../src/space/presets.js';
import { base64UrlDecode } from '../src/utils/encoding.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { makeKey, person, type Person } from './helpers/person.js';
import { resign, selfSigner } from './helpers/invitation.js';

const provider = createP256Provider();

/** A fresh key under a note from the person's account, about what `subject` names */
async function keyOf(who: Person, options: { subject?: string; command?: string; expiration?: number } = {}) {
  const key = await makeKey();
  const proof = await createLocalRootSigner(who.me, provider).delegate({
    audience: key.did,
    command: options.command ?? '/',
    ...(options.subject ? { subject: options.subject } : {}),
    expiration: options.expiration ?? Math.floor(Date.now() / 1000) + 3600,
  });
  return { did: key.did, key: key.privateKey, proof } satisfies LooseSigner;
}

describe('loose versions', () => {
  test('a version with no space checks out, and says whose account it speaks for', async () => {
    const who = await person();
    const signer = await keyOf(who);
    const version = await signLoose(signer, 'app.note', { text: 'hi' }, provider, { to: 'someone' });
    const checked = await checkLoose(decodeLoose(encodeLoose(version)), 'app.note', provider);
    assert.equal(checked?.root, who.node.did);
    assert.equal(checked?.version.to, 'someone');
    // Its own key, with no note, speaks for itself.
    const own = await selfSigner();
    assert.equal(
      (await checkLoose(await signLoose(own, 'app.note', {}, provider), 'app.note', provider))?.root,
      own.did,
    );
  });

  test('one that names a space, another collection, another body or another recipient is refused', async () => {
    const signer = await selfSigner();
    const version = await signLoose(signer, 'app.note', { text: 'hi' }, provider, { to: 'someone' });
    assert.equal(await checkLoose({ ...version, space: 'b' }, 'app.note', provider), null);
    assert.equal(await checkLoose(version, 'app.other', provider), null);
    assert.equal(await checkLoose({ ...version, body: { text: 'bye' } }, 'app.note', provider), null);
    assert.equal(await checkLoose({ ...version, to: 'another' }, 'app.note', provider), null);
    assert.equal(await checkLoose({ ...version, seq: 1 }, 'app.note', provider), null);
  });

  test('a note is judged when the version says it was signed: dated outside it, or ahead of now, is refused', async () => {
    const who = await person();
    const now = Math.floor(Date.now() / 1000);
    // A note that ran out an hour ago, and a version dated now, after it.
    const lapsed = await keyOf(who, { expiration: now - 3600 });
    assert.equal(
      await checkLoose(await signLoose(lapsed, 'app.note', {}, provider), 'app.note', provider),
      null,
    );
    const signer = await keyOf(who);
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(
      await checkLoose(
        await signLoose(signer, 'app.note', {}, provider, { createdAt: ahead }),
        'app.note',
        provider,
      ),
      null,
    );
    // A note made out to another key proves nothing about this one.
    const other = await keyOf(who);
    assert.equal(
      await checkLoose(
        await signLoose({ ...signer, proof: other.proof }, 'app.note', {}, provider),
        'app.note',
        provider,
      ),
      null,
    );
  });
});

describe('invitations', () => {
  test('relays and nodes changed by whoever passed it on are refused when joining (#20)', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const bob = await person(hub);
    const { id } = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    const invite = await alice.node.spaces.invite(id, { role: 'editor' });
    assert.equal(parseSpaceInvite(invite).invitedBy, alice.node.did);

    const { version, secret } = readInvitation(invite);
    const edit = (change: Record<string, unknown>) =>
      writeInvitation({ ...version, body: { ...version.body, ...change } }, base64UrlDecode(secret!));
    for (const changed of [
      edit({ relays: ['wss://mallory.example'] }),
      edit({
        nodes: ['wss://mallory.example/peer#did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
      }),
      writeInvitation({ ...version, proof: undefined }, base64UrlDecode(secret!)),
    ])
      await assert.rejects(bob.node.spaces.join(changed), /doesn't check out/);
    assert.equal((await bob.node.spaces.list()).length, 0);
    await bob.node.spaces.join(invite);
  });

  test('a key whose note is about another space may not invite to this one', async () => {
    const alice = await person();
    const club = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    const other = await alice.node.spaces.create({ name: 'Other', ...team, visibility: 'private' });
    const invite = await alice.node.spaces.invite(club.id, { role: 'editor' });
    // Signed again by an app given only the other space: the account's own key, its note, but not here.
    const app = await keyOf(alice, { subject: `space:${other.id}` });
    const signed = readInvitation(await resign(invite, () => {}, app)).version;
    assert.match((await checkInvitation(signed, provider)) ?? '', /doesn't let it invite/);
    // One given this space may.
    const given = await keyOf(alice, { subject: `space:${club.id}` });
    assert.equal(
      await checkInvitation(readInvitation(await resign(invite, () => {}, given)).version, provider),
      null,
    );
  });

  test('a role invite needs a note that may change who may do what; sharing to view needs one that may read', async () => {
    const alice = await person();
    const club = await alice.node.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    const reader = await keyOf(alice, { subject: `space:${club.id}`, command: '/record/read' });
    const role = await alice.node.spaces.invite(club.id, { role: 'editor' });
    const view = await alice.node.spaces.invite(club.id, { write: false });
    assert.match(
      (await checkInvitation(readInvitation(await resign(role, () => {}, reader)).version, provider)) ?? '',
      /doesn't let it invite/,
    );
    assert.equal(
      await checkInvitation(readInvitation(await resign(view, () => {}, reader)).version, provider),
      null,
    );
  });

  test('a body with a member it should not have, or a key that is not one, is refused', async () => {
    const registry = createSpaceManager(createMemoryAdapter());
    const made = await registry.create({
      name: 'Notes',
      visibility: 'private',
      creator: 'did:key:zowner',
      ...team,
    });
    const invite = await registry.createInvite(made.space.id, await selfSigner());
    for (const change of [
      (b: Record<string, unknown>) => (b.invitedBy = 'did:key:zme'),
      (b: Record<string, unknown>) => (b.key = 'short'),
    ]) {
      const signed = readInvitation(await resign(invite, change)).version;
      assert.notEqual(await checkInvitation(signed, provider), null);
    }
    assert.equal(readInvitation(invite).version.collection, INVITATION_COLLECTION);
  });
});
