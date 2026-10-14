/**
 * An app acting for an account through a grant from its home: it writes where
 * it was given access, nowhere else, and never holds the seed.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMincaAuth, type MincaAuth } from '../src/session/auth.js';
import {
  homeAddress,
  startConnectedNode,
  type AppKey,
  type ConnectRequest,
  type Grant,
  type ProposeRequest,
} from '../src/session/connect.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import type { P2PNode } from '../src/node/types.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { team } from '../src/space/presets.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import { hold, letGo } from './helpers/hold.js';
import { joined } from './helpers/joined.js';
import { isRecord } from '../src/utils/guards.js';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { deriveContactKeyBytes } from '../src/identity/contact-key.js';
import { until } from './helpers/until.js';
import { watchNotifications, type NotifyMatch } from '../src/node/watch-notifications.js';
import { notifyOn } from '../src/space/own-automations.js';
import { asked, testAppKey } from './helpers/person.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/**
 * The account home: a signed-in flow on the hub. Signing out waits only
 * briefly for a peer to take its revokes in, unless a test is about that wait.
 */
async function home(hub: FakeHub, { signOutGraceMs = 300 } = {}): Promise<MincaAuth> {
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const stores = memoryStores();
  const values = new Map<string, string>([['minca.stay-signed-in', '"never"']]);
  const auth = createMincaAuth({
    rpId: 'home.test',
    storage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => void values.set(k, v),
      removeItem: (k) => void values.delete(k),
    },
    browser: { accounts: async () => accounts, stores: () => stores },
    network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    signOutGraceMs,
  });
  await auth.start();
  await auth.createAccount('Ada');
  auth.codeSaved();
  cleanup.push(() => auth.signOut());
  return auth;
}

async function appKey(): Promise<AppKey> {
  const provider = createP256Provider();
  const made = await provider.generateKeyPair();
  return {
    keys: { privateKey: made.privateKey, publicKey: made.publicKey },
    did: publicKeyToDid(await provider.exportPublicKey(made.publicKey), P256_MULTICODEC),
  };
}

async function app(hub: FakeHub, grant: Omit<Grant, 'home'>, key: AppKey): Promise<P2PNode> {
  const node = await startConnectedNode({
    grant: { ...grant, home: 'https://home.test/connect' },
    key,
    stores: memoryStores(),
    network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
  });
  cleanup.push(() => node.close());
  return node;
}

