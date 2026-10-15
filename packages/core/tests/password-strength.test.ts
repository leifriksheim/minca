import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength } from '../src/session/password-strength.js';

describe('password strength', () => {
  test('an empty password says nothing', () => {
    assert.deepEqual(passwordStrength(''), { strength: 'weak', bits: 0, hint: '' });
  });

  test('short, repeated, sequential and common passwords are weak', () => {
    for (const weak of [
      'abc',
      'hunter2',
      '123456',
      'aaaaaaaaaaaaaaaa',
      'abcdefghijklmnop',
      'Password1!',
      'qwerty2024',
    ]) {
      assert.equal(passwordStrength(weak).strength, 'weak', weak);
    }
  });

  test('a longer mix is fair, and a long one or a few words is strong', () => {
    assert.equal(passwordStrength('summer2024').strength, 'fair');
    assert.equal(passwordStrength('ilovemydog').strength, 'fair');
    assert.equal(passwordStrength('Tr0ub4dor&3').strength, 'strong');
    assert.equal(passwordStrength('correct horse battery staple').strength, 'strong');
    assert.equal(passwordStrength('x7#Kp2!vQ9@mL4zR').strength, 'strong');
  });

  test('every weak password still says why', () => {
    assert.match(passwordStrength('abc').hint, /^Weak/);
  });
});
