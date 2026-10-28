/**
 * Processes racing for the agent's key: however many take a lock at once, or
 * take the agent up when the one running it stops, one signs with it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Grant } from '@minca/core/session';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { base64UrlEncode } from '../../core/src/utils/encoding.js';
import { until } from '../../core/tests/helpers/until.js';
import { connectAgent } from '../src/agent.js';
import { tempDir } from './helpers/nodes.js';

const children: ChildProcess[] = [];
test.after(() => {
  for (const child of children) child.kill('SIGKILL');
});

/** A helper in `tests/helpers` as a process of its own, and the lines it says */
function start(helper: string, args: ReadonlyArray<string>) {
  const child = spawn(
    process.execPath,
    [
      '--conditions=@minca/source',
      '--import',
      'tsx',
      path.join(import.meta.dirname, 'helpers', helper),
      ...args,
    ],
    { cwd: path.join(import.meta.dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'] },
  );
  children.push(child);
  const said: string[] = [];
  if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => said.push(line));
  return { child, said, last: () => said.at(-1) };
}

/** A process that has run and gone, so its pid names nobody */
async function gonePid(): Promise<number> {
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.once('exit', resolve));
  return gone.pid ?? 2147483646;
}

describe('one signer for a key', () => {
  for (const left of ['lock.0', 'lock'])
    test(`several processes taking a lock left behind (${left}) at once: one gets it`, async () => {
      for (let trial = 0; trial < 5; trial += 1) {
        const dir = await tempDir();
        await writeFile(path.join(dir, left), String(await gonePid()));
        const racers = [0, 1, 2, 3].map(() => start('lock-child.ts', [path.join(dir, 'lock')]));
        await until(() => racers.every((racer) => racer.last() === 'ready'), 10_000, 'the racers to start');
        const at = Date.now() + 300;
        for (const racer of racers) racer.child.stdin?.write(`${at}\n`);
        await until(() => racers.every((racer) => racer.said.length === 2), 10_000, 'each to try');
        const held = racers.filter((racer) => racer.last() === 'HELD').length;
        for (const racer of racers) racer.child.stdin?.end();
        assert.equal(held, 1, `trial ${trial}: ${held} processes hold the lock`);
      }
    });

  for (const signal of ['SIGTERM', 'SIGKILL'] as const)
    test(`the process running the agent stopped by ${signal}: one of those borrowing takes it up`, async () => {
      const manager = createIdentityManager();
      const seed = generateSeed();
      const me = await manager.fromSeed(seed);
      const accountKey = await deriveAccountKey(seed);
      const home = await tempDir();
      await connectAgent({
        home,
        accountHome: 'https://home.test',
        relays: [],
        name: 'Agent on test',
        onLink: () => {},
        check: async () => {},
        connect: async ({ key }) =>
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
          }) satisfies Grant,
      });

      const first = start('session-child.ts', [home]);
      await until(() => first.last() === 'LOCAL', 10_000, 'the first to run the agent');
      const rest = [0, 1, 2].map(() => start('session-child.ts', [home]));
      await until(() => rest.every((one) => one.last() === 'REMOTE'), 10_000, 'the rest to borrow it');
      first.child.kill(signal);

      await until(() => rest.some((one) => one.last() === 'LOCAL'), 10_000, 'one to take it up');
      // Long enough for every one of them to have tried.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const running = rest.filter((one) => one.said.includes('LOCAL')).length;
      assert.equal(running, 1, `${running} processes ran the agent's node, each signing with its key`);
      assert.ok(rest.every((one) => one.last() === 'LOCAL' || one.last() === 'REMOTE'));
    });
});
