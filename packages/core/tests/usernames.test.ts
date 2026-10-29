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
import { resolveUsername } from '../src/inbox/names.js';
import { team } from '../src/space/presets.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { portOf } from './helpers/net.js';
import { patience } from './helpers/until.js';
import { open, person as somebody } from './helpers/person.js';

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
  test('a contact invited into a space finds the invite, and joins', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, space: pair } = await contacts(hub);
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    await leif.contacts.invite(pair, bills.id, { role: 'editor' });

    const [invite] = await until(
      () => anna.contacts.invites(),
      (found) => found.length === 1,
      'the invite',
    );
    assert.equal(invite!.from, leif.did);
    assert.equal(invite!.name, 'Bills');
    assert.equal(invite!.space, bills.id);
    // Leif doesn't see his own.
    assert.deepEqual(await leif.contacts.invites(), []);

    const joined = await anna.spaces.join(invite!.invite);
    assert.equal(joined.id, bills.id);
    // The role the invite gives arrives as the space syncs.
    await anna.spaces.hold(bills.id);
    await leif.spaces.hold(bills.id);
    await until(
      async () => (await anna.spaces.list()).find((space) => space.id === bills.id)?.writable,
      (writable) => writable === true,
      'Anna to hold the editor role',
    );
    // Held now, so no longer offered.
    assert.deepEqual(await anna.contacts.invites(), []);
  });

  test('an invite from someone blocked is not shown', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const { anna, leif, space: pair } = await contacts(hub);
    const bills = await leif.spaces.create({ name: 'Bills', visibility: 'private', ...team });
    await leif.contacts.invite(pair, bills.id, { role: 'editor' });
    await until(
      () => anna.contacts.invites(),
      (found) => found.length === 1,
      'the invite',
    );
    await anna.contacts.block(leif.did);
    assert.deepEqual(await anna.contacts.invites(), []);
  });
});
