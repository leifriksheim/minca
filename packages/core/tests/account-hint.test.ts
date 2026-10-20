/**
 * The account hint: an app saying, in the link to the account home, which
 * account it acts for. Only a hint, so anything that is not a DID is dropped.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { accountHomeLink, clearAccountHint, readAccountHint } from '../src/session/account-hint.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { generateSeed } from '../src/identity/recovery-code.js';

const scope: Record<string, unknown> = globalThis;
const before = { location: scope.location, history: scope.history };
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
