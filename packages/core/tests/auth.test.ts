/**
 * The sign-in flow as state: creating an account, signing out and back in with
 * its password, and the mistakes it has to explain.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  createMincaAuth,
  type MincaAuth,
  type MincaAuthConfig,
  type AuthState,
} from '../src/session/auth.js';
import type { KeyValueStore } from '../src/session/stay-signed-in.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';

function memoryStorage(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** A flow whose "browser" is in memory, so it runs here as it would in a page. */
function testAuth(config: Partial<MincaAuthConfig> = {}): MincaAuth {
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const stores = new Map<string, ReturnType<typeof memoryStores>>();
  const storage = memoryStorage();
  // Staying signed in keeps a key in IndexedDB, which Node does not have.
  storage.setItem('minca.stay-signed-in', JSON.stringify('never'));
  return createMincaAuth({
    ...config,
    rpId: 'example.test',
    storage,
    browser: {
      accounts: async () => accounts,
      stores: (account) => {
        let factory = stores.get(account.id);
        if (!factory) stores.set(account.id, (factory = memoryStores()));
        return factory;
      },
    },
  });
}

const open: MincaAuth[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((auth) => auth.signOut()));
});

function started(config: Partial<MincaAuthConfig> = {}): MincaAuth {
  const auth = testAuth(config);
  open.push(auth);
  return auth;
}

const PASSWORD = 'correct horse battery';

/** Makes an account the whole way: name, recovery code, password. Returns its recovery code. */
async function createAccount(auth: MincaAuth, name: string, password = PASSWORD): Promise<string> {
  await auth.createAccount(name);
  const code = auth.getState().freshCode!;
  auth.codeSaved();
  assert.equal(await auth.setPassword(password), true, auth.getState().error?.message ?? 'no reason given');
  return code;
}

