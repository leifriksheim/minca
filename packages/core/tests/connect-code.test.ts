/**
 * Connecting a program by code (`weave connect wv_…`): the channel both sides
 * run, and what the relay, someone who learns the code later, a second
 * program with the same code, or someone posing as the app can do with it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import {
  channelKeyPair,
  channelRoom,
  CODE_CHANNEL,
  deriveChannel,
  type Channel,
} from '../src/identity/channel.js';
import { parseUCAN } from '../src/identity/ucan.js';
import { checkGrant, type AppKey, type Grant } from '../src/session/connect.js';
import { bytesField, meetOnChannel } from '../src/session/channel-room.js';
import {
  connectWithCode,
  newConnectCode,
  offerConnectCode,
  readConnectCode,
  type ConnectCodeStage,
} from '../src/session/connect-code.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';
import { isObject } from '../src/utils/guards.js';
import type { PeerTransport } from '../src/network/transport.js';
import type { NetworkMessage } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { until } from './helpers/until.js';
import { open, person, type Person } from './helpers/person.js';

/** Where the app in these tests lives */
const ORIGIN = 'https://app.test';

/** Both sides of one code channel, run by hand */
async function exchange() {
  const { secret } = readConnectCode(await newConnectCode('did:key:zAccount'));
  const offer = await channelKeyPair();
  const join = await channelKeyPair();
  const points = { kind: CODE_CHANNEL, offer: offer.point, join: join.point };
  return {
    secret,
    points,
    app: await deriveChannel({ secret, privateKey: offer.privateKey, ...points, side: 'offer' }),
    program: await deriveChannel({ secret, privateKey: join.privateKey, ...points, side: 'join' }),
  };
}

/** What a relay passes on: every message, as sent */
type Wire = (message: NetworkMessage, send: (message: NetworkMessage) => void) => void;

/** A room on a fake hub that every message crosses through `wire`, and a record of what crossed */
function room(hub: FakeHub, wire: Wire = (message, send) => send(message)) {
  const seen: NetworkMessage[] = [];
  const transport = (did: string): PeerTransport => {
    const inner = hub.transport(did, 'code');
    return {
      ...inner,
      send(peer: string, data: Uint8Array) {
        const message: unknown = JSON.parse(new TextDecoder().decode(data));
        if (!isObject(message) || typeof message.type !== 'string' || typeof message.from !== 'string')
          return inner.send(peer, data);
        const sent = { type: message.type, from: message.from, payload: message.payload };
        seen.push(sent);
        wire(sent, (out) => inner.send(peer, utf8Encode(JSON.stringify(out))));
      },
    };
  };
  return { network: { relays: [], transport }, seen };
}

/** A note from this person's account to `audience`: records only, unless `can` says otherwise */
async function grantFor(who: Person, audience: string, can = 'record/*'): Promise<Grant> {
  const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
    audience,
    capabilities: [{ with: '*', can }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    v: 1,
    did: who.me.did,
    name: 'Ada',
    token: note.encoded,
    access: 'write',
    scope: 'account',
    spaces: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    home: 'https://home.test/connect',
  };
}

/** A program's key */
async function programKey(who: Person): Promise<AppKey> {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  return { keys, did: publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC) };
}

/** An offer whose person allows the first program that asks, with `grant` */
async function allowing(
  network: ReturnType<typeof room>['network'],
  account: string,
  grant: (asking: Extract<ConnectCodeStage, { kind: 'asking' }>) => Promise<Grant>,
) {
  const stages: ConnectCodeStage[] = [];
  const offer = await offerConnectCode({ ...network, account, origin: ORIGIN }, (stage) => {
    stages.push(stage);
    if (stage.kind === 'asking') void grant(stage).then((g) => stage.allow(g));
  });
  open.push({ close: async () => offer.stop() });
  return { offer, stages, kinds: () => stages.map((stage) => stage.kind) };
}

