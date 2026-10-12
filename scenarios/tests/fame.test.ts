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
  test('before the claim, which had seen it: passes anyway, citing the old version (a gap the plan closes)', async () => {
    // The plan (§3): a cited version must be current as of what the claim had seen.
    const f2 = claim('f2', ['r1', 'r2', 'r3', 'r4', 'r5', 'd3']);
    assert.equal(await cel([comment, ...reactions, withdraw(['r3']), f2], 'f2'), 'pass');
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
