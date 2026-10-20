/**
 * Taking up a sign-in another tab keeps: a phone pairs in the tab its camera
 * opened, while the app that sent it to sign in waits in another. The waiting
 * tab signs in as a refresh would, and never beside a sign-in of its own:
 * two nodes in one tab would leave one running, unrevoked, after sign-out.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMincaAuth,
  type MincaAuth,
  type MincaAuthConfig,
  type MincaSession,
} from '../src/session/auth.js';
import type { KeyValueStore } from '../src/session/stay-signed-in.js';
import { createFolderAccountStore } from '../src/identity/account-store.js';
import { createMemoryDirectory } from './helpers/memory-directory.js';
import { memoryStores } from './helpers/memory-stores.js';
import { until } from './helpers/until.js';
import { createFakeHub } from './helpers/fake-transport.js';
import type { PairingStage } from '../src/session/pairing.js';
import { encodePairingTicket } from '../src/identity/pairing.js';
import { base64UrlEncode } from '../src/utils/encoding.js';

// ── A page: device keys need IndexedDB, and tabs hear each other through `storage` events ──

/** Just enough IndexedDB for `identity/idb.ts`: one map per database, answered on the next tick */
function memoryIndexedDb() {
  const databases = new Map<string, Map<string, unknown>>();
  const later = (fn: () => void) => void setTimeout(fn, 1);
  const request = (produce: () => unknown, done?: () => void) => {
    const asked: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      onsuccess: null,
      onerror: null,
    };
    later(() => {
      asked.result = produce();
      asked.onsuccess?.();
      if (done) later(done);
    });
    return asked;
  };
  return {
    open(name: string) {
      const opening: { result: unknown; onsuccess: (() => void) | null; onupgradeneeded: null } = {
        result: null,
        onsuccess: null,
        onupgradeneeded: null,
      };
      later(() => {
        const data = databases.get(name) ?? databases.set(name, new Map()).get(name)!;
        opening.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const tx: {
              oncomplete: (() => void) | null;
              onerror: null;
              onabort: null;
              objectStore: () => unknown;
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                put: (value: unknown, key: string) =>
                  request(
                    () => (data.set(key, value), key),
                    () => tx.oncomplete?.(),
                  ),
                get: (key: string) => request(() => data.get(key)),
                delete: (key: string) =>
                  request(
                    () => void data.delete(key),
                    () => tx.oncomplete?.(),
                  ),
              }),
            };
            return tx;
          },
        };
        opening.onsuccess?.();
      });
      return opening;
    },
  };
}

const page = new EventTarget();
const scope: Record<string, unknown> = globalThis;
const before = { indexedDB: scope.indexedDB, addEventListener: scope.addEventListener };
scope.indexedDB = memoryIndexedDb();
scope.addEventListener = page.addEventListener.bind(page);
after(() => Object.assign(scope, before));

/** One browser profile: every tab shares its storage and its accounts */
function browser() {
  const values = new Map<string, string>();
  const writes = new Set<(key: string) => void>();
  const storage: KeyValueStore = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
      for (const heard of writes) heard(key);
    },
    removeItem: (key) => void values.delete(key),
  };
  const accounts = createFolderAccountStore(createMemoryDirectory().handle);
  const stores = new Map<string, ReturnType<typeof memoryStores>>();
  const config: MincaAuthConfig = {
    rpId: 'example.test',
    storage,
    browser: {
      accounts: async () => accounts,
      stores: (account) => stores.get(account.id) ?? stores.set(account.id, memoryStores()).get(account.id)!,
    },
  };
  /** What another tab's write looks like from here; `newValue` may be stale by the time it arrives */
  const otherTabWrote = (newValue = storage.getItem('minca.remembered-session')) => {
    const event = Object.assign(new Event('storage'), { key: 'minca.remembered-session', newValue });
    page.dispatchEvent(event);
  };
  return { config, storage, writes, otherTabWrote };
}

/** Every session a tab ever holds */
function sessionsOf(auth: ReturnType<typeof createMincaAuth>): Set<MincaSession> {
  const seen = new Set<MincaSession>();
  auth.subscribe((state) => void (state.session && seen.add(state.session)));
  return seen;
}

async function signedInTab(config: MincaAuthConfig, name = 'Ada') {
  const tab = createMincaAuth(config);
  await tab.start();
  await tab.createAccount(name);
  tab.codeSaved();
  assert.equal(await tab.setPassword('correct horse battery'), true);
  return tab;
}

