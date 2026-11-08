/**
 * The minca command as this computer's agent: once `minca connect` has
 * allowed one, a command runs as it unless an account is named, so an agent's
 * shell uses Minca with the records-only note, whatever secret it inherits.
 * Like the MCP service, it refuses a space it can't catch up with.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { team } from '@minca/core';
import type { Grant } from '@minca/core/session';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { base64UrlEncode } from '../../core/src/utils/encoding.js';
import { connectAgent, reconnectAgent } from '../src/agent.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import { chooseAccount, createAccount, openHome, unlock } from '../src/home.js';
import { tempDir } from './helpers/nodes.js';

const run = promisify(execFile);
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

describe('the minca command, as the connected agent', () => {
  let daemon: Daemon;
  let space: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    // Ada's always-on node, holding a space, which the agent reaches over its socket.
    const adaHome = await openHome(await tempDir());
    const created = await createAccount(adaHome, { name: 'Ada' });
    assert.ok(created.code);
    const ada = await unlock(adaHome, await chooseAccount(adaHome), { code: created.code });
    daemon = await startDaemon({ unlocked: ada, port: 0, host: '127.0.0.1', rescanMs: 100 });
    space = (await daemon.node.spaces.create({ name: 'Notes', ...team, visibility: 'private' })).id;

    // `minca connect` on another computer with no account of its own: the home's answer is stood in for.
    const home = await tempDir();
    await reconnectAgent(home, (slot) =>
      connectAgent({
        slot,
        accountHome: 'https://home.test',
        relays: [],
        name: 'Agent on test',
        onLink: () => {},
        check: async () => {},
        connect: async ({ key }) =>
          ({
            v: GRANT_VERSION,
            did: ada.account.did,
            name: 'Ada',
            note: await ada.signer.delegate({
              audience: key.did,
              command: '/record',
              expiration: Math.floor(Date.now() / 1000) + 3600,
            }),
            access: 'write',
            scope: 'account',
            spaces: [],
            accountKey: base64UrlEncode(ada.accountKey),
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            home: 'https://home.test/connect',
          }) satisfies Grant,
      }),
    );
    // An account of its own here too, and its passphrase in the environment, as the README once suggested.
    await createAccount(await openHome(home), { name: 'Local', passphrase: 'pw' });
    const peer = `ws://127.0.0.1:${daemon.port}`;
    env = {
      ...process.env,
      MINCA_HOME: home,
      MINCA_PASSPHRASE: 'pw',
      MINCA_NODES: `${peer}/peer`,
      MINCA_RELAYS: peer,
    };
  });

  let closed = false;
  after(async () => {
    if (!closed) await daemon.close();
  });

  const minca = (...args: string[]) =>
    run(process.execPath, ['--conditions=@minca/source', '--import', 'tsx', main, ...args], {
      env,
      timeout: 60_000,
    });

  test('writes as the agent, "via agent", and the write reaches the always-on node before it exits', async () => {
    await minca('records', 'put', '--space', space, '--collection', 'app.note', '--body', '{"text":"milk"}');
    const kept = await daemon.node.records.query(space, { collection: 'app.note' });
    const [note] = kept.records;
    assert.equal(
      note?.root,
      daemon.node.did,
      "it counts as Ada's, not the account here whose passphrase it had",
    );
    assert.equal(note?.recordsOnly, true, 'written under the records-only note');

    const read: unknown = JSON.parse(
      (await minca('records', 'query', '--space', space, '--collection', 'app.note')).stdout,
    );
    assert.match(JSON.stringify(read), /milk/);
  });

  test('may not do what needs the person: the note grants records only', async () => {
    await assert.rejects(
      minca('spaces', 'assign', '--space', space, '--did', daemon.node.did, '--role', 'editor'),
      /An agent can't change who is in a space/,
    );
  });

  test('refuses a space it can’t catch up with, rather than write behind', async () => {
    await daemon.close();
    closed = true;
    await assert.rejects(
      minca('records', 'put', '--space', space, '--collection', 'app.note', '--body', '{"text":"late"}'),
      /Nobody who keeps this space is online right now/,
    );
  });
});
