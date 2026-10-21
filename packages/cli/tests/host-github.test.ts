/**
 * Connecting a bot a host runs to GitHub: the admin's request, GitHub's
 * install screen and redirect, the bot saying what it is connected to, and
 * GitHub's webhook. Apart from host.test.ts so the two run side by side.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../../core/src/node/node.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import type { HostNode } from '../../core/src/node/host.js';
import { describeHost } from '../../core/src/session/hosting.js';
import { startHost } from '../src/host.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { tempDir } from './helpers/nodes.js';
import { until } from '../../core/tests/helpers/until.js';
import { host as hostSchema } from '../../core/src/schemas/library/community.js';
import {
  askToConnect,
  askToDisconnect,
  connect,
  connectPage,
  connector,
} from '../../core/src/schemas/connectors.js';
import { verifierOf } from '../src/host-connect.js';
import type { GitHubApp } from '../src/connectors/github.js';
import { githubConnector } from '../src/connectors/github-connector.js';
import { team } from '../../core/src/space/presets.js';
import { joined } from '../../core/tests/helpers/joined.js';

const provider = createP256Provider();
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

async function account() {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveAccountKey(seed),
  };
}

const carries = (node: HostNode, spaceId: string) => async () =>
  (await node.spaces()).some((space) => space.id === spaceId);

describe('connecting a bot to GitHub', () => {
  const hosts: Array<{ close(): Promise<void> }> = [];
  afterEach(() => Promise.all(hosts.splice(0).map((served) => served.close())));
  const model = {
    name: 'claude-sonnet-5-5',
    dailyCap: 1,
    think: () => async () => {
      throw new Error('No model in these tests');
    },
  };

  /** What the installation reaches, as GitHub would say it now */
  let repos = ['acme/site', 'acme/docs'];
  /** GitHub as the host sees it: each sign-in code reaches one installation */
  function fakeGitHub(reach: Record<string, { installation: number; account: string }>): GitHubApp {
    return {
      installUrl: (state) => `https://github.example/apps/minca/installations/new?state=${state}`,
      confirm: async (code, installation) => {
        const one = reach[code];
        return one && one.installation === installation ? { account: one.account } : null;
      },
      repos: async () => repos,
      token: async () => 'ghs_test',
      hooks: true,
      // GitHub's signature, as these tests write it.
      signed: (body, signature) => signature === `sha256=${body.length}`,
    };
  }

  /** A community on a free host with GitHub, its bot joined, and the two collections defined */
  async function botToConnect(
    github: GitHubApp | null = fakeGitHub({ good: { installation: 42, account: 'acme' } }),
  ) {
    const folder = await tempDir('minca-connect-');
    const served = await startHost({
      key: await provider.generateKeyPair(),
      stores: memoryStores(),
      port: 0,
      free: true,
      bots: { folder, model },
      connectors: github ? [githubConnector(github)] : [],
    });
    hosts.push(served);
    const url = `http://127.0.0.1:${served.port}`;
    const me = await account();
    const laptop = await createNode({
      signer: me.signer,
      stores: memoryStores(),
      accountKey: me.accountKey,
      watchIntervalMs: 0,
      network: {},
    });
    open.push(laptop);
    const { id: space } = await laptop.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await laptop.collections.define(space, hostSchema);
    await laptop.records.put(space, hostSchema.name, { url });
    await laptop.hosting.space(space);
    await until(carries(served.node, space), 6000, 'the host to carry the space');
    const { bot } = await laptop.hosting.startBot(space, url, { name: 'Club Bot' });
    await until(
      async () =>
        (await laptop.spaces.access(space)).members.some((m) => m.did === bot && m.roles.length > 0),
      15_000,
      'the bot to join',
    );
    await laptop.collections.define(space, connect);
    await laptop.collections.define(space, connector);

    /** Writes a request, as the admin's app does; its key */
    const ask = async (
      secret: string,
      over: Partial<{ bot: string; expires: string; disconnect: boolean }> = {},
    ) =>
      (
        await laptop.records.put(space, connect, {
          bot,
          kind: 'github',
          verifier: await verifierOf(secretOf(secret)),
          expires: new Date(Date.now() + 300_000).toISOString(),
          ...over,
        })
      ).key;
    /** Opens the host's connect page, as the popup does */
    const openPage = (request: string, secret: string, as = bot) =>
      fetch(
        `${url}/host/bots/${encodeURIComponent(as)}/connect/github?space=${space}&request=${request}&secret=${secretOf(secret)}`,
        { redirect: 'manual' },
      );
    /** GitHub's return to the host; with `from`, in the browser that opened that page, bringing its state and cookie */
    const back = (params: Record<string, string>, from?: Response) => {
      const cookie = from?.headers.get('set-cookie')?.split(';')[0];
      const query = new URLSearchParams({ ...(from ? { state: stateOf(from) } : {}), ...params });
      return fetch(`${url}/host/connect/github/callback?${query}`, {
        redirect: 'manual',
        ...(cookie ? { headers: { cookie } } : {}),
      });
    };
    /** The bot's own std.connector, as the admin's laptop sees it */
    const said = async () =>
      (await laptop.records.list(space, { collection: connector.name })).filter(
        (record) => record.createdBy === bot && record.verified,
      );
    /** Connects the bot all the way, as an admin would */
    const connectNow = async () => {
      const page = await openPage(await ask('secret-one'), 'secret-one');
      const done = await back({ installation_id: '42', code: 'good' }, page);
      assert.equal(done.status, 200);
      await until(async () => (await said()).length === 1, 8000, 'the bot’s std.connector');
    };
    const hook = (event: string, payload: unknown, signature?: string) => {
      const body = JSON.stringify(payload);
      return fetch(`${url}/host/connect/github/hook`, {
        method: 'POST',
        headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? `sha256=${body.length}` },
        body,
      });
    };
    return { url, port: served.port, laptop, space, bot, ask, openPage, back, said, connectNow, hook };
  }

  /** A secret as long as a device makes one, from a word that tells tests' secrets apart */
  const secretOf = (word: string) => word.padEnd(43, '0');
  const stateOf = (res: Response) =>
    new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';

  test('a host refuses to start with two connectors of one id, or one whose id won’t fit an address', async () => {
    const github = githubConnector(fakeGitHub({}));
    const start = async (connectors: ReadonlyArray<typeof github>) =>
      startHost({
        key: await provider.generateKeyPair(),
        stores: memoryStores(),
        port: 0,
        free: true,
        bots: { folder: await tempDir('minca-connect-'), model },
        connectors,
      });
    await assert.rejects(start([github, github]), /share an id/);
    await assert.rejects(start([{ ...github, id: '../Bots' }]), /lowercase letters, digits and dashes/);
  });

  test('the host says it connects bots to GitHub only when it has a GitHub App', async () => {
    const { url } = await botToConnect();
    assert.deepEqual((await describeHost(url)).connectors, [{ id: 'github', name: 'GitHub' }]);
    const without = await botToConnect(null);
    assert.equal((await describeHost(without.url)).connectors, undefined);
    const request = await without.ask('secret-one');
    assert.equal((await without.openPage(request, 'secret-one')).status, 404);
  });

  test('an admin connects the bot: GitHub’s install screen, back, and the bot says what it is connected to', async () => {
    const { laptop, space, bot, ask, openPage, back } = await botToConnect();
    const request = await ask('secret-one');
    const page = await openPage(request, 'secret-one');
    assert.equal(page.status, 302);
    assert.match(
      page.headers.get('location') ?? '',
      /^https:\/\/github\.example\/apps\/minca\/installations\/new\?state=/,
    );

    const done = await back(
      {
        installation_id: '42',
        setup_action: 'install',
        code: 'good',
      },
      page,
    );
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Connected to GitHub as acme\./);
    await until(
      async () =>
        (await laptop.records.list(space, { collection: connector.name })).some(
          (record) =>
            record.createdBy === bot &&
            record.verified &&
            JSON.stringify(record.body).includes('"account":"acme"'),
        ),
      8000,
      'the bot’s own std.connector',
    );

    // The link and GitHub's state are each good once.
    assert.equal((await openPage(request, 'secret-one')).status, 403);
    assert.equal(
      (await back({ installation_id: '42', setup_action: 'install', code: 'good' }, page)).status,
      403,
    );
  });

  test('the host refuses a request with the wrong secret, run out, too far ahead, or for another bot', async () => {
    const { url, space, ask, openPage, bot } = await botToConnect();
    assert.equal((await openPage(await ask('secret-one'), 'secret-two')).status, 403, 'the wrong secret');
    const past = new Date(Date.now() - 1000).toISOString();
    assert.equal((await openPage(await ask('s', { expires: past }), 's')).status, 403, 'run out');
    const far = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await openPage(await ask('s', { expires: far }), 's')).status, 403, 'too far ahead');
    assert.equal((await openPage(await ask('s', { disconnect: true }), 's')).status, 403, 'a disconnect');
    // Named for another account than the bot whose page is opened.
    const other = await ask('s', { bot: 'did:key:zDnaeOther' });
    assert.equal((await openPage(other, 's')).status, 403, 'for another bot');
    assert.equal((await openPage(await ask('s'), 's', 'did:key:zDnaeNobody')).status, 404, 'no such bot');
    // A secret too short to be a device's, whose hash could be worked back.
    const short = await ask('s');
    const page = await fetch(
      new URL(
        `/host/bots/${encodeURIComponent(bot)}/connect/github?space=${space}&request=${short}&secret=s`,
        url,
      ),
      { redirect: 'manual' },
    );
    assert.equal(page.status, 400, 'too short');
    assert.ok(bot);
  });

  test('a member who may not instruct the bot can’t connect it, even with their own secret', async () => {
    const { port, laptop, space, bot, openPage } = await botToConnect();
    // An editor, as the bot is: no grant to instruct bots.
    const mate = await account();
    const theirs = await createNode({
      signer: mate.signer,
      stores: memoryStores(),
      accountKey: mate.accountKey,
      watchIntervalMs: 0,
      network: { nodes: [`ws://127.0.0.1:${port}/peer`] },
    });
    open.push(theirs);
    await theirs.spaces.join(await laptop.spaces.invite(space, { role: 'editor' }));
    await joined(theirs, space, 15_000);
    const request = (
      await theirs.records.put(space, connect, {
        bot,
        kind: 'github',
        verifier: await verifierOf(secretOf('their-secret')),
        expires: new Date(Date.now() + 300_000).toISOString(),
      })
    ).key;
    const page = await openPage(request, 'their-secret');
    assert.equal(page.status, 403);
    assert.match(await page.text(), /Only someone who may instruct this bot/);
  });

  test('GitHub’s redirect counts only with a state the host gave, and an installation the GitHub user reaches', async () => {
    const { ask, openPage, back } = await botToConnect(
      fakeGitHub({
        good: { installation: 42, account: 'acme' },
        stranger: { installation: 7, account: 'them' },
      }),
    );
    assert.equal((await back({ installation_id: '42', code: 'good', state: 'made-up' })).status, 403);
    const page = await openPage(await ask('secret-one'), 'secret-one');
    // Someone else's installation id put in the redirect: the GitHub user can't reach it.
    assert.equal((await back({ installation_id: '42', code: 'stranger' }, page)).status, 403);
    // And the state is spent by that try.
    assert.equal((await back({ installation_id: '42', code: 'good' }, page)).status, 403);

    // GitHub's link sent to someone else, who installs in their own browser: the state, but not the cookie.
    const sent = await openPage(await ask('secret-two'), 'secret-two');
    const elsewhere = await back({ installation_id: '42', code: 'good', state: stateOf(sent) });
    assert.equal(elsewhere.status, 403);
    assert.match(await elsewhere.text(), /started in another browser/);
    assert.match(sent.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Lax/);
  });

  test('an admin disconnects the bot with a request of the same kind; the bot takes back what it said', async () => {
    const { url, space, bot, ask, said, connectNow } = await botToConnect();
    await connectNow();
    const disconnect = async (request: string, secret: string) =>
      fetch(`${url}/host/bots/${encodeURIComponent(bot)}/disconnect/github`, {
        method: 'POST',
        body: JSON.stringify({ space, request, secret: secretOf(secret) }),
      });
    // A request to connect doesn't disconnect, and the wrong secret doesn't either.
    assert.equal((await disconnect(await ask('secret-two'), 'secret-two')).status, 403);
    assert.equal((await disconnect(await ask('secret-three', { disconnect: true }), 'nope')).status, 403);
    assert.equal((await said()).length, 1, 'still connected');

    const request = await ask('secret-four', { disconnect: true });
    assert.equal((await disconnect(request, 'secret-four')).status, 200);
    await until(async () => (await said()).length === 0, 8000, 'the bot to take its std.connector back');
    assert.equal((await disconnect(request, 'secret-four')).status, 403, 'once');
  });

  test('the library’s own calls lead through it, as the app makes them: connect, then disconnect', async () => {
    const { url, laptop, space, bot, back, said } = await botToConnect();
    const views = await laptop.hosting.space(space);
    assert.deepEqual(
      views[0]?.connectors,
      [{ id: 'github', name: 'GitHub' }],
      'the app sees the host connects bots to GitHub',
    );

    const page = await fetch(connectPage(url, await askToConnect(laptop, space, bot, 'github')), {
      redirect: 'manual',
    });
    assert.equal(page.status, 302);
    assert.equal((await back({ installation_id: '42', code: 'good' }, page)).status, 200);
    await until(async () => (await said()).length === 1, 8000, 'connected');

    await askToDisconnect(url, await askToConnect(laptop, space, bot, 'github', { disconnect: true }));
    await until(async () => (await said()).length === 0, 8000, 'disconnected');
    await assert.rejects(
      askToDisconnect(url, {
        space,
        bot,
        kind: 'github',
        request: 'no-such-request',
        secret: 'x'.repeat(43),
      }),
      /hasn’t reached the host/,
    );
  });

  test('GitHub’s webhook, signed, says when the App is uninstalled or its repositories change', async () => {
    const { said, connectNow, hook } = await botToConnect();
    await connectNow();
    const installation = { id: 42, account: { login: 'acme' } };
    assert.equal(
      (await hook('installation', { action: 'deleted', installation }, 'sha256=forged')).status,
      401,
    );
    assert.equal((await said()).length, 1, 'an unsigned call changes nothing');

    repos = ['acme/site'];
    try {
      assert.equal(
        (await hook('installation_repositories', { action: 'removed', installation })).status,
        200,
      );
      await until(
        async () => JSON.stringify((await said())[0]?.body).includes('"reaches":["acme/site"]'),
        8000,
        'the bot to say it reaches one repository now',
      );
      // Someone adds repositories to the installation, for another community perhaps: this one's don't grow.
      repos = ['acme/site', 'acme/docs', 'acme/private'];
      assert.equal((await hook('installation_repositories', { action: 'added', installation })).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(JSON.stringify((await said())[0]?.body).includes('"reaches":["acme/site"]'), 'only narrowed');
    } finally {
      repos = ['acme/site', 'acme/docs'];
    }
    assert.equal((await hook('installation', { action: 'deleted', installation })).status, 200);
    await until(async () => (await said()).length === 0, 8000, 'the connection to be gone');
  });
});
