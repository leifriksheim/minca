/**
 * What the MCP service can't do, it says: a write the keepers haven't
 * confirmed, and a space the always-on nodes don't carry.
 */
import { test } from 'node:test';
import { noteTerms } from '../../core/src/identity/abilities.js';
import assert from 'node:assert/strict';
import { createNode } from '../../core/src/node/node.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { startMcpServer } from '../src/remote-mcp/server.js';
import { startHost } from '../src/host.js';
import { until } from '../../core/tests/helpers/until.js';
import { tempDir } from './helpers/nodes.js';
import { keptByHosts, closing, freePort, signInWith, callTool, between } from './helpers/remote-mcp.js';

test('a write the keepers haven’t confirmed is not said to be written', async () => {
  const served = await startHost({
    key: await createP256Provider().generateKeyPair(),
    stores: memoryStores(),
    port: 0,
    free: true,
  });
  closing.push(() => served.close());
  const peer = `ws://127.0.0.1:${served.port}/peer`;
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const onHost = async () => {
    const node = await createNode({
      signer,
      stores: memoryStores(),
      accountKey,
      watchIntervalMs: 0,
      network: { nodes: [peer] },
    });
    closing.push(() => node.close());
    return node;
  };
  const laptop = await onHost();
  const space = await laptop.spaces.create({ name: 'Club', visibility: 'private' });
  await laptop.records.put(space.id, 'app.note', { text: 'Soup on Friday' });
  await laptop.hosting.use(`http://127.0.0.1:${served.port}`);
  await until(
    async () => {
      const reached = (await served.node.spaces()).filter((one) => one.peers > 0).map((one) => one.name);
      return reached.includes('Account registry') && reached.includes('Club');
    },
    15_000,
    'the host to carry her registry and the space',
  );
  await keptByHosts(laptop, space.id);
  const invite = await laptop.spaces.invite(space.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await laptop.close();

  const link = await between(served.port);
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const data = await tempDir('mcp-server-');
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: [`ws://127.0.0.1:${link.port}/peer`],
    data,
    port,
    version: '0',
    accountHome: 'https://home.test',
    idleMs: 1000,
  });
  closing.push(() => service.close());
  const token = await signInWith(issuer, async (audience) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      v: GRANT_VERSION,
      did: me.did,
      name: 'Ada',
      note: await signer.delegate({ audience, expiration: expiresAt, ...noteTerms('/record', [space.id]) }),
      access: 'write',
      scope: 'spaces',
      spaces: [{ id: space.id, name: 'Club', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });
  const read = await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' });
  assert.ok(read.includes('Soup on Friday'), read);

  // The host's answers are lost just as the chat app writes: it stores the version, but its
  // word never comes back. The node's folder goes when it stops, so a version no always-on node
  // stored would go with it, and the place it was signed at, which is kept, would point at
  // nothing (found by adversarial review): the app is told it isn't confirmed.
  link.cutBack();
  const put = await callTool(issuer, token, 'records_put', {
    space: space.id,
    records: [{ collection: 'app.note', body: { text: 'Bread too' } }],
  });
  assert.match(put, /"isError":true/);
  assert.match(put, /not yet kept elsewhere/);
  // Once the link is back, the host's word on it comes back too, and every write after is
  // confirmed, not reported lost for the life of the node (found by adversarial review).
  link.mend();
  let n = 0;
  await until(
    async () =>
      (
        await callTool(issuer, token, 'records_put', {
          space: space.id,
          records: [{ collection: 'app.note', body: { text: `Cake ${n++}` } }],
        })
      ).includes('"isError":false'),
    30_000,
    'a write to be confirmed again',
  );
  for (let more = 0; more < 3; more++)
    assert.match(
      await callTool(issuer, token, 'records_put', {
        space: space.id,
        records: [{ collection: 'app.note', body: { text: `Pie ${more}` } }],
      }),
      /"isError":false/,
    );
});

test('a space the always-on nodes don’t carry fails its own calls only', async () => {
  const served = await startHost({
    key: await createP256Provider().generateKeyPair(),
    stores: memoryStores(),
    port: 0,
    free: true,
  });
  closing.push(() => served.close());
  const peer = `ws://127.0.0.1:${served.port}/peer`;
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const laptop = await createNode({
    signer,
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: { nodes: [peer] },
  });
  closing.push(() => laptop.close());
  const space = await laptop.spaces.create({ name: 'Club', visibility: 'private' });
  await laptop.records.put(space.id, 'app.note', { text: 'Soup on Friday' });
  await laptop.hosting.use(`http://127.0.0.1:${served.port}`);
  await until(
    async () => (await served.node.spaces()).some((one) => one.name === 'Club' && one.peers > 0),
    15_000,
    'the host to carry the space',
  );
  const invite = await laptop.spaces.invite(space.id);
  // Time for what it wrote to reach the host, before it goes.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await laptop.close();
  // Another space of hers, on a device that never handed it to the host.
  const offline = await createNode({ signer, stores: memoryStores(), accountKey, watchIntervalMs: 0 });
  closing.push(() => offline.close());
  const other = await offline.spaces.create({ name: 'Elsewhere', visibility: 'private' });
  const otherInvite = await offline.spaces.invite(other.id);

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: [peer],
    data: await tempDir('mcp-server-'),
    port,
    version: '0',
    accountHome: 'https://home.test',
  });
  closing.push(() => service.close());
  const token = await signInWith(issuer, async (audience) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      v: GRANT_VERSION,
      did: me.did,
      name: 'Ada',
      note: await signer.delegate({
        audience,
        expiration: expiresAt,
        ...noteTerms('/record', [space.id, other.id]),
      }),
      access: 'write',
      scope: 'spaces',
      spaces: [
        { id: space.id, name: 'Club', invite },
        { id: other.id, name: 'Elsewhere', invite: otherInvite },
      ],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });
  const club = await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' });
  assert.ok(club.includes('Soup on Friday'), club);
  const elsewhere = await callTool(issuer, token, 'records_put', {
    space: other.id,
    records: [{ collection: 'app.note', body: { text: 'Unseen' } }],
  });
  assert.match(elsewhere, /"isError":true/);
  assert.match(elsewhere, /Nobody who keeps this space is online right now/);
});
