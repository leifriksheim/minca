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
  test('a key of the account that defines them final can’t keep them: the account defines them again', async () => {
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
    const defined = () =>
      node.collections.list(registry).then((all) => all.find((c) => c.name === automation.name));
    assert.equal((await defined())?.version, 1, 'defined once, not again with each one');

    // What a whole-account app's key could sign: the same collection, now final.
    await node.collections.define(registry, { ...automation, version: 2, rules: { final: true } });
    await node.automations.update(spam.id, { paused: true });
    await node.automations.remove(spam.id);
    assert.deepEqual(
      (await node.automations.list()).map((one) => one.name),
      ['Other'],
    );
    assert.equal((await defined())?.version, 3, 'the library’s definition, again');
    await node.close();
  });
});
