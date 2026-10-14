/**
 * Adding `minca mcp` to the agents on a computer and taking it out again, run
 * in a child process with a home of its own and no `claude` on the PATH, so
 * nothing real is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/nodes.js';
import { at } from './helpers/json.js';

const run = promisify(execFile);
const clients = fileURLToPath(new URL('../src/clients.ts', import.meta.url));

/** Runs a call from clients.ts as if `home` were the user's home directory */
async function runIn(home: string, call: string): Promise<unknown> {
  const script =
    `const clients = await import(${JSON.stringify(clients)});` +
    `const done = await clients.${call};` +
    'process.stdout.write(JSON.stringify(done));';
  const { stdout } = await run(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), PATH: await tempDir() } },
  );
  return JSON.parse(stdout);
}

/** Connecting, for a minca home at `mincaHome` */
const configureIn = (home: string, mincaHome = '/h') =>
  runIn(
    home,
    `configureClients({ command: '/bin/minca', args: ['mcp', '--home', ${JSON.stringify(mincaHome)}] })`,
  );

/** Disconnecting, for a minca home at `mincaHome` */
const unconfigureIn = (home: string, mincaHome = '/h') =>
  runIn(home, `unconfigureClients(${JSON.stringify(mincaHome)})`);

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

test('adds minca to each agent found, keeping its other servers, and replaces it when run again', async () => {
  const home = await tempDir();
  await mkdir(path.join(home, '.cursor'));
  await writeFile(
    path.join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
  );
  // Claude Code without its CLI on the PATH: its config file instead.
  await mkdir(path.join(home, '.claude'));

  const done = await configureIn(home);
  assert.ok(Array.isArray(done));
  const names = done.map((entry) => at(entry, 'client'));
  assert.ok(names.includes('Cursor') && names.includes('Claude Code'), `configured: ${names.join(', ')}`);
  assert.ok(done.every((entry) => at(entry, 'ok') === true));

  const expected = { command: '/bin/minca', args: ['mcp', '--home', '/h'] };
  const cursor = await readJson(path.join(home, '.cursor', 'mcp.json'));
  assert.deepEqual(at(cursor, 'mcpServers', 'other'), { command: 'other' });
  assert.deepEqual(at(cursor, 'mcpServers', 'minca', 'command'), expected.command);
  assert.deepEqual(at(cursor, 'mcpServers', 'minca', 'args'), expected.args);
  const claude = await readJson(path.join(home, '.claude.json'));
  assert.deepEqual(at(claude, 'mcpServers', 'minca', 'args'), expected.args);

  await configureIn(home);
  const servers = at(await readJson(path.join(home, '.cursor', 'mcp.json')), 'mcpServers');
  assert.ok(typeof servers === 'object' && servers !== null);
  assert.deepEqual(Object.keys(servers).sort(), ['minca', 'other']);
});

test('touches nothing when no agent is installed', async () => {
  const done = await configureIn(await tempDir());
  assert.deepEqual(done, []);
});

test('disconnecting takes minca out of each agent connecting added it to, and nothing else', async () => {
  const home = await tempDir();
  await mkdir(path.join(home, '.cursor'));
  await writeFile(
    path.join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
  );
  await mkdir(path.join(home, '.claude'));
  await configureIn(home);

  const done = await unconfigureIn(home);
  assert.ok(Array.isArray(done));
  const names = done.map((entry) => at(entry, 'client'));
  assert.ok(names.includes('Cursor') && names.includes('Claude Code'), `removed from: ${names.join(', ')}`);
  assert.ok(done.every((entry) => at(entry, 'ok') === true));

  const cursor = await readJson(path.join(home, '.cursor', 'mcp.json'));
  assert.equal(at(cursor, 'mcpServers', 'minca'), undefined);
  assert.deepEqual(at(cursor, 'mcpServers', 'other'), { command: 'other' });
  assert.equal(at(await readJson(path.join(home, '.claude.json')), 'mcpServers', 'minca'), undefined);

  // Again: nothing left to take out.
  assert.deepEqual(await unconfigureIn(home), []);
});

test('disconnecting leaves an entry added by hand, or for another home', async () => {
  const home = await tempDir();
  await mkdir(path.join(home, '.cursor'));
  const byHand = { command: 'minca', args: ['mcp', '--account'] };
  await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { minca: byHand } }));
  assert.deepEqual(await unconfigureIn(home), []);
  assert.deepEqual(at(await readJson(path.join(home, '.cursor', 'mcp.json')), 'mcpServers', 'minca'), byHand);

  await configureIn(home, '/other-home');
  assert.deepEqual(await unconfigureIn(home, '/h'), []);
  assert.deepEqual(
    at(await readJson(path.join(home, '.cursor', 'mcp.json')), 'mcpServers', 'minca', 'args'),
    ['mcp', '--home', '/other-home'],
  );
});
