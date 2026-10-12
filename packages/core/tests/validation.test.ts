/**
 * Validation gate tests — signature checks and UCAN-based authorization.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { didToPublicKey } from '../src/identity/did.js';
import { extendProof, issueDelegation, type Proof } from '../src/identity/ucan.js';
import { writeRequirement } from '../src/identity/abilities.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { createCryptoGate } from '../src/validation/crypto-gate.js';
import { createCapabilityGate } from '../src/validation/capability-gate.js';
import { createVersionCheck } from '../src/validation/check-version.js';
import type { Version } from '../src/types.js';
import { makeKey } from './helpers/person.js';

const provider = createP256Provider();
const signer = createSigner(provider);

const COLLECTION = 'app.test.note';
/** What writing a note needs: `/record/write` in the space named after the collection */
const WRITE = (version: { readonly collection: string }) => writeRequirement(COLLECTION, version.collection);
/** A note's terms: records in that space, or in another */
const ALL = { command: '/record', subject: `space:${COLLECTION}` } as const;
const OTHER = { command: '/record', subject: 'space:something.else' } as const;

const resolvePublicKey = async (did: string) => provider.importPublicKey(didToPublicKey(did).publicKeyBytes);

/** Signs a note, optionally carrying a delegation proof. */
async function signNote(
  key: { did: string; privateKey: CryptoKey },
  text: string,
  proof?: Proof,
): Promise<Version<{ text: string }>> {
  const unsigned = createVersion({
    author: key.did,
    collection: COLLECTION,
    body: { text },
    ...(proof ? { proof } : {}),
  });
  return signer.sign(unsigned, key.privateKey);
}

describe('crypto gate', () => {
  const gate = createCryptoGate(provider);

  test('accepts a version signed by its author', async () => {
    const author = await makeKey();
    const version = await signNote(author, 'hello');

    const result = await gate.validate(version, resolvePublicKey);
    assert.equal(result.passed, true, result.reason ?? 'no reason given');
  });

  test('rejects a tampered body', async () => {
    const author = await makeKey();
    const version = await signNote(author, 'hello');
    const tampered = { ...version, body: { text: 'goodbye' } };

    const result = await gate.validate(tampered, resolvePublicKey);
    assert.equal(result.passed, false);
  });

  test('rejects an id that does not match the content', async () => {
    const author = await makeKey();
    const version = await signNote(author, 'hello');
    const relabelled = { ...version, id: 'bafyfake' };

    const result = await gate.validate(relabelled, resolvePublicKey);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /id does not match/i);
  });

  test('rejects a signature from another key', async () => {
    const author = await makeKey();
    const impostor = await makeKey();
    // Same payload, signed by someone else while still claiming the author DID
    const unsigned = createVersion({ author: author.did, collection: COLLECTION, body: { text: 'hi' } });
    const forged = await signer.sign(unsigned, impostor.privateKey);

    const result = await gate.validate(forged, resolvePublicKey);
    assert.equal(result.passed, false);
  });
});

describe('version check', () => {
  const check = createVersionCheck({ provider, required: WRITE });

  test('refuses a malformed version, however well signed', async () => {
    const author = await makeKey();
    const unsigned = createVersion({ author: author.did, collection: COLLECTION, body: { text: 'x' } });
    const malformed = await signer.sign({ ...unsigned, seq: 2 }, author.privateKey);
    const result = await check(malformed);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /later version/);
  });

  test('does not refuse a body for its shape: that depends on which definition a node has', async () => {
    const author = await makeKey();
    const unsigned = createVersion({ author: author.did, collection: COLLECTION, body: { text: 42 } });
    assert.equal((await check(await signer.sign(unsigned, author.privateKey))).passed, true);
  });

  test('refuses a tampered version at the signature', async () => {
    const author = await makeKey();
    const note = await signNote(author, 'honest');
    const result = await check({ ...note, body: { text: 'tampered' } });
    assert.equal(result.passed, false);
    assert.equal(result.gate, 'crypto');
  });
});

