/**
 * The command the apps tell people to paste a connect code or a space invite
 * after. Whoever publishes the package it names runs as that person and gets
 * what they paste, so it must be the package this repo publishes, not a name
 * nobody has claimed yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

test('the default CLI command names the package this repo publishes', async () => {
  const manifest: unknown = JSON.parse(await read('packages/cli/package.json'));
  assert.ok(isRecord(manifest) && typeof manifest.name === 'string');
  for (const file of ['apps/example/src/components/ConnectAgent.tsx', 'apps/shared/src/CommunitySetup.tsx']) {
    const command = /VITE_WEAVE_CONNECT \?\? '([^']+)'/.exec(await read(file))?.[1];
    assert.ok(command, `${file} has no default command`);
    assert.equal(command.split(/\s+/)[1], manifest.name, `${file} tells people to run another package`);
  }
});