describe('connecting an app to an account home', () => {
  test('the grant is a note from the account to the app key, for the chosen spaces only', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const groceries = await node.spaces.create({ name: 'Groceries', visibility: 'private' });
    await node.spaces.create({ name: 'Diary', visibility: 'private' });
    const key = await appKey();

    const request: ConnectRequest = await asked(
      { v: 1, audience: key.did, name: 'Todo', access: 'write' },
      key,
    );
    const grant = await auth.grant({ origin: 'https://todo.test', request, spaceIds: [groceries.id] });

    const { payload } = grant.note;
    assert.equal(payload.iss, auth.getState().session!.did);
    assert.equal(payload.aud, key.did);
    // One space: a note about that space, for every command there.
    assert.equal(payload.sub, `space:${groceries.id}`);
    assert.equal(payload.cmd, '/');
    assert.deepEqual(payload.pol, []);
    assert.deepEqual(
      grant.spaces.map((space) => space.name),
      ['Groceries'],
    );
    assert.equal(auth.connections()[0]?.origin, 'https://todo.test');
  });

  test('the app writes in its space, and the account sees it; it cannot write anywhere else', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode, did } = auth.getState().session!;
    const groceries = await homeNode.spaces.create({ name: 'Groceries', visibility: 'private' });
    const key = await appKey();

    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [groceries.id],
    });
    const todo = await app(hub, grant, key);
    assert.equal(todo.did, did, 'the app acts for the account');
    assert.equal(todo.sessionDid, key.did, 'with its own key');

    const milk = await todo.records.put(groceries.id, 'app.todo.item', { text: 'milk' });
    await hold(homeNode, groceries.id);
    await until(
      async () => (await homeNode.records.get(groceries.id, milk.key)) !== null,
      3000,
      'the record to reach the home',
    );
    const seen = await homeNode.records.get(groceries.id, milk.key);
    assert.equal(seen?.verified, true);
    assert.equal(seen?.root, did);

    // A space the app makes for itself is outside the note.
    const own = await todo.spaces.create({ name: 'Mine', visibility: 'private' }).catch(() => null);
    if (own) await assert.rejects(() => todo.records.put(own.id, 'app.todo.item', { text: 'nope' }));
  });

  test('spaces the app asked for are made by the home, in the account', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked(
        {
          v: 1,
          audience: key.did,
          access: 'write',
          create: [{ name: 'Todos', visibility: 'private' }],
        },
        key,
      ),
      spaceIds: [],
    });
    assert.equal(grant.spaces[0]?.name, 'Todos');
    const listed = await auth.getState().session!.node.spaces.list();
    assert.ok(
      listed.some((space) => space.id === grant.spaces[0]?.id),
      'the account holds it',
    );

    const todo = await app(hub, grant, key);
    await todo.records.put(grant.spaces[0].id, 'app.todo.item', { text: 'first' });
  });

  test('read access carries no write: the app cannot change a thing', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const shared = await auth
      .getState()
      .session!.node.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://viewer.test',
      request: await asked({ v: 1, audience: key.did, access: 'read' }, key),
      spaceIds: [shared.id],
    });
    const viewer = await app(hub, grant, key);
    await assert.rejects(() => viewer.records.put(shared.id, 'app.note', { text: 'hi' }));
  });

  test('whole-account access: the app sees every space, and a space it makes lands in the account', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const diary = await homeNode.spaces.create({ name: 'Diary', visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://browser.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    assert.equal(grant.scope, 'account');
    assert.ok(grant.accountKey);
    // The whole account: a note about the account itself, every command, no conditions.
    assert.equal(grant.note.payload.sub, grant.did);
    assert.equal(grant.note.payload.cmd, '/');
    assert.deepEqual(grant.note.payload.pol, []);

    const browser = await app(hub, grant, key);
    await until(
      async () => (await browser.spaces.list()).some((space) => space.id === diary.id),
      3000,
      'the account list to reach the app',
    );
    await browser.records.put(diary.id, 'app.note', { text: 'dear diary' });

    const made = await browser.spaces.create({ name: 'Made by the app', visibility: 'private' });
    await browser.records.put(made.id, 'app.note', { text: 'mine' });
    await until(
      async () => (await homeNode.spaces.list()).some((space) => space.id === made.id),
      3000,
      'the new space to reach the home',
    );
    assert.equal(auth.connections()[0]?.scope, 'account');
  });

  test('disconnecting forgets the app', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const key = await appKey();
    await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'read' }, key),
      spaceIds: [],
    });
    await auth.disconnect('https://todo.test');
    assert.deepEqual(auth.connections(), []);
  });

  test('an app can only ask for a key it holds, and none the home already uses for something else', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const space = await node.spaces.create({ name: 'Notes', visibility: 'private' });
    const ask = (origin: string, request: ConnectRequest) =>
      auth.grant({ origin, request, spaceIds: [space.id] });
    const mine = await testAppKey('mine');
    const theirs = await testAppKey('theirs');
    // Naming a key without holding it: its proof is another key's.
    const forged: ConnectRequest = {
      ...(await asked({ v: 1, audience: theirs.did, access: 'write' } as const, mine)),
      audience: theirs.did,
    };
    await assert.rejects(ask('https://evil.test', forged), /holds the key/);
    // Even with a proof, never the home's own key: disconnecting would revoke the home.
    await assert.rejects(
      ask('https://evil.test', { v: 1, audience: node.sessionDid, proof: 'x', access: 'write' }),
      /holds the key|this home’s own/,
    );
    // A program's proof, handed to an app over a connect code, can't ask for the app's own
    // connection, nor for more than the records only it asked for.
    const programKey = await testAppKey('program');
    const programAsk = await asked(
      { v: 1, audience: programKey.did, access: 'write', via: 'code', recordsOnly: true } as const,
      programKey,
      'https://evil.test',
    );
    const { via: _via, ...asOwn } = programAsk;
    await assert.rejects(ask('https://evil.test', asOwn), /holds the key/);
    await assert.rejects(ask('https://evil.test', { ...programAsk, recordsOnly: false }), /holds the key/);
    // An app's own proof can't be passed off as a program's either.
    const ownAsk = await asked({ v: 1, audience: programKey.did, access: 'write' } as const, programKey);
    await assert.rejects(ask('https://evil.test', { ...ownAsk, via: 'code' }), /holds the key/);
    // A program's proof names the app it went through: from any other origin it is refused.
    await assert.rejects(ask('https://other.test', programAsk), /holds the key/);
    // Nor a key another app was given.
    await ask('https://good.test', await asked({ v: 1, audience: theirs.did, access: 'write' }, theirs));
    await assert.rejects(
      ask('https://evil.test', await asked({ v: 1, audience: theirs.did, access: 'write' }, theirs)),
      /already connected/,
    );
  });

  test('connecting again with a new key revokes the old one: no time ends a note, so revoking does', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const first = await testAppKey('first');
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: first.did, access: 'write' }, first),
      spaceIds: [shared.id],
    });
    const todo = await app(hub, grant, first);
    await todo.records.put(shared.id, 'app.todo.item', { text: 'with the first key' });
    const second = await testAppKey('second');
    await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: second.did, access: 'write' }, second),
      spaceIds: [shared.id],
    });
    await until(
      async () =>
        todo.records.put(shared.id, 'app.todo.item', { text: 'after' }).then(
          () => false,
          (error: Error) => /revoked/.test(error.message),
        ),
      3000,
      'the old key to be revoked',
    );
  });

  test('disconnecting revokes the note: the app stops counting at once, and what it wrote before stays', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [shared.id],
    });
    // The app holds no secret of the space's: what lets it write is the note alone.
    assert.equal(parseSpaceInvite(grant.spaces[0]!.invite).invite, undefined);

    const todo = await app(hub, grant, key);
    const told: string[] = [];
    todo.subscribe((event) => event.type === 'revoked' && told.push(event.space));
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await hold(homeNode, shared.id);
    await until(
      async () => (await homeNode.records.get(shared.id, before.key)) !== null,
      3000,
      'the app’s record to reach the home',
    );

    await auth.disconnect('https://todo.test');
    assert.deepEqual(auth.connections(), []);
    await until(
      async () =>
        todo.records.put(shared.id, 'app.todo.item', { text: 'after' }).then(
          () => false,
          (error: Error) => /revoked/.test(error.message),
        ),
      3000,
      'the revoke to reach the app',
    );
    assert.equal((await homeNode.records.get(shared.id, before.key))?.verified, true);
    // The app is told, so it can sign itself out rather than keep writing into nothing.
    await until(async () => told.includes(shared.id), 3000, 'the app to hear it was revoked');
  });

  test('disconnecting says whether a peer took the revoke in: only then can the app hear of it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const connect = async (origin: string) => {
      const key = await appKey();
      const grant = await auth.grant({
        origin,
        request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
        spaceIds: [shared.id],
      });
      return { key, grant };
    };

    // Nobody else is there: it is disconnected here, and nowhere else yet.
    await connect('https://alone.test');
    assert.equal(await auth.disconnect('https://alone.test', { waitMs: 300 }), false);

    // The app is connected: it takes the revoke in, and says so.
    const { key, grant } = await connect('https://todo.test');
    const todo = await app(hub, grant, key);
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await hold(homeNode, shared.id);
    await until(
      async () => (await homeNode.records.get(shared.id, before.key)) !== null,
      3000,
      'the two to meet',
    );
    assert.equal(await auth.disconnect('https://todo.test', { waitMs: 3000 }), true);
  });

  test('a space the account has left has nothing to revoke: disconnecting still says the app heard', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const other = await homeNode.spaces.create({ name: 'Other', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [shared.id, other.id],
    });
    const todo = await app(hub, grant, key);
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await hold(homeNode, shared.id);
    await until(
      async () => (await homeNode.records.get(shared.id, before.key)) !== null,
      3000,
      'the two to meet',
    );
    await homeNode.spaces.leave(other.id);
    assert.equal(await auth.disconnect('https://todo.test', { waitMs: 3000 }), true);
  });

  test('signing out and disconnecting: the apps connected here are revoked before the home goes', async () => {
    // A network slow enough that a home which stopped at once would leave its revokes behind.
    const hub = createFakeHub({ latencyMs: 400 });
    const auth = await home(hub, { signOutGraceMs: 5000 });
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [shared.id],
    });
    const todo = await app(hub, grant, key);
    await hold(homeNode, shared.id);
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await until(
      async () => (await homeNode.records.get(shared.id, before.key)) !== null,
      15_000,
      'the two to meet',
    );

    await auth.signOut({ disconnect: true });
    // The home has stopped: whatever reaches the app now, it sent before stopping.
    await until(
      async () =>
        todo.records.put(shared.id, 'app.todo.item', { text: 'after' }).then(
          () => false,
          (error: Error) => /revoked/.test(error.message),
        ),
      5000,
      'the revoke to reach the app, though the home has gone',
    );
  });

  test('disconnecting in a space the home no longer holds: it opens it, and waits for the app to hear', async () => {
    // Slow enough that a freshly opened space has met nobody by the time the revoke is written.
    const hub = createFakeHub({ latencyMs: 100 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [shared.id],
    });
    const todo = await app(hub, grant, key);
    await hold(todo, shared.id);
    await hold(homeNode, shared.id);
    const before = await todo.records.put(shared.id, 'app.todo.item', { text: 'before' });
    await until(
      async () => (await homeNode.records.get(shared.id, before.key)) !== null,
      5000,
      'the two to meet',
    );
    // Nothing on the home holds the space now: it closes.
    await letGo(homeNode, shared.id);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(await auth.disconnect('https://todo.test', { waitMs: 5000 }), true, 'the app heard');
    await auth.signOut();
    // The home has stopped: whatever reaches the app now, it sent before stopping.
    await until(
      async () =>
        todo.records.put(shared.id, 'app.todo.item', { text: 'after' }).then(
          () => false,
          (error: Error) => /revoked/.test(error.message),
        ),
      5000,
      'the revoke at the app',
    );
  });

  test('signing out alone: the apps connected here keep their notes', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const shared = await homeNode.spaces.create({ name: 'Team', ...team, visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [shared.id],
    });
    const todo = await app(hub, grant, key);
    await hold(homeNode, shared.id);

    await auth.signOut();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await todo.records.put(shared.id, 'app.todo.item', { text: 'still mine' });
  });

  test('disconnecting a whole-account app revokes it in the account registry too: it can no longer rename the account', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://browser.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    const browser = await app(hub, grant, key);
    await until(
      async () => (await browser.account.profile())?.name === 'Ada',
      3000,
      'the account to reach the app',
    );
    await browser.account.setName('Ada L');
    await until(
      async () => (await homeNode.account.profile())?.name === 'Ada L',
      3000,
      'the rename to reach the home',
    );

    await auth.disconnect('https://browser.test');
    await until(
      async () =>
        browser.account.setName('Not Ada').then(
          () => false,
          (error: Error) => /revoked/.test(error.message),
        ),
      3000,
      'the revoke to reach the app',
    );
  });
});

