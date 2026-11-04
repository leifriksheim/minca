/**
 * Updates: found, downloaded quietly, then offered in the menu bar; never
 * installed without a click, and silent when there is nothing to find.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdates, updateMenu, type Updater, type UpdateState } from '../src/bun/updates.ts';

function fakeUpdater(found: Awaited<ReturnType<Updater['checkForUpdate']>>, ready = true) {
  const calls: string[] = [];
  const updater: Updater = {
    checkForUpdate: async () => (calls.push('check'), found),
    downloadUpdate: async () => void calls.push('download'),
    updateInfo: () => ({ updateReady: ready }),
    applyUpdate: async () => void calls.push('apply'),
  };
  return { updater, calls };
}

function run(updater: Updater) {
  const seen: UpdateState['status'][] = [];
  const updates = createUpdates({ updater, current: '0.1.18', changed: (state) => seen.push(state.status) });
  return { updates, seen };
}

test('a new version is downloaded, then offered with a dot, and installed only when clicked', async () => {
  const { updater, calls } = fakeUpdater({ version: '0.1.19', updateAvailable: true });
  const { updates, seen } = run(updater);
  await updates.check();
  assert.deepEqual(seen, ['checking', 'downloading', 'ready']);
  assert.deepEqual(calls, ['check', 'download']);
  assert.deepEqual(updateMenu(updates.state()), {
    line: { label: 'Restart to update to 0.1.19', action: 'update' },
    attention: true,
  });
  await updates.apply();
  assert.deepEqual(calls, ['check', 'download', 'apply']);
});

test('once one is ready, checking again does nothing', async () => {
  const { updater, calls } = fakeUpdater({ version: '0.1.19', updateAvailable: true });
  const { updates } = run(updater);
  await updates.check();
  await updates.check();
  assert.deepEqual(calls, ['check', 'download']);
});

test('with nothing new, it says so and offers to check again', async () => {
  const { updater, calls } = fakeUpdater({ version: '0.1.18', updateAvailable: false });
  const { updates } = run(updater);
  await updates.check();
  assert.deepEqual(updateMenu(updates.state()), {
    line: { label: 'Minca 0.1.18 is up to date', action: 'check' },
    attention: false,
  });
  await updates.apply();
  assert.deepEqual(calls, ['check']);
});

test('offline, or a download that fails, leaves it quiet and ready to try again', async () => {
  const offline = run(fakeUpdater({ version: '', updateAvailable: false, error: 'Failed to fetch' }).updater);
  await offline.updates.check();
  assert.equal(offline.updates.state().status, 'idle');

  const failed = run(fakeUpdater({ version: '0.1.19', updateAvailable: true }, false).updater);
  await failed.updates.check();
  assert.equal(failed.updates.state().status, 'idle');
  assert.deepEqual(updateMenu(failed.updates.state()).line, { label: 'Check for updates', action: 'check' });
});