describe('createMincaAuth', () => {
  test('an empty place asks whether you have an account', async () => {
    const auth = started();
    await auth.start();
    assert.equal(auth.getState().stage, 'welcome');
    assert.equal(auth.getState().place?.kind, 'browser');
  });

  test('creating an account shows the recovery code, then asks for an everyday way in', async () => {
    const auth = started();
    await auth.start();
    auth.startCreating();
    await auth.createAccount('Ada');

    const made = auth.getState();
    assert.equal(made.stage, 'recovery');
    assert.equal(made.setup, 'new');
    assert.ok(made.freshCode, 'the recovery code is shown');
    assert.equal(made.session?.account.name, 'Ada');
    assert.equal(auth.recoveryCode(), null, 'shown once here; reading it later takes proof it is you');

    auth.codeSaved();
    assert.equal(auth.getState().stage, 'unlock', 'a passkey or password is not optional');
    assert.equal(auth.getState().freshCode, null);

    assert.equal(await auth.setPassword(PASSWORD), true);
    // No pod to offer here: Node cannot open folders.
    assert.equal(auth.getState().stage, 'ready');
    assert.equal(auth.getState().setup, null);
    assert.equal(auth.getState().entry?.hasPassword, true);
  });

  test('a short password is taken, and opens the account again', async () => {
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();

    assert.equal(await auth.setPassword('abc'), true, auth.getState().error?.message ?? 'no reason given');
    const did = auth.getState().session!.did;
    await auth.signOut();
    await auth.signInWithPassword('abc');
    assert.equal(auth.getState().stage, 'ready');
    assert.equal(auth.getState().session?.did, did);
  });

  test('an empty password is refused, and the flow waits', async () => {
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    auth.codeSaved();

    assert.equal(await auth.setPassword(''), false);
    assert.equal(auth.getState().stage, 'unlock');
    assert.match(auth.getState().error?.message ?? '', /Choose a password/);
  });

  test('signing out and back in with the password is the same account', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    const did = auth.getState().session!.did;

    const space = await auth.getState().session!.node.spaces.create({ name: 'Notes', visibility: 'private' });

    // With no network there is nobody to wait for: signing out doesn't sit out its grace.
    const signingOut = Date.now();
    await auth.signOut();
    assert.ok(Date.now() - signingOut < 4000, 'waited for a peer with no network to bring one');
    assert.equal(auth.getState().session, null);
    assert.equal(auth.getState().stage, 'signIn');
    assert.equal(auth.getState().entry?.hasPassword, true);

    await auth.signInWithPassword(PASSWORD);
    const back = auth.getState();
    assert.equal(back.stage, 'ready');
    assert.equal(back.session?.did, did);
    assert.deepEqual(
      (await back.session.node.spaces.list()).map((s) => s.id),
      [space.id],
    );
  });

  test('a wrong password is refused', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    await auth.signOut();

    await auth.signInWithPassword('not the password');
    assert.equal(auth.getState().session, null);
    assert.equal(auth.getState().error?.code, 'VAULT_UNLOCK_FAILED');
  });

  test('changing the password stops the old one working', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    assert.equal(await auth.confirm({ password: PASSWORD }), true);
    assert.equal(await auth.setPassword('a different one entirely'), true);
    assert.equal(auth.getState().entry?.vault.wraps.filter((wrap) => wrap.kind === 'passphrase').length, 1);
    await auth.signOut();

    await auth.signInWithPassword(PASSWORD);
    assert.equal(auth.getState().session, null);
    await auth.signInWithPassword('a different one entirely');
    assert.equal(auth.getState().stage, 'ready');
  });

  test('the recovery code still opens an account that has a password, straight in', async () => {
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    await auth.signOut();

    auth.showRestore();
    await auth.signInWithCode(code);
    assert.equal(auth.getState().stage, 'ready');
  });

  test('restoring on a new device goes straight on to set up a way in there', async () => {
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    const did = auth.getState().session!.did;

    const elsewhere = started();
    await elsewhere.start();
    elsewhere.showExisting();
    assert.equal(elsewhere.getState().stage, 'existing');
    elsewhere.showRestore();
    await elsewhere.signInWithCode(code);

    const restored = elsewhere.getState();
    assert.equal(restored.session?.did, did);
    assert.equal(restored.stage, 'unlock', 'the person just typed the code: it is not shown back to them');
    assert.equal(restored.setup, 'restored');
    assert.equal(restored.freshCode, null);
    await elsewhere.setPassword(PASSWORD);
    assert.equal(elsewhere.getState().stage, 'ready');
  });

  test('a recovery code filled into the password field still opens the account', async () => {
    // Before passwords, the recovery code was the login, and managers still fill it.
    const auth = started();
    await auth.start();
    await auth.createAccount('Ada');
    const code = auth.getState().freshCode!;
    const did = auth.getState().session!.did;
    await auth.signOut();

    await auth.signInWithPassword(code);
    assert.equal(auth.getState().session?.did, did);
    assert.equal(auth.getState().stage, 'unlock');
  });

  test('a recovery code for another account is refused with a reason', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    await auth.signOut();

    const other = testAuth();
    await other.start();
    await other.createAccount('Grace');
    const graces = other.getState().freshCode!;
    await other.signOut();

    await auth.signInWithCode(graces);
    const state: AuthState = auth.getState();
    assert.equal(state.session, null);
    assert.match(state.error?.message ?? '', /different account, not Ada/);
  });

  test('a recovery code after "another account" opens that account, not the one listed', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    await auth.signOut();

    const other = testAuth();
    await other.start();
    await other.createAccount('Grace');
    const graces = other.getState().freshCode!;
    const graceDid = other.getState().session!.did;
    await other.signOut();

    auth.showExisting();
    auth.showRestore();
    await auth.signInWithCode(graces);
    assert.equal(auth.getState().error, null);
    assert.equal(auth.getState().session?.did, graceDid);
  });

  test('something that is not a recovery code says what one looks like', async () => {
    const auth = started();
    await auth.start();
    await auth.signInWithCode('hunter2');
    assert.equal(auth.getState().error?.code, 'VAULT_UNLOCK_FAILED');
    assert.ok(auth.getState().error?.hint);
    assert.equal(auth.getState().busy, false);
  });

  test('where folders can be picked, a new account is offered a pod, unless the page says not to', async () => {
    // The flow looks for the picker when it is made.
    Object.defineProperty(globalThis, 'showDirectoryPicker', { value: () => {}, configurable: true });
    try {
      const offered = started();
      const declined = started({ offerPod: false });
      for (const auth of [offered, declined]) {
        await auth.start();
        auth.startCreating();
        await createAccount(auth, 'Ada');
      }
      assert.equal(offered.getState().stage, 'pod');
      assert.equal(declined.getState().stage, 'ready');
      assert.equal(declined.getState().setup, null);
    } finally {
      Reflect.deleteProperty(globalThis, 'showDirectoryPicker');
    }
  });

  test('with a host, a new account is kept online with nothing to choose: it goes in while the host is handed the spaces', async () => {
    // Nothing answers at this address: the handover fails in the background, and nothing waits on it but `settled`.
    Object.defineProperty(globalThis, 'showDirectoryPicker', { value: () => {}, configurable: true });
    try {
      const auth = started({ network: { hosts: ['http://127.0.0.1:9'] } });
      await auth.start();
      auth.startCreating();
      await createAccount(auth, 'Ada');
      // No pod offered either: kept online, a folder is for later, on the account page.
      assert.equal(auth.getState().stage, 'ready');
      assert.equal(auth.getState().setup, null);
      await auth.settled();
    } finally {
      Reflect.deleteProperty(globalThis, 'showDirectoryPicker');
    }
  });

  /** A host that only describes itself, at a local address; `limits` makes it keep accounts with nothing paid */
  async function describedHost(limits: boolean): Promise<{ url: string; close: () => void }> {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          minca: 'host/1',
          did: 'did:key:zDnaeaALTBzySrYHGFnMoDgD9BAQYYcPkB9nXFyPwqLJUFZRL',
          name: 'Test host',
          free: false,
          price: '$0.10 a GB a month',
          fund: { perGb: '0.10', min: '5', methods: ['request'], recurring: false },
          ...(limits
            ? {
                limits: {
                  accountBytes: 250_000_000,
                  space: { writers: 10, bytes: 500_000_000, windowDays: 30, readers: 50 },
                  graceDays: 30,
                  keepDays: 30,
                  idleDays: 180,
                },
              }
            : {}),
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  for (const [limits, what] of [
    [
      true,
      'a host that keeps accounts with nothing paid is used, though setting a way in started a new session',
    ],
    [false, 'a host that only keeps paid accounts is never signed up for by itself'],
  ] as const)
    test(what, async () => {
      const host = await describedHost(limits);
      try {
        const auth = started({ network: { hosts: [host.url] } });
        await auth.start();
        auth.startCreating();
        await createAccount(auth, 'Ada');
        await auth.settled();
        const used = (await auth.getState().session!.node.hosting.list()).map((view) => view.url);
        assert.deepEqual(used, limits ? [host.url] : []);
      } finally {
        host.close();
      }
    });

  test('reading the recovery code or offering the account to a phone takes proof it is you', async () => {
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    assert.equal(auth.recoveryCode(), null, 'a page left open hands out nothing');
    await assert.rejects(
      auth.offerToPhone(() => {}),
      /Confirm it is you/,
    );

    assert.equal(await auth.confirm({ password: 'not the password' }), false);
    assert.equal(auth.recoveryCode(), null);
    assert.ok(auth.getState().error, 'a wrong answer says so');
    assert.equal(await auth.confirm({ code: '0000-0000-0000-0000-0000-0000-00' }), false, 'nor another code');

    assert.equal(await auth.confirm({ password: PASSWORD }), true);
    assert.equal(auth.recoveryCode(), code);

    await auth.signOut();
    await auth.signInWithPassword(PASSWORD);
    assert.equal(auth.recoveryCode(), null, 'a new sign-in asks again');
    assert.equal(await auth.confirm({ code }), true, 'the recovery code is proof too');
    assert.equal(auth.recoveryCode(), code);
  });

  test('changing how the account signs in takes proof it is you, once it is set up', async () => {
    // Otherwise a new password would open the gate to the recovery code, and lock the owner out.
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    assert.equal(await auth.setPassword('chosen by whoever sat down'), false);
    assert.equal(await auth.removeShortcut('passphrase'), false);
    assert.equal(await auth.confirm({ password: 'chosen by whoever sat down' }), false);
    assert.equal(auth.recoveryCode(), null);

    await auth.signOut();
    await auth.signInWithPassword(PASSWORD);
    assert.equal(auth.getState().stage, 'ready', 'the owner’s password still opens it');
  });

  test('no call steps back into setup to skip the proof', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    auth.codeSaved();
    auth.finishSetup();
    assert.equal(auth.getState().stage, 'ready', 'neither reopens setup once it is done');
    assert.equal(await auth.setPassword('chosen by whoever sat down'), false);
    assert.equal(await auth.confirm({ password: 'chosen by whoever sat down' }), false);
  });

  test('proof is for one account, and does not carry over to another', async () => {
    const auth = started();
    await auth.start();
    await createAccount(auth, 'Ada');
    assert.equal(await auth.confirm({ password: PASSWORD }), true);
    await auth.signOut();
    await createAccount(auth, 'Bob');
    assert.equal(auth.isConfirmed(), false);
    assert.equal(auth.recoveryCode(), null);
  });

  test('subscribers hear every change', async () => {
    const auth = started();
    const stages: string[] = [];
    auth.subscribe((state) => stages.push(state.stage));
    await auth.start();
    await createAccount(auth, 'Ada');
    assert.equal(stages.at(-1), 'ready');
    for (const stage of ['welcome', 'recovery', 'unlock']) assert.ok(stages.includes(stage), stage);
  });
});

