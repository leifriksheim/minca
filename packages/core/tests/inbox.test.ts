/**
 * The inbox (`node.inbox`, `src/inbox/`): a code that says where to knock and
 * nothing about who you are, signed by its own key; a relay mailbox that
 * holds sealed knocks, learns nothing from them, can't be filled by one
 * address, and lets only the inbox's owner clear it; knocks that prove who
 * knocked, with authority to, when; and two people who shared no space
 * becoming contacts through one.
 */
import { team } from '../src/space/presets.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import * as z from 'zod';

import { createRelay, MAX_MESSAGE_BYTES, type MailboxLimits } from '../../relay/relay.mjs';
import { createNode } from '../src/node/node.js';
import type { P2PNode } from '../src/node/types.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import {
  contactPublicKey,
  deriveContactKeyBytes,
  deriveInboxKeyBytes,
  deriveInboxSignKeyBytes,
} from '../src/identity/contact-key.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import type { NoteTerms } from '../src/identity/abilities.js';
import { issueDelegation, type Delegation } from '../src/identity/ucan.js';
import {
  clip,
  encodeInbox,
  inboxTopic,
  knockId,
  openKnock,
  readInbox,
  sealKnock,
  signPurge,
} from '../src/inbox/inbox.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import { decodeLoose, encodeLoose, signLoose } from '../src/records/loose.js';
import { inboxAuthor } from '../src/inbox/inbox.js';
import { signingKeyOf } from '../src/identity/contact-key.js';
import { sealValueTo } from '../src/identity/hpke.js';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';
import { createMailboxClient } from '../src/network/relays.js';
import { grantSigner } from '../src/session/connect.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { portOf } from './helpers/net.js';
import { isRecord } from '../src/utils/guards.js';
import { patience } from './helpers/until.js';
import { open, person as somebody } from './helpers/person.js';

const person = async (hub: FakeHub, name: string, seed?: Uint8Array) =>
  (await somebody(hub, { name, seed, relays: [relayUrl], accountKey: true, contactKey: true })).node;

// ─── Relays, for the mailbox ────────────────────────────────────────

