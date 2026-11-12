import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSeenStore } from '../src/seen-store.js';

const ACCOUNT = 'did:key:zAlice';

beforeEach(() => {
  const kept = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    },
  });
});

test('a look is kept for the next visit, and for that account only', () => {
  const store = createSeenStore(ACCOUNT);
  store.begin('climbing');
  const readUpTo = new Date(Date.parse(store.read().get('climbing')!.since) + 1).toISOString();
  // A look is never later than now, so wait out the millisecond it is dated in.
  while (new Date().toISOString() < readUpTo);
  store.look('climbing', 'chat', readUpTo);

  assert.equal(createSeenStore(ACCOUNT).read().get('climbing')?.apps.chat, readUpTo);
  assert.equal(createSeenStore('did:key:zBob').read().size, 0);
});

test('a look never moves back, and a record dated ahead reads only up to now', () => {
  const store = createSeenStore(ACCOUNT);
  store.begin('climbing');
  const began = store.read().get('climbing')!.since;

  store.look('climbing', 'chat', new Date(Date.parse(began) - 60_000).toISOString());
  assert.deepEqual(store.read().get('climbing')?.apps, {});

  while (new Date().toISOString() <= began);
  store.look('climbing', 'chat', '2999-01-01T00:00:00.000Z');
  const read = store.read().get('climbing')?.apps.chat;
  assert.ok(read && read > began && read <= new Date().toISOString(), `read up to ${read}`);
});

test('what is kept but is not a seen state is left out', () => {
  globalThis.localStorage.setItem(
    `minca.seen:${ACCOUNT}`,
    JSON.stringify({ climbing: { since: '2026-01-01T00:00:00.000Z', apps: {} }, broken: { apps: [] } }),
  );
  assert.deepEqual([...createSeenStore(ACCOUNT).read().keys()], ['climbing']);
});
