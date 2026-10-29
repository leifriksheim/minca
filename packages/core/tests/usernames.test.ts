// Usernames on the node: claiming one for the inbox, knocking on someone by
// theirs, and inviting a contact into a space (packages/core/docs/usernames.md).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { createRelay, MAX_MESSAGE_BYTES } from '../../relay/relay.mjs';
import { createNames } from '../../names/names.mjs';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createMincaAuth, type MincaAuth } from '../src/session/auth.js';
import {
  adHocUsername,
  nameFromUsername,
  parseUsername,
  resolveUsername,
  usernameFree,
  usernameIdeas,
} from '../src/inbox/names.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { portOf } from './helpers/net.js';
import { patience } from './helpers/until.js';
import { open, person as somebody } from './helpers/person.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';

const provider = createP256Provider();

let relayUrl: string;
let domain: string;
const closers: Array<() => void> = [];

before(async () => {
  const relay = createRelay({ mailbox: { dropsPerNetwork: 10_000, dropsPerNetworkPerTopic: 1000 } });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const relayServer = createServer();
  relayServer.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  relayUrl = `ws://127.0.0.1:${portOf(relayServer)}`;

  const namesServer = createServer();
  await new Promise<void>((resolve) => namesServer.listen(0, resolve));
  domain = `localhost:${portOf(namesServer)}`;
  const names = createNames({
    domain,
    claim: `http://${domain}/.well-known/minca.json`,
    dir: mkdtempSync(join(tmpdir(), 'minca-names-')),
    limits: { workBits: 4, newNamesPerNetwork: 1000 },
  });
  namesServer.on('request', (req, res) => {
    if (!names.handle(req, res)) res.writeHead(404).end();
  });
  closers.push(
    () => relay.close(),
    () => relayServer.close(),
    () => names.close(),
    () => namesServer.close(),
  );
});
after(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
  for (const close of closers) close();
});

const person = async (hub: FakeHub, name: string) =>
  (await somebody(hub, { name, relays: [relayUrl], accountKey: true, contactKey: true })).node;

async function until<T>(get: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 8000) {
  const deadline = Date.now() + patience(ms);
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A name nobody in these tests has used */
let names = 0;
const fresh = (name: string) => `${name}${++names}@${domain}`;

/** What a code says: the inbox's keys, places and name */
const said = async (code: string) => {
  const { key, places, name } = (await resolveUsername(code, provider)).inbox;
  return { key, places, name };
};

/** Leif knocks on Anna by her username; Anna accepts. Both sides end as contacts. */
async function contacts(hub: FakeHub) {
  const anna = await person(hub, 'Anna');
  const leif = await person(hub, 'Leif');
  const username = fresh('anna');
  await anna.inbox.claim(username);
  const { space } = await leif.inbox.knock(username.toUpperCase());
  const [knock] = await until(
    () => anna.inbox.knocks(),
    (k) => k.length === 1,
    'the knock',
  );
  await anna.inbox.accept(knock!.id);
  await leif.spaces.hold(space);
  await anna.spaces.hold(space);
  // Reading his knocks is when Leif's node sees Anna joined, and makes her a contact.
  await until(
    () => leif.inbox.sent(),
    (sent) => sent.length === 0,
    'Leif to see Anna joined',
  );
  return { anna, leif, space, username };
}

describe('node.inbox and usernames', () => {
  test('a username claimed for the inbox leads to its code, follows it when replaced, and is given up', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const username = fresh('anna');
    // Claiming opens the inbox when it isn't yet.
    const claimed = await anna.inbox.claim(username.replace('anna', 'Anna'));
    assert.equal(claimed.username, username);
    assert.ok((claimed.usernameUntil ?? 0) > Date.now() + 300 * 24 * 3600_000);
    assert.deepEqual(await said(username), { key: claimed.key, places: claimed.places, name: 'Anna' });

    // A new inbox: the name leads to the new one, and the inbox keeps the name.
    const replaced = await anna.inbox.rotate();
    assert.notEqual(replaced.key, claimed.key);
    assert.equal(replaced.username, username);
    assert.equal((await said(username)).key, replaced.key);
    // A new name for the inbox is in what the username leads to too.
    const renamed = await anna.inbox.open({ name: 'Anna B' });
    assert.equal(renamed.username, username);
    assert.equal((await said(username)).name, 'Anna B');

    // One name at a time: a new one gives the old one up.
    const next = fresh('annab');
    await anna.inbox.claim(next);
    await assert.rejects(resolveUsername(username, provider), /doesn't know/);

    const released = await anna.inbox.release();
    assert.equal(released.username, undefined);
    await assert.rejects(resolveUsername(next, provider), /doesn't know/);
  });

  test('replacing the inbox while its name service is down changes nothing, so the name never leads nowhere', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    // A name service of its own, to stop.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const at = `localhost:${portOf(server)}`;
    const names = createNames({
      domain: at,
      claim: `http://${at}/.well-known/minca.json`,
      dir: mkdtempSync(join(tmpdir(), 'minca-names-')),
      limits: { workBits: 4 },
    });
    server.on('request', (req, res) => {
      if (!names.handle(req, res)) res.writeHead(404).end();
    });
    const anna = await person(hub, 'Anna');
    const before = await anna.inbox.claim(`anna@${at}`);
    names.close();
    await new Promise((resolve) => server.close(resolve));

    await assert.rejects(anna.inbox.rotate());
    await assert.rejects(anna.inbox.open({ name: 'Anna B' }));
    const after = await anna.inbox.get();
    assert.equal(after?.gen, before.gen);
    assert.equal(after?.name, 'Anna');
    assert.equal(after?.username, `anna@${at}`);
  });

  test('someone found by their username becomes a contact who keeps it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, space, username } = await contacts(hub);
    const annaForLeif = await leif.contacts.get(anna.did);
    assert.equal(annaForLeif?.username, username);
    assert.equal(annaForLeif?.space, space);
  });

  test('a username nobody holds, or your own, is no one to knock on', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    await assert.rejects(anna.inbox.knock(fresh('nobody')), /doesn't know/);
    const username = fresh('anna');
    await anna.inbox.claim(username);
    await assert.rejects(anna.inbox.knock(username), /your own inbox/);
  });
});