/** A relay on a free port. Tests all come from 127.0.0.1, so the main one allows that address plenty. */
async function startRelay(mailbox: Partial<MailboxLimits> = {}) {
  const relay = createRelay({ mailbox });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${portOf(server)}`,
    close: () => {
      relay.close();
      server.close();
    },
  };
}

let main: Awaited<ReturnType<typeof startRelay>>;
let relayUrl: string;
before(async () => {
  main = await startRelay({ dropsPerNetwork: 10_000 });
  relayUrl = main.url;
});
after(() => main.close());

async function until<T>(
  get: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + patience(ms);
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An inbox's keys, as its owner holds them */
async function someInbox(gen = 0, contactKey?: Uint8Array) {
  const contact = contactKey ?? (await deriveContactKeyBytes(generateSeed()));
  const key = await deriveInboxKeyBytes(contact, gen);
  const sign = await deriveInboxSignKeyBytes(contact, gen);
  const signPublic = contactPublicKey(sign);
  return { key, sign, publicKey: contactPublicKey(key), signPublic, topic: await inboxTopic(signPublic) };
}

const provider = createP256Provider();

// ─── Codes ──────────────────────────────────────────────────────────

describe('an inbox code', () => {
  test('carries two keys, its gen, 1–3 mailboxes and a name, and reads back from a bare code or a link', async () => {
    const { sign, publicKey: key, signPublic } = await someInbox();
    const body = {
      key,
      sign: signPublic,
      gen: 0,
      places: ['wss://a.example', 'wss://b.example'],
      name: 'Anna',
    };
    const code = await encodeInbox(sign, body, provider);
    assert.deepEqual(await readInbox(code, provider), body);
    assert.equal((await readInbox(`https://chat.example/#inbox=${code}`, provider)).key, key);
    assert.equal((await readInbox(`  ${code}\n`, provider)).key, key);
  });

  test('refuses what could not be knocked on', async () => {
    const { sign, publicKey: key, signPublic } = await someInbox();
    const body = { key, sign: signPublic, gen: 0, places: ['wss://a.example'] };
    await assert.rejects(encodeInbox(sign, { ...body, places: [] }, provider), /1–3 mailboxes/);
    await assert.rejects(
      encodeInbox(sign, { ...body, places: ['wss://a', 'wss://b', 'wss://c', 'wss://d'] }, provider),
      /1–3 mailboxes/,
    );
    await assert.rejects(
      encodeInbox(sign, { ...body, places: ['ws://relay.example'] }, provider),
      /not a wss/,
    );
    await assert.rejects(encodeInbox(sign, { ...body, key: 'not-a-point' }, provider), /P-256/);
    await assert.rejects(encodeInbox(sign, { ...body, sign: key }, provider), /signing key/);
    await assert.rejects(readInbox('hello', provider), /not an inbox code/);
  });

  test('is signed by its own signing key: one signed by another key, or edited, is refused', async () => {
    const { sign, publicKey: key, signPublic } = await someInbox();
    const other = await someInbox();
    const body = { key, sign: signPublic, gen: 0, places: ['wss://a.example'] };
    // Signed with another inbox's key, as someone handing out a code for an inbox not theirs would.
    await assert.rejects(encodeInbox(other.sign, body, provider), /its own signing key/);
    const forged = encodeLoose(
      await signLoose(
        { did: inboxAuthor(other.signPublic), key: await signingKeyOf(other.sign) },
        'sys.inbox',
        body,
        provider,
      ),
    );
    await assert.rejects(readInbox(forged, provider), /not signed by its own key/);
    // The right key, and the mailboxes changed after.
    const version = decodeLoose(await encodeInbox(sign, body, provider));
    assert.ok(isRecord(version) && isRecord(version.body));
    const edited = base64UrlEncode(
      utf8Encode(
        JSON.stringify({ ...version, body: { ...version.body, places: ['wss://mallory.example'] } }),
      ),
    );
    await assert.rejects(readInbox(edited, provider), /not signed by its own key/);
  });

  test("says nothing about the account: neither key is the contact key, and each gen's differ", async () => {
    const contactKey = await deriveContactKeyBytes(generateSeed());
    const one = await someInbox(0, contactKey);
    const two = await someInbox(1, contactKey);
    assert.notEqual(one.publicKey, contactPublicKey(contactKey));
    assert.notEqual(one.signPublic, contactPublicKey(contactKey));
    assert.notEqual(one.publicKey, one.signPublic);
    assert.notEqual(one.publicKey, two.publicKey);
    assert.notEqual(one.topic, two.topic);
    // …and the same on every device that holds the contact key.
    assert.equal(one.publicKey, (await someInbox(0, contactKey)).publicKey);
  });

  test('names are cut to length without splitting a character', () => {
    assert.equal(clip('ab😀cd', 3), 'ab😀');
    assert.equal(clip('short', 64), 'short');
  });
});

// ─── The relay's mailbox ────────────────────────────────────────────