describe('a sign-in kept in another tab', () => {
  test('is taken up by a tab that is signed out and waiting', async () => {
    const { config, storage, otherTabWrote } = browser();
    const waiting = createMincaAuth(config);
    await waiting.start();
    assert.equal(waiting.getState().stage, 'welcome');

    const paired = await signedInTab(config);
    const keyOf = () => storage.getItem('minca.remembered-session')?.match(/"deviceKeyId":"([^"]+)"/)?.[1];
    const kept = keyOf();
    assert.ok(kept);
    otherTabWrote();

    await until(() => waiting.getState().stage === 'ready', 5000, 'the waiting tab to sign in');
    assert.equal(waiting.getState().session?.did, paired.getState().session?.did);
    assert.equal(keyOf(), kept, 'taking up does not replace the key other tabs read');
    await waiting.signOut();
    await paired.signOut();
  });

  test('never starts a second node beside a sign-in by hand', async () => {
    const { config, writes, otherTabWrote } = browser();
    const waiting = createMincaAuth(config);
    await waiting.start();
    const paired = await signedInTab(config);
    await paired.confirm({ password: 'correct horse battery' });
    const code = paired.recoveryCode()!;
    const seen = sessionsOf(waiting);

    // The person signs in by hand while the take-up is starting its node, just after it notes the account.
    const byHand: Promise<void>[] = [];
    writes.add((key) => {
      if (key === 'minca.last-account' && byHand.length === 0) byHand.push(waiting.signInWithCode(code));
    });
    otherTabWrote();
    await until(() => byHand.length > 0, 5000, 'the take-up to start');
    await Promise.all(byHand);
    await until(() => !waiting.getState().busy, 5000, 'the tab to settle');

    await waiting.signOut();
    await paired.signOut();
    // The take-up may land first and the sign-in by hand replace it: neither node outlives signing out.
    for (const session of seen)
      await assert.rejects(session.node.spaces.create({ name: 'after sign-out', visibility: 'private' }));
  });

  test('never starts a second node beside the tab starting up', async () => {
    const { config, otherTabWrote } = browser();
    const first = await signedInTab(config);

    const restored = createMincaAuth(config);
    const seen = sessionsOf(restored);
    let fired = false;
    restored.subscribe((state) => {
      if (!fired && state.place && state.accounts.length > 0 && !state.session) {
        fired = true;
        otherTabWrote();
      }
    });
    await restored.start();
    await until(() => !restored.getState().busy, 5000, 'the tab to settle');

    assert.equal(seen.size, 1, 'one node for one tab');
    await restored.signOut();
    await first.signOut();
  });

  test('is not taken up after a sign-out in another tab', async () => {
    const { config, otherTabWrote } = browser();
    const waiting = createMincaAuth(config);
    await waiting.start();
    const paired = await signedInTab(config);
    const kept = paired.getState().session && config.storage?.getItem('minca.remembered-session');
    await paired.signOut();
    otherTabWrote(kept || null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(waiting.getState().session, null);
  });
  test('goes when the person signs out in the tab they took it from', async () => {
    const { config, otherTabWrote } = browser();
    const waiting = createMincaAuth(config);
    await waiting.start();
    const paired = await signedInTab(config);
    otherTabWrote();
    await until(() => waiting.getState().stage === 'ready', 5000, 'the waiting tab to sign in');
    const taken = waiting.getState().session!;

    await paired.signOut();
    otherTabWrote(null);
    await until(() => waiting.getState().session === null, 5000, 'the waiting tab to sign out');
    await assert.rejects(taken.node.spaces.create({ name: 'after sign-out', visibility: 'private' }));
  });

  test('does not switch a tab where the person picked another account', async () => {
    const { config, otherTabWrote } = browser();
    const ada = await signedInTab(config);
    await ada.signOut();

    const waiting = createMincaAuth(config);
    await waiting.start();
    assert.equal(waiting.getState().stage, 'signIn');
    const adaId = waiting.getState().accounts[0]!.id;
    await waiting.select(adaId);

    const other = createMincaAuth(config);
    await other.start();
    other.startCreating();
    await other.createAccount('Bob');
    other.codeSaved();
    assert.equal(await other.setPassword('correct horse battery'), true);
    otherTabWrote();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await until(() => !waiting.getState().busy, 5000, 'the tab to settle');

    assert.equal(waiting.getState().session, null, 'still waiting for Ada');
    assert.equal(waiting.getState().selectedId, adaId);
    await other.signOut();
  });
});