describe('giving an app the contacts', () => {
  test('it lists them and opens requests sent to the account, and sees no other space', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const club = await homeNode.spaces.create({ name: 'Book club', ...team, visibility: 'private' });
    await homeNode.spaces.create({ name: 'Diary', visibility: 'private' });

    // Bob, in the book club, asks the account to add him.
    const seed = generateSeed();
    const manager = createIdentityManager();
    const bob = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
      stores: memoryStores(),
      accountKey: await deriveAccountKey(seed),
      contactKey: await deriveContactKeyBytes(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    cleanup.push(() => bob.close());
    await bob.account.setName('Bob');
    await bob.spaces.join(await homeNode.spaces.invite(club.id, { role: 'editor' }));
    await hold(homeNode, club.id);
    await joined(bob, club.id);
    await hold(bob, club.id);
    await until(
      async () => (await bob.spaces.profiles(club.id)).some((p) => p.did === homeNode.did && p.contactKey),
      5000,
      'the account’s contact key',
    );
    await bob.contacts.ask(club.id, homeNode.did);
    await homeNode.contacts.put({ did: bob.did, name: 'Bob from book club' });

    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://people.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', contacts: true }, key),
      spaceIds: [club.id],
    });
    const contactsSpace = await homeNode.contacts.space();
    assert.equal(grant.contactsSpace, contactsSpace);
    assert.ok(grant.contactKey);
    assert.equal(grant.accountKey, undefined);

    const people = await app(hub, grant, key);
    assert.equal(await people.contacts.space(), contactsSpace);
    assert.deepEqual(
      (await people.spaces.list()).map((space) => space.name),
      ['Book club'],
    );
    assert.equal(await people.account.profile(), null, 'no account registry');

    await hold(homeNode, contactsSpace!);
    await hold(people, contactsSpace!);
    await until(async () => (await people.contacts.list()).length === 1, 5000, 'the contact list');
    await hold(people, club.id);
    await until(async () => (await people.contacts.requests(club.id)).length === 1, 5000, 'Bob’s request');
    assert.equal((await people.contacts.requests(club.id))[0]!.from, bob.did);
    // Accepting joins a new space, which needs the whole account.
    await assert.rejects(
      people.contacts.accept(club.id, (await people.contacts.requests(club.id))[0]!.key),
      /whole account/,
    );
  });

  test('an app not given them has no contact key, and cannot open requests', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const club = await homeNode.spaces.create({ name: 'Book club', visibility: 'private' });
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'write' }, key),
      spaceIds: [club.id],
    });
    assert.equal(grant.contactKey, undefined);
    assert.equal(grant.contactsSpace, undefined);
    const todo = await app(hub, grant, key);
    assert.equal(await todo.contacts.space(), null);
    await assert.rejects(todo.contacts.requests(club.id), /can't read contact requests/);
  });
});

