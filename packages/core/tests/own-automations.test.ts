/**
 * The account's own automations, kept in its registry (`space/own-automations.ts`):
 * the person can always pause and remove them, whatever another key of the
 * account defined their collection as.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { deriveAccountRegistry } from '../src/space/account-registry.js';
import { automation } from '../src/schemas/automations.js';
import { notifyOn } from '../src/space/own-automations.js';
import { memoryStores } from './helpers/memory-stores.js';

describe('the account’s own automations', () => {
  test('they are a system collection: no definition another key of the account writes can stop the person pausing or removing one', async () => {
    const manager = createIdentityManager();
    const seed = generateSeed();
    const identity = await manager.fromSeed(seed);
    const accountKey = await deriveAccountKey(seed);
    const node = await createNode({
      signer: createLocalRootSigner(identity, manager.getProvider()),
      stores: memoryStores(),
      accountKey,
      watchIntervalMs: 0,
    });
    const own = (name: string) => ({
      ...notifyOn(name, 'app.chat'),
      then: { kind: 'notify' as const, text: name },
      spaces: 'all' as const,
      app: { origin: 'https://chat.example' },
    });
    const spam = await node.automations.add(own('Spam'));
    await node.automations.add(own('Other'));
    const registry = (await deriveAccountRegistry(accountKey, identity.did)).space.id;
    // What a whole-account app's key could sign: no definition of sys.automation is a definition at all,
    // and one of std.automation there, final at the highest version it may have, reaches nothing of it.
    await assert.rejects(node.collections.define(registry, { ...automation, name: 'sys.automation' }));
    await node.collections.define(registry, { ...automation, version: 2 ** 53 - 1, rules: { final: true } });
    await node.automations.update(spam.id, { paused: true });
    assert.equal((await node.automations.list()).find((one) => one.id === spam.id)?.paused, true);
    await node.automations.remove(spam.id);
    assert.deepEqual(
      (await node.automations.list()).map((one) => one.name),
      ['Other'],
    );
    await node.close();
  });
});
