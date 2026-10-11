/**
 * Connecting a program by code (`weave connect wv_…`): the channel both sides
 * run, and what the relay, someone who learns the code later, or a second
 * program with the same code can do with it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { channelKeyPair, channelRoom, CODE_CHANNEL, deriveChannel } from '../src/identity/channel.js';
import { parseUCAN } from '../src/identity/ucan.js';
import { checkGrant, type Grant } from '../src/session/connect.js';
import {
  connectWithCode,
  newConnectCode,
  offerConnectCode,
  readConnectCode,
  type ConnectCodeStage,
} from '../src/session/connect-code.js';
import { base64UrlDecode, utf8Encode } from '../src/utils/encoding.js';
import { isObject } from '../src/utils/guards.js';
import type { PeerTransport } from '../src/network/transport.js';
import type { NetworkMessage } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { until } from './helpers/until.js';
import { open, person, type Person } from './helpers/person.js';

/** Both sides of one code channel, run by hand */
async function exchange() {
  const secret = readConnectCode(newConnectCode());
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
async function programKey(who: Person): Promise<string> {
  const provider = who.manager.getProvider();
  const keys = await provider.generateKeyPair();
  return publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
}

/** An offer whose person allows the first program that asks, with `grant` */
async function allowing(
  network: ReturnType<typeof room>['network'],
  grant: (asking: Extract<ConnectCodeStage, { kind: 'asking' }>) => Promise<Grant>,
) {
  const stages: ConnectCodeStage[] = [];
  const offer = await offerConnectCode(network, (stage) => {
    stages.push(stage);
    if (stage.kind === 'asking') void grant(stage).then((g) => stage.allow(g));
  });
  open.push({ close: async () => offer.stop() });
  return { offer, stages, kinds: () => stages.map((stage) => stage.kind) };
}

describe('the code channel', () => {
  test('the room for a code', async () => {
    // The example in spec 06 §3.
    const room = await channelRoom(
      CODE_CHANNEL,
      readConnectCode('npx weave connect wv_eYV4XGMvhkky6OWpPfqfRQ'),
    );
    assert.equal(room, 'bodq6nylbhebwd57ve5zifkt7gqnltkzfn2dpclw4wlwewc5j66ya');
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

describe('connecting a program by code', () => {
  test('the app asks the person, and the program gets a checked records-only note for its key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const did = await programKey(who);
    const { network } = room(hub);
    const offer = await allowing(network, async (stage) => {
      assert.equal(stage.asking.name, 'Agent on laptop');
      assert.equal(stage.asking.recordsOnly, true);
      return grantFor(who, stage.asking.did);
    });

    // Someone with a different code in the same place gets nowhere.
    await assert.rejects(
      () =>
        connectWithCode({
          code: newConnectCode(),
          did: 'did:key:zStranger',
          proof: 'unchecked here: the home checks it',
          name: 'x',
          recordsOnly: true,
          network,
          findTimeoutMs: 300,
        }),
      /did not answer/,
    );

    const grant = await connectWithCode({
      code: `npx weave connect ${offer.offer.code}`,
      did,
      proof: 'unchecked here: the home checks it',
      name: 'Agent on laptop',
      recordsOnly: true,
      network,
    });
    assert.equal(grant.did, who.me.did);
    assert.equal(parseUCAN(grant.token).payload.aud, did);
    await until(async () => offer.kinds().includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(offer.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a recording of the room, and the code learned later, open nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const did = await programKey(who);
    const { network, seen } = room(hub);
    const offer = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    await connectWithCode({ code: offer.offer.code, did, proof: 'p', name: 'n', recordsOnly: true, network });

    const point = (type: string) => {
      const payload = seen.find((m) => m.type === type)?.payload;
      assert.ok(isObject(payload) && typeof payload.key === 'string', type);
      return base64UrlDecode(payload.key);
    };
    const sealed = (type: string) => seen.find((m) => m.type === type)?.payload;
    // The grant crossed the relay only sealed.
    assert.ok(!JSON.stringify(seen).includes(who.me.did));
    const secret = readConnectCode(offer.offer.code);
    const points = { kind: CODE_CHANNEL, offer: point('code:key'), join: point('code:hello') };
    for (const side of ['offer', 'join'] as const) {
      const eve = await channelKeyPair();
      const guess = await deriveChannel({ secret, privateKey: eve.privateKey, ...points, side });
      assert.equal(await guess.open('code:ask', sealed('code:ask')), null);
      assert.equal(await guess.open('code:answer', sealed('code:answer')), null);
    }
  });

  test('a relay that relabels or repeats messages changes nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const did = await programKey(who);
    const { network } = room(hub, (message, send) => {
      send(message);
      // Each sealed message again, and once more as every other type.
      if (message.type === 'code:hello' || message.type === 'code:key') return;
      send(message);
      for (const type of ['code:ask', 'code:heard', 'code:answer', 'code:done'])
        if (type !== message.type) send({ ...message, type });
    });
    const offer = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    const grant = await connectWithCode({
      code: offer.offer.code,
      did,
      proof: 'p',
      name: 'n',
      recordsOnly: true,
      network,
    });
    assert.equal(parseUCAN(grant.token).payload.aud, did);
    await until(async () => offer.kinds().includes('connected'), 2000, 'the app hearing it worked');
    assert.deepEqual(offer.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a code works for one program: a second with the same code is not answered', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const { network } = room(hub);
    let release = () => {};
    const decided = new Promise<void>((resolve) => (release = resolve));
    const offer = await allowing(network, async (stage) => {
      await decided;
      return grantFor(who, stage.asking.did);
    });
    const first = connectWithCode({
      code: offer.offer.code,
      did: await programKey(who),
      proof: 'p',
      name: 'first',
      recordsOnly: true,
      network,
    });
    await until(async () => offer.kinds().includes('asking'), 2000, 'the first program asking');

    await assert.rejects(
      connectWithCode({
        code: offer.offer.code,
        did: await programKey(who),
        proof: 'p',
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

  test('saying no reaches the program; a note for another key, or for more than records, is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const did = await programKey(who);
    const { network } = room(hub);
    const refusals: unknown[] = [];
    const offer = await offerConnectCode(network, (stage) => {
      if (stage.kind !== 'asking') return;
      void (async () => {
        for (const grant of [
          await grantFor(who, 'did:key:zOther'),
          await grantFor(who, stage.asking.did, '*'),
        ])
          await stage.allow(grant).catch((error: unknown) => refusals.push(error));
        stage.deny('Not today.');
      })();
    });
    open.push({ close: async () => offer.stop() });
    await assert.rejects(
      () => connectWithCode({ code: offer.code, did, proof: 'p', name: 'n', recordsOnly: true, network }),
      /Not today/,
    );
    assert.equal(refusals.length, 2);
    // And should an app send one anyway, the program refuses it too.
    await assert.rejects(
      checkGrant(await grantFor(who, did, '*'), did, { recordsOnly: true }),
      /more than records/,
    );
    assert.throws(() => readConnectCode('wv_short'), /not a connect code/);
  });
});
