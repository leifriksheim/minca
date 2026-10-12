/**
 * Delegations in Weave's JSON profile of UCAN 1.0 (spec 01 §7): the token,
 * its one form, and chains of them — each link no wider than the last.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import {
  commandCovers,
  delegationId,
  extendProof,
  isCommand,
  issueDelegation,
  parseDelegation,
  proofGrants,
  verifyDelegation,
  verifyProof,
  type Delegation,
  type Proof,
} from '../src/identity/ucan.js';
import { canonicalize } from '../src/schema/version.js';
import { base64UrlDecode, base64UrlEncode } from '../src/utils/encoding.js';
import { makeKey } from './helpers/person.js';

const provider = createP256Provider();
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

type Key = Awaited<ReturnType<typeof makeKey>>;

/** A note from `issuer` to `audience`, every command about the issuer's account unless said otherwise */
const note = (issuer: Key, audience: string, terms: Partial<Parameters<typeof issueDelegation>[0]> = {}) =>
  issueDelegation({ issuer, audience, command: '/', ...terms }, provider);

/** The same token with its signature's `s` in the other form, `n − s` */
function otherForm(token: Delegation): Delegation {
  const sig = base64UrlDecode(token.sig);
  let s = sig.subarray(32).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  s = N - s;
  for (let i = 63; i >= 32; i--) {
    sig[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return { ...token, sig: base64UrlEncode(sig) };
}

describe('the token (01 §7.1)', () => {
  // The example of spec 01 §7.8: the root key of §3.3 to the did:key spec's example key.
  const example = {
    signed:
      '{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr"},"type":"weave/ucan/dlg@1"}',
    token:
      '{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr"},"sig":"5nEZcQqVKr77iRLSYCRVC-W7AYbE-4MTEZSPC4FMjuQBk9UVvQLN-34gst5lghf3y0YRWT9m5Vaqkt6XcBu7Qw","type":"weave/ucan/dlg@1"}',
    id: 'b6zstk7cjkyvhhcdfdoihjemyyq5s4frwwvk3aijuf5ykcqa4fbya',
  };

  test('the example of 01 §7.8: its bytes, its id, and it verifies', async () => {
    const token: unknown = JSON.parse(example.token);
    const parsed = parseDelegation(token);
    assert.ok(parsed);
    assert.equal(canonicalize(parsed), example.token);
    assert.equal(canonicalize({ payload: parsed.payload, type: parsed.type }), example.signed);
    assert.equal(await delegationId(parsed), example.id);
    const checked = await verifyDelegation(token, provider, { untimed: true });
    assert.equal(checked.valid, true, checked.valid ? '' : checked.reason);
    // Live, it is good from nbf until exp.
    assert.equal((await verifyDelegation(token, provider, { at: 1789996100 })).valid, true);
    assert.equal((await verifyDelegation(token, provider, { at: 1790000000 })).valid, false);
    assert.equal((await verifyDelegation(token, provider, { at: 1789996099 })).valid, false);

    // Issued again from the same seed and terms: the same signed bytes (the signature itself is randomized).
    const manager = createIdentityManager();
    const root = await manager.fromSeed(Uint8Array.from({ length: 16 }, (_, i) => i * 17));
    const again = await issueDelegation(
      {
        issuer: root,
        audience: 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169',
        command: '/record',
        policy: [['==', '.collection', 'app.note']],
        nonce: 'AAECAwQFBgcICQoL',
        expiration: 1790000000,
        notBefore: 1789996100,
      },
      manager.getProvider(),
    );
    assert.equal(canonicalize({ payload: again.payload, type: again.type }), example.signed);
  });

  test('one token, one id: the high-S form of a signature is refused', async () => {
    const parsed = parseDelegation(JSON.parse(example.token))!;
    const twin = otherForm(parsed);
    assert.notEqual(await delegationId(twin), example.id);
    const checked = await verifyDelegation(twin, provider, { untimed: true });
    assert.equal(checked.valid, false);
    assert.match(checked.valid ? '' : checked.reason, /high-S/);
  });

  test('an issuer signs in the low-S form only', async () => {
    const root = await makeKey();
    const session = await makeKey();
    for (let i = 0; i < 24; i++) {
      const token = await note(root, session.did);
      assert.equal((await verifyDelegation(token, provider)).valid, true);
      // Its twin would be high: refused, so every token issued is the one form.
      assert.equal((await verifyDelegation(otherForm(token), provider)).valid, false);
    }
  });

  test('round-trips, and its payload says who, about what, which command, under what', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const token = await note(root, session.did, { command: '/record/write', subject: 'space:bspace' });
    assert.equal(token.type, 'weave/ucan/dlg@1');
    assert.equal(token.payload.iss, root.did);
    assert.equal(token.payload.aud, session.did);
    assert.equal(token.payload.sub, 'space:bspace');
    assert.equal(token.payload.cmd, '/record/write');
    assert.deepEqual(token.payload.pol, []);
    // The default subject is the issuer's own account.
    assert.equal((await note(root, session.did)).payload.sub, root.did);
    // A plain JSON object: what a version, a grant or a message carries as it is.
    assert.deepEqual(parseDelegation(JSON.parse(JSON.stringify(token))), token);
  });

  test('refuses a tampered payload', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const token = await note(root, session.did, { command: '/record/read' });
    const widened = { ...token, payload: { ...token.payload, cmd: '/' } };
    const checked = await verifyDelegation(widened, provider);
    assert.equal(checked.valid, false);
    assert.match(checked.valid ? '' : checked.reason, /signature/i);
  });

  test('refuses anything but its exact shape', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const token = await note(root, session.did);
    const { payload } = token;
    const bad: Array<[string, unknown]> = [
      ['an extra member', { ...token, prf: [] }],
      ['an unknown payload field', { ...token, payload: { ...payload, att: [] } }],
      ['another type', { ...token, type: 'ucan/dlg@1.0.0' }],
      ['no nonce', { ...token, payload: { ...payload, nonce: undefined } }],
      ['a null subject (powerline)', { ...token, payload: { ...payload, sub: null } }],
      ['a subject that is neither', { ...token, payload: { ...payload, sub: 'role:admin' } }],
      ['a command in capitals', { ...token, payload: { ...payload, cmd: '/Record' } }],
      ['a command with a trailing slash', { ...token, payload: { ...payload, cmd: '/record/' } }],
      ['a command without its slash', { ...token, payload: { ...payload, cmd: 'record/write' } }],
      ['a policy that is not one', { ...token, payload: { ...payload, pol: [['~', '.a', 1]] } }],
      ['a selector that is not one', { ...token, payload: { ...payload, pol: [['==', 'a', 1]] } }],
      [
        'an issuer that is not a P-256 key',
        { ...token, payload: { ...payload, iss: 'did:web:example.com' } },
      ],
      ['a fractional time', { ...token, payload: { ...payload, exp: 1.5 } }],
      ['a padded signature', { ...token, sig: `${token.sig}==` }],
      ['a short signature', { ...token, sig: token.sig.slice(0, 80) }],
      ['a JWT', 'eyJhbGciOiJFUzI1NiJ9.e30.sig'],
    ];
    for (const [what, value] of bad) {
      assert.equal(parseDelegation(value), null, what);
      assert.equal((await verifyDelegation(value, provider)).valid, false, what);
    }
    // A signature spelled with non-zero trailing bits decodes to the same bytes: still refused.
    const last = token.sig.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = token.sig.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]!;
    if (base64UrlEncode(base64UrlDecode(respelled)) === token.sig)
      assert.equal(parseDelegation({ ...token, sig: respelled }), null, 'a second spelling');
  });

  test('live checks judge time; a record judges none', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const now = Math.floor(Date.now() / 1000);
    const expired = await note(root, session.did, { notBefore: now - 7200, expiration: now - 3600 });
    const early = await note(root, session.did, { notBefore: now + 600 });
    const timeless = await note(root, session.did, { notBefore: null, expiration: null });
    assert.match(
      String(await verifyDelegation(expired, provider).then((c) => !c.valid && c.reason)),
      /expired/,
    );
    assert.match(
      String(await verifyDelegation(early, provider).then((c) => !c.valid && c.reason)),
      /not yet/,
    );
    assert.match(
      String(await verifyDelegation(timeless, provider).then((c) => !c.valid && c.reason)),
      /starts and ends/,
    );
    for (const token of [expired, early, timeless])
      assert.equal((await verifyDelegation(token, provider, { untimed: true })).valid, true);
  });

  test('commands cover what is under them, by whole segments', () => {
    assert.equal(commandCovers('/', '/record/write'), true);
    assert.equal(commandCovers('/record', '/record/write'), true);
    assert.equal(commandCovers('/record', '/record'), true);
    assert.equal(commandCovers('/record', '/recordings'), false);
    assert.equal(commandCovers('/record/write', '/record'), false);
    assert.equal(commandCovers('/record/read', '/record/write'), false);
    assert.equal(isCommand('/'), true);
    assert.equal(isCommand('/ほげ/ふが'), true);
    assert.equal(isCommand('//'), false);
    assert.equal(isCommand(''), false);
  });
});

