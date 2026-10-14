/**
 * The spec's worked examples that no other test derives: each value is
 * computed here from the inputs the spec gives, so a change to a label or a
 * derivation can't leave an example behind.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { didToPublicKey } from '../src/identity/did.js';
import { hkdf } from '../src/identity/hkdf.js';
import { contactPublicKey, deriveContactKeyBytes } from '../src/identity/contact-key.js';
import { channelRoom, PAIRING_CHANNEL } from '../src/identity/channel.js';
import { relayRoom } from '../src/node/space-runtime.js';
import { deriveInviteKey, inviteKey } from '../src/space/space-access.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  hexToBytes,
  utf8Encode,
} from '../src/utils/encoding.js';

const provider = createP256Provider();
/** The seed of 01 §3.3 */
const SEED = hexToBytes('00112233445566778899aabbccddeeff');

describe('01: identity', () => {
  test('§3.3: the root key of the example seed, step by step', async () => {
    const okm = await hkdf(SEED, utf8Encode('minca/p256-identity-key/v1'), 48);
    assert.equal(
      bytesToHex(okm),
      'b1fc34eb5cbbdbabadec3403288c38f11ff530ad0e5e5561c1e8a36698232fdb11c563fc83da5893315f3e37cd3ed86d',
    );
    // d = (okm mod (n − 1)) + 1, as 32 bytes
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const d = (BigInt(`0x${bytesToHex(okm)}`) % (n - 1n)) + 1n;
    assert.equal(
      d.toString(16).padStart(64, '0'),
      '686fc0350a6b8c186f7b0b7856e67534000e51f22a79609256330344e73c2dee',
    );
    const identity = await createIdentityManager().fromSeed(SEED);
    const q = didToPublicKey(identity.did);
    assert.equal(
      bytesToHex(q.publicKeyBytes),
      '02388118d5b41d2e75aa0732d0b00606b5c1c085aaaff729fbcfc0349aa42247e2',
    );
    // §3.4: the did:key's decoded bytes, the multicodec prefix then Q
    assert.equal(
      bytesToHex(new Uint8Array([...q.multicodecPrefix, ...q.publicKeyBytes])),
      '802402388118d5b41d2e75aa0732d0b00606b5c1c085aaaff729fbcfc0349aa42247e2',
    );
  });

  test('§10.1: the contact key of the example seed', async () => {
    const secret = await deriveContactKeyBytes(SEED);
    assert.equal(bytesToHex(secret), '1d513eb757cd656fa9aee6e6f54a0506965be5279c281ae9520601bece578201');
    assert.equal(contactPublicKey(secret), 'AwFM-6h0Js6WTFMPqM9EDDkDHknhhgfst2aD-fROgWoV');
  });

  test('§15: the pairing room of the example secret', async () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
    assert.equal(
      await channelRoom(PAIRING_CHANNEL, secret),
      'bha5qohdu5w35oenvib6zfdg4blcbzc4onwelk4nium6ooen6nq7q',
    );
  });
});

describe('03: spaces', () => {
  test('§1.2: the founder is the account of the seed 01 02 … 10', async () => {
    const founder = await createIdentityManager().fromSeed(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
    assert.equal(founder.did, 'did:key:zDnaed8DYZ8Hx21hjLc7fE9TXMkDUV65S3ys8HtLrnPC1piwd');
  });

  test('§7.1 and §3.1: the invite key of the secret 00 … 1f, and its record key', async () => {
    const invite = await deriveInviteKey(
      Uint8Array.from({ length: 32 }, (_, i) => i),
      provider,
    );
    assert.equal(invite.did, 'did:key:zDnaepvP6YSjYyaBgu3v9VSziUgdmpk4t5a4Xw9VVA1e1BEd9');
    assert.equal(await inviteKey(invite.did), 'invite:13d55f0d88a0d85e161fee68b002cb9a68e8cb45');
  });
});

describe('04: network', () => {
  test('§2: the relay room of a space', async () => {
    const prefix = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', utf8Encode('minca-room/v1|example-space-id')),
    ).subarray(0, 20);
    assert.equal(bytesToHex(prefix), '9c76ed8676b603bf3ec19ec228ef20fbbaa6ffcf');
    assert.equal(await relayRoom('example-space-id'), 'tr3o3btwwyb36pwbt3bcr3za7o5kn76p');
  });

  test('§6.2: the example proof is the prover’s signature over T', async () => {
    const manager = createIdentityManager();
    const prover = await manager.fromSeed(new Uint8Array(16).fill(7));
    const verifier = await manager.fromSeed(new Uint8Array(16));
    const T = `minca-mesh/v1|example-space-id|${prover.did}|${verifier.did}|_8bGsP1hPeS2r_CFgK10jg|sha-256 AA:BB|sha-256 CC:DD`;
    const sig = 'TajJEwHsk_JRk6cPhnN3l0dbvZB6aCYtaIX_d2aHjDKqxJPtbdmv99hK3DcpW1mwwvJOwAQR1jNi9ouUFuLSEA';
    const key = await provider.importPublicKey(didToPublicKey(prover.did).publicKeyBytes);
    assert.equal(
      await provider.verify(key, base64UrlDecode(sig), utf8Encode(T)),
      true,
      base64UrlEncode(await provider.sign(prover.privateKey, utf8Encode(T))),
    );
  });
});
