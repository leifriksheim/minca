/**
 * Pairing tests — what the QR code shows, the exchange both devices run, and
 * what someone who saw the code, or replayed what passed, can do with it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  newPairingSecret,
  pairingRoomId,
  pairingKeyPair,
  pairingCommitment,
  derivePairingChannel,
  encodePairingTicket,
  decodePairingTicket,
  sealPairingPayload,
  openPairingPayload,
  type PairingTicket,
} from '../src/identity/pairing.js';
import { offerToPhone, receiveFromDesktop, type PairingStage } from '../src/session/pairing.js';
import { generateSeed, seedToRecoveryCode } from '../src/identity/recovery-code.js';
import { base64UrlEncode, utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import { isProtocolError } from '../src/utils/errors.js';
import { createFakeHub } from './helpers/fake-transport.js';

const stops: Array<() => void> = [];
after(() => stops.forEach((stop) => stop()));

const unreadable = (error: unknown) => isProtocolError(error, 'PAIRING_TICKET_UNREADABLE');

/** Both sides of one exchange, run by hand */
async function exchange(secret = newPairingSecret()) {
  const offer = await pairingKeyPair();
  const phone = await pairingKeyPair();
  const points = { offer: offer.point, phone: phone.point };
  return {
    secret,
    offer: await derivePairingChannel({ secret, privateKey: offer.privateKey, ...points, peer: phone.point }),
    phone: await derivePairingChannel({ secret, privateKey: phone.privateKey, ...points, peer: offer.point }),
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
    const old = base64UrlEncode(
      utf8Encode(JSON.stringify({ v: 1, code: seedToRecoveryCode(generateSeed()), relay: 'wss://r' })),
    );
    const short = base64UrlEncode(utf8Encode(JSON.stringify({ v: 2, secret: 'AAAA', relay: 'wss://r' })));
    for (const bad of ['', 'not-base64!!', old, short]) {
      assert.throws(() => decodePairingTicket(bad), unreadable);
    }
  });
});

describe('the meeting room', () => {
  test('is named after the secret, so every offer meets somewhere new', async () => {
    const secret = newPairingSecret();
    assert.equal(await pairingRoomId(secret), await pairingRoomId(Uint8Array.from(secret)));
    assert.notEqual(await pairingRoomId(newPairingSecret()), await pairingRoomId(newPairingSecret()));
  });
});

describe('the exchange', () => {
  test('both sides get the same key and the same six digits', async () => {
    const both = await exchange();
    assert.match(both.offer.code, /^\d{6}$/);
    assert.equal(both.offer.code, both.phone.code);
    const sealed = await sealPairingPayload(utf8Encode('the account'), both.offer.key);
    assert.equal(utf8Decode(await openPairingPayload(sealed, both.phone.key)), 'the account');
  });

  test('someone without the secret gets a different channel', async () => {
    const offer = await pairingKeyPair();
    const phone = await pairingKeyPair();
    const points = { offer: offer.point, phone: phone.point };
    const real = await derivePairingChannel({
      secret: newPairingSecret(),
      privateKey: offer.privateKey,
      ...points,
      peer: phone.point,
    });
    const guess = await derivePairingChannel({
      secret: newPairingSecret(),
      privateKey: phone.privateKey,
      ...points,
      peer: offer.point,
    });
    const sealed = await sealPairingPayload(utf8Encode('the account'), real.key);
    await assert.rejects(() => openPairingPayload(sealed, guess.key), unreadable);
  });

  test('a handover from one exchange opens in no other, even with the same secret', async () => {
    const first = await exchange();
    const second = await exchange(first.secret);
    const sealed = await sealPairingPayload(utf8Encode('the account'), first.offer.key);
    await assert.rejects(() => openPairingPayload(sealed, second.phone.key), unreadable);
  });

  test('a key that is not a P-256 point is refused', async () => {
    const offer = await pairingKeyPair();
    const junk = new Uint8Array(65).fill(4);
    await assert.rejects(
      () =>
        derivePairingChannel({
          secret: newPairingSecret(),
          privateKey: offer.privateKey,
          offer: offer.point,
          phone: junk,
          peer: junk,
        }),
      unreadable,
    );
  });

  test('a truncated payload is refused rather than misread', async () => {
    const { offer } = await exchange();
    await assert.rejects(() => openPairingPayload(new Uint8Array(4), offer.key), unreadable);
  });

  test('the commitment is a hash of the point', async () => {
    const { point } = await pairingKeyPair();
    assert.equal(await pairingCommitment(point), await pairingCommitment(Uint8Array.from(point)));
    assert.notEqual(await pairingCommitment(point), await pairingCommitment((await pairingKeyPair()).point));
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
