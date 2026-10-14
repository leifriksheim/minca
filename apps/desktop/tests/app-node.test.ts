/**
 * The shell's side of the app's node: the key that seals its folder, kept in
 * the system's keychain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keychainKey } from '../src/bun/app-node.ts';

function fakeKeychain(start: string | null = null) {
  const kept = { value: start, writes: 0 };
  return {
    kept,
    secrets: {
      get: async () => kept.value,
      set: async ({ value }: { value: string }) => {
        kept.value = value;
        kept.writes += 1;
      },
    },
  };
}

test('the sealing key is made once, 32 random bytes, and read back after', async () => {
  const { kept, secrets } = fakeKeychain();
  const made = await keychainKey(secrets);
  assert.equal(Buffer.from(made, 'base64url').length, 32);
  assert.equal(await keychainKey(secrets), made);
  assert.equal(kept.writes, 1);
  assert.notEqual(await keychainKey(fakeKeychain().secrets), made);
});

test('something else under its name is never overwritten: it is left, and said', async () => {
  const { kept, secrets } = fakeKeychain('hunter2');
  await assert.rejects(keychainKey(secrets), /didn’t make/);
  assert.equal(kept.value, 'hunter2');
  assert.equal(kept.writes, 0);
});
