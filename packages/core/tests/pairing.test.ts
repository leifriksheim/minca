/**
 * Pairing tests — what the QR code shows, the exchange both devices run, and
 * what someone who saw the code, or replayed what passed, can do with it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  newPairingSecret,
  pairingCode,
  pairingCommitment,
  encodePairingTicket,
  decodePairingTicket,
  type PairingTicket,
} from '../src/identity/pairing.js';
import {
  channelRoom,
  channelKeyPair,
  deriveChannel,
  CODE_CHANNEL,
  PAIRING_CHANNEL,
  type ChannelKind,
} from '../src/identity/channel.js';
import { offerToPhone, receiveFromDesktop, type PairingStage } from '../src/session/pairing.js';
import { generateSeed, seedToRecoveryCode } from '../src/identity/recovery-code.js';
import { base64UrlEncode, utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import { isProtocolError } from '../src/utils/errors.js';
import { createFakeHub } from './helpers/fake-transport.js';

const stops: Array<() => void> = [];
after(() => stops.forEach((stop) => stop()));

const unreadable = (error: unknown) => isProtocolError(error, 'PAIRING_TICKET_UNREADABLE');

/** Both sides of one exchange, run by hand */
async function exchange(secret = newPairingSecret(), kind: ChannelKind = PAIRING_CHANNEL) {
  const offer = await channelKeyPair();
  const phone = await channelKeyPair();
  const points = { kind, offer: offer.point, join: phone.point };
  return {
    secret,
    points,
    offer: await deriveChannel({ secret, privateKey: offer.privateKey, ...points, side: 'offer' }),
    phone: await deriveChannel({ secret, privateKey: phone.privateKey, ...points, side: 'join' }),
  };
}

/** An offer on a fake hub, recording its stages */
async function offering(seed: Uint8Array, options: { ttlMs?: number } = {}) {
  const hub = createFakeHub({ latencyMs: 1 });
  const stages: PairingStage[] = [];
  const transport = (did: string) => hub.transport(did, 'pair');
  const offer = await offerToPhone(
    {
      seed,
      invites: async () => ['invite-one', 'invite-two'],
      relays: ['wss://relay.example'],
      link: 'https://home.example/',
      transport,
      ...options,
    },
    (stage) => stages.push(stage),
  );
  stops.push(() => offer.stop());
  const ticket = decodePairingTicket(offer.url.split('#pair=')[1] ?? '');
  const compare = () => {
    const stage = stages.find((s) => s.kind === 'compare');
    assert.ok(stage?.kind === 'compare');
    return stage;
  };
  return { offer, stages, ticket, transport, compare };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the ticket in the QR code', () => {
  test('carries a fresh secret and nothing about the account', async () => {
    const seed = generateSeed();
    const { offer, ticket } = await offering(seed);

    assert.deepEqual(Object.keys(ticket).sort(), ['relay', 'secret', 'v']);
    assert.equal(ticket.relay, 'wss://relay.example');
    const code = seedToRecoveryCode(seed);
    assert.ok(!offer.url.includes(code) && !offer.url.includes(code.replace(/-/g, '')));
    assert.notEqual(ticket.secret, base64UrlEncode(seed));
    // A QR holding a whole URL has to stay readable across a desk.
    assert.ok(offer.url.length < 200, `pairing URL was ${offer.url.length} characters`);

    const again = await offering(seed);
    assert.notEqual(again.ticket.secret, ticket.secret);
  });

  test('round-trips', () => {
    const ticket: PairingTicket = {
      v: 2,
      secret: base64UrlEncode(newPairingSecret()),
      relay: 'ws://192.168.1.42:8787',
    };
    assert.deepEqual(decodePairingTicket(encodePairingTicket(ticket)), ticket);
  });

  test('an old ticket with a recovery code in it, or a mangled one, is refused', () => {
    const other = base64UrlEncode(
      utf8Encode(JSON.stringify({ v: 1, code: seedToRecoveryCode(generateSeed()), relay: 'wss://r' })),
    );
    const short = base64UrlEncode(utf8Encode(JSON.stringify({ v: 2, secret: 'AAAA', relay: 'wss://r' })));
    for (const bad of ['', 'not-base64!!', other, short]) {
      assert.throws(() => decodePairingTicket(bad), unreadable);
    }
  });
});