describe('an account home typed by a person', () => {
  test('a bare address becomes its https connect page', () => {
    assert.equal(homeAddress('minca.example.com'), 'https://minca.example.com/connect');
    assert.equal(homeAddress(' https://minca.example.com/ '), 'https://minca.example.com/connect');
    assert.equal(homeAddress('https://me.example/minca/connect#x'), 'https://me.example/minca/connect');
  });

  test('plain http only for this machine', () => {
    assert.equal(homeAddress('localhost:5174'), 'http://localhost:5174/connect');
    assert.throws(() => homeAddress('http://minca.example.com'), /https/);
  });

  test('something that is not an address says so', () => {
    assert.throws(() => homeAddress(''), /address/);
    assert.throws(() => homeAddress('not a url at all'), /not a web address/);
  });

  test("the grant carries the home's relays", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const accounts = createFolderAccountStore(createMemoryDirectory().handle);
    const stores = memoryStores();
    const values = new Map<string, string>([['minca.stay-signed-in', '"never"']]);
    const auth = createMincaAuth({
      rpId: 'home.test',
      storage: {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => void values.set(k, v),
        removeItem: (k) => void values.delete(k),
      },
      browser: { accounts: async () => accounts, stores: () => stores },
      network: {
        relays: ['wss://relay.of-the-home.test'],
        transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)],
      },
    });
    await auth.start();
    await auth.createAccount('Ada');
    cleanup.push(() => auth.signOut());
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: key.did, access: 'read' }, key),
      spaceIds: [],
    });
    assert.deepEqual(grant.relays, ['wss://relay.of-the-home.test']);
  });
});

describe('connecting a carrier to an account home', () => {
  test('it gets an invite to a carry space and no note; disconnecting removes it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node, did } = auth.getState().session!;
    await node.spaces.create({ name: 'Notes', visibility: 'private' });
    const key = await appKey();

    const request: ConnectRequest = await asked(
      { v: 1, audience: key.did, name: 'Minca for Chrome', access: 'carry' },
      key,
    );
    const grant = await auth.grantCarry({ origin: 'chrome-extension://abcdef', request });

    assert.equal(grant.kind, 'carry');
    assert.equal(grant.did, did);
    assert.equal('note' in grant, false, 'no note: a carrier never writes');
    const carry = parseSpaceInvite(grant.carry.invite);
    assert.equal(carry.space.id, grant.carry.space);
    assert.deepEqual(carry.space.top, { founders: [did] });
    assert.equal(carry.invite, undefined, 'view-only');
    assert.equal(grant.pod, null, 'this account lives in the browser');

    assert.deepEqual(
      (await node.carriers.list()).map((carrier) => carrier.did),
      [key.did],
    );
    assert.equal(auth.connections()[0]?.access, 'carry');
    await assert.rejects(
      () => auth.grant({ origin: 'chrome-extension://abcdef', request, spaceIds: [] }),
      /grantCarry/,
    );

    // A carrier is disconnected by its own key: by origin alone is the app there, and no carrier.
    await auth.disconnect('chrome-extension://abcdef');
    assert.equal(auth.connections().length, 1);
    await auth.disconnect('chrome-extension://abcdef', { audience: key.did });
    assert.deepEqual(await node.carriers.list(), []);
    assert.deepEqual(auth.connections(), []);
  });

  test('a carrier and an app at one origin are two connections: connecting either again replaces only its own', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const origin = 'http://127.0.0.1:47830';
    const kinds = () => auth.connections().map((connection) => `${connection.access}:${connection.audience}`);
    const carriers = async () => (await node.carriers.list()).map((carrier) => carrier.did);
    const connectApp = async (key: AppKey) =>
      auth.grant({
        origin,
        request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
        spaceIds: [],
      });
    const connectCarrier = async (key: AppKey) =>
      auth.grantCarry({ origin, request: await asked({ v: 1, audience: key.did, access: 'carry' }, key) });

    const app = await appKey();
    const carrier = await appKey();
    await connectApp(app);
    await connectCarrier(carrier);
    assert.deepEqual(kinds().sort(), [`carry:${carrier.did}`, `write:${app.did}`].sort(), 'the app stays');

    const appAgain = await appKey();
    await connectApp(appAgain);
    assert.deepEqual(
      kinds().sort(),
      [`carry:${carrier.did}`, `write:${appAgain.did}`].sort(),
      'the carrier stays',
    );
    assert.deepEqual(await carriers(), [carrier.did], 'and is still carrying');

    const carrierAgain = await appKey();
    await connectCarrier(carrierAgain);
    assert.deepEqual(kinds().sort(), [`carry:${carrierAgain.did}`, `write:${appAgain.did}`].sort());
    assert.deepEqual(await carriers(), [carrierAgain.did], 'the earlier carrier is removed');

    // One key is one connection: the app's key can't be a carrier too, nor the carrier's an app.
    await assert.rejects(connectCarrier(appAgain), /already connected/);
    await assert.rejects(connectApp(carrierAgain), /already connected/);

    // Disconnecting the carrier leaves the app, and what the app proposed.
    const kept = notifyOn('Mentioned', 'app.chat.message', { mentions: { $contains: '$me' } });
    await auth.propose({ origin, request: { v: 2, kind: 'propose', automations: [kept] } });
    const automations = async () => (await node.automations.list()).length;
    assert.equal(await automations(), 1);
    const other = await appKey();
    await connectCarrier(other);
    await auth.disconnect(origin, { audience: other.did });
    assert.deepEqual(kinds(), [`write:${appAgain.did}`]);
    assert.equal(await automations(), 1, 'the app keeps its automations');
    await connectCarrier(carrierAgain);

    // Disconnecting the app leaves the carrier; the carrier goes by its own key.
    await auth.disconnect(origin);
    assert.deepEqual(kinds(), [`carry:${carrierAgain.did}`]);
    assert.deepEqual(await carriers(), [carrierAgain.did]);
    await auth.disconnect(origin, { audience: carrierAgain.did });
    assert.deepEqual(auth.connections(), []);
    assert.deepEqual(await carriers(), []);
  });
});

