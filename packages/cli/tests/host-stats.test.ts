/**
 * What a host shows anyone about itself (packages/cli/HOSTING.md, Stats):
 * rounded totals, counted once an hour, so asking often learns nothing new.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostStats, isHostStats, statsLines, type HostCounts } from '../src/host-stats.js';

test('stats are rounded: counts to 5, data to 0.1 GB, money to the dollar', async () => {
  const stats = createHostStats({
    name: 'Host',
    now: () => 1_000,
    collect: async () => ({
      communities: 2,
      accounts: 13,
      spaces: 18,
      bytes: 1_234_000_000,
      bots: 1,
      funds: { balance: 41_600_000, hostingDaily: 110_000, aiDaily: 410_000 },
    }),
  });
  assert.deepEqual(await stats.get(), {
    name: 'Host',
    at: 1_000,
    every: 3600,
    communities: 0,
    accounts: 15,
    spaces: 20,
    gb: 1.2,
    bots: 0,
    funds: { balance: 42, monthly: { hosting: 3, ai: 12 } },
    upDays: 0,
  });
});

test('stats are counted once an hour, however often they are asked for', async () => {
  let clock = 0;
  let counts = 0;
  let bytes = 0;
  const stats = createHostStats({
    name: 'Host',
    now: () => clock,
    collect: async (): Promise<HostCounts> => {
      counts += 1;
      return { communities: 10, accounts: 10, spaces: 10, bytes };
    },
  });
  assert.equal((await stats.get()).gb, 0);
  // A community writes 40 MB at once: nobody asking within the hour sees it.
  bytes = 400_000_000;
  clock = 3599;
  assert.equal((await stats.get()).gb, 0);
  assert.equal(counts, 1);
  clock = 3600;
  assert.equal((await stats.get()).gb, 0.4);
  assert.equal(counts, 2);
});

test('a count that fails is tried again on the next ask', async () => {
  let fail = true;
  const stats = createHostStats({
    name: 'Host',
    now: () => 0,
    collect: async () => {
      if (fail) throw new Error('disk busy');
      return { communities: 0, accounts: 0, spaces: 0, bytes: 0 };
    },
  });
  await assert.rejects(stats.get(), /disk busy/);
  fail = false;
  assert.equal((await stats.get()).spaces, 0);
});

test('a terminal shows stats in words, and refuses an answer that is not stats', () => {
  const lines = statsLines({
    name: 'Host',
    at: 0,
    every: 3600,
    communities: 0,
    accounts: 15,
    spaces: 20,
    gb: 1.2,
    funds: { balance: 42, monthly: { hosting: 3, ai: 12 } },
    upDays: 4,
  });
  assert.equal(lines[0], 'Host, counted 1970-01-01 00:00 UTC');
  assert.ok(lines.includes('  Communities    fewer than 3'));
  assert.ok(lines.includes('  Spent a month  $3 hosting, $12 AI'));
  assert.equal(isHostStats({ name: 'Host', at: 0 }), false);
  assert.equal(isHostStats(null), false);
});
