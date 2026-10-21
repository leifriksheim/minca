/**
 * A community's fund: what goes in, what keeping the space online takes by
 * the second, what its bots take as they spend, and how long it lasts at the
 * rate it is spent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createMemoryBlobStore } from '../../core/src/storage/blob/memory.js';
import { createFunds } from '../src/fund.js';

const DAY = 86_400;
const START = Date.UTC(2026, 9, 1) / 1000;

async function setUp(mirror = createMemoryBlobStore()) {
  let clock = START;
  const funds = createFunds({
    store: await memoryStores()('funds'),
    perGb: 4e6,
    mirror,
    now: () => clock,
  });
  return { funds, mirror, pass: (days: number) => void (clock += days * DAY), now: () => clock };
}

describe('a community fund', () => {
  test('keeping a small space online takes the rate for one GB by the second, and the estimate follows', async () => {
    const t = await setUp();
    let state = await t.funds.add('space:club', 12e6);
    assert.equal(state.balance, 12e6);
    assert.ok(Math.abs(t.funds.daily(state) - 4e6 / 30) < 1);
    assert.ok(Math.abs((t.funds.until(state) - t.now()) / DAY - 90) < 0.01, '$12 at $4 a month: 90 days');

    t.pass(15);
    state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance - 10e6) < 10, 'half a month: $2 taken');
    // Paying in adds to what is left.
    state = await t.funds.add('space:club', 5e6);
    assert.ok(Math.abs(state.balance - 15e6) < 10);
  });

  test('it pays for each GB it is measured to take, from when it was measured so; unmeasured, for one', async () => {
    const t = await setUp();
    let state = await t.funds.add('space:club', 12e6);
    state = await t.funds.settle('space:club', 3e9);
    assert.ok(Math.abs(t.funds.daily(state) - (3 * 4e6) / 30) < 1);
    t.pass(10);
    state = await t.funds.settle('space:club', 3e9);
    assert.ok(Math.abs(state.balance - 8e6) < 10, 'ten days at $12 a month: $4 taken');
    state = await t.funds.settle('space:club', 1.5e9);
    assert.ok(Math.abs(t.funds.daily(state) - (1.5 * 4e6) / 30) < 1, 'by the byte, not rounded up');
    state = await t.funds.settle('space:club', 0);
    assert.equal(t.funds.daily(state), 0, 'nothing to pay for, nothing taken');
  });

  test('bots take what they spend; a busy week brings the date nearer', async () => {
    const t = await setUp();
    await t.funds.add('space:club', 30e6);
    for (let day = 0; day < 7; day++) {
      t.pass(1);
      await t.funds.charge('space:club', 1e6);
    }
    const state = await t.funds.settle('space:club');
    const daily = t.funds.daily(state);
    assert.ok(Math.abs(daily - (4e6 / 30 + 1e6)) < 20_000, `about $1.13 a day, not ${daily / 1e6}`);
    const left = (t.funds.until(state) - t.now()) / DAY;
    assert.equal(t.funds.botDaily(state, 'did:key:zBot'), 0, 'spent by no bot in particular');
    assert.ok(left > 19 && left < 21, `$22 or so at $1.13 a day: about 20 days, not ${left}`);
  });

  test('each bot’s spending is counted apart, to show what the fund pays for', async () => {
    const t = await setUp();
    await t.funds.add('space:club', 30e6);
    for (let day = 0; day < 7; day++) {
      t.pass(1);
      await t.funds.charge('space:club', 700_000, 'did:key:zBusy');
      await t.funds.charge('space:club', 70_000, 'did:key:zQuiet');
    }
    const state = await t.funds.get('space:club');
    assert.ok(Math.abs(t.funds.botDaily(state, 'did:key:zBusy') - 700_000) < 1);
    assert.ok(Math.abs(t.funds.botDaily(state, 'did:key:zQuiet') - 70_000) < 1);
    assert.ok(
      Math.abs(t.funds.daily(state) - (4e6 / 30 + 770_000)) < 1,
      'and together, in the fund’s own rate',
    );
  });

  test('its grace is lent: the fund goes below zero by a grace at most, and the next payment pays that first', async () => {
    const t = await setUp();
    await t.funds.add('space:club', 4e6);
    t.pass(30);
    let state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance) < 10, 'a month at $4: empty');
    const ranOut = t.now();
    t.pass(15);
    state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance + 2e6) < 10, 'half its grace: $2 owed');
    assert.ok(Math.abs(t.funds.until(state) - ranOut) < 2, 'and it says when it ran out');
    // Part paid back within its grace: the grace it was lent stays as it was.
    state = await t.funds.add('space:club', 1e6);
    assert.ok(Math.abs(state.balance + 1e6) < 10);
    assert.ok(Math.abs(t.funds.until(state) - ranOut) < 2);
    state = await t.funds.charge('space:club', 1e6);
    t.pass(60);
    state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance + 4e6) < 10, 'a whole grace owed, no more');
    // A small payment pays what is owed first: it buys no grace of its own.
    state = await t.funds.add('space:club', 1e6);
    assert.ok(state.balance < 0);
    state = await t.funds.add('space:club', 5e6);
    assert.ok(Math.abs(state.balance - 2e6) < 10, '$6 in, $4 owed: $2 left');
  });

  test('a grace is no longer than the payment before it lasted: the least payment into a large space buys hours', async () => {
    const t = await setUp();
    // 100 GB at $4 a GB: $400 a month, so $4 lasts 0.3 days.
    await t.funds.settle('space:big', 100e9);
    await t.funds.add('space:big', 4e6);
    const paidAt = t.now();
    t.pass(1);
    let state = await t.funds.settle('space:big');
    assert.ok(Math.abs(state.balance + 4e6) < 100, 'lent 0.3 days, $4 owed');
    t.pass(30);
    state = await t.funds.settle('space:big');
    assert.ok(Math.abs(state.balance + 4e6) < 100, 'and no more after');
    // The host's grace runs from the date it says: so it ends 0.6 days after paying.
    const ends = t.funds.until(state) + 30 * DAY;
    assert.ok(Math.abs(ends - (paidAt + 0.6 * DAY)) < 60, `ends 0.6 days on, not ${(ends - paidAt) / DAY}`);
  });

  test('once its grace is over, a fund owes nothing more, whatever its space grows to', async () => {
    const t = await setUp();
    await t.funds.add('space:club', 4e6);
    t.pass(70);
    let state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance + 4e6) < 10, 'a month paid, a month lent');
    state = await t.funds.settle('space:club', 1000e9);
    t.pass(30);
    state = await t.funds.settle('space:club');
    assert.ok(Math.abs(state.balance + 4e6) < 10, 'still what the grace kept online');
  });

  test('a fund nobody paid into owes nothing', async () => {
    const t = await setUp();
    await t.funds.settle('space:club', 5e9);
    t.pass(20);
    const state = await t.funds.settle('space:club');
    assert.equal(state.balance, 0);
    assert.equal((await t.funds.add('space:club', 5e6)).balance, 5e6);
  });

  test('a fund comes back from the bucket when the disk is lost', async () => {
    const t = await setUp();
    await t.funds.add('space:club', 7e6);
    const again = createFunds({
      store: await memoryStores()('funds'),
      perGb: 4e6,
      mirror: t.mirror,
      now: t.now,
    });
    assert.equal((await again.get('space:club')).balance, 7e6);
  });
});