describe('an app proposing automations', () => {
  const propose = (automations: ProposeRequest['automations']): ProposeRequest => ({
    v: 2,
    kind: 'propose',
    automations,
  });
  const connect = async (
    auth: Awaited<ReturnType<typeof home>>,
    request: Partial<ConnectRequest>,
    spaceIds: string[] = [],
  ) =>
    auth.grant({
      origin: 'https://chat.test',
      request: await asked({ v: 1, audience: (await appKey()).did, access: 'write', ...request }),
      spaceIds,
    });

  test("the ones the person says yes to become the account's, naming the app, looking at the spaces it was given, or some of them", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const club = await node.spaces.create({ name: 'Club', visibility: 'private' });
    const work = await node.spaces.create({ name: 'Work', visibility: 'private' });
    await connect(auth, { name: 'Chat' }, [club.id, work.id]);

    const request = propose([
      notifyOn('Mentioned in chat', 'app.chat.message', { mentions: { $contains: '$me' } }),
      { ...notifyOn('New message in Club', 'app.chat.message'), spaces: [club.id] },
      notifyOn('Not this one', 'app.chat.poll'),
    ]);
    const answer = await auth.propose({ origin: 'https://chat.test', request, kept: [0, 1] });

    const subs = await node.automations.list();
    const find = (label: string) => subs.find((sub) => sub.name === label);
    assert.equal(answer.kind, 'proposed');
    assert.deepEqual(answer.automations.map((sub) => sub.name).sort(), [
      'Mentioned in chat',
      'New message in Club',
    ]);
    assert.deepEqual(find('Mentioned in chat')?.spaces, [club.id, work.id], "the grant's spaces");
    assert.deepEqual(find('New message in Club')?.spaces, [club.id], 'or the ones it named');
    assert.deepEqual(
      find('Mentioned in chat')?.when?.query.where,
      { mentions: { $contains: '$me' } },
      '"$me" stays whoever runs it: the account',
    );
    assert.deepEqual(subs[0]!.app, { origin: 'https://chat.test', name: 'Chat' });
    assert.equal(subs[0]!.open, 'https://chat.test/', 'a click goes back to the app');

    // Proposing again adds nothing twice.
    await auth.propose({ origin: 'https://chat.test', request, kept: [0] });
    assert.equal((await node.automations.list()).length, 2);
  });

  test('proposing the same thing several times at once adds it once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const club = await node.spaces.create({ name: 'Club', visibility: 'private' });
    await connect(auth, { name: 'Chat' }, [club.id]);
    const request = propose([notifyOn('New message', 'app.chat.message')]);
    await Promise.all([1, 2, 3].map(() => auth.propose({ origin: 'https://chat.test', request })));
    assert.equal((await node.automations.list()).length, 1);
  });

  test("a whole-account app's look at every space", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    await connect(auth, { scope: 'account' });
    await auth.propose({
      origin: 'https://chat.test',
      request: propose([notifyOn('New message', 'app.chat.message')]),
    });
    assert.equal((await node.automations.list())[0]?.spaces, 'all');
  });

  test('a whole-account app is handed the automations in the answer: it holds them without ever meeting the home', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://chat.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    // A hub of its own: the home's window closes before the two ever meet.
    const chat = await app(createFakeHub({ latencyMs: 1 }), grant, key);
    const request = propose([notifyOn('New message', 'app.chat.message')]);
    const first = await auth.propose({ origin: 'https://chat.test', request });
    const [made] = first.automations;
    await node.automations.update(made!.id, { paused: true });

    // Asked again, the one it has is found, and every version of it handed over.
    const answer = await auth.propose({ origin: 'https://chat.test', request });
    const versions = answer.versions ?? [];
    assert.equal(versions.length, 2, 'the first version and the pause');
    assert.equal(await chat.automations.take(versions), 2);
    assert.deepEqual(
      (await chat.automations.list()).map((sub) => [sub.id, sub.paused]),
      [[made!.id, true]],
    );
    assert.equal(await chat.automations.take(versions), 0, 'nothing new the second time');
  });

  test('handed-over versions are refused when they are not automations, or do not check out', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://chat.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    const chat = await app(createFakeHub({ latencyMs: 1 }), grant, key);
    const answer = await auth.propose({
      origin: 'https://chat.test',
      request: propose([notifyOn('New message', 'app.chat.message')]),
    });
    const [version] = answer.versions!;

    assert.equal(
      await chat.automations.take([{ ...version!, collection: 'sys.profile' }]),
      0,
      'another collection',
    );
    assert.equal(
      await chat.automations.take([{ ...version!, createdAt: new Date(0).toISOString() }]),
      0,
      'changed after signing',
    );
    assert.deepEqual(await chat.automations.list(), []);
  });

  test('an app given only some spaces, which cannot read them, is handed none', async () => {
    const auth = await home(createFakeHub({ latencyMs: 1 }));
    const { node } = auth.getState().session!;
    const club = await node.spaces.create({ name: 'Club', visibility: 'private' });
    await connect(auth, {}, [club.id]);
    const answer = await auth.propose({
      origin: 'https://chat.test',
      request: propose([notifyOn('New message', 'app.chat.message')]),
    });
    assert.equal(answer.automations.length, 1);
    assert.equal(answer.versions, undefined);
  });

  test('refused: from nowhere connected here, from a carrier or a program connected by code, or looking at a space the app was not given', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const club = await node.spaces.create({ name: 'Club', visibility: 'private' });
    const work = await node.spaces.create({ name: 'Work', visibility: 'private' });
    await connect(auth, {}, [club.id]);
    const extension = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    await auth.grantCarry({
      origin: extension,
      request: await asked({
        v: 1,
        audience: (await appKey()).did,
        name: 'Minca for Chrome',
        access: 'carry',
      }),
    });
    await auth.grant({
      origin: 'https://code.test',
      request: await asked(
        {
          v: 1,
          audience: (await appKey()).did,
          access: 'write',
          scope: 'account',
          via: 'code',
          recordsOnly: true,
        },
        undefined,
        'https://code.test',
      ),
      spaceIds: [],
    });

    const one = propose([notifyOn('New', 'app.chat.message', { mentions: { $contains: '$me' } })]);
    for (const origin of ['https://stranger.test', extension, 'https://code.test'])
      await assert.rejects(() => auth.propose({ origin, request: one }), /Connect it first/, origin);
    await assert.rejects(
      () =>
        auth.propose({
          origin: 'https://chat.test',
          request: propose([
            notifyOn('Fine', 'app.chat.message'),
            { ...notifyOn('In Work', 'app.chat.message'), spaces: [work.id] },
          ]),
        }),
      /not given/,
    );
    assert.deepEqual(await node.automations.list(), [], 'nothing written, not even the one that was fine');
  });

  test('disconnecting the app removes its subscriptions, and leaves the others', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    await connect(auth, { scope: 'account' });
    await auth.grant({
      origin: 'https://todo.test',
      request: await asked({ v: 1, audience: (await appKey()).did, access: 'write', scope: 'account' }),
      spaceIds: [],
    });
    const request = propose([
      notifyOn('New message', 'app.chat.message'),
      notifyOn('Mentioned', 'app.chat.message', { mentions: { $contains: '$me' } }),
    ]);
    await auth.propose({ origin: 'https://chat.test', request });
    await auth.propose({
      origin: 'https://todo.test',
      request: propose([notifyOn('New todo', 'app.todo.item')]),
    });
    assert.equal((await node.automations.list()).length, 3);

    await auth.disconnect('https://chat.test');
    assert.deepEqual(
      (await node.automations.list()).map((sub) => sub.name),
      ['New todo'],
    );
  });

  test('disconnecting a whole-account app removes what its own key wrote, whatever app that names', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node } = auth.getState().session!;
    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://evil.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    const evil = await app(hub, grant, key);
    const own = (name: string, origin: string) => ({
      ...notifyOn(name, 'app.chat.message'),
      then: { kind: 'notify' as const, text: name },
      spaces: 'all' as const,
      app: { origin },
    });
    await evil.automations.add(own('Own', 'https://evil.test'));
    await evil.automations.add({
      ...own('Your bank: sign in again', 'https://bank.test'),
      open: 'https://evil.test/phish',
    });
    await until(
      async () => (await node.automations.list()).length === 2,
      5000,
      'its automations to reach the home',
    );

    await auth.disconnect('https://evil.test');
    assert.deepEqual(await node.automations.list(), []);
  });
});

