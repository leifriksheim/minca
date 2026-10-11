/**
 * What the example asks the account home for, for a program connecting by
 * code: the app decides, and gives records only whatever the program asks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { programRequest } from '../src/program-terms';

const asking = { did: 'did:key:zProgram', name: 'Agent on laptop', proof: 'p' };

test('a program asking for records only gets records in the whole account, for as long as chosen', () => {
  assert.deepEqual(programRequest({ ...asking, recordsOnly: true }, 30), {
    name: 'Agent on laptop',
    access: 'write',
    scope: 'account',
    chooseSpaces: false,
    recordsOnly: true,
    days: 30,
  });
});

test('a program asking for more than records is denied, not given what it asked', () => {
  assert.equal(programRequest({ ...asking, recordsOnly: false }, 30), null);
});
