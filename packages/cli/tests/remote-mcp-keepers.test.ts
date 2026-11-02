/**
 * The MCP service's node and the space's keepers: a fresh node never starts a
 * line again, and a write isn't done until every keeper has it.
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
import { lineKey } from '../../core/src/records/key.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { startMcpServer } from '../src/remote-mcp/server.js';
import { startHost } from '../src/host.js';
import { until } from '../../core/tests/helpers/until.js';
import { tempDir } from './helpers/nodes.js';
import { keptByHosts, closing, freePort, signInWith, callTool, between } from './helpers/remote-mcp.js';

test('a fresh node answers only once it holds what the free host does: a payment never starts her line again', async () => {
  // Ada's laptop pays twice in her line (09 §7), hands the space to the free host, and goes offline.
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
  const space = await laptop.spaces.create({ name: 'Credit', visibility: 'private' });
  await laptop.collections.define(space.id, {
    name: 'app.pay',
    schema: { type: 'object' },
    contract: {
      check: [
        {
          that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount',
          else: 'The balance follows from the one before',
        },
      ],
      line: { once: ['received'] },
    },
  });
  const line = await lineKey(me.did, 'app.pay');
  for (let i = 0; i < 20; i++) await laptop.records.put(space.id, 'app.note', { i });
  const first = await laptop.records.put(space.id, 'app.pay', { amount: 10, balance: -10 }, { key: line });
  await laptop.records.update(space.id, line, { amount: 5, balance: -15 });
  await laptop.hosting.use(`http://127.0.0.1:${served.port}`);
  await until(
    async () => {
      const reached = (await served.node.spaces()).filter((one) => one.peers > 0).map((one) => one.name);
      return reached.includes('Account registry') && reached.includes('Credit');
    },
    15_000,
    'the host to carry her registry and the space',
  );
  await keptByHosts(laptop, space.id);
  const invite = await laptop.spaces.invite(space.id);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await laptop.close();

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
      note: await signer.delegate({ audience, expiration: expiresAt, ...noteTerms('/record', [space.id]) }),
      access: 'write',
      scope: 'spaces',
      spaces: [{ id: space.id, name: 'Credit', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });

  // The chat app's first call, from a node started just now: her line is there, so it pays after it.
  // A node that answered from what it had so far would say there is none, and the model would start one.
  const paid = await callTool(issuer, token, 'records_update', {
    space: space.id,
    key: line,
    body: { amount: 1, balance: -16 },
  });
  assert.match(paid, /"isError":false/, paid);

  // Her phone sees one line, and her first payment still counts (found by adversarial review).
  const phone = await onHost();
  await until(
    async () => (await phone.spaces.list()).some((one) => one.id === space.id),
    40_000,
    'the phone to learn of the space',
  );
  await until(
    async () => (await phone.records.get<{ balance: number }>(space.id, line))?.body?.balance === -16,
    40_000,
    'the phone to get the chat app’s payment',
  );
  const verdict = await phone.records.contracts(space.id, line, first.version);
  assert.notEqual(verdict?.passes, false, JSON.stringify(verdict));
});

test('with two always-on keepers, a payment one of them missed isn’t done until both have it, and the next builds on it', async () => {
  const hosts = await Promise.all(
    [0, 1].map(async () => {
      const served = await startHost({
        key: await createP256Provider().generateKeyPair(),
        stores: memoryStores(),
        port: 0,
        free: true,
      });
      closing.push(() => served.close());
      return served;
    }),
  );
  const [h1, h2] = hosts;
  assert.ok(h1 && h2);
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const peers = hosts.map((served) => `ws://127.0.0.1:${served.port}/peer`);
  const onHosts = async () => {
    const node = await createNode({
      signer,
      stores: memoryStores(),
      accountKey,
      watchIntervalMs: 0,
      network: { nodes: peers },
    });
    closing.push(() => node.close());
    return node;
  };
  const laptop = await onHosts();
  const space = await laptop.spaces.create({ name: 'Credit', visibility: 'private' });
  await laptop.collections.define(space.id, {
    name: 'app.pay',
    schema: { type: 'object' },
    contract: {
      check: [
        {
          that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount',
          else: 'The balance follows from the one before',
        },
      ],
      line: { once: ['received'] },
    },
  });
  const line = await lineKey(me.did, 'app.pay');
  const first = await laptop.records.put(space.id, 'app.pay', { amount: 10, balance: -10 }, { key: line });
  for (const served of hosts) await laptop.hosting.use(`http://127.0.0.1:${served.port}`);
  for (const served of hosts)
    await until(
      async () => (await served.node.spaces()).some((one) => one.name === 'Credit' && one.peers > 0),
      15_000,
      'each host to carry the space',
    );
  await keptByHosts(laptop, space.id, 2);
  const invite = await laptop.spaces.invite(space.id);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await laptop.close();

  const link1 = await between(h1.port);
  const link2 = await between(h2.port);
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const data = await tempDir('mcp-server-');
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: [`ws://127.0.0.1:${link1.port}/peer`, `ws://127.0.0.1:${link2.port}/peer`],
    data,
    port,
    version: '0',
    accountHome: 'https://home.test',
    idleMs: 1500,
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
      spaces: [{ id: space.id, name: 'Credit', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });

  // The second host can't be reached. She pays 5; the first stores it, but a payment is done
  // only once both keepers have it: a node behind, answered by the second alone, would pay again
  // from the balance before it, a double spend that ends her line (09 §7.5; found by adversarial review).
  link2.refuse();
  const paid = await callTool(issuer, token, 'records_update', {
    space: space.id,
    key: line,
    body: { amount: 5, balance: -15 },
  });
  assert.match(paid, /"isError":true/, paid);
  assert.match(paid, /not yet kept elsewhere/);
  // Its node waits for them, idle or not, rather than lose what they don't have.
  link2.mend();
  await until(
    async () => (await callTool(issuer, token, 'spaces_status', { space: space.id })).includes('"pending":0'),
    60_000,
    'both keepers to have the payment',
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Next time the first can't be reached. The second has the payment now, so a node started
  // from it carries on after it: the line and the key's log both go on unbroken. Not done until
  // the first has it too, but written, once.
  link1.refuse();
  const again = await callTool(issuer, token, 'records_update', {
    space: space.id,
    key: line,
    body: { amount: 1, balance: -16 },
  });
  assert.match(again, /"isError":false|not yet kept elsewhere/, again);

  link1.mend();
  const phone = await onHosts();
  await until(
    async () => (await phone.spaces.list()).some((one) => one.id === space.id),
    40_000,
    'the phone to learn of the space',
  );
  await until(
    async () => (await phone.records.get<{ balance: number }>(space.id, line))?.body?.balance === -16,
    40_000,
    'the phone to get both payments',
  );
  assert.notEqual((await phone.records.contracts(space.id, line, first.version))?.passes, false);
  const forks = await phone.records.list(space.id, { collection: 'sys.fork' }).catch(() => []);
  assert.equal(forks.length, 0, 'no key forked');
});

test(
  'a write call that fails between doesn’t let the node forget a payment one keeper missed',
  { timeout: 240_000 },
  async () => {
    // Found by adversarial review: it cleared what the node waited on, and the node stopped with the payment.

    const hosts = await Promise.all(
      [0, 1].map(async () => {
        const served = await startHost({
          key: await createP256Provider().generateKeyPair(),
          stores: memoryStores(),
          port: 0,
          free: true,
        });
        closing.push(() => served.close());
        return served;
      }),
    );
    const [h1, h2] = hosts;
    assert.ok(h1 && h2);
    const manager = createIdentityManager();
    const seed = generateSeed();
    const me = await manager.fromSeed(seed);
    const signer = createLocalRootSigner(me, manager.getProvider());
    const accountKey = await deriveAccountKey(seed);
    const peers = hosts.map((served) => 'ws://127.0.0.1:' + served.port + '/peer');
    const onHosts = async () => {
      const node = await createNode({
        signer,
        stores: memoryStores(),
        accountKey,
        watchIntervalMs: 0,
        network: { nodes: peers },
      });
      closing.push(() => node.close());
      return node;
    };
    const laptop = await onHosts();
    const space = await laptop.spaces.create({ name: 'Credit', visibility: 'private' });
    await laptop.collections.define(space.id, {
      name: 'app.pay',
      schema: { type: 'object' },
      contract: {
        check: [
          {
            that: 'body.balance == (prev == null ? 0.0 : prev.body.balance) - body.amount',
            else: 'The balance follows from the one before',
          },
        ],
        line: { once: ['received'] },
      },
    });
    const line = await lineKey(me.did, 'app.pay');
    await laptop.records.put(space.id, 'app.pay', { amount: 10, balance: -10 }, { key: line });
    for (const served of hosts) await laptop.hosting.use('http://127.0.0.1:' + served.port);
    for (const served of hosts)
      await until(
        async () => (await served.node.spaces()).some((one) => one.name === 'Credit' && one.peers > 0),
        15_000,
        'each host to carry the space',
      );
    await keptByHosts(laptop, space.id, 2);
    const invite = await laptop.spaces.invite(space.id);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await laptop.close();

    const link1 = await between(h1.port);
    const link2 = await between(h2.port);
    const port = await freePort();
    const issuer = 'http://127.0.0.1:' + port;
    const service = await startMcpServer({
      publicUrl: issuer,
      nodes: ['ws://127.0.0.1:' + link1.port + '/peer', 'ws://127.0.0.1:' + link2.port + '/peer'],
      data: await tempDir('mcp-server-'),
      port,
      version: '0',
      accountHome: 'https://home.test',
      idleMs: 1500,
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
        spaces: [{ id: space.id, name: 'Credit', invite }],
        expiresAt,
        home: 'https://home.test/connect',
      };
    });

    // The second keeper is down: she pays 5, the first has it, it is not done.
    link2.refuse();
    const paid = await callTool(issuer, token, 'records_update', {
      space: space.id,
      key: line,
      body: { amount: 5, balance: -15 },
    });
    assert.match(paid, /not yet kept elsewhere/, paid);
    {
      // The model tries a write that fails: nothing written, so nothing since its start waits.
      const failed = await callTool(issuer, token, 'records_update', {
        space: space.id,
        key: 'no-such-record',
        body: { x: 1 },
      });
      assert.match(failed, /isError":true/, failed);
    }
    // Idle well past idleMs: the node should wait for the second keeper, as the payment is still pending.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    // Now the first keeper is down and the second back: a node that still runs has the payment and passes it on.
    link1.refuse();
    link2.mend();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const got = await callTool(issuer, token, 'records_get', { space: space.id, key: line });

    assert.match(got, /-15/, 'the payment of 5 went with the node: the balance read is the one before it');
  },
);