describe('an app showing its own notifications', () => {
  test("it hears new records its kept subscriptions ask about — others', mentioning the account — and nothing else", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const auth = await home(hub);
    const { node: homeNode } = auth.getState().session!;
    const club = await homeNode.spaces.create({ name: 'Club', ...team, visibility: 'private' });

    const seed = generateSeed();
    const manager = createIdentityManager();
    const bob = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
      stores: memoryStores(),
      accountKey: await deriveAccountKey(seed),
      watchIntervalMs: 0,
      network: { transports: (spaceId, sessionDid) => [hub.transport(sessionDid, spaceId)] },
    });
    cleanup.push(() => bob.close());
    await bob.spaces.join(await homeNode.spaces.invite(club.id, { role: 'editor' }));
    await hold(homeNode, club.id);
    await joined(bob, club.id);
    await hold(bob, club.id);
    // Already there: never news.
    await bob.records.put(club.id, 'app.chat.message', { text: 'before', mentions: [homeNode.did] });

    const key = await appKey();
    const grant = await auth.grant({
      origin: 'https://chat.test',
      request: await asked({ v: 1, audience: key.did, access: 'write', scope: 'account' }, key),
      spaceIds: [],
    });
    await auth.propose({
      origin: 'https://chat.test',
      request: {
        v: 2,
        kind: 'propose',
        automations: [
          notifyOn('Mentioned', 'app.chat.message', { mentions: { $contains: '$me' } }),
          notifyOn('Paused', 'app.chat.poll'),
        ],
      },
    });
    const paused = (await homeNode.automations.list()).find((sub) => sub.name === 'Paused')!;
    await homeNode.automations.update(paused.id, { paused: true });
    // Another app's automation is that app's to show.
    await homeNode.automations.add({
      name: 'Elsewhere',
      when: { query: { collection: 'app.chat.message' } },
      then: { kind: 'notify', text: 'Elsewhere' },
      spaces: 'all',
      app: { origin: 'https://other.test' },
    });

    const chat = await app(hub, grant, key);
    await until(
      async () => (await chat.spaces.list()).some((space) => space.id === club.id),
      5000,
      'the club',
    );
    await hold(chat, club.id);
    const heard: NotifyMatch[] = [];
    const stop = watchNotifications(chat, {
      origin: 'https://chat.test',
      onNotify: (match) => heard.push(match),
    });
    cleanup.push(async () => stop());
    await until(
      async () => (await chat.automations.list()).length === 3,
      5000,
      'the subscriptions to reach the app',
    );
    await until(
      async () => (await chat.records.list(club.id, { collection: 'app.chat.message' })).length === 1,
      5000,
      'what was there before',
    );

    await chat.records.put(club.id, 'app.chat.message', { text: 'mine', mentions: [homeNode.did] });
    await bob.records.put(club.id, 'app.chat.message', { text: 'not about you', mentions: [] });
    await bob.records.put(club.id, 'app.chat.poll', { question: 'Lunch?' });
    const wanted = await bob.records.put(club.id, 'app.chat.message', {
      text: 'hi',
      mentions: [homeNode.did],
    });

    await until(() => heard.length > 0, 5000, 'a notification');
    await until(
      async () => (await chat.records.list(club.id, { collection: 'app.chat.poll' })).length === 1,
      5000,
      'the poll',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      heard.map((match) => [match.automation.name, match.record.key]),
      [['Mentioned', wanted.key]],
      "only Bob's mention: not the app's own, not one about no one, not the paused one, not before",
    );
  });
});

