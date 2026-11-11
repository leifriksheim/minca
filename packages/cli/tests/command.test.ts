/**
 * The minca command, run as a real process: what a person or an agent's shell
 * types. Apart from the daemon's tests: each file starts many processes, and
 * together they took most of a file's time limit on a busy machine.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/nodes.js';
import { loadModelSetting } from '../src/guide.js';
import { at } from './helpers/json.js';

const run = promisify(execFile);

describe('the minca command', () => {
  test('init, create and list from a real process', async () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const env = { ...process.env, MINCA_HOME: await tempDir(), MINCA_PASSPHRASE: 'pw' };
    const minca = (...args: string[]) =>
      run(process.execPath, ['--conditions=@minca/source', '--import', 'tsx', main, ...args], {
        env,
      });

    const { stderr } = await minca('init', '--name', 'Leif', '--passphrase');
    assert.match(stderr, /Recovery code: [0-9A-Z-]+/);

    const created: unknown = JSON.parse(
      (await minca('spaces', 'create', '--name', 'Notes', '--visibility', 'private')).stdout,
    );
    const space = at(created, 'id');
    assert.ok(typeof space === 'string');
    await minca(
      'records',
      'put',
      '--space',
      space,
      '--records',
      '[{"collection":"app.note","body":{"text":"hi"}}]',
    );
    const listed: unknown = JSON.parse(
      (await minca('records', 'query', '--space', space, '--collection', 'app.note')).stdout,
    );
    assert.equal(at(listed, 'records', 0, 'body', 'text'), 'hi');

    await assert.rejects(minca('records', 'put', '--space', space, '--nonsense', 'x'), /has no --nonsense/);
  });

  test('an unknown command says so, without asking for an account first', async () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const env = { ...process.env, MINCA_HOME: await tempDir() };
    await assert.rejects(
      run(process.execPath, ['--conditions=@minca/source', '--import', 'tsx', main, 'agnet'], {
        env,
      }),
      (error: unknown) => {
        const said = String(at(error, 'stderr'));
        assert.match(said, /Unknown command "agnet"/);
        assert.doesNotMatch(said, /minca init/);
        return true;
      },
    );
  });

  test('with no terminal nothing is asked: a missing value fails at once, naming its flag', async () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const env = { ...process.env, MINCA_HOME: await tempDir(), MINCA_PASSPHRASE: 'pw' };
    // execFile gives no terminal, as an agent's shell or CI would.
    const minca = (...args: string[]) =>
      run(process.execPath, ['--conditions=@minca/source', '--import', 'tsx', main, ...args], {
        env,
        timeout: 30_000,
      });
    const refused = async (args: string[], pattern: RegExp) =>
      assert.rejects(minca(...args), (error: unknown) => {
        assert.match(String(at(error, 'stderr')), pattern);
        return true;
      });

    await minca('init', '--name', 'Leif', '--passphrase');
    await refused(['spaces', 'invite'], /Missing --space\. Its id is in `minca spaces list`/);
    await refused(['spaces', 'create', '--name', 'Club'], /Missing --visibility/);

    const space = at(
      JSON.parse((await minca('spaces', 'create', '--name', 'Club', '--visibility', 'private')).stdout),
      'id',
    );
    assert.ok(typeof space === 'string');
    await refused(['records', 'get', '--space', space], /Missing --key/);

    // A standard collection by its name, and an automation by flags alone.
    const defined: unknown = JSON.parse(
      (await minca('collections', 'define', '--standard', 'std.automation', '--space', space)).stdout,
    );
    assert.equal(at(defined, 'name'), 'std.automation');
    await refused(
      ['automation', 'add', '--space', space, '--name', 'Mentions', '--collection', 'std.message'],
      /Missing --do/,
    );
    const mentions: unknown = JSON.parse(
      (
        await minca(
          'automation',
          'add',
          '--space',
          space,
          '--name',
          'Mentions',
          '--collection',
          'std.message',
          '--where',
          '{"mentions":{"$contains":"$me"}}',
          '--from',
          'member',
          '--do',
          'Answer them briefly',
        )
      ).stdout,
    );
    assert.deepEqual(at(mentions, 'when'), {
      query: { collection: 'std.message', where: { mentions: { $contains: '$me' } } },
      from: ['member'],
    });
    assert.deepEqual(at(mentions, 'then'), { kind: 'ask', text: 'Answer them briefly' });
    const scheduled: unknown = JSON.parse(
      (
        await minca(
          'automation',
          'add',
          '--space',
          space,
          '--name',
          'Mornings',
          '--every',
          '0 8 * * 1-5',
          '--do',
          'Plan my day',
        )
      ).stdout,
    );
    assert.equal(at(scheduled, 'every'), '0 8 * * 1-5');
    await refused(
      ['automation', 'add', '--space', space, '--name', 'Bad', '--every', 'at noon daily', '--do', 'x'],
      /--every: /,
    );
    await refused(
      ['collections', 'define', '--standard', 'std.nothing', '--space', space],
      /The library has no std\.nothing/,
    );

    // Something that can't be undone still runs without asking, as it always has: the agent or script said so.
    const listed: unknown = JSON.parse(
      (await minca('records', 'query', '--space', space, '--collection', 'std.automation')).stdout,
    );
    const key = at(listed, 'records', 0, 'key');
    assert.ok(typeof key === 'string');
    await minca('records', 'delete', '--space', space, '--key', key);
  });

  test('what agent setup kept is read back, and anything unreadable is as if never kept', async () => {
    const home = await tempDir();
    await mkdir(path.join(home, 'agent'), { recursive: true });
    assert.equal(await loadModelSetting(home), null);
    await writeFile(
      path.join(home, 'agent', 'model.json'),
      JSON.stringify({
        provider: 'openai',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        price: '0.66/1.98',
      }),
    );
    assert.deepEqual(await loadModelSetting(home), {
      provider: 'openai',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      price: '0.66/1.98',
    });
    await writeFile(path.join(home, 'agent', 'model.json'), '{"provider":"elsewhere","model":"x"}');
    assert.equal(await loadModelSetting(home), null);
    await writeFile(path.join(home, 'agent', 'model.json'), 'not json');
    assert.equal(await loadModelSetting(home), null);
  });
});