describe('a pairing link opened where a sign-in is kept', () => {
  /** A tab opened from a phone-pairing QR code */
  function openedFromPairingLink(config: MincaAuthConfig, link?: string) {
    const ticket = { v: 2, secret: base64UrlEncode(new Uint8Array(16)), relay: '' } as const;
    const was = { location: scope.location, history: scope.history };
    const hash = link ? link.slice(link.indexOf('#')) : `#pair=${encodePairingTicket(ticket)}`;
    scope.location = { hash, pathname: '/', search: '' };
    scope.history = { replaceState() {} };
    try {
      return createMincaAuth(config);
    } finally {
      Object.assign(scope, was);
    }
  }

  test('still asks before pairing, signed in, and going back keeps that account', async () => {
    const { config } = browser();
    const first = await signedInTab(config);
    const did = first.getState().session?.did;

    const phone = openedFromPairingLink(config);
    await phone.start();
    assert.equal(phone.getState().stage, 'pair', 'the kept sign-in does not skip the warning');
    assert.ok(phone.getState().pairing);
    assert.equal(phone.getState().session?.did, did, 'it says who this device is signed in as');

    phone.dismissPairing();
    assert.equal(phone.getState().stage, 'ready');
    assert.equal(phone.getState().session?.did, did);
    await phone.signOut();
    await first.signOut();
  });

  /** A computer signed in as Ada showing a pairing code, and a phone signed in as Bob that opened it */
  async function pairing(
    options: { adaOnPhone?: boolean; signedIn?: boolean; beforeConfirm?: (phone: MincaAuth) => void } = {},
  ) {
    const hub = createFakeHub({ latencyMs: 1 });
    const pairingTransport = (did: string) => hub.transport(did, 'pair');
    const computer = await signedInTab({ ...browser().config, pairingTransport });
    const ada = computer.getState().session!.did;
    assert.equal(await computer.confirm({ password: 'correct horse battery' }), true);
    const phoneConfig = { ...browser().config, pairingTransport };
    if (options.adaOnPhone) {
      const before = createMincaAuth(phoneConfig);
      await before.start();
      await before.signInWithCode(computer.recoveryCode()!);
      await before.setPassword('correct horse battery');
      await before.signOut();
    }
    const bobTab = options.signedIn === false ? null : await signedInTab(phoneConfig, 'Bob');
    const bob = bobTab?.getState().session?.did ?? null;
    const stages: PairingStage[] = [];
    const offer = await computer.offerToPhone((stage) => stages.push(stage));
    const phone = openedFromPairingLink(phoneConfig, offer.url);
    await phone.start();
    assert.equal(phone.getState().session?.did ?? null, bob);

    const accepting = phone.acceptPairing();
    await until(() => stages.some((stage) => stage.kind === 'compare'), 5000, 'the codes to show');
    const compare = stages.find((stage) => stage.kind === 'compare');
    assert.ok(compare?.kind === 'compare');
    options.beforeConfirm?.(phone);
    compare.same();
    await accepting;
    const done = async () => {
      offer.stop();
      await Promise.all([phone.signOut(), bobTab?.signOut(), computer.signOut()]);
    };
    return { phone, ada, bob, stages, done };
  }

  test('signed in as another, it asks to add the account that arrived, and keeps the other', async () => {
    const { phone, ada, bob, done } = await pairing();
    const asked = phone.getState();
    assert.equal(asked.session?.did, bob, 'nothing switches before the person answers');
    assert.deepEqual(asked.pairingArrival, { did: ada, account: null });

    await phone.answerPairing(true);
    assert.equal(phone.getState().session?.did, ada);
    const kept = phone.getState().accounts.map((account) => account.did);
    assert.ok(bob && kept.includes(bob) && kept.includes(ada), 'both accounts are on the phone');
    await done();
  });

  test('an account already on the phone is offered as a switch', async () => {
    const { phone, ada, done } = await pairing({ adaOnPhone: true });
    const arrival = phone.getState().pairingArrival;
    assert.equal(arrival?.did, ada);
    assert.equal(arrival?.account?.did, ada, 'it names the account this phone keeps');
    await phone.answerPairing(true);
    assert.equal(phone.getState().session?.did, ada);
    assert.equal(phone.getState().stage, 'ready', 'it has a way in here already');
    // The computer was asked, not this phone: giving an app access here asks again.
    assert.equal(phone.mayGrant(), false);
    await done();
  });

  test('saying no keeps the phone as it was', async () => {
    const { phone, ada, bob, done } = await pairing();
    await phone.answerPairing(false);
    assert.equal(phone.getState().session?.did, bob);
    assert.equal(phone.getState().stage, 'ready');
    assert.ok(!phone.getState().accounts.some((account) => account.did === ada), 'the account was not filed');
    await done();
  });
  test('"Not now" while the code shows stops the pairing, even if the computer confirms after', async () => {
    const { phone, ada, stages, done } = await pairing({
      signedIn: false,
      beforeConfirm: (tab) => tab.dismissPairing(),
    });
    await new Promise((settle) => setTimeout(settle, 200));
    assert.equal(phone.getState().busy, false, 'the screen it went back to is not held up');
    assert.equal(phone.getState().error, null, 'stopping is not an error');
    assert.ok(!stages.some((stage) => stage.kind === 'sent'), 'the computer is not told it arrived');
    assert.equal(phone.getState().session, null, 'nothing was signed in');
    assert.equal(phone.getState().pairingArrival, null);
    assert.ok(!phone.getState().accounts.some((account) => account.did === ada), 'the account was not filed');
    await done();
  });
});
