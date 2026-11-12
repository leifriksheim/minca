/**
 * `network.reach`: where a node may connect, asked of every address it found
 * rather than was given. For a node whose reading and invites are someone
 * else's, none of them may choose an address it refuses: not a host it asks
 * about itself, a host a record names, nor a short link's places. (That it
 * dials no node an invite names, and no relay, is shown end to end in
 * `packages/cli/tests/remote-mcp-server.test.ts`.)
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createNode } from '../src/node/node.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { encodeInviteLink } from '../src/space/invite-link.js';
import { host } from '@minca/std';
import { memoryStores } from './helpers/memory-stores.js';
import { createFakeHub } from './helpers/fake-transport.js';

const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => {});
});

/** A server on this machine that notes every request and connection it gets */
async function listening() {
  const seen: string[] = [];
  const note = (req: IncomingMessage) => seen.push(req.url ?? '');
  const server = createServer((req, res) => {
    note(req);
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    note(req);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  closing.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: address.port, seen };
}

/** A node that may reach nothing it finds, or, given no `reach`, anything */
async function aNode(refuses: boolean) {
  const hub = createFakeHub({ latencyMs: 1 });
  const manager = createIdentityManager();
  const seed = generateSeed();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
    network: {
      transports: (spaceId, did) => [hub.transport(did, spaceId)],
      ...(refuses ? { reach: async () => false } : {}),
    },
  });
  closing.push(() => node.close());
  return node;
}

const link = (port: number) =>
  encodeInviteLink({
    secret: Uint8Array.from({ length: 16 }, (_, i) => i),
    pin: Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i),
    places: [`ws://localhost:${port}`],
  });

describe('a node that may reach nothing it finds', () => {
  test('asks no host about itself', async () => {
    const server = await listening();
    const node = await aNode(true);
    await assert.rejects(node.hosting.use(`http://127.0.0.1:${server.port}`), /may not reach/);
    assert.deepEqual(server.seen, []);
  });

  test('asks no host a space’s own records name, nor holds a socket to it', async () => {
    const server = await listening();
    const node = await aNode(true);
    const space = await node.spaces.create({ name: 'Club', visibility: 'private' });
    await node.collections.define(space.id, host);
    await node.records.put(space.id, host.name, { url: `http://127.0.0.1:${server.port}` });
    const [view] = await node.hosting.space(space.id);
    assert.ok(view?.error, 'the host it names is not asked');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(server.seen, []);
  });

  test('asks no place a short link names', async () => {
    const server = await listening();
    const node = await aNode(true);
    await node.spaces.preview(link(server.port)).catch(() => null);
    await node.spaces.join(link(server.port)).catch(() => null);
    assert.deepEqual(server.seen, []);
  });

  test('follows no host’s redirect to an address it may not reach', async () => {
    const inside = await listening();
    // A host it may reach, which sends whoever asks to an address inside the network.
    const outside = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${inside.port}/latest/meta-data/` });
      res.end();
    });
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
    closing.push(() => new Promise<void>((resolve) => outside.close(() => resolve())));
    const address = outside.address();
    assert.ok(address && typeof address === 'object');
    const hub = createFakeHub({ latencyMs: 1 });
    const manager = createIdentityManager();
    const seed = generateSeed();
    const node = await createNode({
      signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
      stores: memoryStores(),
      accountKey: await deriveAccountKey(seed),
      watchIntervalMs: 0,
      network: {
        transports: (spaceId, did) => [hub.transport(did, spaceId)],
        reach: async (url) => new URL(url).port === String(address.port),
      },
    });
    closing.push(() => node.close());
    await node.hosting.use(`http://127.0.0.1:${address.port}`).catch(() => null);
    assert.deepEqual(inside.seen, [], 'the redirect was not followed');
  });

  test('where any other node would', async () => {
    const server = await listening();
    const node = await aNode(false);
    await node.spaces.preview(link(server.port)).catch(() => null);
    assert.ok(server.seen.length > 0, 'it went to the place the link named');
  });
});