describe('the meeting room', () => {
  test('is named after the secret, so every offer meets somewhere new', async () => {
    const secret = newPairingSecret();
    const room = (s: Uint8Array) => channelRoom(PAIRING_CHANNEL, s);
    assert.equal(await room(secret), await room(Uint8Array.from(secret)));
    assert.notEqual(await room(newPairingSecret()), await room(newPairingSecret()));
    // Connecting by code meets elsewhere, even with the same secret.
    assert.notEqual(await room(secret), await channelRoom(CODE_CHANNEL, secret));
  });
});

describe('the exchange', () => {
  test('both sides get the same six digits, and each opens what the other sealed', async () => {
    const both = await exchange();
    const code = await pairingCode(both.offer);
    assert.match(code, /^\d{6}$/);
    assert.equal(code, await pairingCode(both.phone));
    const handover = await both.offer.seal('pair:handover', utf8Encode('the account'));
    // Text, not an array of numbers.
    assert.match(handover, /^[A-Za-z0-9_-]+$/);
    assert.equal(utf8Decode((await both.phone.open('pair:handover', handover))!), 'the account');
    const done = await both.phone.seal('pair:done', utf8Encode('thanks'));
    assert.equal(utf8Decode((await both.offer.open('pair:done', done))!), 'thanks');
  });

  test('someone without the secret gets a different channel', async () => {
    const offer = await channelKeyPair();
    const phone = await channelKeyPair();
    const points = { kind: PAIRING_CHANNEL, offer: offer.point, join: phone.point };
    const real = await deriveChannel({
      secret: newPairingSecret(),
      privateKey: offer.privateKey,
      ...points,
      side: 'offer',
    });
    const guess = await deriveChannel({
      secret: newPairingSecret(),
      privateKey: phone.privateKey,
      ...points,
      side: 'join',
    });
    const sealed = await real.seal('pair:handover', utf8Encode('the account'));
    assert.equal(await guess.open('pair:handover', sealed), null);
  });

  test('a handover from one exchange opens in no other, even with the same secret', async () => {
    const first = await exchange();
    const second = await exchange(first.secret);
    const sealed = await first.offer.seal('pair:handover', utf8Encode('the account'));
    assert.equal(await second.phone.open('pair:handover', sealed), null);
  });

  test('a message sent back to the side that sealed it does not open there', async () => {
    // Each direction has its own key: what the offering device sent, reflected
    // back to it, is not something the phone said.
    const both = await exchange();
    const handover = await both.offer.seal('pair:done', utf8Encode('the account'));
    assert.equal(await both.offer.open('pair:done', handover), null);
    const done = await both.phone.seal('pair:handover', utf8Encode('hello'));
    assert.equal(await both.phone.open('pair:handover', done), null);
  });

  test('a message relabelled as another type does not open', async () => {
    const both = await exchange();
    const done = await both.phone.seal('pair:done', utf8Encode('{"spaces":1}'));
    assert.equal(await both.offer.open('pair:handover', done), null);
    // Refusing it left the count alone: the real message still opens.
    assert.ok(await both.offer.open('pair:done', done));
  });

  test('a message replayed, or delivered out of order, does not open', async () => {
    const both = await exchange();
    const first = await both.offer.seal('pair:handover', utf8Encode('one'));
    const second = await both.offer.seal('pair:handover', utf8Encode('two'));
    // The second before the first: it is not the next one.
    assert.equal(await both.phone.open('pair:handover', second), null);
    assert.equal(utf8Decode((await both.phone.open('pair:handover', first))!), 'one');
    // The first again: already taken.
    assert.equal(await both.phone.open('pair:handover', first), null);
    assert.equal(utf8Decode((await both.phone.open('pair:handover', second))!), 'two');
    assert.equal(await both.phone.open('pair:handover', second), null);
  });

  test('a key that is not a P-256 point is refused', async () => {
    const offer = await channelKeyPair();
    const junk = new Uint8Array(65).fill(4);
    await assert.rejects(
      () =>
        deriveChannel({
          kind: PAIRING_CHANNEL,
          secret: newPairingSecret(),
          privateKey: offer.privateKey,
          offer: offer.point,
          join: junk,
          side: 'offer',
        }),
      unreadable,
    );
  });

  test('a truncated payload, or one that is not text, is refused rather than misread', async () => {
    const { offer } = await exchange();
    for (const bad of ['AAAA', '', [1, 2, 3], null, '!!not base64!!'])
      assert.equal(await offer.open('pair:done', bad), null);
  });

  test('the commitment is a hash of the point', async () => {
    const { point } = await channelKeyPair();
    assert.equal(await pairingCommitment(point), await pairingCommitment(Uint8Array.from(point)));
    assert.notEqual(await pairingCommitment(point), await pairingCommitment((await channelKeyPair()).point));
  });

  test('someone who learns the secret later cannot open a recording of the exchange', async () => {
    // What passed in the room: both points in the clear, and sealed messages.
    const both = await exchange();
    const sealed = await both.offer.seal('pair:handover', utf8Encode('the account'));
    // With the secret and both points, but neither private key, the best guess
    // is an exchange of one's own against the recorded points.
    for (const side of ['offer', 'join'] as const) {
      const eve = await channelKeyPair();
      const guess = await deriveChannel({
        secret: both.secret,
        privateKey: eve.privateKey,
        ...both.points,
        side,
      });
      assert.equal(await guess.open('pair:handover', sealed), null);
    }
  });

  test('pairing and connecting by code never open each other’s messages', async () => {
    const secret = newPairingSecret();
    const offer = await channelKeyPair();
    const join = await channelKeyPair();
    const points = { offer: offer.point, join: join.point };
    const pairing = await deriveChannel({
      kind: PAIRING_CHANNEL,
      secret,
      privateKey: offer.privateKey,
      ...points,
      side: 'offer',
    });
    const code = await deriveChannel({
      kind: CODE_CHANNEL,
      secret,
      privateKey: join.privateKey,
      ...points,
      side: 'join',
    });
    assert.equal(await code.open('x', await pairing.seal('x', utf8Encode('hi'))), null);
  });
});

