/**
 * What the app bundle carries beside the CLI: node-datachannel is left out of
 * the CLI's build, so the bundle needs it and everything it imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEBRTC_COPY } from '../scripts/webrtc.ts';

/** A package's runtime dependencies, from its package.json in the workspace */
function dependencies(name: string): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)) return [];
  const { dependencies } = manifest;
  return typeof dependencies === 'object' && dependencies !== null ? Object.keys(dependencies) : [];
}

test('the bundle carries node-datachannel and every package it needs at run time', () => {
  const copied = new Set(Object.values(WEBRTC_COPY));
  const needed = ['node-datachannel'];
  for (const name of needed) {
    for (const dependency of dependencies(name)) if (!needed.includes(dependency)) needed.push(dependency);
  }
  for (const name of needed)
    assert.ok(copied.has(`views/node_modules/${name}`), `${name} is not in the bundle`);
});
