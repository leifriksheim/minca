/**
 * `network.only`: a node that reaches nothing but what it was given. What it
 * reads and the invites it is handed are someone else's, so none of them may
 * choose an address for it: not a host a record names, nor a short link's
 * places. (That it dials no node an invite names is shown end to end in
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
import { host } from '../src/schemas/library/community.js';
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

async function aNode(only: boolean) {
  const hub = createFakeHub({ latencyMs: 1 });
  const manager = createIdentityManager();
  const seed = generateSeed();
  const node = await createNode({
    signer: createLocalRootSigner(await manager.fromSeed(seed), manager.getProvider()),
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
    network: { transports: (spaceId, did) => [hub.transport(did, spaceId)], ...(only ? { only } : {}) },
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

describe('a node that reaches only what it was given', () => {
  test('asks no host about itself', async () => {
    const server = await listening();
    const node = await aNode(true);
    await assert.rejects(node.hosting.use(`http://127.0.0.1:${server.port}`), /reaches only/);
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
    await assert.rejects(node.spaces.preview(link(server.port)), /reaches only/);
    await assert.rejects(node.spaces.join(link(server.port)), /reaches only/);
    assert.deepEqual(server.seen, []);
  });

  test('where any other node would', async () => {
    const server = await listening();
    const node = await aNode(false);
    await node.spaces.preview(link(server.port)).catch(() => null);
    assert.ok(server.seen.length > 0, 'it went to the place the link named');
  });
});
