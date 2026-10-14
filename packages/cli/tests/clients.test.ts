/**
 * Adding `minca mcp` to the agents on a computer, run in a child process with
 * a home of its own and no `claude` on the PATH, so nothing real is touched.
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

/** Runs configureClients as if `home` were the user's home directory */
async function configureIn(home: string): Promise<unknown> {
  const script =
    `const { configureClients } = await import(${JSON.stringify(clients)});` +
    `const done = await configureClients({ command: '/bin/minca', args: ['mcp', '--home', '/h'] });` +
    'process.stdout.write(JSON.stringify(done));';
  const { stdout } = await run(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), PATH: await tempDir() } },
  );
  return JSON.parse(stdout);
}

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
