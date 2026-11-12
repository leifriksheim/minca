/**
 * A carrier added before carry spaces were derived names its space and an
 * invite to it. Opening that space on a device that doesn't hold it yet joins
 * it on the way, and must not wait on itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { passKey } from '../src/space/pass.js';
import { memoryStores } from './helpers/memory-stores.js';

async function account() {
  const seed = generateSeed();
  const manager = createIdentityManager();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveAccountKey(seed),
  };
}

// Stands in for an older node that wrote a legacy sys.carrier: catch the space runtimes the node opens.
// The node writes `sys.carrier` itself, so the record an older node left is put through the registry's runtime, caught as the node freezes it.
type Rt = {
  get: (key: string) => Promise<unknown>;
  upsertSystem: (c: string, k: string, b: unknown) => Promise<unknown>;
};
const runtimesSeen: Rt[] = [];
const freeze = Object.freeze;
Object.freeze = function <T>(value: T): T {
  if (value && typeof value === 'object' && 'upsertSystem' in value)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a space's runtime, known by the method only it has
    runtimesSeen.push(value as unknown as Rt);
  return freeze(value);
};

test('opening a legacy carrier space this device does not hold yet settles', async () => {
  const me = await account();
  const carrierAccount = await account();
  const carrierNode = await createNode({
    signer: carrierAccount.signer,
    stores: memoryStores(),
    watchIntervalMs: 0,
  });
  const carry = await carrierNode.spaces.create({ name: 'Carry', visibility: 'private' });
  const carryInvite: string = await carrierNode.spaces.invite(carry.id);

  const node = await createNode({
    signer: me.signer,
    stores: memoryStores(),
    accountKey: me.accountKey,
    watchIntervalMs: 0,
  });
  const registryId = (await node.account.space())!;
  const marker = await node.records.put(registryId, 'app.marker', { here: true });
  let registryRt: Rt | undefined;
  for (const rt of runtimesSeen) if (await rt.get(marker.key)) registryRt = rt;
  assert.ok(registryRt, 'found the account registry runtime');

  await registryRt.upsertSystem('sys.carrier', (await passKey(carry.id)).replace(/^pass:/, 'carrier:'), {
    did: carrierAccount.did,
    name: 'Old carrier',
    since: new Date().toISOString(),
    space: carry.id,
    invite: carryInvite,
  });

  const opened = node.spaces.hold(carry.id).then(
    () => 'opened',
    (error: unknown) => `refused: ${String(error)}`,
  );
  const outcome = await Promise.race([
    opened,
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  assert.notEqual(
    outcome,
    'hung',
    'runtime(carry) never settles: closeRuntime awaits the open that is joining',
  );
  await Promise.race([
    Promise.all([node.close(), carrierNode.close()]),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
});
