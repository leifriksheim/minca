/**
 * Joining a space while the node has spaces open: an invite that is refused
 * must close nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { decodeLoose } from '../src/records/loose.js';
import { base64UrlEncode, utf8Encode } from '../src/utils/encoding.js';
import { memoryStores } from './helpers/memory-stores.js';
import * as z from 'zod';

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

// The space runtimes the node opens, caught as the node freezes each.
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

test('an invite that is refused closes no space the node has open', async () => {
  const me = await account();
  const stranger = await account();
  const strangerNode = await createNode({
    signer: stranger.signer,
    stores: memoryStores(),
    watchIntervalMs: 0,
  });
  const node = await createNode({
    signer: me.signer,
    stores: memoryStores(),
    accountKey: me.accountKey,
    watchIntervalMs: 0,
  });
  const registryId = (await node.account.space())!;
  const release = await node.spaces.hold(registryId);
  await node.records.put(registryId, 'app.marker', { here: true });

  // The stranger's own invite, naming the account registry instead: open here, but not a space the node lists.
  const bait = await strangerNode.spaces.create({ name: 'Bait', visibility: 'public' });
  const [signed = '', ...rest] = (await strangerNode.spaces.invite(bait.id, { write: false })).split('.');
  const version = z
    .looseObject({ body: z.looseObject({ space: z.looseObject({ id: z.string() }) }) })
    .parse(decodeLoose(signed));
  version.body.space.id = registryId;
  const forged = [base64UrlEncode(utf8Encode(JSON.stringify(version))), ...rest].join('.');

  const openedBefore = runtimesSeen.length;
  await assert.rejects(node.spaces.join(forged));
  await node.records.put(registryId, 'app.marker', { here: 'still' });
  assert.equal(runtimesSeen.length, openedBefore, 'the registry was closed and opened again');

  await release();
  await Promise.all([node.close(), strangerNode.close()]);
});