describe('the code channel', () => {
  test('the room for a code', async () => {
    // The example in spec 06 §3.
    const code = readConnectCode('npx weave connect wv_eYV4XGMvhkky6OWpPfqfRaT1uh9z7enO');
    assert.equal(base64UrlEncode(code.secret), 'eYV4XGMvhkky6OWpPfqfRQ');
    const room = await channelRoom(CODE_CHANNEL, code.secret);
    assert.equal(room, 'bodq6nylbhebwd57ve5zifkt7gqnltkzfn2dpclw4wlwewc5j66ya');
    // The account it names: the start of its fingerprint.
    assert.equal(Buffer.from(code.account).toString('hex'), 'a4f5ba1f73ede9ce');
    const made = readConnectCode(
      await newConnectCode('did:key:zDnaeyrPwbZxpDVLsnvAvAEGYazWB2ZrM7QL4Qb1JPzfiYpKy'),
    );
    assert.equal(Buffer.from(made.account).toString('hex'), 'a4f5ba1f73ede9ce');
  });

  test('a message sent back to the side that sealed it does not open there', async () => {
    const both = await exchange();
    const ask = await both.program.seal('code:ask', utf8Encode('{}'));
    assert.equal(await both.program.open('code:heard', ask), null);
    assert.equal(await both.program.open('code:ask', ask), null);
    assert.ok(await both.app.open('code:ask', ask));
  });

  test('a message relabelled as another type, or replayed, does not open', async () => {
    const both = await exchange();
    const heard = await both.app.seal('code:heard', utf8Encode('{}'));
    const answer = await both.app.seal('code:answer', utf8Encode('{"denied":"no"}'));
    assert.equal(await both.program.open('code:answer', heard), null);
    assert.ok(await both.program.open('code:heard', heard));
    assert.equal(await both.program.open('code:heard', heard), null, 'the same one twice');
    assert.ok(await both.program.open('code:answer', answer));
  });

  test('the code alone does not open a recorded exchange', async () => {
    const both = await exchange();
    const sealed = await both.app.seal('code:answer', utf8Encode('{"grant":"…"}'));
    for (const side of ['offer', 'join'] as const) {
      const eve = await channelKeyPair();
      const guess = await deriveChannel({
        secret: both.secret,
        privateKey: eve.privateKey,
        ...both.points,
        side,
      });
      assert.equal(await guess.open('code:answer', sealed), null);
    }
  });
});

/**
 * Someone else who holds the code, posing as the app: answers the first
 * program to say hello, tells it `origin`, and hands it `grant`.
 */
async function impostor(
  code: string,
  network: ReturnType<typeof room>['network'],
  grant: (did: string) => Promise<Grant>,
) {
  const { secret } = readConnectCode(code);
  const meeting = await meetOnChannel(CODE_CHANNEL, network, secret);
  const mine = await channelKeyPair();
  let channel: Channel | null = null;
  const asks: unknown[] = [];
  const handle = async (message: NetworkMessage) => {
    if (message.type === 'code:hello' && !channel) {
      const join = bytesField(message, 'key');
      if (!join) return;
      channel = await deriveChannel({
        kind: CODE_CHANNEL,
        secret,
        privateKey: mine.privateKey,
        offer: mine.point,
        join,
        side: 'offer',
      });
      meeting.send(message.from, 'code:key', { key: base64UrlEncode(mine.point) });
      await meeting.seal(message.from, 'code:app', channel, { origin: 'https://impostor.test' });
    } else if (message.type === 'code:ask' && channel) {
      const ask = await meeting.open(message, channel);
      if (!isObject(ask) || typeof ask.did !== 'string') return;
      asks.push(ask);
      await meeting.seal(message.from, 'code:heard', channel, {});
      await meeting.seal(message.from, 'code:answer', channel, { grant: await grant(ask.did) });
    }
  };
  let handling: Promise<void> = Promise.resolve();
  meeting.net.on('message', (message: NetworkMessage) => {
    handling = handling.then(() => handle(message)).catch(() => {});
  });
  await meeting.net.connect();
  open.push({ close: async () => meeting.net.disconnect() });
  return { asks };
}