describe("the relay's mailbox", () => {
  const mailbox = createMailboxClient();

  test('holds a blob under a topic for whoever fetches it, once however often it is dropped', async () => {
    const { topic } = await someInbox();
    const id = await mailbox.drop(relayUrl, topic, 'c2VhbGVk');
    assert.equal(id, await knockId('c2VhbGVk'));
    assert.equal(await mailbox.drop(relayUrl, topic, 'c2VhbGVk'), id);
    const items = await mailbox.fetch(relayUrl, topic);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.blob, 'c2VhbGVk');
    assert.equal(items[0]!.id, id);
    assert.deepEqual(await mailbox.fetch(relayUrl, topic, items[0]!.seq), []);
  });

  test('a fetch reads every page, so junk dropped first hides no knock after it', async () => {
    const { topic } = await someInbox();
    // Large blobs fill a page with four: 63 of them, and the knock last, fill the topic.
    const own = await startRelay({ dropsPerNetwork: 10_000, dropsPerNetworkPerTopic: 10_000 });
    try {
      for (let i = 0; i < 63; i++)
        await mailbox.drop(own.url, topic, `${i}`.padStart(2, '0').padEnd(12_000, 'A'));
      await mailbox.drop(own.url, topic, 'cmVhbA');
      const items = await mailbox.fetch(own.url, topic);
      assert.equal(items.length, 64);
      assert.equal(items.at(-1)!.blob, 'cmVhbA');
    } finally {
      own.close();
    }
  });

  test('refuses what is not a sealed blob, and topics that are not a hash', async () => {
    const { topic } = await someInbox();
    await assert.rejects(mailbox.drop(relayUrl, topic, 'not base64url!'), /refused/);
    await assert.rejects(mailbox.drop(relayUrl, topic, 'a'.repeat(12_001)), /refused/);
    // A malformed topic gets no answer at all.
    await assert.rejects(
      createMailboxClient({ timeoutMs: 300 }).drop(relayUrl, 'short', 'abc'),
      /did not answer/,
    );
  });

  test('takes only a few knocks on one inbox from one address an hour', async () => {
    const { topic } = await someInbox();
    for (let i = 0; i < 4; i++) await mailbox.drop(relayUrl, topic, `a${i}`);
    await assert.rejects(mailbox.drop(relayUrl, topic, 'a4'), /Too many knocks on this inbox/);
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 4);
  });

  test('takes only so many knocks from one address in all, whatever the topics', async () => {
    const own = await startRelay({ dropsPerNetwork: 5 });
    try {
      for (let i = 0; i < 5; i++) await mailbox.drop(own.url, (await someInbox(i)).topic, `b${i}`);
      await assert.rejects(
        mailbox.drop(own.url, (await someInbox()).topic, 'b6'),
        /Too many knocks from here/,
      );
    } finally {
      own.close();
    }
  });

  test('when full, still takes a knock or two on an inbox that holds fewer', async () => {
    const own = await startRelay({ maxChars: 100, reserveChars: 100 });
    try {
      const busy = (await someInbox()).topic;
      const quiet = (await someInbox()).topic;
      const blob = (n: number) => `${n}`.padEnd(40, 'x');
      await mailbox.drop(own.url, busy, blob(1));
      await mailbox.drop(own.url, busy, blob(2));
      await assert.rejects(mailbox.drop(own.url, busy, blob(3)), /mailbox is full/);
      await mailbox.drop(own.url, quiet, blob(4));
    } finally {
      own.close();
    }
  });

  test('lets knocks go when their time is up', async () => {
    const { topic } = await someInbox();
    await mailbox.drop(relayUrl, topic, 'ZXhwaXJlcw', 1);
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await mailbox.fetch(relayUrl, topic)).length, 0);
  });

  test('tells a watcher about a knock as it arrives', async () => {
    const { topic } = await someInbox();
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    const heard: string[] = [];
    const Mail = z.object({ type: z.literal('mail'), items: z.array(z.object({ blob: z.string() })) });
    ws.onmessage = (event) => {
      const mail = Mail.safeParse(JSON.parse(String(event.data)));
      if (mail.success) heard.push(...mail.data.items.map((item) => item.blob));
    };
    ws.send(JSON.stringify({ type: 'fetch', topic, watch: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mailbox.drop(relayUrl, topic, 'bmV3cw');
    await until(
      async () => heard,
      (h) => h.includes('bmV3cw'),
      'the watcher to hear the knock',
    );
    ws.close();
  });

  test("is cleared only by the inbox's owner: the key that hashes to the topic, signing this socket's challenge", async () => {
    const door = await someInbox();
    const stranger = await someInbox();
    const ids = [
      await mailbox.drop(relayUrl, door.topic, 'b25l'),
      await mailbox.drop(relayUrl, door.topic, 'dHdv'),
      await mailbox.drop(relayUrl, door.topic, 'dGhyZWU'),
    ];

    // Someone else's key, or the right key and a signature over the wrong thing, clear nothing.
    await assert.rejects(
      mailbox.purge(relayUrl, door.topic, stranger.signPublic, null, (nonce) =>
        signPurge(stranger.sign, door.topic, nonce, null),
      ),
      /not this inbox/,
    );
    await assert.rejects(
      mailbox.purge(relayUrl, door.topic, door.signPublic, null, (nonce) =>
        signPurge(door.sign, door.topic, `${nonce}x`, null),
      ),
      /does not check out/,
    );
    assert.equal((await mailbox.fetch(relayUrl, door.topic)).length, 3);

    // One knock, then the rest.
    assert.equal(
      await mailbox.purge(relayUrl, door.topic, door.signPublic, [ids[0]!], (nonce) =>
        signPurge(door.sign, door.topic, nonce, [ids[0]!]),
      ),
      1,
    );
    assert.deepEqual(
      (await mailbox.fetch(relayUrl, door.topic)).map((item) => item.id).sort(),
      [ids[1]!, ids[2]!].sort(),
    );
    assert.equal(
      await mailbox.purge(relayUrl, door.topic, door.signPublic, null, (nonce) =>
        signPurge(door.sign, door.topic, nonce, null),
      ),
      2,
    );
    assert.deepEqual(await mailbox.fetch(relayUrl, door.topic), []);
  });

  test('a challenge is good for one purge', async () => {
    const door = await someInbox();
    await mailbox.drop(relayUrl, door.topic, 'cmVwbGF5');
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    const answers: unknown[] = [];
    ws.onmessage = (event) => answers.push(JSON.parse(String(event.data)));
    ws.send(JSON.stringify({ type: 'challenge' }));
    const [challenge] = await until(
      async () => answers,
      (a) => a.length === 1,
      'the challenge',
    );
    const { nonce } = z.object({ nonce: z.string() }).parse(challenge);
    const purge = {
      type: 'purge',
      topic: door.topic,
      sign: door.signPublic,
      ids: ['nothing'],
      sig: await signPurge(door.sign, door.topic, nonce, ['nothing']),
    };
    ws.send(JSON.stringify(purge));
    ws.send(JSON.stringify(purge));
    await until(
      async () => answers,
      (a) => a.length === 3,
      'both answers',
    );
    const typeOf = (answer: unknown) => (isRecord(answer) ? answer.type : undefined);
    assert.equal(typeOf(answers[1]), 'purged');
    assert.equal(typeOf(answers[2]), 'refused');
    ws.close();
  });
});

// ─── Knocks ─────────────────────────────────────────────────────────

describe('a knock', () => {
  /** Leif's account, a session under it with a note on these terms, and a space for two he made */
  async function leifWith(hub: FakeHub, terms: NoteTerms = { command: '/' }, expiresIn = 3600) {
    const seed = generateSeed();
    const leif = await person(hub, 'Leif', seed);
    const manager = createIdentityManager();
    const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
    const keys = await provider.generateKeyPair();
    const sessionDid = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const token = await root.delegate({
      audience: sessionDid,
      ...terms,
      expiration: Math.floor(Date.now() / 1000) + expiresIn,
    });
    const pair = await leif.spaces.create({ name: 'Leif & Anna', ...team, visibility: 'private' });
    const invite = await leif.spaces.invite(pair.id, { role: 'editor' });
    return {
      leif,
      invite,
      pair,
      session: { did: sessionDid, key: keys.privateKey, proof: token },
    };
  }

  /** What a knock carries, from an invite string */
  const carrying = (invite: string, name = 'Leif', note?: string) => {
    const parsed = parseSpaceInvite(invite);
    return {
      invite: parsed.signed,
      secret: base64UrlDecode(parsed.invite ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      name,
      ...(note ? { note } : {}),
    };
  };

  test('opens only with its inbox, and only as from the account whose note signed it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { leif, invite, pair, session } = await leifWith(hub);
    const anna = await person(hub, 'Anna');
    const inbox = await someInbox();
    const other = await someInbox();

    const blob = await sealKnock(
      inbox.publicKey,
      carrying(invite, 'Leif', 'hi from the gig'),
      session,
      provider,
    );
    const opened = await openKnock([inbox.key], blob, provider);
    assert.equal(opened?.from, leif.did);
    assert.equal(opened?.name, 'Leif');
    assert.equal(opened?.note, 'hi from the gig');
    assert.equal(opened?.pairSpace, pair.id);

    // Another inbox's key can't open it, and a knock sealed to one key but naming another doesn't count.
    assert.equal(await openKnock([other.key], blob, provider), null);
    // Inviting to a space someone else made, or signed by someone else, doesn't check out.
    const annas = await anna.spaces.create({ name: 'Not Leif’s', ...team, visibility: 'private' });
    const stolen = await sealKnock(
      inbox.publicKey,
      carrying(await anna.spaces.invite(annas.id, { role: 'editor' })),
      session,
      provider,
    );
    assert.equal(await openKnock([inbox.key], stolen, provider), null);
    // Nor to a space he founded with someone else, or one that assigns anyone a role: it is not his alone.
    for (const shared of [
      await leif.spaces.create({ name: 'Ours', ...team, visibility: 'private', cofounders: [anna.did] }),
      await leif.spaces.create({ name: 'Ours', visibility: 'private', ...team, creatorRoles: ['editor'] }),
    ]) {
      const knock = await sealKnock(
        inbox.publicKey,
        carrying(await leif.spaces.invite(shared.id, { role: 'editor' })),
        session,
        provider,
      );
      assert.equal(await openKnock([inbox.key], knock, provider), null);
    }
    // Nor one that only shares the space to view: there is no role to join with.
    const view = await sealKnock(
      inbox.publicKey,
      carrying(await leif.spaces.invite(pair.id, { write: false })),
      session,
      provider,
    );
    assert.equal(await openKnock([inbox.key], view, provider), null);
    // A note the session passes on is no note: alone, it is not from the account…
    const deeper = await provider.generateKeyPair();
    const deeperDid = publicKeyToDid(await provider.exportPublicKey(deeper.publicKey), P256_MULTICODEC);
    const passedOn = await issueDelegation(
      {
        issuer: { did: session.did, privateKey: session.key },
        audience: deeperDid,
        command: '/',
        subject: leif.did,
      },
      provider,
    );
    const leafOnly = await sealKnock(
      inbox.publicKey,
      carrying(invite),
      { did: deeperDid, key: deeper.privateKey, proof: passedOn },
      provider,
    );
    assert.equal(await openKnock([inbox.key], leafOnly, provider), null);
    // …and behind the session's own note, as a chain, it is refused too: a proof is one link.
    const chain = [session.proof, passedOn];
    const relayed = await sealKnock(
      inbox.publicKey,
      carrying(invite),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a chain, which the type rules out, as a peer may send one
      { did: deeperDid, key: deeper.privateKey, proof: chain as unknown as Delegation },
      provider,
    );
    assert.equal(await openKnock([inbox.key], relayed, provider), null);
  });

  test('sealed to one key, naming another, is refused: nobody re-seals a knock as if sent elsewhere', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { invite, session } = await leifWith(hub);
    const inbox = await someInbox();
    const other = await someInbox();
    // Signed for one inbox, sealed by hand to another, as whoever opened it could.
    const { signed, invite: secret } = parseSpaceInvite(invite);
    const version = await signLoose(
      session,
      'sys.knock',
      { invite: signed, secret, name: 'Leif' },
      provider,
      {
        to: inbox.publicKey,
      },
    );
    const resealed = await sealValueTo(other.publicKey, 'minca/mail/v1', { to: other.publicKey }, version);
    assert.equal(await openKnock([other.key], resealed, provider), null);
    const proper = await sealValueTo(inbox.publicKey, 'minca/mail/v1', { to: inbox.publicKey }, version);
    assert.notEqual(await openKnock([inbox.key], proper, provider), null);
  });

  test('needs a note that grants /account/write: an app given one space or several, a key given records only, or one only to read, cannot knock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const inbox = await someInbox();
    for (const terms of [
      { command: '/', subject: 'space:bafyonespace' },
      {
        command: '/',
        policy: [
          [
            'or',
            [
              ['==', '.space', 'bafyone'],
              ['==', '.space', 'bafytwo'],
            ],
          ],
        ],
      },
      { command: '/record' },
      { command: '/record/read' },
    ]) {
      const { invite, session } = await leifWith(hub, terms);
      const blob = await sealKnock(inbox.publicKey, carrying(invite), session, provider);
      assert.equal(await openKnock([inbox.key], blob, provider), null, JSON.stringify(terms));
    }
  });

  test('is judged by when it was signed: within its life and not in the future, its note as it stood then', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const inbox = await someInbox();
    const seed = generateSeed();
    const leif = await person(hub, 'Leif', seed);
    const manager = createIdentityManager();
    const root = createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider());
    const keys = await provider.generateKeyPair();
    const sessionDid = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const pair = await leif.spaces.create({ name: 'Leif & Anna', ...team, visibility: 'private' });
    const invite = await leif.spaces.invite(pair.id, { role: 'editor' });
    /** A knock signed `ago` ms before now (negative: in the future), under a note good for half an hour then */
    const knockFrom = async (ago: number): Promise<string> => {
      const realNow = Date.now;
      Date.now = () => realNow() - ago;
      try {
        const token = await root.delegate({
          audience: sessionDid,
          command: '/',
          expiration: Math.floor(Date.now() / 1000) + 1800,
        });
        return await sealKnock(
          inbox.publicKey,
          carrying(invite),
          { did: sessionDid, key: keys.privateKey, proof: token },
          provider,
        );
      } finally {
        Date.now = realNow;
      }
    };
    // Signed an hour ago, its note long run out since: still a knock, judged when it was signed.
    assert.equal((await openKnock([inbox.key], await knockFrom(3600_000), provider))?.from, leif.did);
    // Older than a knock lives, or dated ahead of any clock's skew, it isn't.
    assert.equal(await openKnock([inbox.key], await knockFrom(15 * 24 * 3600_000), provider), null);
    assert.equal(await openKnock([inbox.key], await knockFrom(-3600_000), provider), null);
  });
});

