/**
 * Envelopes and HPKE — the two ways anything is sealed (spec 01 §9): the
 * exact bytes, the official HPKE vectors, and a sealed thing refusing to
 * open anywhere but where it was sealed for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  boundContext,
  openEnvelope as open,
  openValue,
  sealEnvelope as seal,
  sealValue,
  MIN_ENVELOPE_BYTES,
} from '../src/identity/envelope.js';
import {
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkeSeal,
  openFrom,
  openValueFrom,
  sealTo,
  sealValueTo,
  type HpkeAead,
} from '../src/identity/hpke.js';
import { contactKeyPair, deriveContactKeyBytes } from '../src/identity/contact-key.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { BOX_LABEL, boxBound } from '../src/space/space-access.js';
import { isRecord } from '../src/utils/guards.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from '../src/utils/encoding.js';

const aesKey = (bytes: Uint8Array) =>
  globalThis.crypto.subtle.importKey('raw', new Uint8Array(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);

describe('the envelope', () => {
  // Fixed inputs, and the exact bytes they give: what another implementation checks itself against.
  const vector = {
    key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    label: 'weave/record-body/v1',
    bound: { space: 'bexample', collection: 'app.note', key: 'k1', keyId: 'aLhvw5pkV65_lcQHEcUOug' },
    plaintext: '{"body":{"text":"hi"}}',
    aad:
      '0177656176652f7265636f72642d626f64792f7631007b22636f6c6c656374696f6e223a226170702e6e6f7465222c226b6579' +
      '223a226b31222c226b65794964223a22614c68767735706b5636355f6c6351484563554f7567222c227370616365223a226265' +
      '78616d706c65227d',
    // nonce a0 a1 … ab
    envelope:
      '01a0a1a2a3a4a5a6a7a8a9aaab9d3a1e4221b220851947f3b67f0ee2e452c43032efcaf9fa505cbbb531a3a7173c059be663ee',
  };

  test('opens the fixed vector, whose additional data is the label and the canonical bound', async () => {
    assert.equal(bytesToHex(new Uint8Array([1, ...boundContext(vector.label, vector.bound)])), vector.aad);
    assert.equal(
      utf8Decode(boundContext(vector.label, vector.bound)),
      'weave/record-body/v1\u0000{"collection":"app.note","key":"k1","keyId":"aLhvw5pkV65_lcQHEcUOug","space":"bexample"}',
    );
    const key = await aesKey(hexToBytes(vector.key));
    const opened = await open(key, vector.label, vector.bound, hexToBytes(vector.envelope));
    assert.equal(utf8Decode(opened!), vector.plaintext);
    // The order fields are given in does not matter: the bound is canonical.
    const reordered = { keyId: vector.bound.keyId, key: 'k1', collection: 'app.note', space: 'bexample' };
    assert.ok(await open(key, vector.label, reordered, hexToBytes(vector.envelope)));
  });

  test('is the version byte, a fresh nonce and the ciphertext with its tag', async () => {
    const key = await aesKey(hexToBytes(vector.key));
    const plaintext = utf8Encode(vector.plaintext);
    const a = await seal(key, vector.label, vector.bound, plaintext);
    const b = await seal(key, vector.label, vector.bound, plaintext);
    assert.equal(a[0], 0x01);
    assert.equal(a.length, 1 + 12 + plaintext.length + 16);
    assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13), 'the nonce must be fresh each time');
    assert.equal(MIN_ENVELOPE_BYTES, 29);
  });

  test('refuses another label, another or one more bound field, another key, a changed byte', async () => {
    const key = await aesKey(hexToBytes(vector.key));
    const sealed = hexToBytes(vector.envelope);
    const { label, bound } = vector;
    assert.equal(await open(key, 'weave/at-rest/v1', bound, sealed), null);
    assert.equal(await open(key, label, { ...bound, key: 'k2' }, sealed), null);
    assert.equal(await open(key, label, { ...bound, extra: 1 }, sealed), null);
    const { keyId: _dropped, ...fewer } = bound;
    assert.equal(await open(key, label, fewer, sealed), null);
    assert.equal(await open(await aesKey(new Uint8Array(32)), label, bound, sealed), null);
    for (let i = 0; i < sealed.length; i += 7) {
      const changed = Uint8Array.from(sealed);
      changed[i] = changed[i]! ^ 1;
      assert.equal(await open(key, label, bound, changed), null, `byte ${i}`);
    }
  });

  test('refuses an unknown version and anything too short', async () => {
    const key = await aesKey(hexToBytes(vector.key));
    const sealed = hexToBytes(vector.envelope);
    for (const version of [0x00, 0x02, 0xff]) {
      const other = Uint8Array.from(sealed);
      other[0] = version;
      assert.equal(await open(key, vector.label, vector.bound, other), null);
    }
    assert.equal(await open(key, vector.label, vector.bound, sealed.subarray(0, 28)), null);
    assert.equal(await open(key, vector.label, vector.bound, new Uint8Array(0)), null);
    // An empty plaintext seals to the minimum, and opens.
    const empty = await seal(key, vector.label, vector.bound, new Uint8Array(0));
    assert.equal(empty.length, MIN_ENVELOPE_BYTES);
    assert.deepEqual(await open(key, vector.label, vector.bound, empty), new Uint8Array(0));
  });

  test('travels as base64url text when it seals a value', async () => {
    const key = await aesKey(hexToBytes(vector.key));
    const text = await sealValue(key, 'weave/membership/v1', { space: 'b1' }, 'a note');
    assert.match(text, /^[A-Za-z0-9_-]+$/);
    assert.equal(await openValue(key, 'weave/membership/v1', { space: 'b1' }, text), 'a note');
    assert.equal(await openValue(key, 'weave/membership/v1', { space: 'b2' }, text), null);
    assert.equal(await openValue(key, 'weave/membership/v1', { space: 'b1' }, 42), null);
  });
});

interface HpkeVector {
  readonly aead_id: HpkeAead;
  readonly info: string;
  readonly ikmE: string;
  readonly ikmR: string;
  readonly skEm: string;
  readonly skRm: string;
  readonly pkEm: string;
  readonly pkRm: string;
  readonly enc: string;
  readonly encryptions: ReadonlyArray<{ readonly aad: string; readonly pt: string; readonly ct: string }>;
}

/** The checked-in fixture: each entry carries the fields read below */
function isFixture(value: unknown): value is { readonly vectors: ReadonlyArray<HpkeVector> } {
  return (
    isRecord(value) &&
    Array.isArray(value.vectors) &&
    value.vectors.every(
      (vector: unknown) =>
        isRecord(vector) &&
        (vector.aead_id === 1 || vector.aead_id === 2) &&
        ['info', 'ikmE', 'ikmR', 'skEm', 'skRm', 'pkEm', 'pkRm', 'enc'].every(
          (field) => typeof vector[field] === 'string',
        ) &&
        Array.isArray(vector.encryptions),
    )
  );
}

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./vectors/hpke-p256.json', import.meta.url), 'utf8'),
);
assert.ok(isFixture(fixture));
const { vectors } = fixture;