describe('pairing a phone', () => {
  test('the account goes over only after the person confirms the same code', async () => {
    const seed = generateSeed();
    const { stages, ticket, transport, compare } = await offering(seed);

    let phoneCode = '';
    const received = receiveFromDesktop(
      ticket,
      (stage) => {
        if (stage.kind === 'confirm') phoneCode = stage.code;
      },
      { transport },
    );

    await until(() => stages.some((s) => s.kind === 'compare') && phoneCode !== '', 'both codes');
    assert.equal(compare().code, phoneCode);
    assert.ok(!stages.some((s) => s.kind === 'sending'), 'nothing is sent before the person confirms');

    compare().same();
    const handover = await received;
    assert.deepEqual(handover.seed, seed);
    assert.deepEqual(handover.spaces, ['invite-one', 'invite-two']);
    await until(() => stages.some((s) => s.kind === 'sent'), 'the phone saying it arrived');
    assert.deepEqual(stages.at(-1), { kind: 'sent', spaces: 2 });
  });

  test('saying the codes differ sends nothing', async () => {
    const { stages, ticket, transport, compare } = await offering(generateSeed());
    const received = receiveFromDesktop(ticket, () => {}, { transport, confirmTimeoutMs: 300 });
    await until(() => stages.some((s) => s.kind === 'compare'), 'the code');
    compare().different();
    await assert.rejects(received, /Nobody confirmed/);
    assert.equal(stages.at(-1)?.kind, 'failed');
  });

  test('a code works for one phone: a second with the same ticket is not answered', async () => {
    const { stages, ticket, transport, compare } = await offering(generateSeed());
    const first = receiveFromDesktop(ticket, () => {}, { transport });
    await until(() => stages.some((s) => s.kind === 'compare'), 'the first phone');

    await assert.rejects(
      receiveFromDesktop(ticket, () => {}, { transport, findTimeoutMs: 300 }),
      /did not answer/,
    );

    compare().same();
    assert.equal((await first).spaces.length, 2);
  });

  test('a code nobody used stops working after a while', async () => {
    const { stages, ticket, transport } = await offering(generateSeed(), { ttlMs: 50 });
    await until(() => stages.some((s) => s.kind === 'failed'), 'the code expiring');
    const last = stages.at(-1);
    assert.ok(last?.kind === 'failed' && /expired/.test(last.reason));
    await assert.rejects(
      receiveFromDesktop(ticket, () => {}, { transport, findTimeoutMs: 300 }),
      /did not answer/,
    );
  });
});
