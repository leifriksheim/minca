/**
 * Delegations in Minca's JSON profile of UCAN 1.0 (spec 01 §7): the token,
 * its one form, and notes — one link from the account, never passed on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import {
  commandCovers,
  delegationId,
  isCommand,
  issueDelegation,
  parseDelegation,
  noteCovers,
  verifyDelegation,
  verifyNote,
  type Delegation,
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
      '{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT"},"type":"minca/ucan/dlg@1"}',
    token:
      '{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT"},"sig":"HBKED5Qimk7X5F0Xd79Gcm4F64GdtYbFqyt7B-kO-ZEl8e2gD3mW07VQaVYfnngREQ5FmzHLA8tCZckpLo7QDg","type":"minca/ucan/dlg@1"}',
    id: 'bcmmtwj62gmokzcmv4h7devlpn2fgrkwof3gj6xv3lkpefcn7x6wa',
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
    assert.equal(token.type, 'minca/ucan/dlg@1');
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
    assert.equal(isCommand('/record.v2/write_all-x'), true);
    // ASCII lower case only: nothing case folding could spell two ways.
    assert.equal(isCommand('/ほげ/ふが'), false);
    assert.equal(isCommand('/İ'), false);
    assert.equal(isCommand('/a b'), false);
    assert.equal(isCommand('//'), false);
    assert.equal(isCommand(''), false);
  });
});

describe('a note (01 §7.5)', () => {
  async function three() {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();
    return { root, session, guest };
  }

  test('root → session verifies, its root the account and its audience the session', async () => {
    const { root, session } = await three();
    const checked = await verifyNote(await note(root, session.did), provider);
    assert.equal(checked.valid, true, checked.valid ? '' : checked.reason);
    assert.equal(checked.valid && checked.root, root.did);
    assert.equal(checked.valid && checked.audience, session.did);
  });

  test('a chain is refused, however sound its links: a key cannot pass its note on', async () => {
    const { root, session, guest } = await three();
    const parent = await note(root, session.did);
    const child = await note(session, guest.did, { command: '/record', subject: root.did });
    for (const proof of [[parent, child], [parent], []]) {
      const checked = await verifyNote(proof, provider);
      assert.equal(checked.valid, false, String(proof.length));
      assert.match(checked.valid ? '' : checked.reason, /one note/);
    }
    // Alone, the passed-on token is not a note from the account it names.
    const alone = await verifyNote(child, provider);
    assert.equal(alone.valid, false);
    assert.match(alone.valid ? '' : alone.reason, /other than its issuer/);
    // Made about the session's own key, it is a note from that key, not from the account.
    const own = await verifyNote(await note(session, guest.did), provider);
    assert.equal(own.valid && own.root, session.did);
  });

  test('a subject naming an account is only ever its issuer', async () => {
    const { root, session } = await three();
    const other = await makeKey();
    const claimed = await note(root, session.did, { subject: other.did });
    assert.equal((await verifyNote(claimed, provider)).valid, false);
  });

  test('a note is made out to a key, with a start and an end', async () => {
    const { root, session } = await three();
    const toRole = await note(root, 'role:admin');
    assert.equal((await verifyNote(toRole, provider, { untimed: true })).valid, false);
    const endless = await note(root, session.did, { expiration: null, notBefore: null });
    const checked = await verifyNote(endless, provider, { untimed: true });
    assert.equal(checked.valid, false);
    assert.match(checked.valid ? '' : checked.reason, /no exp or nbf/);
  });

  test('a live check judges its time; a record’s does not', async () => {
    const { root, session } = await three();
    const now = Math.floor(Date.now() / 1000);
    const old = await note(root, session.did, { notBefore: now - 7200, expiration: now - 3600 });
    assert.equal((await verifyNote(old, provider)).valid, false);
    assert.equal((await verifyNote(old, provider, { untimed: true })).valid, true);
  });

  test('what a note grants: its command, subject and policy', async () => {
    const { root, session } = await three();
    const token = await note(root, session.did, {
      command: '/record',
      subject: 'space:bgarden',
      policy: [['like', '.collection', 'app.n*']],
    });
    const write = (space: string, collection: string) => ({
      space,
      cmd: '/record/write',
      args: { collection, space },
    });
    assert.equal(noteCovers(token, write('bgarden', 'app.note')), true);
    assert.equal(noteCovers(token, write('bgarden', 'app.todo')), false, 'the policy');
    assert.equal(noteCovers(token, write('bother', 'app.note')), false, 'another space');
    assert.equal(noteCovers(token, { ...write('bgarden', 'app.note'), cmd: '/collection/define' }), false);
    assert.equal(noteCovers(token, { space: null, cmd: '/record/write', args: {} }), false, 'the account');
  });
});
