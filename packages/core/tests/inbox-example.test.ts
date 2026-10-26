// The example in spec 07 §3: scalars, keys and topic from the contact key of 01 §10.1, gen 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveInboxKeyBytes,
  deriveInboxSignKeyBytes,
  contactPublicKey,
} from '../src/identity/contact-key.js';
import { inboxTopic, inboxAuthor } from '../src/inbox/inbox.js';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
test('07 §3 example values', async () => {
  const contact = Uint8Array.from(
    Buffer.from('1d513eb757cd656fa9aee6e6f54a0506965be5279c281ae9520601bece578201', 'hex'),
  );
  const key = await deriveInboxKeyBytes(contact, 0);
  const sign = await deriveInboxSignKeyBytes(contact, 0);
  assert.equal(hex(key), '3eb6fe8cd7d3d571c860e3867262a326d0f6337a6e5b2f23ec8894c6b7712bff');
  assert.equal(hex(sign), 'd439cfa23bbb48af5cac7e829c00683812d3adf402868a994a8bbc9527790001');
  assert.equal(contactPublicKey(key), 'Az7e4Rrb7cRwOBUTo2R3DHPN_XhU_eEELZCaHnEdENoo');
  assert.equal(contactPublicKey(sign), 'A5014XmFHNvGb4sJVDmiDas-v4R4QJFmBRsO-N1lEMNY');
  assert.equal(await inboxTopic(contactPublicKey(sign)), 'HxW8ECmsKlUka0UEOGFx8bgChj6ToCYTOreTaBnVCtY');
  assert.equal(
    inboxAuthor(contactPublicKey(sign)),
    'did:key:zDnaetEy5TtXJYGtyxUAzR7a7Uj6H4aVcNgULLRxPuNMBtWJK',
  );
});
