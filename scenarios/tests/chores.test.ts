/** 6. Chores: a computed view, promoted into a claim, with the hard cases. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { story } from '../communities/chores.js';

describe('chores: done is a view', () => {
  test('two different people’s 👍 make it done; one person twice, or a 😐, does not', async () => {
    const { c, dishes, nodAt, view } = await story();
    await c.add(dishes, await nodAt(1), await nodAt(1), await nodAt(2, dishes, '😐'));
    assert.deepEqual(await view(dishes), { thumbs: 1, done: false });
    await c.add(await nodAt(3));
    assert.deepEqual(await view(dishes), { thumbs: 2, done: true });
  });

  test('a 👍 on another chore counts for that one alone', async () => {
    const { c, dishes, laundry, nodAt, view } = await story();
    await c.add(dishes, laundry, await nodAt(1), await nodAt(2, laundry));
    assert.deepEqual(
      [await view(dishes), await view(laundry)],
      [
        { thumbs: 1, done: false },
        { thumbs: 1, done: false },
      ],
    );
  });

  test('a withdrawn 👍 turns it back', async () => {
    const { c, dishes, nodAt, withdraw, view } = await story();
    const first = await nodAt(1);
    await c.add(dishes, first, await nodAt(2));
    assert.equal((await view(dishes))?.done, true);
    await c.add(await withdraw(first, 1));
    assert.equal((await view(dishes))?.done, false);
  });

  test('a body that says it is done is not read in place of the view', async () => {
    const { c, alice, nodAt, view } = await story();
    const forged = await c.sign(alice, { collection: 'app.chore', body: { text: 'Taxes', done: true } });
    await c.add(forged, await nodAt(1, forged));
    assert.equal((await view(forged))?.done, false);
  });

  test('what watches { done: true } finds a chore once the 👍 that makes it done arrives', async () => {
    const { c, dishes, laundry, nodAt, done } = await story();
    await c.add(dishes, laundry, await nodAt(1), await nodAt(2, laundry));
    assert.deepEqual(await done(), []);
    await c.add(await nodAt(2));
    assert.deepEqual(await done(), [dishes.key]);
  });
});

describe('chores: what sets an automation off', () => {
  test('a chore done before the automation was made stays quiet, whatever comes after', async () => {
    const { c, dishes, nodAt, automate } = await story();
    await c.add(dishes, await nodAt(1), await nodAt(2));
    const run = await automate();
    await c.add(await nodAt(3, dishes, '😐'));
    assert.deepEqual(await run(), []);
  });

  test('the nod that makes it done sets it off, once', async () => {
    const { c, dishes, nodAt, automate } = await story();
    await c.add(dishes, await nodAt(1));
    const run = await automate();
    await c.add(await nodAt(2));
    await run();
    await c.add(await nodAt(3));
    assert.deepEqual(await run(), ['Dishes is done']);
  });

  test('admins only: the children make it done, and a parent’s 😐 after sets nothing off', async () => {
    const { c, alice, dishes, nodAt, nodBy, automate } = await story();
    await c.add(dishes);
    const run = await automate({ from: ['admin'] });
    await c.add(await nodAt(1), await nodAt(2));
    await run();
    await c.add(await nodBy(alice, dishes, '😐'));
    assert.deepEqual(await run(), []);
  });

  test('admins only: a parent’s 👍 that makes it done sets it off', async () => {
    const { c, alice, dishes, nodAt, nodBy, automate } = await story();
    await c.add(dishes, await nodAt(1));
    const run = await automate({ from: ['admin'] });
    await c.add(await nodBy(alice));
    assert.deepEqual(await run(), ['Dishes is done']);
  });
});

describe('chores: promoted, done is a verdict', () => {
  test('a claim citing the 👍s the view counted passes', async () => {
    const { c, dishes, nodAt, promote } = await story();
    await c.add(dishes, await nodAt(1), await nodAt(2));
    const complete = await promote(dishes);
    await c.add(complete);
    assert.equal(await c.verdict(complete), 'pass');
  });

  test('a 👍 withdrawn after: the view turns back, the claim stands', async () => {
    const { c, dishes, nodAt, withdraw, promote, view } = await story();
    const first = await nodAt(1);
    await c.add(dishes, first, await nodAt(2));
    const complete = await promote(dishes);
    await c.add(complete, await withdraw(first, 1));
    assert.equal((await view(dishes))?.done, false, 'the view follows what is held');
    assert.equal(await c.verdict(complete), 'pass', 'the verdict follows what was cited');
  });

  test('a claim that arrives before its 👍s waits, and passes once they do', async () => {
    const { c, dishes, nodAt, claim } = await story();
    const nods = [await nodAt(1), await nodAt(2)];
    const early = await claim(dishes, nods);
    await c.add(dishes, early);
    assert.equal(await c.verdict(early), 'pending');
    await c.add(...nods);
    assert.equal(await c.verdict(early), 'pass');
  });
});

describe('chores: claims that try to cheat', () => {
  test('one person’s 👍 cited twice fails', async () => {
    const { c, dishes, nodAt, claim } = await story();
    const nods = [await nodAt(1), await nodAt(1)];
    const cheat = await claim(dishes, nods);
    await c.add(dishes, ...nods, cheat);
    assert.equal(await c.verdict(cheat), 'fail');
  });

  test('a 👍 on the laundry cited for the dishes fails', async () => {
    const { c, dishes, laundry, nodAt, claim } = await story();
    const nods = [await nodAt(1), await nodAt(2, laundry)];
    const cheat = await claim(dishes, nods);
    await c.add(dishes, laundry, ...nods, cheat);
    assert.equal(await c.verdict(cheat), 'fail');
  });

  test('a 😐 cited as a 👍 fails', async () => {
    const { c, dishes, nodAt, claim } = await story();
    const nods = [await nodAt(1), await nodAt(2, dishes, '😐')];
    const cheat = await claim(dishes, nods);
    await c.add(dishes, ...nods, cheat);
    assert.equal(await c.verdict(cheat), 'fail');
  });

  test('a chore cited in place of a 👍 fails', async () => {
    const { c, dishes, laundry, nodAt, claim } = await story();
    const one = await nodAt(1);
    const cheat = await claim(dishes, [one, laundry]);
    await c.add(dishes, laundry, one, cheat);
    assert.equal(await c.verdict(cheat), 'fail');
  });

  test('a member’s own claim is judged the same as Alice’s', async () => {
    const { c, m, dishes, nodAt, claim } = await story();
    const nods = [await nodAt(1), await nodAt(2)];
    const theirs = await claim(dishes, nods, m(3));
    const lone = await claim(dishes, [nods[0]!], m(3));
    await c.add(dishes, ...nods, theirs, lone);
    assert.deepEqual(await c.verdicts(theirs, lone), ['pass', 'fail']);
  });
});
