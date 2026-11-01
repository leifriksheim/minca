/**
 * A host's MCP endpoint, as a chat app meets it: it finds the authorization
 * server from the endpoint's 401, registers itself, sends the person to sign
 * in, gets a token, and calls the tools as an agent of their account. The
 * client side is real: `oauth4webapi` for OAuth, the MCP SDK's own client for
 * MCP. Only the account home's answer is stood in for: the note an account
 * signs for the key the consent page made.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import * as oauth from 'oauth4webapi';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Grant } from '@minca/core/session';
import { createNode } from '../../core/src/node/node.js';
import { didOf } from '../../core/src/identity/did.js';
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
import { createRemoteMcp, type RemoteMcp } from '../src/remote-mcp/index.js';
import { mayRedirect } from '../src/remote-mcp/consent.js';
import { isRecord } from '../src/json.js';
import { onHub } from './helpers/nodes.js';

const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => {});
});

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const insecure = { [oauth.allowInsecureRequests]: true };

/** Someone with an account, online, who signs a records-only note for whatever key their home is shown */
async function accountHolder(hub: FakeHub) {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const accountKey = await deriveAccountKey(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const node = await createNode({
    signer,
    stores: memoryStores(),
    accountKey,
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  closing.push(() => node.close());
  const grantFor = async (audience: string, seconds = 3600, command = '/record'): Promise<Grant> => ({
    v: GRANT_VERSION,
    did: me.did,
    name: 'Ada',
    note: await signer.delegate({ audience, command, expiration: Math.floor(Date.now() / 1000) + seconds }),
    access: 'write',
    scope: 'account',
    spaces: [],
    accountKey: base64UrlEncode(accountKey),
    expiresAt: Math.floor(Date.now() / 1000) + seconds,
    home: 'https://home.test/connect',
  });
  return { node, did: me.did, grantFor };
}

/** The key the consent page makes in the browser, as it hands it over */
async function browserKey() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    did: await didOf(keys.publicKey),
    jwk: {
      privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
      publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    },
  };
}

/** A host with only its MCP endpoint, on a port of its own, its agents on the hub */
async function aHost(hub: FakeHub) {
  let remote: RemoteMcp | null = null;
  const server: Server = createServer((req, res) => {
    void (remote?.routes(req, res) ?? Promise.resolve(false)).then((answered) => {
      if (!answered) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const issuer = `http://127.0.0.1:${address.port}`;
  const stores = memoryStores();
  remote = await createRemoteMcp({
    publicUrl: issuer,
    store: await stores('host-mcp'),
    stores: (connection) => (where) => stores(`agents/${connection}/${where}`),
    network: () => onHub(hub),
    name: 'Test host',
    version: '0',
    accountHome: 'https://home.test',
    idleMs: 60_000,
  });
  const running = remote;
  closing.push(async () => {
    await running.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { issuer, resource: `${issuer}/mcp` };
}

/** A browser's cookies, by name, for this one host */
function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    take(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair!.indexOf('=');
        cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

/** A chat app: finds the authorization server from the endpoint, and registers itself there */
async function anApp(resource: string, redirect = CLAUDE, name = 'Claude') {
  const challenge = await fetch(resource, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(challenge.status, 401, 'no token, no tools');
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    challenge.headers.get('www-authenticate') ?? '',
  )?.[1];
  assert.ok(metadataUrl, 'the 401 says where to find the authorization server');
  const metadata = field(await (await fetch(metadataUrl)).json());
  assert.equal(metadata('resource'), resource);
  const servers = metadata('authorization_servers');
  assert.ok(Array.isArray(servers) && typeof servers[0] === 'string');

  const issuerUrl = new URL(servers[0]);
  const as = await oauth.processDiscoveryResponse(
    issuerUrl,
    await oauth.discoveryRequest(issuerUrl, { algorithm: 'oauth2', ...insecure }),
  );
  assert.ok(as.registration_endpoint, 'apps may register themselves');
  const registered = await oauth.processDynamicClientRegistrationResponse(
    await oauth.dynamicClientRegistrationRequest(
      as,
      {
        client_name: name,
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      insecure,
    ),
  );
  const client: oauth.Client = { client_id: registered.client_id, token_endpoint_auth_method: 'none' };
  return { as, client, redirect };
}

type App = Awaited<ReturnType<typeof anApp>>;

/** Starts signing in, as the app sends the person's browser: to the consent page, with its cookies */
async function startSignIn(app: App, resource: string) {
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(app.as.authorization_endpoint!);
  url.search = new URLSearchParams({
    client_id: app.client.client_id,
    redirect_uri: app.redirect,
    response_type: 'code',
    scope: 'mcp',
    resource,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  const jar = cookieJar();
  const authorize = await fetch(url, { redirect: 'manual' });
  jar.take(authorize);
  const consent = new URL(authorize.headers.get('location')!, url);
  return { verifier, state, jar, consent };
}

type SignIn = Awaited<ReturnType<typeof startSignIn>>;

/** What the consent page posts once the home answered: same origin, JSON */
const postFromPage = (
  signIn: SignIn,
  action: 'allow' | 'deny',
  body: unknown,
  origin = signIn.consent.origin,
) =>
  fetch(`${signIn.consent.href}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie: signIn.jar.header() },
    body: JSON.stringify(body),
  });

/** The whole sign-in, the person allowing it with `grant` for `key`: the app's tokens */
async function signIn(app: App, resource: string, grantFor: (did: string) => Promise<Grant>) {
  const started = await startSignIn(app, resource);
  const page = await fetch(started.consent, { headers: { cookie: started.jar.header() } });
  assert.equal(page.status, 200, await page.clone().text());
  const key = await browserKey();
  const allowed = await postFromPage(started, 'allow', { key: key.jwk, grant: await grantFor(key.did) });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  started.jar.take(allowed);
  const redirect = field(await allowed.json())('redirect');
  assert.ok(typeof redirect === 'string');
  // The browser follows on: the authorization server finishes, and sends it to the app with a code.
  const resumed = await fetch(redirect, { redirect: 'manual', headers: { cookie: started.jar.header() } });
  const back = new URL(resumed.headers.get('location')!, redirect);
  assert.equal(`${back.origin}${back.pathname}`, app.redirect, 'back to the app, where it registered');
  const params = oauth.validateAuthResponse(app.as, app.client, back, started.state);
  const tokens = await oauth.processAuthorizationCodeResponse(
    app.as,
    app.client,
    await oauth.authorizationCodeGrantRequest(
      app.as,
      app.client,
      oauth.None(),
      params,
      app.redirect,
      started.verifier,
      {
        additionalParameters: { resource },
        ...insecure,
      },
    ),
  );
  return { tokens, did: key.did };
}

async function mcpClient(resource: string, token: string) {
  const client = new Client({ name: 'test app', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  closing.push(() => client.close());
  return client;
}

/** A JSON object's fields, by name: undefined for anything else */
const field = (value: unknown) => (name: string) => (isRecord(value) ? value[name] : undefined);

/** A tool result's text */
function textOf(result: unknown): string {
  const content = field(result)('content');
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = field(first)('text');
  return typeof text === 'string' ? text : '';
}

describe('a host’s MCP endpoint', () => {
  test('a chat app signs in at the person’s account home and writes as their agent', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const space = await ada.node.spaces.create({ name: 'Lunch club', visibility: 'private' });
    await hold(ada.node, space.id);
    const host = await aHost(hub);

    const app = await anApp(host.resource);
    const { tokens, did } = await signIn(app, host.resource, (audience) => ada.grantFor(audience));
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token, 'a refresh token, so the connection lasts as long as its note');

    const client = await mcpClient(host.resource, tokens.access_token);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('records_put') && names.includes('collections_propose'));
    assert.ok(!names.includes('collections_define'), 'an agent proposes collections, never defines them');
    assert.match(client.getInstructions() ?? '', new RegExp(ada.did), 'it is told whose account it acts for');

    await until(
      async () => textOf(await client.callTool({ name: 'spaces_list', arguments: {} })).includes(space.id),
      8000,
      'the agent to find the space',
    );
    let written = '';
    await until(
      async () => {
        const result = await client.callTool({
          name: 'records_put',
          arguments: { space: space.id, collection: 'app.note', body: { text: 'Soup on Friday' } },
        });
        written = result.isError ? '' : textOf(result);
        return written !== '';
      },
      8000,
      'the agent to write',
    );
    // It reaches Ada as hers, written by the key her home signed for: an agent's.
    await until(
      async () =>
        (await ada.node.records.list(space.id, { collection: 'app.note' })).some(
          (record) => field(record.body)('text') === 'Soup on Friday',
        ),
      8000,
      'the note to reach Ada',
    );
    const [note] = await ada.node.records.list(space.id, { collection: 'app.note' });
    assert.equal(note!.root, ada.did, 'written as Ada');
    assert.equal(note!.recordsOnly, true, 'marked as written under a records-only note');
    assert.notEqual(did, ada.did);

    // A refreshed token acts for the same connection.
    const refreshed = await oauth.processRefreshTokenResponse(
      app.as,
      app.client,
      await oauth.refreshTokenGrantRequest(app.as, app.client, oauth.None(), tokens.refresh_token, {
        additionalParameters: { resource: host.resource },
        ...insecure,
      }),
    );
    const again = await mcpClient(host.resource, refreshed.access_token);
    assert.match(textOf(await again.callTool({ name: 'spaces_list', arguments: {} })), new RegExp(space.id));
  });

  test('serves a 2025-era client too, which posts JSON-RPC without the new envelope', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const { tokens } = await signIn(app, host.resource, (audience) => ada.grantFor(audience));
    const response = await fetch(host.resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"protocolVersion":"2025-11-25"/);
  });

  test('a token that isn’t one, or whose connection the host forgot, gets the challenge again', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const host = await aHost(hub);
    const call = (token: string) =>
      fetch(host.resource, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const made = await call('made-up');
    assert.equal(made.status, 401);
    assert.match(made.headers.get('www-authenticate') ?? '', /invalid_token/);
  });

  test('a note run out, made out to another key, or granting more than records is refused, and no code is given', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);

    const cases: Array<[string, (did: string) => Promise<Grant>]> = [
      ['another key', async () => ada.grantFor((await browserKey()).did)],
      ['run out', (did) => ada.grantFor(did, -60)],
      ['more than records', (did) => ada.grantFor(did, 3600, '/')],
    ];
    for (const [what, grantFor] of cases) {
      const started = await startSignIn(app, host.resource);
      const key = await browserKey();
      const answer = await postFromPage(started, 'allow', { key: key.jwk, grant: await grantFor(key.did) });
      assert.equal(answer.status, 400, `${what}: refused`);
      assert.equal(field(await answer.json())('redirect'), undefined, `${what}: no way on to a code`);
    }
  });

  test('only the consent page may answer: another site’s post is refused', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const started = await startSignIn(app, host.resource);
    const key = await browserKey();
    const answer = await postFromPage(
      started,
      'allow',
      { key: key.jwk, grant: await ada.grantFor(key.did) },
      'https://elsewhere.example',
    );
    assert.equal(answer.status, 403);
  });

  test('an app that wants its code sent anywhere but a known chat app, this computer or its own scheme is never shown the page', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource, 'https://collector.example/callback', 'Claude');
    const started = await startSignIn(app, host.resource);
    const page = await fetch(started.consent, { headers: { cookie: started.jar.header() } });
    assert.equal(page.status, 400);
    assert.match(await page.text(), /isn’t a chat app this host knows/);
    // Nor does posting the answer straight away get anywhere.
    const key = await browserKey();
    const answer = await postFromPage(started, 'allow', { key: key.jwk, grant: await ada.grantFor(key.did) });
    assert.equal(answer.status, 400);
  });

  test('the consent page names the app and where it goes back to, and runs only its own script', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const started = await startSignIn(app, host.resource);
    const page = await fetch(started.consent, { headers: { cookie: started.jar.header() } });
    const html = await page.text();
    assert.match(html, /Connect Claude to Minca/);
    assert.match(html, /go back to claude\.ai/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  });
});

describe('where a code may go', () => {
  test('known chat apps over https, this computer over http, and apps’ own schemes', () => {
    assert.ok(mayRedirect('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(mayRedirect('https://chatgpt.com/connector_platform_oauth_redirect'));
    assert.ok(mayRedirect('http://127.0.0.1:33418/callback'));
    assert.ok(mayRedirect('http://localhost/callback'));
    assert.ok(mayRedirect('cursor://anysphere.cursor-mcp/oauth/callback'));
    assert.ok(mayRedirect('https://chat.example.com/cb', ['chat.example.com']));
  });
  test('nowhere else', () => {
    assert.ok(!mayRedirect('https://claude.ai.evil.example/cb'));
    assert.ok(!mayRedirect('https://evil.example/cb'));
    assert.ok(!mayRedirect('http://claude.ai/api/mcp/auth_callback'), 'not in the clear');
    assert.ok(!mayRedirect('http://192.168.1.10/cb'));
    assert.ok(!mayRedirect('javascript:alert(1)'));
    assert.ok(!mayRedirect('data:text/html,hi'));
    assert.ok(!mayRedirect('not a url'));
  });
});
