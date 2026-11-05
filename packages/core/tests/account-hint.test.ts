/**
 * The account hint: an app saying, in the link to the account home, which
 * account it acts for. Only a hint, so anything that is not a DID is dropped.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { accountHomeLink, clearAccountHint, readAccountHint } from '../src/session/account-hint.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { createMincaConnection, openAccountHome } from '../src/session/connection.js';

const scope: Record<string, unknown> = globalThis;
const before = { location: scope.location, history: scope.history, open: scope.open };
afterEach(() => Object.assign(scope, before));

/** A page opened at `href`, whose address `replaceState` changes */
function openedAt(href: string) {
  const url = new URL(href);
  const location = { hash: url.hash, pathname: url.pathname, search: url.search };
  scope.location = location;
  scope.history = {
    replaceState(_state: unknown, _title: string, next: string) {
      const moved = new URL(next, url);
      Object.assign(location, { hash: moved.hash, pathname: moved.pathname, search: moved.search });
    },
  };
  return location;
}

describe('the account hint', () => {
  test('a link to the home names the account, beside the connect page, and reads back', async () => {
    const { did } = await createIdentityManager().fromSeed(generateSeed());
    const link = accountHomeLink('https://home.example/minca/connect', did);
    assert.equal(new URL(link).pathname, '/minca/');
    openedAt(link);
    assert.equal(readAccountHint(), did);
  });

  test('a section stays once the hint is taken out', async () => {
    const { did } = await createIdentityManager().fromSeed(generateSeed());
    const location = openedAt(accountHomeLink('https://home.example/', did, 'notifications'));
    assert.equal(readAccountHint(), did);
    clearAccountHint();
    assert.equal(location.hash, '#notifications');
    assert.equal(readAccountHint(), null);
  });

  test('anything that is not a DID is no hint', () => {
    for (const hash of ['#account=bob', '#account=%E0%A4%A', '#account=did:key:zNotAKey', '#account=', '']) {
      openedAt(`https://home.example/${hash}`);
      assert.equal(readAccountHint(), null, hash);
    }
  });
});

describe('opening the account home from an app', () => {
  /** Where `openHome` sends the browser, and in what window */
  function opened(section?: string) {
    const calls: unknown[][] = [];
    scope.open = (...args: unknown[]) => calls.push(args);
    const values = new Map<string, string>();
    const connection = createMincaConnection({
      home: 'https://home.example/minca/connect',
      request: { name: 'Todo', access: 'read' },
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
      },
    });
    connection.openHome(section);
    return calls;
  }

  test('before any account is connected it opens the account page, naming none', () => {
    const [[url, name, features] = []] = opened();
    assert.equal(url, 'https://home.example/minca/');
    assert.equal(name, 'minca-account');
    assert.match(String(features), /^popup,width=720,height=820/);
  });

  test('at a section, the section is the fragment', () => {
    const [[url] = []] = opened('notifications');
    assert.equal(url, 'https://home.example/minca/#notifications');
  });

  test('for a connected account, at the home it was connected at, naming it', async () => {
    const { did } = await createIdentityManager().fromSeed(generateSeed());
    const calls: unknown[][] = [];
    scope.open = (...args: unknown[]) => calls.push(args);
    openAccountHome(
      { home: 'https://default.example/connect', grant: { home: 'https://mine.example/connect', did } },
      'notifications',
    );
    const [[url] = []] = calls;
    const location = openedAt(String(url));
    assert.equal(new URL(String(url)).origin, 'https://mine.example');
    assert.equal(readAccountHint(), did);
    clearAccountHint();
    assert.equal(location.hash, '#notifications');
  });

  test('a section cannot add a hint of its own', () => {
    const [[url] = []] = opened('x&account=did:key:zDnaeOther');
    openedAt(String(url));
    assert.equal(readAccountHint(), null);
  });
});
