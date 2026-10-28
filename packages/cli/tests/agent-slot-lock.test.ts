/**
 * Sessions starting the agent at once, with a slot's lock left by a process
 * that is gone (a crash, a reboot): however many take it over together, one
 * gets the slot, so one signs with its key and its line doesn't fork
 * (spec 02 §4.10).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { connectWithCode, Grant } from '@minca/core/session';
import { createNode } from '../../core/src/node/node.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { base64UrlEncode } from '../../core/src/utils/encoding.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createFakeHub } from '../../core/tests/helpers/fake-transport.js';
import { hold } from '../../core/tests/helpers/hold.js';
import { until } from '../../core/tests/helpers/until.js';
import { connectAgent, startAgentNode } from '../src/agent.js';
import { onHub, tempDir } from './helpers/nodes.js';

const children: ChildProcess[] = [];
test.after(() => {
  for (const child of children) child.kill('SIGKILL');
});

/** Sessions in processes of their own, each claiming a slot at the same moment: the slot each got */
async function race(home: string, count: number, space?: string): Promise<string[]> {
  const racers = Array.from({ length: count }, () => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=@minca/source',
        '--import',
        'tsx',
        path.join(import.meta.dirname, 'helpers', 'slot-child.ts'),
        home,
        ...(space ? [space] : []),
      ],
      { cwd: path.join(import.meta.dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'] },
    );
    children.push(child);
    const said: string[] = [];
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => said.push(line));
    return { child, said };
  });
  await until(() => racers.every((racer) => racer.said[0] === 'ready'), 20_000, 'the racers to start');
  const at = Date.now() + 300;
  for (const racer of racers) racer.child.stdin?.write(`${at}\n`);
  await until(() => racers.every((racer) => racer.said.length === 2), 30_000, 'each to claim');
  const slots = racers.map((racer) => racer.said[1] ?? '');
  await Promise.all(
    racers.map(({ child }) => {
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.stdin?.end();
      return gone;
    }),
  );
  return slots;
}

/** A process that has run and gone, so its pid names nobody */
async function gonePid(): Promise<number> {
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.once('exit', resolve));
  return gone.pid ?? 2147483646;
}

/** Someone with an account, online, and a connected slot 1 in a new home */
async function connected() {
  const hub = createFakeHub({ latencyMs: 1 });
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const accountKey = await deriveAccountKey(seed);
  const ada = await createNode({
    signer: createLocalRootSigner(me, manager.getProvider()),
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  const connect: typeof connectWithCode = async ({ key }) =>
    ({
      v: GRANT_VERSION,
      did: me.did,
      name: 'Ada',
      note: await createLocalRootSigner(me, manager.getProvider()).delegate({
        audience: key.did,
        command: '/record',
        expiration: Math.floor(Date.now() / 1000) + 3600,
      }),
      access: 'write',
      scope: 'account',
      spaces: [],
      accountKey: base64UrlEncode(accountKey),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      home: 'https://home.test/connect',
    }) satisfies Grant;
  const home = await tempDir();
  const dir = path.join(home, 'agent', '1');
  await connectAgent({
    slot: dir,
    accountHome: 'https://home.test',
    relays: [],
    name: 'Agent on test',
    onLink: () => {},
    check: async () => {},
    connect,
  });
  return { hub, ada, home, dir };
}

describe('one session to a slot', () => {
  test('sessions taking over a slot left locked, all at once: one gets it', async () => {
    const { ada, home, dir } = await connected();
    for (let trial = 0; trial < 5; trial += 1) {
      await writeFile(path.join(dir, 'lock.0'), String(await gonePid()));
      const slots = await race(home, 4);
      const inOne = slots.filter((slot) => slot === dir).length;
      assert.equal(inOne, 1, `trial ${trial}: ${inOne} sessions hold slot 1`);
      assert.equal(new Set(slots).size, slots.length, `trial ${trial}: each session has a slot of its own`);
    }
    await ada.close();
  });

  test('sessions writing as they start on a slot left locked: its key never forks', async () => {
    const { hub, ada, home, dir } = await connected();
    const space = await ada.spaces.create({ name: 'Team', visibility: 'private' });
    await hold(ada, space.id);
    // Slot 1 ran once, joined the space, and its process went without letting go.
    const slot = { dir, release: async () => {} };
    const first = await startAgentNode(home, slot, { network: onHub(hub) });
    await until(
      async () => (await first.node.spaces.list()).some((s) => s.id === space.id),
      20_000,
      'joined',
    );
    await first.node.records.put(space.id, 'app.note', { text: 'before' });
    await first.close();
    await writeFile(path.join(dir, 'lock.0'), String(await gonePid()));

    await race(home, 4, space.id);
    // What they wrote, from the shared folder, to a peer that would see a fork.
    const again = await startAgentNode(home, slot, { network: onHub(hub) });
    await until(
      async () => (await ada.records.list(space.id, { collection: 'app.note' })).length >= 6,
      30_000,
      'what slot 1 wrote to reach Ada',
    );
    assert.deepEqual((await ada.spaces.access(space.id)).forks, []);
    await again.close();
    await ada.close();
  });
});