describe('the app asking its home', () => {
  test('a hello that arrives before the request is ready is still answered, and the request repeats until answered', async () => {
    const { connectToHome } = await import('../src/session/connect.js');
    const key = await testAppKey('early-hello');
    const toHome: Array<{ message: unknown; origin: string }> = [];
    const popup = {
      closed: false,
      close() {},
      postMessage: (message: unknown, origin: string) => toHome.push({ message, origin }),
    };
    type Heard = { source: unknown; origin: string; data: unknown };
    const listeners = new Set<(event: Heard) => void>();
    const g: {
      open?: unknown;
      location?: unknown;
      addEventListener?: unknown;
      removeEventListener?: unknown;
    } = globalThis;
    const saved = {
      open: g.open,
      location: g.location,
      addEventListener: g.addEventListener,
      removeEventListener: g.removeEventListener,
    };
    Object.assign(g, {
      open: () => popup,
      location: { href: 'https://app.test/' },
      addEventListener: (_type: string, listener: (event: Heard) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: Heard) => void) => listeners.delete(listener),
    });
    const fromHome = (data: unknown) => {
      for (const listener of [...listeners]) listener({ source: popup, origin: 'https://home.test', data });
    };
    try {
      const asking = connectToHome({ home: 'https://home.test/connect', key, request: { access: 'write' } });
      // The home loaded and said hello while the app was still making its proof.
      fromHome({ type: 'minca:hello' });
      await until(() => toHome.length > 0);
      const [sent] = toHome;
      assert.equal(sent?.origin, 'https://home.test', 'only to the home');
      assert.ok(isRecord(sent?.message) && sent.message.type === 'minca:request');
      assert.ok(isRecord(sent.message.request) && sent.message.request.audience === key.did);
      // The hello may be missed altogether: the request is sent again until the home answers, to it alone.
      const before = toHome.length;
      await until(() => toHome.length > before);
      assert.ok(toHome.every((m) => m.origin === 'https://home.test'));
      fromHome({ type: 'minca:denied', reason: 'Not now' });
      await assert.rejects(asking, /Not now/);
      const after = toHome.length;
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(toHome.length, after, 'and stops once answered');
    } finally {
      Object.assign(g, saved);
    }
  });
});

