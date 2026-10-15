import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength } from '../src/session/password-strength.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { unwrapSeedWithPassphrase, wrapSeedWithPassphrase } from '../src/identity/account-vault.js';

describe('password strength', () => {
  test('an empty password says nothing', () => {
    assert.deepEqual(passwordStrength(''), { strength: 'weak', bits: 0, hint: '' });
  });

  test('short, repeated, sequential and common passwords are weak', () => {
    for (const weak of [
      'abc',
      'hunter2',
      '123456',
      'a'.repeat(60),
      'abcdefghijklmnop',
      'Password1!',
      'P@ssw0rd!',
      'qwerty2024',
      'summer2024',
      'iloveyou1234',
      'Passwordpassword',
      'password1password1',
    ]) {
      assert.equal(passwordStrength(weak).strength, 'weak', weak);
    }
  });

  test('a longer mix is fair, and a long one or a few words is strong', () => {
    assert.equal(passwordStrength('kettle9plum').strength, 'fair');
    assert.equal(passwordStrength('Tr0ub4dor&3').strength, 'strong');
    assert.equal(passwordStrength('correct horse battery staple').strength, 'strong');
    assert.equal(passwordStrength('x7#Kp2!vQ9@mL4zR').strength, 'strong');
  });

  test('every weak password still says why', () => {
    assert.match(passwordStrength('abc').hint, /^Weak/);
  });

  // The vault hashes the NFKC form (01 §11.3): a fullwidth password opens with its ASCII twin, so it is judged as that.
  test('a fullwidth password is judged as the password that opens it', async () => {
    const fullwidth = 'ｐａｓｓｗｏｒｄ１２３';
    assert.equal(passwordStrength(fullwidth).strength, 'weak');
    assert.equal(passwordStrength('Ｐａｓｓｗｏｒｄ１！').strength, 'weak');

    const seed = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await wrapSeedWithPassphrase(seed, fullwidth);
    const { did } = await createIdentityManager().fromSeed(seed);
    assert.deepEqual(await unwrapSeedWithPassphrase(wrap, 'password123', did), seed);
  });
});