describe('HPKE (RFC 9180), against the CFRG test vectors', () => {
  test('covers base mode, DHKEM(P-256), HKDF-SHA256, with AES-128-GCM and AES-256-GCM', () => {
    assert.deepEqual(vectors.map((vector) => vector.aead_id).sort(), [1, 2]);
  });

  for (const vector of vectors) {
    test(`aead ${vector.aead_id}: derives the keys, seals to the vector's bytes, and opens them`, async () => {
      const ephemeral = await hpkeDeriveKeyPair(hexToBytes(vector.ikmE));
      const recipient = await hpkeDeriveKeyPair(hexToBytes(vector.ikmR));
      assert.equal(bytesToHex(ephemeral.privateKey), vector.skEm);
      assert.equal(bytesToHex(ephemeral.publicKey), vector.pkEm);
      assert.equal(bytesToHex(recipient.privateKey), vector.skRm);
      assert.equal(bytesToHex(recipient.publicKey), vector.pkRm);

      const [first] = vector.encryptions;
      const sealed = await hpkeSeal({
        publicKey: recipient.publicKey,
        info: hexToBytes(vector.info),
        aad: hexToBytes(first!.aad),
        plaintext: hexToBytes(first!.pt),
        aead: vector.aead_id,
        ephemeral: {
          privateKey: (await contactKeyPair(ephemeral.privateKey)).privateKey,
          publicKey: ephemeral.publicKey,
        },
      });
      assert.equal(bytesToHex(sealed.enc), vector.enc);
      assert.equal(bytesToHex(sealed.ciphertext), first!.ct);

      const opened = await hpkeOpen({
        recipient: {
          privateKey: (await contactKeyPair(recipient.privateKey)).privateKey,
          publicKey: recipient.publicKey,
        },
        enc: hexToBytes(vector.enc),
        info: hexToBytes(vector.info),
        aad: hexToBytes(first!.aad),
        ciphertext: hexToBytes(first!.ct),
        aead: vector.aead_id,
      });
      assert.equal(bytesToHex(opened!), first!.pt);
    });
  }
});