describe('the home receiving a request', () => {
  /** The fields of a message event the home reads */
  type PageMessage = { source: unknown; data: unknown; origin: string };

  const isDenied = (message: unknown) => isRecord(message) && message.type === 'minca:denied';

  /** Stands in for the popup's window: an opener, and the page's message events. */
  function popupWindow() {
    const sent: Array<{ message: unknown; origin: string }> = [];
    const listeners = new Set<(event: PageMessage) => void>();
    const opener = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
    const g: {
      opener?: unknown;
      addEventListener?: unknown;
      removeEventListener?: unknown;
      close?: unknown;
    } = globalThis;
    const saved = {
      opener: g.opener,
      add: g.addEventListener,
      remove: g.removeEventListener,
      close: g.close,
    };
    g.opener = opener;
    g.addEventListener = (_type: string, listener: (event: PageMessage) => void) => listeners.add(listener);
    g.removeEventListener = (_type: string, listener: (event: PageMessage) => void) =>
      listeners.delete(listener);
    g.close = () => {};
    return {
      sent,
      send: (data: unknown, origin = 'https://app.test') => {
        for (const listener of [...listeners]) listener({ source: opener, data, origin });
      },
      restore: () =>
        Object.assign(g, {
          opener: saved.opener,
          addEventListener: saved.add,
          removeEventListener: saved.remove,
          close: saved.close,
        }),
    };
  }

  const isHello = (message: unknown) => isRecord(message) && message.type === 'minca:hello';

  test('it says hello once, and still takes a request that comes much later', async () => {
    const popup = popupWindow();
    try {
      const { receiveConnectRequest } = await import('../src/session/connect.js');
      const received = receiveConnectRequest(5000);
      // A phone that paused the app's tab: its request comes when the tab runs again.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const hellos = popup.sent.filter((m) => isHello(m.message));
      assert.equal(
        hellos.length,
        1,
        'a page that takes over the app’s tab later is not told where the home is',
      );
      assert.equal(hellos[0]?.origin, '*', 'a hello carries nothing secret');
      popup.send({
        type: 'minca:request',
        request: await asked({ v: 1, audience: 'did:key:zApp', access: 'write' }),
      });
      const incoming = await received;
      assert.equal(incoming?.origin, 'https://app.test');
    } finally {
      popup.restore();
    }
  });

  test('it stops waiting when the app that opened it is gone', async () => {
    const popup = popupWindow();
    try {
      const { receiveConnectRequest } = await import('../src/session/connect.js');
      const received = receiveConnectRequest(60_000);
      const g: { opener?: unknown } = globalThis;
      if (isRecord(g.opener)) g.opener.closed = true;
      assert.equal(await received, null);
    } finally {
      popup.restore();
    }
  });

  test('a request it cannot read is refused out loud, not left waiting', async () => {
    const popup = popupWindow();
    try {
      const { receiveConnectRequest } = await import('../src/session/connect.js');
      const received = receiveConnectRequest(1000);
      popup.send({
        type: 'minca:request',
        request: await asked({ v: 1, audience: 'did:key:zApp', access: 'something-new' }),
      });
      assert.equal(await received, null);
      const denied = popup.sent.find((m) => isDenied(m.message));
      assert.ok(denied, 'the app is told');
      assert.equal(denied.origin, 'https://app.test', 'and only the app that asked');
      assert.ok(isRecord(denied.message) && typeof denied.message.reason === 'string');
      assert.match(denied.message.reason, /did not understand/);
      await new Promise((resolve) => setTimeout(resolve, 150)); // the window closes itself a moment later
    } finally {
      popup.restore();
    }
  });

  test('a request with a field it does not know is refused, subscriptions while connecting included', async () => {
    const { receiveConnectRequest } = await import('../src/session/connect.js');
    for (const request of [
      await asked({
        v: 1,
        audience: 'did:key:zChat',
        access: 'write',
        automations: [notifyOn('New message', 'app.chat.message')],
      }),
      { v: 2, kind: 'propose', automations: [notifyOn('New', 'app.chat.message')], extra: true },
      // There is no kind of key to name, only what it may do.
      await asked({ v: 1, audience: 'did:key:zOld', access: 'write', agent: true }),
      // Records only goes with no contacts, no spaces made for it and no carrying; a program by code carries nothing.
      await asked({ v: 1, audience: 'did:key:zNarrow', access: 'write', recordsOnly: true, contacts: true }),
      await asked({
        v: 1,
        audience: 'did:key:zNarrow',
        access: 'write',
        recordsOnly: true,
        create: [{ name: 'Mine', visibility: 'private' }],
      }),
      await asked({ v: 1, audience: 'did:key:zNarrow', access: 'carry', recordsOnly: true }),
      await asked(
        { v: 1, audience: 'did:key:zByCode', access: 'carry', via: 'code' },
        undefined,
        'https://x.test',
      ),
      { ...(await asked({ v: 1, audience: 'did:key:zByCode', access: 'write' })), via: 'popup' },
    ]) {
      const popup = popupWindow();
      try {
        const received = receiveConnectRequest(1000);
        popup.send({ type: 'minca:request', request });
        assert.equal(await received, null);
        assert.ok(popup.sent.some((m) => isDenied(m.message)));
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        popup.restore();
      }
    }
  });

  test('a proposed subscription whose click leads to another site, or that names a protocol collection, is refused', async () => {
    const { receiveConnectRequest } = await import('../src/session/connect.js');
    const asked = [
      {
        v: 2,
        kind: 'propose',
        automations: [{ ...notifyOn('New', 'app.chat.message'), open: 'https://elsewhere.test/' }],
      },
      { v: 2, kind: 'propose', automations: [notifyOn('New', 'sys.wake')] },
    ];
    for (const request of asked) {
      const popup = popupWindow();
      try {
        const received = receiveConnectRequest(1000);
        popup.send({ type: 'minca:request', request });
        assert.equal(await received, null);
        assert.ok(popup.sent.some((m) => isDenied(m.message)));
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        popup.restore();
      }
    }
    const popup = popupWindow();
    try {
      const received = receiveConnectRequest(1000);
      popup.send({
        type: 'minca:request',
        request: {
          v: 2,
          kind: 'propose',
          automations: [{ ...notifyOn('New', 'app.chat.message'), open: 'https://app.test/inbox' }],
        },
      });
      const incoming = await received;
      assert.ok(incoming && 'kind' in incoming.request, 'one leading back to the app is read');
      assert.equal(incoming.request.automations.length, 1);
    } finally {
      popup.restore();
    }
  });
  test('a carry request is read', async () => {
    const popup = popupWindow();
    try {
      const { receiveConnectRequest, isProposeRequest } = await import('../src/session/connect.js');
      const received = receiveConnectRequest(1000);
      popup.send(
        {
          type: 'minca:request',
          request: await asked({
            v: 1,
            audience: 'did:key:zCarrier',
            access: 'carry',
            name: 'Minca for Chrome',
          }),
        },
        'chrome-extension://abc',
      );
      const incoming = await received;
      assert.ok(incoming && !isProposeRequest(incoming.request));
      assert.equal(incoming.request.access, 'carry');
      assert.equal(incoming?.origin, 'chrome-extension://abc');
    } finally {
      popup.restore();
    }
  });

  test('a proposal is read, and one with nothing in it, or asking for more, is refused', async () => {
    const { receiveConnectRequest, isProposeRequest } = await import('../src/session/connect.js');
    const origin = 'https://app.test';
    for (const request of [
      { v: 2, kind: 'propose', automations: [] },
      { v: 2, kind: 'propose', automations: [notifyOn('New', 'sys.wake')] },
      { v: 1, kind: 'something-new', automations: [notifyOn('New', 'app.chat.message')] },
    ]) {
      const popup = popupWindow();
      try {
        const received = receiveConnectRequest(1000);
        popup.send({ type: 'minca:request', request }, origin);
        assert.equal(await received, null);
        assert.ok(popup.sent.some((m) => isDenied(m.message)));
        await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        popup.restore();
      }
    }
    const popup = popupWindow();
    try {
      const received = receiveConnectRequest(1000);
      popup.send(
        {
          type: 'minca:request',
          request: {
            v: 2,
            kind: 'propose',
            automations: [{ ...notifyOn('New', 'app.chat.message'), spaces: ['s1'] }],
          },
        },
        origin,
      );
      const incoming = await received;
      assert.ok(incoming && isProposeRequest(incoming.request));
      assert.equal(incoming.origin, origin);
    } finally {
      popup.restore();
    }
  });
});
