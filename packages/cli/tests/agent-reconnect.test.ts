/**
 * Connecting this computer's agent again: each `minca connect` makes a new
 * key, since a key the home revoked can't write again whatever note it gets,
 * and a running agent takes the new key and note up without a restart.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { connectWithCode, Grant } from '@minca/core/session';
import { createNode } from '../../core/src/node/node.js';
import type { P2PNode } from '../../core/src/node/types.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { base64UrlEncode } from '../../core/src/utils/encoding.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createFakeHub, type FakeHub } from '../../core/tests/helpers/fake-transport.js';
import { hold } from '../../core/tests/helpers/hold.js';
import { until } from '../../core/tests/helpers/until.js';
import { connectAgent, reloadOnConnect, startAgentNode, type RunningAgent } from '../src/agent.js';
import { onHub, tempDir } from './helpers/nodes.js';

const open: Array<{ close(): Promise<void> }> = [];
test.after(async () => {
  await Promise.all(open.splice(0).map((one) => one.close().catch(() => {})));
});

/** Someone with an account, online, and the account home's side of `minca connect` */
async function accountHolder(hub: FakeHub) {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const accountKey = await deriveAccountKey(seed);
  const node = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  open.push(node);
  const audiences: string[] = [];
  // What the home answers a code with: a records-only note for the whole account, made out to the key it was shown.
  const connect: typeof connectWithCode = async ({ key }) => {
    audiences.push(key.did);
    const note = await createLocalRootSigner(me, manager.getProvider()).delegate({
      audience: key.did,
      command: '/record',
      expiration: Math.floor(Date.now() / 1000) + 3600,
    });
    return {
      v: GRANT_VERSION,
      did: me.did,
      name: 'Ada',
      note,
      access: 'write',
      scope: 'account',
      spaces: [],
      accountKey: base64UrlEncode(accountKey),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      home: 'https://home.test/connect',
    } satisfies Grant;
  };
  return { node, connect, audiences };
}

const connectHere = (home: string, connect: typeof connectWithCode) =>
  connectAgent({
    home,
    accountHome: 'https://home.test',
    relays: [],
    name: 'Agent on test',
    onLink: () => {},
    check: async () => {},
    connect,
  });

const writes = (agent: RunningAgent, space: string, text: string) =>
  agent.node.records.put(space, 'app.note', { text }).then(
    (record) => record.key,
    (error: Error) => error,
  );

describe('connecting the agent again', () => {
  test('makes a new key each time, kept whole beside the grant made out to it', async () => {
    const home = await tempDir();
    const { connect, audiences } = await accountHolder(createFakeHub({ latencyMs: 1 }));
    await connectHere(home, connect);
    const firstKey = await readFile(path.join(home, 'agent', 'key.json'), 'utf8');
    await connectHere(home, connect);
    const secondKey = await readFile(path.join(home, 'agent', 'key.json'), 'utf8');

    assert.equal(audiences.length, 2);
    assert.notEqual(audiences[0], audiences[1], 'a new key for the second connect');
    assert.notEqual(firstKey, secondKey);
    for (const file of ['key.json', 'grant.json'])
      assert.equal((await stat(path.join(home, 'agent', file))).mode & 0o777, 0o600, file);

    // What starts from them is the second key, under the second note.
    const hub = createFakeHub({ latencyMs: 1 });
    const agent = await startAgentNode(home, { network: onHub(hub) });
    open.push(agent);
    assert.equal(agent.node.sessionDid, audiences[1]);
    assert.equal(await agent.reload(), false, 'nothing new on disk: nothing to reload');
  });

  test('a running agent whose key was revoked says so, and writes again once connected anew, without a restart', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const space = await ada.node.spaces.create({ name: 'Team', visibility: 'private' });
    await hold(ada.node, space.id);

    const home = await tempDir();
    await connectHere(home, ada.connect);
    const told: string[] = [];
    const agent = await startAgentNode(home, { network: onHub(hub), onRevoked: (id) => told.push(id) });
    open.push(agent);
    const reloaded: string[] = [];
    const stop = reloadOnConnect(home, agent, (line) => reloaded.push(line), { everyMs: 200 });
    open.push({ close: async () => stop() });
    await until(
      async () => (await agent.node.spaces.list()).some((one) => one.id === space.id),
      6000,
      'the agent to find the space',
    );
    await until(
      async () => typeof (await writes(agent, space.id, 'before')) === 'string',
      6000,
      'the agent to write',
    );

    // Disconnected in the account home: its key is revoked, and stays so.
    const firstKey = agent.node.sessionDid;
    await ada.node.spaces.revoke(space.id, firstKey);
    await until(async () => agent.revoked().includes(space.id), 6000, 'the agent to hear it was revoked');
    assert.deepEqual(told, [space.id]);
    const refused = await writes(agent, space.id, 'while revoked');
    assert.ok(refused instanceof Error && /revoked/.test(refused.message), String(refused));

    // `minca connect` again, while it runs: it picks the new key and note up by itself.
    await connectHere(home, ada.connect);
    await until(async () => agent.node.sessionDid !== firstKey, 6000, 'the agent to reload').catch(
      (error: unknown) => {
        throw new Error(`${String(error)}: ${reloaded.join(' | ')}`);
      },
    );
    assert.equal(agent.node.sessionDid, ada.audiences[1]);
    assert.deepEqual(agent.revoked(), [], 'the new key is not revoked');
    assert.ok(
      reloaded.some((line) => line.startsWith('reconnected')),
      reloaded.join('\n'),
    );

    let written: string | Error = new Error('not tried');
    await until(
      async () => typeof (written = await writes(agent, space.id, 'after')) === 'string',
      6000,
      'the agent to write again',
    );
    const key = String(written);
    await until(async () => (await ada.node.records.get(space.id, key)) !== null, 6000, 'it to reach Ada');
    assert.equal((await ada.node.records.get(space.id, key))?.verified, true);
  });

  test('a grant on disk that is not made out to the key there is left alone', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const home = await tempDir();
    await connectHere(home, ada.connect);
    const agent = await startAgentNode(home, { network: onHub(hub) });
    open.push(agent);
    const running: P2PNode = agent.node;

    // Another connect's key without its grant, as between the two writes: not one to start under.
    const other = await tempDir();
    await connectHere(other, ada.connect);
    await copyFile(path.join(other, 'agent', 'key.json'), path.join(home, 'agent', 'key.json'));
    assert.equal(await agent.reload(), false);
    assert.equal(agent.node, running);
  });
});