describe('capability gate', () => {
  const gate = createCapabilityGate({ provider, required: WRITE });

  test('accepts an author writing for itself', async () => {
    const author = await makeKey();
    const version = await signNote(author, 'my own note');

    const result = await gate.validate(version);
    assert.equal(result.passed, true, result.reason ?? 'no reason given');
  });

  test('accepts a delegated author carrying a valid proof', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueDelegation({ issuer: root, audience: session.did, ...ALL }, provider);

    const version = await signNote(session, 'delegated note', [ucan]);
    const result = await gate.validate(version);
    assert.equal(result.passed, true, result.reason ?? 'no reason given');
  });

  test('rejects a proof issued to a different key', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const thief = await makeKey();

    // A perfectly valid UCAN — for somebody else.
    const ucan = await issueDelegation({ issuer: root, audience: session.did, ...ALL }, provider);

    const version = await signNote(thief, 'stolen proof', [ucan]);
    const result = await gate.validate(version);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /different key/i);
  });

  test('rejects a proof that does not grant the required capability', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueDelegation({ issuer: root, audience: session.did, ...OTHER }, provider);

    const version = await signNote(session, 'wrong space', [ucan]);
    const result = await gate.validate(version);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /does not grant/i);
  });

  test('a note’s policy is checked against the version: its collection and its space', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const ucan = await issueDelegation(
      {
        issuer: root,
        audience: session.did,
        command: '/record/write',
        policy: [
          ['==', '.collection', COLLECTION],
          ['==', '.space', COLLECTION],
        ],
      },
      provider,
    );
    const allowed = await signNote(session, 'in its collection', [ucan]);
    assert.equal((await gate.validate(allowed)).passed, true);
    const elsewhere = await signer.sign(
      createVersion({
        author: session.did,
        collection: 'app.test.other',
        body: { text: 'x' },
        proof: [ucan],
      }),
      session.privateKey,
    );
    const result = await gate.validate(elsewhere);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /does not grant/i);
  });

  test('a chain travels on the version: root → session → guest, and no wider', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();
    const parent = await issueDelegation({ issuer: root, audience: session.did, ...ALL }, provider);
    const proof = await extendProof(
      [parent],
      { issuer: session, audience: guest.did, command: '/record/write' },
      provider,
    );
    assert.equal((await gate.validate(await signNote(guest, 'two links', proof))).passed, true);
    // Its leaf alone roots at the session, not the account; and without the leaf it is the session's.
    const leafOnly = await gate.validate(await signNote(guest, 'one link', [proof[1]!]));
    assert.equal(leafOnly.passed, true, 'a valid chain of one, rooted at the session key');
    assert.equal((await gate.validate(await signNote(guest, 'parent only', [parent]))).passed, false);
    // A guest link wider than its parent: refused.
    const wider = await issueDelegation(
      { issuer: session, audience: guest.did, command: '/', subject: `space:${COLLECTION}` },
      provider,
    );
    const widened = await gate.validate(await signNote(guest, 'wider', [parent, wider]));
    assert.equal(widened.passed, false);
    assert.match(widened.reason ?? '', /widens its command/);
  });

  test('a record’s standing judges no time: an expired note, and any date it claims, all stand', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    // A note that ran out an hour ago: live checks refuse it, but what its key signed is judged without a clock.
    const ucan = await issueDelegation(
      {
        issuer: root,
        audience: session.did,
        ...ALL,
        notBefore: now - 7200,
        expiration: now - 3600,
      },
      provider,
    );
    for (const when of [now - 86_400 * 365, now - 5000, now, now + 86_400 * 365]) {
      const unsigned = createVersion({
        author: session.did,
        collection: COLLECTION,
        body: { text: `dated ${when}` },
        proof: [ucan],
        createdAt: new Date(when * 1000).toISOString(),
      });
      const result = await gate.validate(await signer.sign(unsigned, session.privateKey));
      assert.equal(result.passed, true, result.reason ?? 'no reason given');
    }
    // What ends a key's writes is a revoke of the key, with its cutoff (03 §6.4).
  });

  test('honours an application trust policy', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const trusted = await makeKey();

    const strictGate = createCapabilityGate({
      provider,
      required: WRITE,
      isTrustedRoot: (did) => did === trusted.did,
    });

    const ucan = await issueDelegation({ issuer: root, audience: session.did, ...ALL }, provider);
    const version = await signNote(session, 'stranger', [ucan]);

    const result = await strictGate.validate(version);
    assert.equal(result.passed, false);
    assert.match(result.reason ?? '', /not authorized/i);
  });
});
