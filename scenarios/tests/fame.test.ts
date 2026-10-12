/** 4. Hall of fame, with the hard cases, judged by the library. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { story } from '../communities/fame.js';

describe('hall of fame: five 🙂', () => {
  test('the claim passes', async () => {
    const { c, comment, reactions, meh, f1 } = await story();
    await c.add(comment, ...reactions, meh, f1);
    assert.equal(await c.verdict(f1), 'pass');
  });
  test('a claim citing the 😐 instead fails', async () => {
    const { c, comment, reactions, meh, claim } = await story();
    const f0 = await claim([...reactions.slice(0, 4), meh]);
    await c.add(comment, ...reactions, meh, f0);
    assert.equal(await c.verdict(f0), 'fail');
  });
});

describe('hall of fame: a reaction withdrawn', () => {
  test('after the claim: still famous, fixed by what was cited', async () => {
    const { c, comment, reactions, meh, f1, withdraw } = await story();
    await c.add(comment, ...reactions, meh, f1, await withdraw(reactions[2]!, 3));
    assert.equal(await c.verdict(f1), 'pass');
  });
  test('before the claim: passes, citing the version before the withdrawal', async () => {
    // A contract judges the versions cited, not whether they are current: records have no
    // causal past a peer can check, so "current as of the claim" would be a promise it can't keep.
    const { c, comment, reactions, meh, claim, withdraw } = await story();
    await c.add(comment, ...reactions, meh, await withdraw(reactions[2]!, 3));
    const late = await claim(reactions);
    await c.add(late);
    assert.equal(await c.verdict(late), 'pass');
  });
});

describe('hall of fame: a reaction from a removed member', () => {
  test('removed after the claim: still famous, even where the removal keeps nothing of theirs', async () => {
    // The claim had not seen the removal, so the removal can't take back what it cites.
    const { c, comment, reactions, meh, f1, remove } = await story();
    const [r1, r2, r3, r4, r5] = reactions;
    await c.add(comment, r1!, r2!, r4!, r5!, meh);
    await remove(3);
    await c.add(r3!, f1);
    assert.equal(await c.verdict(f1), 'pass');
  });
  test('removed, and a claim that had seen it cites the reaction: fails', async () => {
    // Alice removes m3 before m3's reaction reaches her, so her removal keeps nothing of m3's (03 §6.3).
    const { c, comment, reactions, meh, claim, remove } = await story();
    const [r1, r2, r3, r4, r5] = reactions;
    await c.add(comment, r1!, r2!, r4!, r5!, meh);
    await remove(3);
    await c.add(r3!);
    const f3 = await claim(reactions);
    await c.add(f3);
    assert.equal(await c.verdict(f3), 'fail');
  });
});

describe('hall of fame: a device holding only some reactions', () => {
  test('the claim waits; it is never judged false', async () => {
    const { c, comment, reactions, meh, f1 } = await story();
    const [r1, r2, r3, r4, r5] = reactions;
    await c.add(comment, r1!, r2!, r4!, f1);
    assert.equal(await c.verdict(f1), 'pending');
    await c.add(r3!, r5!, meh);
    assert.equal(await c.verdict(f1), 'pass');
  });
});