describe('sealing to a key', () => {
  const recipient = async () => contactKeyPair(await deriveContactKeyBytes(generateSeed()));

  test('is the version byte, the ephemeral point and the ciphertext, as base64url', async () => {
    const to = await recipient();
    const plaintext = utf8Encode('the space key');
    const sealed = await sealTo(to.publicKey, 'weave/knock/v1', { door: to.publicKey }, plaintext);
    assert.match(sealed, /^[A-Za-z0-9_-]+$/);
    const bytes = base64UrlDecode(sealed);
    assert.equal(bytes[0], 0x01);
    assert.equal(bytes[1], 0x04, 'an uncompressed point');
    assert.equal(bytes.length, 1 + 65 + plaintext.length + 16);
    assert.deepEqual(await openFrom(to, 'weave/knock/v1', { door: to.publicKey }, sealed), plaintext);
  });

  test('a box opened with the wrong bound, label or key opens nothing', async () => {
    const to = await recipient();
    const someoneElse = await recipient();
    const bound = boxBound('bspace', 'key-1', 'did:key:zTo');
    const sealed = await sealValueTo(to.publicKey, BOX_LABEL, bound, { key: 'raw' });
    assert.deepEqual(await openValueFrom(to, BOX_LABEL, bound, sealed), { key: 'raw' });
    for (const wrong of [
      boxBound('bother', 'key-1', 'did:key:zTo'),
      boxBound('bspace', 'key-2', 'did:key:zTo'),
      boxBound('bspace', 'key-1', 'did:key:zSomeoneElse'),
    ])
      assert.equal(await openValueFrom(to, BOX_LABEL, wrong, sealed), null);
    assert.equal(await openValueFrom(to, 'weave/direct-box/v1', bound, sealed), null);
    assert.equal(await openValueFrom(someoneElse, BOX_LABEL, bound, sealed), null);
    // The right private key presented under another public key is a different recipient.
    assert.equal(
      await openValueFrom({ ...to, publicKey: someoneElse.publicKey }, BOX_LABEL, bound, sealed),
      null,
    );
  });

  test('refuses an unknown version, a short or changed value, and anything not text', async () => {
    const to = await recipient();
    const bound = { door: to.publicKey };
    const bytes = base64UrlDecode(await sealTo(to.publicKey, 'weave/knock/v1', bound, utf8Encode('hi')));
    const flipped = (at: number, to?: number) => {
      const copy = Uint8Array.from(bytes);
      copy[at] = to ?? copy[at]! ^ 1;
      return base64UrlEncode(copy);
    };
    for (const bad of [
      flipped(0, 0x02),
      base64UrlEncode(bytes.subarray(0, 81)),
      flipped(70),
      flipped(10),
      '',
      42,
      null,
    ])
      assert.equal(await openFrom(to, 'weave/knock/v1', bound, bad), null);
  });
});