describe('passwords beside the CLI', () => {
  test('setting a password keeps the CLI passphrase, and either opens the account', async () => {
    const { wrapSeedWithPassphrase, CLI_PASSPHRASE_LABEL } = await import('../src/identity/account-vault.js');
    const { recoveryCodeToSeed } = await import('../src/identity/recovery-code.js');
    const auth = started();
    await auth.start();
    const code = await createAccount(auth, 'Ada');
    const { place, session } = auth.getState();
    const vault = (await place!.store.read(session!.account.id))!;
    const cli = await wrapSeedWithPassphrase(
      recoveryCodeToSeed(code),
      'unattended secret',
      CLI_PASSPHRASE_LABEL,
    );
    await place!.store.write(session!.account, { ...vault, wraps: [...vault.wraps, cli] });

    assert.equal(await auth.confirm({ code }), true);
    assert.equal(await auth.setPassword('a brand new password'), true);
    const labels = auth
      .getState()
      .entry!.vault.wraps.filter((wrap) => wrap.kind === 'passphrase')
      .map((wrap) => wrap.label);
    assert.deepEqual(labels.sort(), [CLI_PASSPHRASE_LABEL, 'Password'].sort());

    await auth.signOut();
    await auth.signInWithPassword('unattended secret');
    assert.equal(auth.getState().stage, 'ready');
    await auth.signOut();
    await auth.signInWithPassword('a brand new password');
    assert.equal(auth.getState().stage, 'ready');
  });
});
