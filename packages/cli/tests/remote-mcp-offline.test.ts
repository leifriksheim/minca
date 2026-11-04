/**
 * The MCP service with every device of hers offline: it reaches her spaces
 * through the free host, the host an invite names, or, with no host at all,
 * her open tab through a relay.
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
import { isRecord } from '../src/json.js';
import { tempDir } from './helpers/nodes.js';
import { enableWebRTC } from '../src/agent.js';
import { parseSpaceInvite } from '../../core/src/space/space-manager.js';
import { keptByHosts, closing, freePort, signInWith, callTool, aRelay } from './helpers/remote-mcp.js';

test('with every device of theirs offline, a chat app reads and writes through the free host, until she disconnects it', async () => {
  // A free host, and Ada's laptop handing it her space, as the home does for every new account.
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
  // Its registry too, which is how her other devices learn of the space: as `host.test.ts` waits.
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
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await laptop.close();

  // The service, reaching spaces through that host alone. A short idle time
  // stands for the default ten minutes, or a stranger filling its room: each
  // stops the chat app's node, and what it held goes.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const settings = {
    publicUrl: issuer,
    nodes: [peer],
    data: await tempDir('mcp-server-'),
    port,
    version: '0',
    accountHome: 'https://home.test',
    idleMs: 1500,
  };
  let service = await startMcpServer(settings);
  closing.push(() => service.close());
  let agent = '';
  const token = await signInWith(issuer, async (audience) => {
    agent = audience;
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

  await until(
    async () =>
      (await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' })).includes(
        'Soup on Friday',
      ),
    20_000,
    'the chat app to read what the laptop wrote, from the host',
  );
  const put = await callTool(issuer, token, 'records_put', {
    space: space.id,
    collection: 'app.note',
    body: { text: 'Bread too' },
  });
  assert.match(put, /"isError":false/);
  // Its node goes idle and its spaces go with it. Where its key has signed stays:
  // a node that forgot would sign at a place it signed before, a fork of the key
  // that withdraws everything it wrote (found by adversarial review).
  // Its node stops, and so does the service; one started again keeps only where the key signed,
  // so its next write follows its last rather than taking a place it used, a fork of the key
  // that would withdraw everything it wrote (found by adversarial review).
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await service.close();
  service = await startMcpServer(settings);
  await until(
    async () =>
      (await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' })).includes(
        'Bread too',
      ),
    20_000,
    'a fresh node to read the space again',
  );
  const again = await callTool(issuer, token, 'records_put', {
    space: space.id,
    collection: 'app.note',
    body: { text: 'Cake' },
  });
  assert.match(again, /"isError":false/);
  // Her phone, later, gets both from the host, as hers and "via agent".
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const phone = await onHost();
  // Asked only once it holds the space: listing one it hasn't joined yet waits for it.
  await until(
    async () => (await phone.spaces.list()).some((one) => one.id === space.id),
    40_000,
    'the phone to learn of the space',
  );
  await until(
    async () =>
      (await phone.records.list(space.id, { collection: 'app.note' })).some(
        (record) => isRecord(record.body) && record.body.text === 'Bread too',
      ),
    40_000,
    'the phone to get what the chat app wrote',
  );
  const written = (await phone.records.list(space.id, { collection: 'app.note' })).find(
    (record) => isRecord(record.body) && record.body.text === 'Bread too',
  );
  assert.equal(written?.root, me.did, 'written as Ada');
  assert.equal(written?.recordsOnly, true, 'via agent');
  await until(
    async () =>
      (await phone.records.list(space.id, { collection: 'app.note' })).some(
        (record) => isRecord(record.body) && record.body.text === 'Cake',
      ),
    40_000,
    'the phone to get what the restarted node wrote',
  );
  // Time to see both writes and find any place signed twice.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const texts = (await phone.records.list(space.id, { collection: 'app.note' }))
    .map((record) => (isRecord(record.body) ? record.body.text : null))
    .sort();
  assert.deepEqual(texts, ['Bread too', 'Cake', 'Soup on Friday'], 'nothing it wrote was withdrawn');

  // She disconnects it at her account home: the key is revoked. Peers refuse what
  // it writes after; its token still carries the space's key, so the service must
  // stop answering it once its node sees the revoke, and go on refusing it after
  // that node stops (found by adversarial review).
  assert.ok(await phone.revokeKey(agent, { waitMs: 5000 }), 'a peer took the revoke in');
  const refused = async () =>
    callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' }).then(
      (read) => {
        assert.ok(!read.includes('Secret plan'), 'it read what she wrote after it was refused');
        return false;
      },
      (error: unknown) => String(error).includes('invalid_token'),
    );
  await until(refused, 20_000, 'the service to refuse the token');
  await phone.records.put(space.id, 'app.note', { text: 'Secret plan' });
  // Its node stops; the next is refused before it starts.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.ok(await refused(), 'and to go on refusing it');
});

test('given no nodes of its own, the service reaches a space through the host her invite names', async () => {
  const served = await startHost({
    key: await createP256Provider().generateKeyPair(),
    stores: memoryStores(),
    port: 0,
    free: true,
  });
  closing.push(() => served.close());
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const laptop = await createNode({
    signer,
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
    network: { nodes: [`ws://127.0.0.1:${served.port}/peer`] },
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
  await keptByHosts(laptop, space.id);
  const invite = await laptop.spaces.invite(space.id);
  const named = parseSpaceInvite(invite).nodes ?? [];
  assert.ok(named.length > 0, 'her invite names her host');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await laptop.close();

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const service = await startMcpServer({
    publicUrl: issuer,
    data: await tempDir('mcp-server-'),
    port,
    version: '0',
    accountHome: 'https://home.test',
    // Her host is on this machine here; anywhere else, it would be at a public address.
    mayReach: async (address) => new URL(address).port === String(served.port),
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
  await until(
    async () =>
      (await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' })).includes(
        'Soup on Friday',
      ),
    30_000,
    'the chat app to read the space through her host',
  );
  const put = await callTool(issuer, token, 'records_put', {
    space: space.id,
    collection: 'app.note',
    body: { text: 'Bread too' },
  });
  assert.match(put, /"isError":false/, put);
});

test('with no host at all, a chat app writes to her open tab through a relay, and is told it is only there', async () => {
  await enableWebRTC();
  const relay = await aRelay();
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  // Her tab: no host, only the relay its space meets at.
  const tab = await createNode({
    signer,
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
    network: { relays: [relay] },
  });
  closing.push(() => tab.close());
  const space = await tab.spaces.create({ name: 'Club', visibility: 'private' });
  await tab.records.put(space.id, 'app.note', { text: 'Soup on Friday' });
  const invite = await tab.spaces.invite(space.id);

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const service = await startMcpServer({
    publicUrl: issuer,
    relays: [relay],
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
      note: await signer.delegate({ audience, expiration: expiresAt, ...noteTerms('/record', [space.id]) }),
      access: 'write',
      scope: 'spaces',
      spaces: [{ id: space.id, name: 'Club', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });
  await until(
    async () =>
      (await callTool(issuer, token, 'records_query', { space: space.id, collection: 'app.note' })).includes(
        'Soup on Friday',
      ),
    40_000,
    'the chat app to read the space from her tab',
  );
  // The space names no keepers: her tab has what it writes, and the app is told that is all.
  const put = await callTool(issuer, token, 'records_put', {
    space: space.id,
    collection: 'app.note',
    body: { text: 'Bread too' },
  });
  assert.match(put, /"isError":false/, put);
  assert.match(put, /Kept by a device of this space that is online now/);
  assert.ok(
    (await tab.records.list(space.id, { collection: 'app.note' })).some(
      (record) => isRecord(record.body) && record.body.text === 'Bread too',
    ),
    'her tab has it',
  );
});