describe('connecting a program by code', () => {
  test('the app asks the person, and the program gets a checked records-only note for its key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    const offer = await allowing(network, who.me.did, async (stage) => {
      assert.equal(stage.asking.name, 'Agent on laptop');
      assert.equal(stage.asking.recordsOnly, true);
      return grantFor(who, stage.asking.did);
    });

    // Someone with a different code in the same place gets nowhere.
    await assert.rejects(
      async () =>
        connectWithCode({
          code: await newConnectCode(who.me.did),
          key,
          name: 'x',
          recordsOnly: true,
          network,
          findTimeoutMs: 300,
        }),
      /did not answer/,
    );

    let found = '';
    const grant = await connectWithCode({
      code: `npx weave connect ${offer.offer.code}`,
      key,
      name: 'Agent on laptop',
      recordsOnly: true,
      network,
      onWaiting: ({ origin }) => (found = origin),
    });
    assert.equal(found, ORIGIN, 'the program learns where the app lives');
    assert.equal(grant.did, who.me.did);
    assert.equal(parseUCAN(grant.token).payload.aud, key.did);
    await until(async () => offer.kinds().includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(offer.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a recording of the room, and the code learned later, open nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network, seen } = room(hub);
    const offer = await allowing(network, who.me.did, async (stage) => grantFor(who, stage.asking.did));
    await connectWithCode({ code: offer.offer.code, key, name: 'n', recordsOnly: true, network });

    const point = (type: string) => {
      const payload = seen.find((m) => m.type === type)?.payload;
      assert.ok(isObject(payload) && typeof payload.key === 'string', type);
      return base64UrlDecode(payload.key);
    };
    const sealed = (type: string) => seen.find((m) => m.type === type)?.payload;
    // The grant and the app's origin crossed the relay only sealed.
    assert.ok(!JSON.stringify(seen).includes(who.me.did));
    assert.ok(!JSON.stringify(seen).includes(ORIGIN));
    const { secret } = readConnectCode(offer.offer.code);
    const points = { kind: CODE_CHANNEL, offer: point('code:key'), join: point('code:hello') };
    for (const side of ['offer', 'join'] as const) {
      const eve = await channelKeyPair();
      const guess = await deriveChannel({ secret, privateKey: eve.privateKey, ...points, side });
      assert.equal(await guess.open('code:app', sealed('code:app')), null);
      assert.equal(await guess.open('code:ask', sealed('code:ask')), null);
      assert.equal(await guess.open('code:answer', sealed('code:answer')), null);
    }
  });

  test('a relay that relabels or repeats messages changes nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub, (message, send) => {
      send(message);
      // Each sealed message again, and once more as every other type.
      if (message.type === 'code:hello' || message.type === 'code:key') return;
      send(message);
      for (const type of ['code:app', 'code:ask', 'code:heard', 'code:answer', 'code:done'])
        if (type !== message.type) send({ ...message, type });
    });
    const offer = await allowing(network, who.me.did, async (stage) => grantFor(who, stage.asking.did));
    const grant = await connectWithCode({
      code: offer.offer.code,
      key,
      name: 'n',
      recordsOnly: true,
      network,
    });
    assert.equal(parseUCAN(grant.token).payload.aud, key.did);
    await until(async () => offer.kinds().includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(offer.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a code works for one program: a second with the same code is not answered', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const { network } = room(hub);
    let release = () => {};
    const decided = new Promise<void>((resolve) => (release = resolve));
    const offer = await allowing(network, who.me.did, async (stage) => {
      await decided;
      return grantFor(who, stage.asking.did);
    });
    const first = connectWithCode({
      code: offer.offer.code,
      key: await programKey(who),
      name: 'first',
      recordsOnly: true,
      network,
    });
    await until(async () => offer.kinds().includes('asking'), 2000, 'the first program asking');

    await assert.rejects(
      connectWithCode({
        code: offer.offer.code,
        key: await programKey(who),
        name: 'second',
        recordsOnly: true,
        network,
        findTimeoutMs: 300,
      }),
      /did not answer/,
    );
    release();
    await first;
    assert.equal(offer.kinds().filter((kind) => kind === 'asking').length, 1);
  });

  test('saying no reaches the program; a note for another key, account, or for more than records, is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const eve = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    const refusals: unknown[] = [];
    const offer = await offerConnectCode({ ...network, account: who.me.did, origin: ORIGIN }, (stage) => {
      if (stage.kind !== 'asking') return;
      void (async () => {
        for (const grant of [
          await grantFor(who, 'did:key:zOther'),
          await grantFor(who, stage.asking.did, '*'),
          await grantFor(eve, stage.asking.did),
        ])
          await stage.allow(grant).catch((error: unknown) => refusals.push(error));
        stage.deny('Not today.');
      })();
    });
    open.push({ close: async () => offer.stop() });
    await assert.rejects(
      () => connectWithCode({ code: offer.code, key, name: 'n', recordsOnly: true, network }),
      /Not today/,
    );
    assert.equal(refusals.length, 3);
    // And should an app send one anyway, the program refuses it too.
    await assert.rejects(
      checkGrant(await grantFor(who, key.did, '*'), key.did, { recordsOnly: true }),
      /more than records/,
    );
    assert.throws(() => readConnectCode('wv_short'), /not a connect code/);
    // A code from before it named the account.
    assert.throws(() => readConnectCode('wv_eYV4XGMvhkky6OWpPfqfRQ'), /not a connect code/);
  });

  test('someone else holding the code who answers first, with a note from their own account, is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const eve = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    // The code on Ada's screen names her account; Eve copied it, and answers before Ada's app does.
    const code = await newConnectCode(who.me.did);
    const posing = await impostor(code, network, (did) => grantFor(eve, did));
    await assert.rejects(
      () => connectWithCode({ code, key, name: 'n', recordsOnly: true, network }),
      /different account than the code names/,
    );
    assert.equal(posing.asks.length, 1, 'it did ask her, and refused what came back');
  });
});