// ─── Two strangers ──────────────────────────────────────────────────

describe('node.inbox', () => {
  /** Anna's knocks, read until `ok` */
  const annaSees = (anna: P2PNode, ok: (count: number) => boolean, what: string, ms?: number) =>
    until(
      () => anna.inbox.knocks(),
      (knocks) => ok(knocks.length),
      what,
      ms,
    );

  test('two people who share no space become contacts through an inbox code', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');

    assert.equal(await anna.inbox.get(), null);
    const inbox = await anna.inbox.open();
    assert.equal(inbox.name, 'Anna');
    assert.equal(inbox.gen, 0);
    assert.deepEqual(inbox.places, [relayUrl]);
    assert.equal((await readInbox((await anna.inbox.get())!.code, provider)).key, inbox.key);

    // Anna posts the code somewhere; Leif pastes it.
    const { space } = await leif.inbox.knock(`https://chat.example/#inbox=${inbox.code}`, {
      note: 'We met at the gig',
    });
    assert.deepEqual(
      (await leif.inbox.sent()).map((k) => [k.space, k.name]),
      [[space, 'Anna']],
    );

    const [knock] = await annaSees(anna, (n) => n === 1, 'the knock to arrive');
    assert.equal(knock!.from, leif.did);
    assert.equal(knock!.name, 'Leif');
    assert.equal(knock!.note, 'We met at the gig');
    assert.equal(knock!.pairSpace, space);

    const contact = await anna.inbox.accept(knock!.id);
    assert.equal(contact.did, leif.did);
    assert.equal(contact.space, space);
    // Accepted: it is no longer waiting, and it's gone from the relay.
    assert.deepEqual(await anna.inbox.knocks(), []);

    // Leif's side becomes a contact once he sees Anna joined: joining is the answer.
    await leif.spaces.hold(space);
    await anna.spaces.hold(space);
    await until(
      () => leif.inbox.sent(),
      (sent) => sent.length === 0,
      'Leif to see Anna joined',
    );
    const annaForLeif = await leif.contacts.get(anna.did);
    assert.equal(annaForLeif?.space, space);
    assert.equal(annaForLeif?.name, 'Anna');
  });

  test('whoever joins first is the contact; the invite is closed behind them, and nobody joins after', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const annaSeed = generateSeed();
    const anna = await person(hub, 'Anna', annaSeed);
    const leif = await person(hub, 'Leif');
    const dave = await person(hub, 'Dave');
    const inbox = await anna.inbox.open();
    const { space } = await leif.inbox.knock(inbox.code);
    await leif.spaces.hold(space);

    // The invite as it went out: whoever gets hold of it later (from Anna's lost laptop, say) holds it too.
    const keys = await someInbox(0, await deriveContactKeyBytes(annaSeed));
    const [item] = await until(
      () => createMailboxClient().fetch(relayUrl, keys.topic),
      (items) => items.length === 1,
      'the knock',
    );
    const invite = (await openKnock([keys.key], item!.blob, provider))!.invite;

    const [knock] = await annaSees(anna, (n) => n === 1, 'the knock');
    await anna.inbox.accept(knock!.id);
    await anna.spaces.hold(space);
    await until(
      () => leif.inbox.sent(),
      (sent) => sent.length === 0,
      'Leif to settle',
    );
    assert.equal((await leif.contacts.get(anna.did))?.space, space);
    assert.ok(
      (await leif.spaces.access(space)).invites.every((open) => !open.open),
      'the invite is closed',
    );
    // Anyone else it reached is refused now: the space's members don't count them in.
    await dave.spaces.join(invite);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const member of [leif, anna])
      assert.equal(
        (await member.spaces.access(space)).members.some((m) => m.did === dave.did),
        false,
      );
  });

  test('a knock can be dismissed without blocking, and a flooded inbox cleared without closing it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const carol = await person(hub, 'Carol');
    const inbox = await anna.inbox.open();

    await leif.inbox.knock(inbox.code);
    const [first] = await annaSees(anna, (n) => n === 1, 'Leif’s knock');
    await anna.inbox.dismiss(first!.id);
    assert.deepEqual(await anna.inbox.knocks(), []);
    assert.equal(await anna.contacts.get(leif.did), null, 'not blocked, not a contact');

    await carol.inbox.knock(inbox.code);
    await leif.inbox.knock(inbox.code);
    await annaSees(anna, (n) => n === 2, 'two more knocks');
    await anna.inbox.clear();
    assert.deepEqual(await anna.inbox.knocks(), []);
    // Still open: the code everyone has keeps working.
    await carol.inbox.knock(inbox.code);
    await annaSees(anna, (n) => n === 1, 'a knock after clearing');
  });

  test('a replaced inbox reads no more knocks on the old code, and knocks from blocked people stay hidden', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const carol = await person(hub, 'Carol');

    const inbox = await anna.inbox.open();
    await leif.inbox.knock(inbox.code);
    await carol.inbox.knock(inbox.code);
    await annaSees(anna, (n) => n === 2, 'both knocks');

    await anna.contacts.block(carol.did);
    assert.deepEqual(
      (await anna.inbox.knocks()).map((k) => k.from),
      [leif.did],
    );

    const next = await anna.inbox.rotate();
    assert.equal(next.gen, 1);
    assert.notEqual(next.key, inbox.key);
    assert.deepEqual(await anna.inbox.knocks(), []);
    // The old code still reads, but what is left there is never opened.
    await leif.inbox.knock(inbox.code);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await anna.inbox.knocks(), []);
    await leif.inbox.knock(next.code);
    await annaSees(anna, (n) => n === 1, 'a knock on the new inbox');
  });

  test('a knock nobody joins is let go after its time, space and all', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const inbox = await anna.inbox.open();
    const { space } = await leif.inbox.knock(inbox.code);
    assert.equal((await leif.inbox.sent()).length, 1);
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 24 * 3600_000;
    try {
      assert.deepEqual(await leif.inbox.sent(), []);
    } finally {
      Date.now = realNow;
    }
    assert.equal(await leif.spaces.get(space), null);
  });

  test('one mailbox of an inbox being down does not stop a knock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const inbox = await anna.inbox.open({ places: ['ws://127.0.0.1:1', relayUrl] });
    await leif.inbox.knock(inbox.code);
    await annaSees(anna, (n) => n === 1, 'the knock through the working relay', 15_000);
  });

  test("a mailbox that lies about when it took a knock can't hide it while another tells the truth", async () => {
    // A mailbox that keeps what is dropped, and says it took it an hour earlier.
    const held = new Map<string, Array<{ seq: number; id: string; at: number; blob: string }>>();
    const liar = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    liar.on('connection', (ws) =>
      ws.on('message', (raw: Buffer) => {
        const message = z.object({ type: z.string(), topic: z.string(), blob: z.string().optional() });
        const m = message.parse(JSON.parse(raw.toString()));
        const list = held.get(m.topic) ?? [];
        if (m.type === 'drop' && m.blob) {
          const id = createHash('sha256').update(m.blob).digest('base64url');
          list.push({ seq: list.length + 1, id, at: Date.now() - 3_600_000, blob: m.blob });
          held.set(m.topic, list);
          ws.send(JSON.stringify({ type: 'dropped', topic: m.topic, id }));
        }
        if (m.type === 'fetch')
          ws.send(JSON.stringify({ type: 'mail', topic: m.topic, items: list, more: false }));
      }),
    );
    await new Promise<void>((resolve) => liar.on('listening', () => resolve()));
    const address = liar.address();
    const liarUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const hub = createFakeHub({ latencyMs: 1 });
      const anna = await person(hub, 'Anna');
      const leif = await person(hub, 'Leif');
      const inbox = await anna.inbox.open({ places: [liarUrl, relayUrl] });
      await leif.inbox.knock(inbox.code);
      await annaSees(anna, (n) => n === 1, 'the knock, by the honest mailbox');
    } finally {
      liar.close();
    }
  });

  test('a knock fails, and leaves nothing behind, when no mailbox of the inbox takes it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const inbox = await anna.inbox.open({ places: ['ws://127.0.0.1:1'] });
    await assert.rejects(leif.inbox.knock(inbox.code), /None of their inbox's mailboxes took the knock/);
    assert.deepEqual(await leif.inbox.sent(), []);
    assert.deepEqual(await leif.spaces.list(), []);
  });

  test('you cannot knock on your own inbox', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const inbox = await anna.inbox.open();
    await assert.rejects(anna.inbox.knock(inbox.code), /your own inbox/);
  });

  test('every device of the account opens the same inbox', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const seed = generateSeed();
    const phone = await person(hub, 'Anna', seed);
    const laptop = await person(hub, 'Anna', seed);
    const leif = await person(hub, 'Leif');
    const inbox = await phone.inbox.open();
    await leif.inbox.knock(inbox.code);
    const [onLaptop] = await annaSees(
      laptop,
      (n) => n === 1,
      'the laptop to see the inbox and its knock',
      10_000,
    );
    assert.equal(onLaptop!.from, leif.did);
    assert.equal((await laptop.inbox.get())?.key, inbox.key);
  });

  test("a key given records only has no inbox and can't knock, even when it was given the contact key", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const seed = generateSeed();
    const anna = await person(hub, 'Anna');
    const inbox = await anna.inbox.open();

    const manager = createIdentityManager();
    const keys = await provider.generateKeyPair();
    const did = publicKeyToDid(await provider.exportPublicKey(keys.publicKey), P256_MULTICODEC);
    const note = await createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()).delegate({
      audience: did,
      // What it may do is what the note grants, whatever holds the key.
      command: '/record',
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const agent = await createNode({
      signer: grantSigner({
        v: 2,
        did: (await manager.fromSeed(seed)).did,
        name: 'Ada',
        note,
        access: 'write',
        scope: 'account',
        spaces: [],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        home: 'https://home.test/connect',
      }),
      sessionKey: keys,
      stores: memoryStores(),
      accountKey: await deriveAccountKey(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: {
        relays: [relayUrl],
        transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
      },
    });
    open.push(agent);
    assert.equal(await agent.inbox.get(), null);
    await assert.rejects(agent.inbox.open(), /doesn't let it use your inbox/);
    await assert.rejects(agent.inbox.knock(inbox.code), /doesn't let it use your inbox/);
    await assert.rejects(agent.inbox.knocks(), /doesn't let it use your inbox/);
  });
});