describe('node.contacts.invite', () => {
  /** Leif makes a team space and invites Anna into it; Anna's view of the invite once it arrives */
  async function invited(hub: FakeHub) {
    const pair = await contacts(hub);
    const { anna, leif } = pair;
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    await leif.contacts.invite(anna.did, bills.id, { role: 'editor' });
    const [invite] = await until(
      () => anna.contacts.invites(),
      (found) => found.length === 1,
      'the invite',
    );
    return { ...pair, bills, invite: invite! };
  }

  test('a contact invited into a space finds the invite, and joins', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, bills, invite } = await invited(hub);
    assert.equal(invite.from, leif.did);
    // The name and the space come from the signed invite, not from what was written beside it.
    assert.equal(invite.name, 'Bills');
    assert.equal(invite.space, bills.id);
    // Leif doesn't see his own.
    assert.deepEqual(await leif.contacts.invites(), []);

    const joined = await anna.contacts.join(invite.pairSpace, invite.key);
    assert.equal(joined.id, bills.id);
    await anna.spaces.hold(bills.id);
    await leif.spaces.hold(bills.id);
    await until(
      async () => (await anna.spaces.list()).find((space) => space.id === bills.id)?.writable,
      (writable) => writable === true,
      'Anna to hold the editor role',
    );
    assert.deepEqual(await anna.contacts.invites(), []);
  });

  test('only a contact who joined your space for two can be invited: never whoever a name leads to', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const anna = await person(hub, 'Anna');
    const leif = await person(hub, 'Leif');
    const username = fresh('anna');
    await anna.inbox.claim(username);
    await leif.inbox.knock(username);
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    // Knocked, not answered: nobody whose account Leif has seen.
    await assert.rejects(leif.contacts.invite(anna.did, bills.id), /haven't joined/);
  });

  test('a used invite is closed and gone, so someone removed is never offered it again', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, bills, invite } = await invited(hub);
    await anna.contacts.join(invite.pairSpace, invite.key);
    await anna.spaces.hold(bills.id);
    await leif.spaces.hold(bills.id);
    await until(
      async () => (await leif.spaces.access(bills.id)).members.some((member) => member.did === anna.did),
      (there) => there,
      'Leif to see Anna in Bills',
    );
    // Leif's node closes the invite it sees used, and deletes it, when it next looks.
    await until(
      async () => {
        await leif.contacts.invites();
        const open = (await leif.spaces.access(bills.id)).invites.filter((invite) => invite.open).length;
        const left = (await leif.records.list(invite.pairSpace, { collection: 'std.space-invite' })).length;
        return open + left;
      },
      (rest) => rest === 0,
      'the used invite to be closed and gone',
    );
    await anna.spaces.leave(bills.id);
    assert.deepEqual(await anna.contacts.invites(), []);
  });

  test('an invite whose record names another space than it is for is not shown', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, space: pair } = await contacts(hub);
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    const family = await leif.spaces.create({ name: 'Family', visibility: 'private', ...team });
    await leif.contacts.invite(anna.did, bills.id, { role: 'editor' });
    // The record says Family, the invite inside it is for Bills.
    const [record] = await leif.records.list<{ invite: string }>(pair, { collection: 'std.space-invite' });
    await leif.records.put(pair, 'std.space-invite', { space: family.id, invite: record!.body!.invite });
    await until(
      () => anna.contacts.invites(),
      (found) => found.length === 1,
      'the honest invite',
    );
    assert.deepEqual(
      (await anna.contacts.invites()).map((invite) => [invite.space, invite.name]),
      [[bills.id, 'Bills']],
    );
  });

  test("a space name the invite's signature does not cover is never shown", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, space: pair } = await contacts(hub);
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    const real = await leif.spaces.invite(bills.id, { role: 'editor' });
    const [encoded, secret] = real.split('.');
    // The space's name changed after signing; the secret kept.
    const text = Buffer.from(encoded!, 'base64url').toString('utf8');
    assert.ok(text.includes('"name":"Bills"'));
    const edited = text.replace('"name":"Bills"', '"name":"Your bank: verify your account"');
    const forged = `${Buffer.from(edited, 'utf8').toString('base64url')}.${secret}`;
    await leif.records.put(pair, 'std.space-invite', { space: bills.id, invite: forged });
    // The honest one beside it arrives; the forged one never shows.
    const family = await leif.spaces.create({ name: 'Family', visibility: 'private', ...team });
    await leif.contacts.invite(anna.did, family.id, { role: 'editor' });
    await until(
      () => anna.contacts.invites(),
      (found) => found.length >= 1,
      'the honest invite',
    );
    assert.deepEqual(
      (await anna.contacts.invites()).map((invite) => invite.name),
      ['Family'],
    );
  });

  test('an invite from someone blocked is not shown', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif } = await invited(hub);
    await anna.contacts.block(leif.did);
    assert.deepEqual(await anna.contacts.invites(), []);
  });
});