describe('a chain (01 §7.5)', () => {
  async function three() {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();
    return { root, session, guest };
  }

  test('root → session → guest verifies, its root the account and its audience the guest', async () => {
    const { root, session, guest } = await three();
    const parent = await note(root, session.did);
    const proof = await extendProof(
      [parent],
      { issuer: session, audience: guest.did, command: '/record/write', subject: 'space:bgarden' },
      provider,
    );
    const chain = await verifyProof(proof, provider);
    assert.equal(chain.valid, true, chain.valid ? '' : chain.reason);
    assert.equal(chain.valid && chain.root, root.did);
    assert.equal(chain.valid && chain.audience, guest.did);
    // The child never outlives the parent.
    assert.equal(proof[1]!.payload.exp, parent.payload.exp);
  });

  test('a link signed by anyone but the key above it is refused', async () => {
    const { root, session, guest } = await three();
    const stranger = await makeKey();
    const parent = await note(root, session.did);
    const forged = await note(stranger, guest.did, { subject: root.did });
    const chain = await verifyProof([parent, forged], provider);
    assert.equal(chain.valid, false);
    assert.match(chain.valid ? '' : chain.reason, /not signed by the key/);
  });

  test('a link that widens its command is refused', async () => {
    const { root, session, guest } = await three();
    const parent = await note(root, session.did, { command: '/record' });
    for (const command of ['/', '/access/change', '/recordings']) {
      const child = await note(session, guest.did, { command, subject: root.did });
      const chain = await verifyProof([parent, child], provider);
      assert.equal(chain.valid, false, command);
      assert.match(chain.valid ? '' : chain.reason, /widens its command/);
    }
    await assert.rejects(
      extendProof([parent], { issuer: session, audience: guest.did, command: '/' }, provider),
      /wider/,
    );
  });

  test('a link that widens its subject is refused: one space to the account, or to another space', async () => {
    const { root, session, guest } = await three();
    const parent = await note(root, session.did, { subject: 'space:bgarden' });
    for (const subject of [root.did, 'space:bother']) {
      const child = await note(session, guest.did, { subject });
      const chain = await verifyProof([parent, child], provider);
      assert.equal(chain.valid, false, subject);
      assert.match(chain.valid ? '' : chain.reason, /widens its subject/);
    }
    await assert.rejects(
      extendProof(
        [parent],
        { issuer: session, audience: guest.did, command: '/', subject: root.did },
        provider,
      ),
      /wider/,
    );
    // From the whole account down to one space is narrower: fine.
    const whole = await note(root, session.did);
    const narrowed = await note(session, guest.did, { subject: 'space:bgarden' });
    assert.equal((await verifyProof([whole, narrowed], provider)).valid, true);
  });

  test('a subject naming an account is only ever the root', async () => {
    const { root, session, guest } = await three();
    const other = await makeKey();
    // A root that claims another account's authority.
    const claimed = await note(root, session.did, { subject: other.did });
    assert.equal((await verifyProof([claimed], provider)).valid, false);
    // A middle link that names its own key as the subject.
    const parent = await note(root, session.did);
    const child = await note(session, guest.did, { subject: session.did });
    assert.equal((await verifyProof([parent, child], provider)).valid, false);
  });

  test('every link is a note: made out to a key, with a start and an end', async () => {
    const { root, session } = await three();
    const toRole = await note(root, 'role:admin');
    assert.equal((await verifyProof([toRole], provider, { untimed: true })).valid, false);
    const endless = await note(root, session.did, { expiration: null, notBefore: null });
    const chain = await verifyProof([endless], provider, { untimed: true });
    assert.equal(chain.valid, false);
    assert.match(chain.valid ? '' : chain.reason, /no exp or nbf/);
  });

  test('a live check judges every link at the same time', async () => {
    const { root, session, guest } = await three();
    const now = Math.floor(Date.now() / 1000);
    const parent = await note(root, session.did, { notBefore: now - 7200, expiration: now - 3600 });
    const child = await note(session, guest.did, { subject: root.did, expiration: now + 3600 });
    assert.equal((await verifyProof([parent, child], provider)).valid, false);
    assert.equal((await verifyProof([parent, child], provider, { untimed: true })).valid, true);
  });

  test('a chain is one to ten links', async () => {
    const keys = [await makeKey()];
    const proof: Delegation[] = [];
    for (let i = 0; i < 11; i++) {
      keys.push(await makeKey());
      proof.push(await note(keys[i]!, keys[i + 1]!.did, { subject: keys[0]!.did }));
    }
    assert.equal((await verifyProof(proof.slice(0, 10), provider)).valid, true);
    assert.equal((await verifyProof(proof, provider)).valid, false);
    assert.equal((await verifyProof([], provider)).valid, false);
  });

  test('what a chain grants: every link’s command, subject and policy, together', async () => {
    const { root, session, guest } = await three();
    const parent = await note(root, session.did, { policy: [['==', '.collection', 'app.note']] });
    const proof: Proof = await extendProof(
      [parent],
      {
        issuer: session,
        audience: guest.did,
        command: '/record',
        subject: 'space:bgarden',
        policy: [['like', '.collection', 'app.*']],
      },
      provider,
    );
    const write = (space: string, collection: string) => ({
      space,
      cmd: '/record/write',
      args: { collection, space },
    });
    assert.equal(proofGrants(proof, write('bgarden', 'app.note')), true);
    // The parent's policy still holds below it, whatever the child says.
    assert.equal(proofGrants(proof, write('bgarden', 'app.todo')), false);
    assert.equal(proofGrants(proof, write('bother', 'app.note')), false, 'another space');
    assert.equal(proofGrants(proof, { ...write('bgarden', 'app.note'), cmd: '/collection/define' }), false);
    assert.equal(proofGrants(proof, { space: null, cmd: '/record/write', args: {} }), false, 'the account');
  });
});
