/**
 * Connecting a program by code (`minca connect`, which opens the account home
 * at `/connect#mc_…`): the channel both sides run, and what the relay,
 * someone who learns the code later, a second program with the same code, or
 * someone posing as the home can do with it.
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
import { checkGrant, type AppKey, type Grant } from '../src/session/connect.js';
import { bytesField, meetOnChannel } from '../src/session/channel-room.js';
import {
  answerConnectCode,
  connectCodeIn,
  connectCodeUrl,
  connectWithCode,
  newConnectCode,
  readConnectCode,
  type ConnectCodeStage,
} from '../src/session/connect-code.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';
import { isObject } from '../src/utils/guards.js';
import { sha256 } from '../src/utils/hash.js';
import type { PeerTransport } from '../src/network/transport.js';
import type { NetworkMessage } from '../src/types.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { until } from './helpers/until.js';
import { open, person, type Person } from './helpers/person.js';

/** Where the home in these tests lives */
const ORIGIN = 'https://home.test';

/** Both sides of one code channel, run by hand */
async function exchange() {
  const secret = readConnectCode(newConnectCode());
  const offer = await channelKeyPair();
  const join = await channelKeyPair();
  const points = { kind: CODE_CHANNEL, offer: offer.point, join: join.point };
  return {
    secret,
    points,
    home: await deriveChannel({ secret, privateKey: offer.privateKey, ...points, side: 'offer' }),
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

/** A note from this person's account to `audience`: records only, unless `command` says otherwise */
async function grantFor(who: Person, audience: string, command = '/record'): Promise<Grant> {
  const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
    audience,
    command,
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  return {
    v: 2,
    did: who.me.did,
    name: 'Ada',
    note,
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

/** A home opened at a new code, whose person allows the first program that asks, with `grant` */
async function allowing(
  network: ReturnType<typeof room>['network'],
  grant: (asking: Extract<ConnectCodeStage, { kind: 'asking' }>) => Promise<Grant>,
) {
  const code = newConnectCode();
  const stages: ConnectCodeStage[] = [];
  const answering = await answerConnectCode({ ...network, code, origin: ORIGIN }, (stage) => {
    stages.push(stage);
    if (stage.kind === 'asking') void grant(stage).then((g) => stage.allow(g));
  });
  open.push({ close: async () => answering.stop() });
  /** The person reading the home's code and typing it into the program */
  const typed = async (matches: (typed: string) => boolean) => {
    await until(async () => stages.some((stage) => stage.kind === 'asking'), 2000, 'the home showing a code');
    const asking = stages.find((stage) => stage.kind === 'asking');
    assert.ok(asking?.kind === 'asking' && matches(`${asking.check.slice(0, 3)} ${asking.check.slice(3)}`));
  };
  return { code, stages, typed, kinds: () => stages.map((stage) => stage.kind) };
}

describe('the code channel', () => {
  test('the room for a code, and the link that carries it', async () => {
    // The example in spec 06 §3.
    const url = connectCodeUrl('https://home.minca.social', 'mc_eYV4XGMvhkky6OWpPfqfRQ');
    assert.equal(url, 'https://home.minca.social/connect#mc_eYV4XGMvhkky6OWpPfqfRQ');
    assert.equal(connectCodeIn(new URL(url).hash), 'mc_eYV4XGMvhkky6OWpPfqfRQ');
    assert.equal(connectCodeIn('#mc_short'), null);
    const secret = readConnectCode(url);
    assert.equal(base64UrlEncode(secret), 'eYV4XGMvhkky6OWpPfqfRQ');
    const room = await channelRoom(CODE_CHANNEL, secret);
    assert.equal(room, 'bihn55ne2az53tlealtmk3ervpyk6xa6364ii25ogc7xv54zkjszq');
    assert.equal(readConnectCode(newConnectCode()).length, 16);
  });

  test('a message sent back to the side that sealed it does not open there', async () => {
    const both = await exchange();
    const ask = await both.program.seal('code:ask', utf8Encode('{}'));
    assert.equal(await both.program.open('code:heard', ask), null);
    assert.equal(await both.program.open('code:ask', ask), null);
    assert.ok(await both.home.open('code:ask', ask));
  });

  test('a message relabelled as another type, or replayed, does not open', async () => {
    const both = await exchange();
    const heard = await both.home.seal('code:heard', utf8Encode('{}'));
    const answer = await both.home.seal('code:answer', utf8Encode('{"denied":"no"}'));
    assert.equal(await both.program.open('code:answer', heard), null);
    assert.ok(await both.program.open('code:heard', heard));
    assert.equal(await both.program.open('code:heard', heard), null, 'the same one twice');
    assert.ok(await both.program.open('code:answer', answer));
  });

  test('the code alone does not open a recorded exchange', async () => {
    const both = await exchange();
    const sealed = await both.home.seal('code:answer', utf8Encode('{"grant":"…"}'));
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
 * Someone else who holds the code, posing as the home: answers the first
 * program to say hello, tells it `origin`, and hands it `grant`.
 */
async function impostor(
  code: string,
  network: ReturnType<typeof room>['network'],
  grant: (did: string) => Promise<Grant>,
  origin = 'https://impostor.test',
) {
  const secret = readConnectCode(code);
  const meeting = await meetOnChannel(CODE_CHANNEL, network, secret);
  const mine = await channelKeyPair();
  let channel: Channel | null = null;
  const asks: unknown[] = [];
  const handle = async (message: NetworkMessage) => {
    if (message.type === 'code:hello' && !channel) {
      meeting.send(message.from, 'code:key', { key: base64UrlEncode(mine.point) });
    } else if (message.type === 'code:point' && !channel) {
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
      await meeting.seal(message.from, 'code:home', channel, { origin });
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
  test('a home opened at a link nobody waits on any more says so', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { network } = room(hub);
    const stages: ConnectCodeStage[] = [];
    const answering = await answerConnectCode(
      { ...network, code: newConnectCode(), origin: ORIGIN, findTimeoutMs: 200 },
      (stage) => stages.push(stage),
    );
    open.push({ close: async () => answering.stop() });
    await until(async () => stages.some((stage) => stage.kind === 'failed'), 2000, 'the home giving up');
  });

  test('the home asks the person, and the program gets a checked records-only note for its key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    const home = await allowing(network, async (stage) => {
      assert.equal(stage.asking.name, 'Agent on laptop');
      return grantFor(who, stage.asking.did);
    });

    // A program with a different code gets nowhere (on a hub of its own: the fake hub puts every
    // code's peers in one room, and the home would take it as its one exchange).
    await assert.rejects(
      connectWithCode({
        home: ORIGIN,
        code: newConnectCode(),
        check: async () => {},
        key,
        name: 'x',
        network: room(createFakeHub({ latencyMs: 1 })).network,
        findTimeoutMs: 300,
      }),
      /not opened in time/,
    );

    let found = '';
    const grant = await connectWithCode({
      home: ORIGIN,
      code: home.code,
      check: home.typed,
      key,
      name: 'Agent on laptop',
      network,
      onWaiting: ({ origin }) => (found = origin),
    });
    assert.equal(found, ORIGIN, 'the program learns where the home lives');
    assert.equal(grant.did, who.me.did);
    assert.equal(grant.note.payload.aud, key.did);
    await until(async () => home.kinds().includes('connected'), 2000, 'the home hearing it worked');
    assert.deepEqual(home.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a recording of the room, and the code learned later, open nothing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network, seen } = room(hub);
    const home = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    await connectWithCode({ home: ORIGIN, code: home.code, check: home.typed, key, name: 'n', network });

    const point = (type: string) => {
      const payload = seen.find((m) => m.type === type)?.payload;
      assert.ok(isObject(payload) && typeof payload.key === 'string', type);
      return base64UrlDecode(payload.key);
    };
    const sealed = (type: string) => seen.find((m) => m.type === type)?.payload;
    // The grant and the home's origin crossed the relay only sealed.
    assert.ok(!JSON.stringify(seen).includes(who.me.did));
    assert.ok(!JSON.stringify(seen).includes(ORIGIN));
    const secret = readConnectCode(home.code);
    const points = { kind: CODE_CHANNEL, offer: point('code:key'), join: point('code:point') };
    for (const side of ['offer', 'join'] as const) {
      const eve = await channelKeyPair();
      const guess = await deriveChannel({ secret, privateKey: eve.privateKey, ...points, side });
      assert.equal(await guess.open('code:home', sealed('code:home')), null);
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
      if (['code:hello', 'code:key', 'code:point'].includes(message.type)) return;
      send(message);
      for (const type of ['code:home', 'code:ask', 'code:heard', 'code:answer', 'code:done'])
        if (type !== message.type) send({ ...message, type });
    });
    const home = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    const grant = await connectWithCode({
      home: ORIGIN,
      code: home.code,
      check: home.typed,
      key,
      name: 'n',
      network,
    });
    assert.equal(grant.note.payload.aud, key.did);
    await until(async () => home.kinds().includes('connected'), 2000, 'the home hearing it worked');
    assert.deepEqual(home.kinds(), ['waiting', 'asking', 'connected']);
  });

  test('a code works for one program: a second with the same code is not answered', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const { network } = room(hub);
    let release = () => {};
    const decided = new Promise<void>((resolve) => (release = resolve));
    const home = await allowing(network, async (stage) => {
      await decided;
      return grantFor(who, stage.asking.did);
    });
    const first = connectWithCode({
      home: ORIGIN,
      code: home.code,
      check: home.typed,
      key: await programKey(who),
      name: 'first',
      network,
    });
    await until(async () => home.kinds().includes('asking'), 2000, 'the first program asking');

    await assert.rejects(
      connectWithCode({
        home: ORIGIN,
        code: home.code,
        check: home.typed,
        key: await programKey(who),
        name: 'second',
        network,
        findTimeoutMs: 300,
      }),
      /not opened in time/,
    );
    release();
    await first;
    assert.equal(home.kinds().filter((kind) => kind === 'asking').length, 1);
  });

  test('saying no reaches the program; a note for another key, or for more than records, is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    const refusals: unknown[] = [];
    const code = newConnectCode();
    const answering = await answerConnectCode({ ...network, code, origin: ORIGIN }, (stage) => {
      if (stage.kind !== 'asking') return;
      void (async () => {
        for (const grant of [
          await grantFor(who, 'did:key:zOther'),
          await grantFor(who, stage.asking.did, '/'),
        ])
          await stage.allow(grant).catch((error: unknown) => refusals.push(error));
        stage.deny('Not today.');
      })();
    });
    open.push({ close: async () => answering.stop() });
    await assert.rejects(
      () => connectWithCode({ home: ORIGIN, code, check: async () => {}, key, name: 'n', network }),
      /Not today/,
    );
    assert.equal(refusals.length, 2);
    // And should a home send one anyway, the program refuses it too.
    await assert.rejects(
      checkGrant(await grantFor(who, key.did, '/'), key.did, { recordsOnly: true }),
      /more than records/,
    );
    assert.throws(() => readConnectCode('mc_short'), /not a connect code/);
    // A code from before the program made them, which named the account.
    assert.throws(() => readConnectCode('mc_eYV4XGMvhkky6OWpPfqfRTkMD-CZuZbG'), /not a connect code/);
  });

  test('the program asks only the home it opened, and keeps that home, whatever the answer names', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const eve = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    // Eve saw the link, and answers as a home of her own: the program never asks her.
    const code = newConnectCode();
    const elsewhere = await impostor(code, network, (did) => grantFor(eve, did));
    await assert.rejects(
      connectWithCode({
        home: ORIGIN,
        code,
        check: async () => {},
        key,
        name: 'n',
        network,
        findTimeoutMs: 300,
      }),
      /not opened in time/,
    );
    assert.equal(elsewhere.asks.length, 0);

    // Saying she is Ada's home, she can hand it a note from her own account; but Ada never sees
    // a code at her own home, so she gives the program none, and it keeps nothing.
    // In a room of its own: the fake hub puts every code's peers in one.
    const second = room(createFakeHub({ latencyMs: 1 })).network;
    const again = newConnectCode();
    const posing = await impostor(
      again,
      second,
      async (did) => ({
        ...(await grantFor(eve, did)),
        home: 'https://evil.test/connect',
      }),
      ORIGIN,
    );
    await assert.rejects(
      connectWithCode({
        home: ORIGIN,
        code: again,
        check: () => new Promise(() => {}),
        key,
        name: 'n',
        network: second,
        decideTimeoutMs: 300,
      }),
      /Nobody answered/,
    );
    assert.equal(posing.asks.length, 1, 'it did ask her, and kept nothing');
  });

  test('the program keeps its note only once the person gives the code the home shows; a point that breaks its commitment is ignored', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const key = await programKey(who);
    const { network } = room(hub);
    const home = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    const tried: boolean[] = [];
    const grant = await connectWithCode({
      home: ORIGIN,
      code: home.code,
      key,
      name: 'n',
      network,
      check: async (matches) => {
        await until(async () => home.kinds().includes('asking'), 2000, 'the home showing a code');
        const asking = home.stages.find((stage) => stage.kind === 'asking');
        assert.ok(asking?.kind === 'asking');
        const wrong = String((Number(asking.check) + 1) % 1_000_000).padStart(6, '0');
        tried.push(matches(wrong), matches(asking.check));
      },
    });
    assert.deepEqual(tried, [false, true]);
    assert.equal(grant.note.payload.aud, key.did);

    // A peer whose point isn't the one it committed to gets no exchange.
    const other = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    const meeting = await meetOnChannel(CODE_CHANNEL, network, readConnectCode(other.code));
    const mine = await channelKeyPair();
    const decoy = await channelKeyPair();
    const said: string[] = [];
    meeting.net.on('message', (message: NetworkMessage) => {
      said.push(message.type);
      if (message.type === 'code:key')
        meeting.send(message.from, 'code:point', { key: base64UrlEncode(decoy.point) });
    });
    const commit = base64UrlEncode(await sha256(mine.point));
    meeting.net.on('peer-connected', (peer: { did: string }) =>
      meeting.send(peer.did, 'code:hello', { commit }),
    );
    await meeting.net.connect();
    open.push({ close: async () => meeting.net.disconnect() });
    await until(async () => said.includes('code:key'), 2000, 'the home answering the hello');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!said.includes('code:home'), 'no exchange for a point it did not commit to');
  });

  test('each side runs one exchange, with keys made for it: a second peer gets nothing to compare', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const who = await person(hub);
    const { network } = room(hub);
    // The fake hub puts every code's peers in one room: the program meets its listeners in another.
    const apart = room(createFakeHub({ latencyMs: 1 })).network;
    /** A peer that only listens, saying hello with a commitment when it meets someone, as a program would */
    async function listener(code: string, hello = true, where = network) {
      const meeting = await meetOnChannel(CODE_CHANNEL, where, readConnectCode(code));
      const heard: NetworkMessage[] = [];
      const mine = await channelKeyPair();
      const commit = base64UrlEncode(await sha256(mine.point));
      meeting.net.on('message', (message: NetworkMessage) => {
        heard.push(message);
        // As a home would: a key for whoever said hello.
        if (!hello && message.type === 'code:hello')
          meeting.send(message.from, 'code:key', { key: base64UrlEncode(mine.point) });
      });
      meeting.net.on('peer-connected', (peer: { did: string }) => {
        if (hello) meeting.send(peer.did, 'code:hello', { commit });
      });
      await meeting.net.connect();
      open.push({ close: async () => meeting.net.disconnect() });
      return heard;
    }
    const has = (heard: NetworkMessage[], type: string) => heard.some((message) => message.type === type);

    // Two peers say hello to one home: only the first gets a key.
    const home = await allowing(network, async (stage) => grantFor(who, stage.asking.did));
    const [a, b] = [await listener(home.code), await listener(home.code)];
    await until(async () => has(a, 'code:key') || has(b, 'code:key'), 2000, 'a key');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal([a, b].filter((heard) => has(heard, 'code:key')).length, 1);

    // A program meeting two homes commits to a different point with each, and goes on with one.
    const code = newConnectCode();
    const [c, d] = [await listener(code, false, apart), await listener(code, false, apart)];
    void connectWithCode({
      home: ORIGIN,
      code,
      check: async () => {},
      key: await programKey(who),
      name: 'n',
      network: apart,
      findTimeoutMs: 1000,
    }).catch(() => {});
    const commitOf = (heard: NetworkMessage[]) => {
      const payload = heard.find((message) => message.type === 'code:hello')?.payload;
      return isObject(payload) ? payload.commit : undefined;
    };
    await until(async () => !!commitOf(c) && !!commitOf(d), 2000, 'both commitments');
    assert.notEqual(commitOf(c), commitOf(d));
    await until(async () => has(c, 'code:point') || has(d, 'code:point'), 2000, 'a point');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal([c, d].filter((heard) => has(heard, 'code:point')).length, 1);
  });
});