describe('a username at sign-up', () => {
  /** A sign-in flow kept in memory, whose new accounts take usernames at the test's domain */
  function signUp(): MincaAuth {
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const values = new Map<string, string>([['minca.stay-signed-in', JSON.stringify('never')]]);
    const auth = createMincaAuth({
      rpId: 'example.test',
      network: { relays: [relayUrl] },
      usernames: domain,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
      },
      browser: { accounts: async () => accounts, stores: () => stores },
    });
    signedUp.push(auth);
    return auth;
  }
  const signedUp: MincaAuth[] = [];
  after(async () => {
    await Promise.all(signedUp.splice(0).map((auth) => auth.signOut()));
  });

  test('is claimed in the background as the account is made, and leads to its inbox', async () => {
    const auth = signUp();
    await auth.start();
    const username = fresh('ada');
    await auth.createAccount('Ada', { username });
    // Setup goes on meanwhile: the recovery code is up before the claim is done.
    assert.equal(auth.getState().stage, 'recovery');
    const claim = await until(
      async () => auth.getState().username,
      (claim) => claim?.status !== 'claiming',
      'the claim',
    );
    assert.deepEqual(claim, { username, status: 'claimed' });
    const inbox = await auth.getState().session!.node.inbox.get();
    assert.equal(inbox?.username, username);
    // A code is signed afresh each time it is written out: the same inbox is the same key.
    assert.equal((await resolveUsername(username, provider)).inbox.key, inbox?.key);
  });

  test('taken meanwhile, it fails and the account is made all the same', async () => {
    const anna = await person(createFakeHub({ latencyMs: 1 }), 'Anna');
    const username = fresh('anna');
    await anna.inbox.claim(username);
    const auth = signUp();
    await auth.start();
    await auth.createAccount('Anna', { username });
    const claim = await until(
      async () => auth.getState().username,
      (claim) => claim?.status !== 'claiming',
      'the claim',
    );
    assert.equal(claim?.status, 'failed');
    assert.equal(auth.getState().stage, 'recovery');
    assert.equal((await auth.getState().session!.node.inbox.get())?.username, undefined);
  });

  test('spaces.reached is true once a peer holds the space, and false for one who never comes', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { leif, space } = await contacts(hub);
    const [peer] = (await leif.spaces.status(space)).peers;
    assert.ok(peer, 'Anna is connected in the space for two');
    assert.equal(await leif.spaces.reached(space, peer, 2000), true);
    assert.equal(await leif.spaces.reached(space, 'did:key:zDnaeNobodyAtAll', 100), false);
  });
});

describe('usernameIdeas and usernameFree', () => {
  test('ideas are always valid names, with letters NFKD keeps whole written out', () => {
    assert.deepEqual(usernameIdeas('Ærøskøbing Ødegård'), [
      'aeroskobing',
      'aeroskobing.odegard',
      'aeroskobing21',
    ]);
    for (const idea of usernameIdeas(`Ann ${'x'.repeat(59)} Yu`))
      assert.ok(parseUsername(`${idea}@minca.social`), `${idea} is a name`);
    assert.deepEqual(usernameIdeas('  '), []);
  });

  test('skipping makes up a valid username and a name to go with it; a typed one names the account until it is renamed', () => {
    for (let i = 0; i < 50; i++) {
      const { username, name } = adHocUsername();
      assert.ok(parseUsername(`${username}@minca.social`), `${username} is a name`);
      assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
    assert.equal(nameFromUsername('leif.r'), 'Leif R');
    assert.equal(nameFromUsername('anna'), 'Anna');
  });

  test('a service that is down is not a free name', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('offline'));
    assert.equal(await usernameFree(fresh('ada'), down), null);
    assert.equal(await usernameFree(fresh('ada')), true);
    const anna = await person(createFakeHub({ latencyMs: 1 }), 'Anna');
    const username = fresh('anna');
    await anna.inbox.claim(username);
    assert.equal(await usernameFree(username), false);
  });
});
