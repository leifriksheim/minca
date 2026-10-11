/**
 * Space tests — the four kinds of list, invites, and end-to-end encryption.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { createSpaceManager, parseSpaceInvite } from '../src/space/space-manager.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { issueUCAN, type Capability } from '../src/identity/ucan.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import { createVersionCheck } from '../src/validation/check-version.js';
import { openBody, sealBody, spaceKeyFromRaw } from '../src/privacy/space-encryption.js';
import { newRecordKey } from '../src/records/version.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { team } from '../src/space/presets.js';
import { makeKey } from './helpers/person.js';

const provider = createP256Provider();
const signer = createSigner(provider);
const OWNER = 'did:key:zOwnerPlaceholder';

describe('space manager', () => {
  test('creates private and public spaces, alone or with roles', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());

    const privatePersonal = await spaces.create({ name: 'Groceries', visibility: 'private', creator: OWNER });
    const publicPersonal = await spaces.create({ name: 'Reading', visibility: 'public', creator: OWNER });
    const privateShared = await spaces.create({
      name: 'Move house',
      ...team,
      visibility: 'private',
      creator: OWNER,
    });
    const publicShared = await spaces.create({
      name: 'Potluck',
      ...team,
      visibility: 'public',
      creator: OWNER,
    });

    // Only private spaces carry a key
    assert.notEqual(privatePersonal.key, null);
    assert.notEqual(privateShared.key, null);
    assert.equal(publicPersonal.key, null);
    assert.equal(publicShared.key, null);

    assert.equal(privatePersonal.space.encryptionKeyId, privatePersonal.key?.id);
    assert.equal(publicShared.space.encryptionKeyId, undefined);
    assert.equal(publicPersonal.space.creator, OWNER);
    assert.equal(publicPersonal.space.creatorRole, 'owner');
    assert.equal(privateShared.role, 'owner');

    const listed = await spaces.list();
    assert.equal(listed.length, 4);
  });

  test('gives each space a distinct id, even with one name', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const first = await spaces.create({ name: 'Todo', visibility: 'public', creator: OWNER });
    const second = await spaces.create({ name: 'Todo', visibility: 'public', creator: OWNER });
    assert.notEqual(first.space.id, second.space.id);
  });

  test('forgets a space and its key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Temp', visibility: 'private', creator: OWNER });

    await spaces.remove(record.space.id);
    assert.equal(await spaces.get(record.space.id), null);
    assert.equal((await spaces.list()).length, 0);
  });
});

describe('invites', () => {
  test('carries a private space key to another device', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Move house', ...team, visibility: 'private', creator: OWNER });
    const invite = await mine.createInvite(record.space.id, OWNER);

    const preview = parseSpaceInvite(invite);
    assert.equal(preview.space.name, 'Move house');
    assert.equal(typeof preview.key, 'string');

    const joined = await theirs.join(invite);
    assert.equal(joined.space.id, record.space.id);
    assert.notEqual(joined.key, null);
    assert.equal(joined.invite, null, 'a view-only invite carries no secret to wait on');

    // The key that arrived must open what the owner sealed
    const place = { space: record.space.id, collection: 'app.test.note', key: 'x' };
    const sealed = await sealBody({ text: 'secret' }, record.key!, place);
    assert.deepEqual(await openBody(sealed, joined.key!, place), { text: 'secret' });
  });

  test('a public space invite carries no key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Potluck', ...team, visibility: 'public', creator: OWNER });
    const invite = await spaces.createInvite(record.space.id, OWNER);

    assert.equal(parseSpaceInvite(invite).key, undefined);
  });

  test('joining keeps the roles the space started with, so every copy agrees who may write', async () => {
    const mine = createSpaceManager(createMemoryAdapter());
    const theirs = createSpaceManager(createMemoryAdapter());

    const record = await mine.create({ name: 'Reading', visibility: 'public', creator: OWNER, ...team });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const joined = await theirs.join(
      await mine.createInvite(record.space.id, OWNER, { secret, role: 'editor' }),
    );

    assert.deepEqual(joined.space.roles, record.space.roles);
    assert.equal(joined.space.creator, OWNER);
    assert.deepEqual(joined.invite, secret, 'the secret waits until its record arrives');
    assert.equal(joined.role, null);
  });

  test('rejects a corrupted invite', () => {
    assert.throws(() => parseSpaceInvite('not-an-invite'), /could not be read/i);
  });
});

describe('private space versions', () => {
  test('encrypt-then-sign survives validation without the key', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const owner = await makeKey();
    const record = await spaces.create({
      name: 'Secrets',
      ...team,
      visibility: 'private',
      creator: owner.did,
    });
    const spaceId = record.space.id;

    const required: Capability = { with: `space:${spaceId}`, can: 'record/write' };

    const session = await makeKey();
    const ucan = await issueUCAN(
      { issuer: owner, audience: session.did, capabilities: [{ with: '*', can: 'record/*' }] },
      provider,
    );

    // Encrypt first, then sign: the signature covers the ciphertext.
    const place = { space: spaceId, collection: 'app.test.note', key: newRecordKey() };
    const sealed = await sealBody({ text: 'dinner at eight' }, record.key!, place);
    const unsigned = createVersion({
      author: session.did,
      collection: 'app.test.note',
      space: spaceId,
      log: { n: 0, c: { n: 0 } },
      body: sealed,
      proof: ucan.encoded,
      version: { key: place.key, seq: 0 },
    });
    const version = await signer.sign(unsigned, session.privateKey);

    const check = createVersionCheck({ provider, requiredCapability: () => required });

    // A peer with no key still verifies and relays it: the signature and capability hold.
    const verdict = await check(version);
    assert.equal(verdict.passed, true, verdict.reason ?? 'no reason given');
    assert.equal(version.space, spaceId);
    assert.equal('text' in version.body, false);

    // A member opens it
    assert.deepEqual(await openBody(version.body, record.key!, place), { text: 'dinner at eight' });
  });

  test('the example body of spec 03 §8.3 opens', async () => {
    const key = await spaceKeyFromRaw(new Uint8Array(32).map((_, i) => 255 - i));
    assert.equal(key.id, 'aLhvw5pkV65_lcQHEcUOug');
    const body = {
      sealed: 'AaChoqOkpaanqKmqq0Fx-eCwOhnoZnLVU8hJnQsqWTBRgYQ5jezwBbEdvJDeKm5_wX3j',
      keyId: 'aLhvw5pkV65_lcQHEcUOug',
    };
    const place = { space: 'bexample', collection: 'app.note', key: 'k1' };
    assert.deepEqual(await openBody(body, key, place), { body: { text: 'hi' } });
  });

  test('a sealed body moved to another record, collection or space does not open', async () => {
    const spaces = createSpaceManager(createMemoryAdapter());
    const record = await spaces.create({ name: 'Secrets', ...team, visibility: 'private', creator: OWNER });
    const key = record.key!;
    const place = { space: record.space.id, collection: 'app.test.note', key: newRecordKey() };
    const sealed = await sealBody({ text: 'dinner at eight' }, key, place);
    assert.deepEqual(await openBody(sealed, key, place), { text: 'dinner at eight' });
    // A member who copies the ciphertext into a record of their own gets nothing readable there.
    assert.equal(await openBody(sealed, key, { ...place, key: newRecordKey() }), null);
    assert.equal(await openBody(sealed, key, { ...place, collection: 'app.test.other' }), null);
    assert.equal(await openBody(sealed, key, { ...place, space: 'bsomewhereelse' }), null);
    // A body naming another key id, or with a changed byte, does not open either.
    assert.equal(await openBody({ ...sealed, keyId: 'AAAAAAAAAAAAAAAAAAAAAA' }, key, place), null);
    const bytes = base64UrlDecode(sealed.sealed);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const flipped = base64UrlEncode(bytes);
    assert.equal(await openBody({ ...sealed, sealed: flipped }, key, place), null);
  });

  test('a personal space refuses a stranger, whatever they sign', async () => {
    const owner = await makeKey();
    const stranger = await makeKey();
    const strangerSession = await makeKey();
    const spaceId = 'space-personal';

    const gate = createCapabilityGate({
      provider,
      requiredCapability: () => ({ with: `space:${spaceId}`, can: 'record/write' }),
      isTrustedRoot: (rootDid) => rootDid === owner.did,
    });

    // Perfectly valid UCAN — from the wrong root.
    const ucan = await issueUCAN(
      { issuer: stranger, audience: strangerSession.did, capabilities: [{ with: '*', can: 'record/*' }] },
      provider,
    );
    const unsigned = createVersion({
      author: strangerSession.did,
      collection: 'app.test.note',
      space: spaceId,
      log: { n: 0, c: { n: 0 } },
      body: { text: 'let me in' },
      proof: ucan.encoded,
    });
    const version = await signer.sign(unsigned, strangerSession.privateKey);

    const result = await gate.validate(version);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /not authorized/i);
  });
});
