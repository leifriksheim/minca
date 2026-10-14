/**
 * `minca carry`: a carrier from a folder. What it does with no grant, with a
 * file that isn't one, and the key it keeps there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { didOf } from '@minca/core';
import { CARRY_GRANT_FILE, carrierKey, runCarrier, type CarryStatus } from '../src/carry.js';
import { tempDir } from './helpers/nodes.js';

const quiet = () => {};

test('with no grant in the folder, it says it is not connected, and carries nothing', async () => {
  const data = await tempDir();
  const said: CarryStatus[] = [];
  const running = await runCarrier({ data, status: (status) => said.push(status), log: quiet });
  assert.equal(running, null);
  assert.deepEqual(said, [{ state: 'not-connected' }]);
});

test('a grant file that is not a carry grant is refused, not carried', async () => {
  const data = await tempDir();
  await writeFile(path.join(data, CARRY_GRANT_FILE), JSON.stringify({ kind: 'write', did: 'did:key:z' }));
  await assert.rejects(runCarrier({ data, status: quiet, log: quiet }), /not a carry grant/);
});

test('its key is made once, kept, and readable by this user alone', async () => {
  const data = await tempDir();
  const first = await carrierKey(data);
  const again = await carrierKey(data);
  assert.equal(await didOf(first.publicKey), await didOf(again.publicKey));
  const { mode } = await stat(path.join(data, 'carrier-key'));
  assert.equal(mode & 0o777, 0o600);
});
