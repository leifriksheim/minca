/** 4. Hall of fame, with the hard cases. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { judge } from '../host/cel-host.js';
import type { Version } from '../host/space.js';
import { base, claim, comment, f1, host, react, reactions, removeM3, withdraw } from '../communities/fame.js';

const cel = async (held: Version[], id: string) => judge(held, host).verdict(id);

describe('hall of fame: five 🙂', () => {
  test('the claim passes', async () => {
    assert.equal(await cel(base, 'f1'), 'pass');
  });
  test('a claim citing the 😐 instead fails', async () => {
    assert.equal(
      await cel([...base, claim('f0', ['r1', 'r2', 'r3', 'r4', 'r6'], ['r1', 'r2', 'r3', 'r4', 'r6'])], 'f0'),
      'fail',
    );
  });
});

describe('hall of fame: a reaction withdrawn', () => {
  test('after the claim: still famous, fixed by what was cited', async () => {
    assert.equal(await cel([...base, withdraw(['r3', 'f1'])], 'f1'), 'pass');
  });
  test('before the claim: passes, citing the version before the withdrawal, whatever the claim had seen', async () => {
    // Accepted (plan §3): a version's `seen` is whatever its writer says, so
    // "a cited version must be current" could be dodged by leaving the
    // withdrawal out of it. Withdrawals don't un-fame a claim; the contract
    // judges the versions cited, and a reaction once given counts.
    const named = claim('f2', ['r1', 'r2', 'r3', 'r4', 'r5', 'd3']);
    const unnamed = claim('f9', ['r1', 'r2', 'r3', 'r4', 'r5']);
    const held = [comment, ...reactions, withdraw(['r3']), named, unnamed];
    assert.equal(await cel(held, 'f2'), 'pass');
    assert.equal(await cel(held, 'f9'), 'pass');
  });
});

describe('hall of fame: a reaction from a removed member', () => {
  test('removed after the claim: still famous', async () => {
    assert.equal(await cel([...base, removeM3(['f1'])], 'f1'), 'pass');
  });
  test('removed, and a claim that had seen it cites the reaction: fails', async () => {
    const f3 = claim('f3', ['r1', 'r2', 'r3', 'r4', 'r5', 'x3']);
    assert.equal(await cel([...base, removeM3(['r3']), f3], 'f3'), 'fail');
  });
});

describe('hall of fame: a device holding only some reactions', () => {
  test('the claim waits; it is never judged false', async () => {
    const partial = [comment, react(1), react(2), react(4), f1];
    assert.equal(await cel(partial, 'f1'), 'pending');
    assert.equal(await cel(base, 'f1'), 'pass');
  });
});
