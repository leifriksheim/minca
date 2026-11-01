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
import { createConnections } from '../src/remote-mcp/connections.js';
import { mayRedirect } from '../src/remote-mcp/redirects.js';
import { isRecord } from '../src/json.js';
import { onHub } from './helpers/nodes.js';

const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => {});
});

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const insecure = { [oauth.allowInsecureRequests]: true };

/** The accounts the test hosts name, as `MINCA_HOST_MCP_ACCOUNTS` does: every one `accountHolder` makes */
const named: string[] = [];

/** Someone with an account, online, who signs a records-only note for whatever key their home is shown */
async function accountHolder(hub: FakeHub, options: { readonly unnamed?: boolean } = {}) {
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
  if (!options.unnamed) named.push(me.did);
  /** What her home signs when she picks every space she has, as the consent page asks: some spaces, records only */
  const grantFor = async (audience: string, seconds = 3600, command = '/record'): Promise<Grant> => ({
    v: GRANT_VERSION,
    did: me.did,
    name: 'Ada',
    note: await signer.delegate({ audience, command, expiration: Math.floor(Date.now() / 1000) + seconds }),
    access: 'write',
    scope: 'spaces',
    spaces: await Promise.all(
      (await node.spaces.list()).map(async (space) => ({
        id: space.id,
        name: space.name,
        invite: await node.spaces.invite(space.id),
      })),
    ),
    expiresAt: Math.floor(Date.now() / 1000) + seconds,
    home: 'https://home.test/connect',
  });
  /** The whole account, key and all, as an app given everything gets */
  const wholeAccount = async (audience: string): Promise<Grant> => ({
    ...(await grantFor(audience)),
    scope: 'account',
    spaces: [],
    accountKey: base64UrlEncode(accountKey),
  });
  return { node, did: me.did, grantFor, wholeAccount };
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
async function aHost(hub: FakeHub, settings: { readonly running?: number } = {}) {
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
  const store = await stores('host-mcp');
  /** Connections whose agents' spaces the host removed, and those whose agents started */
  const dropped: string[] = [];
  const started = new Set<string>();
  remote = await createRemoteMcp({
    publicUrl: issuer,
    accounts: named,
    store,
    stores: (connection) => {
      started.add(connection);
      return (where) => stores(`agents/${connection}/${where}`);
    },
    drop: async (connection) => {
      dropped.push(connection);
    },
    addressOf: () => '127.0.0.1',
    network: () => onHub(hub),
    ...settings,
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
  const connections = async () => (await store.list('connection:')).length;
  return { issuer, resource: `${issuer}/mcp`, remote: running, dropped, started, connections };
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
async function anApp(
  resource: string,
  redirect = CLAUDE,
  name = 'Claude',
  more: Record<string, string> = {},
) {
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
        ...more,
      },
      insecure,
    ),
  );
  const client: oauth.Client = { client_id: registered.client_id, token_endpoint_auth_method: 'none' };
  return { as, client, redirect };
}

type App = Awaited<ReturnType<typeof anApp>>;

/** Registers an app as anyone may, and gives the answer as it came */
const register = (issuer: string, metadata: Record<string, unknown>) =>
  fetch(`${issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  });

/** Starts signing in, as the app sends the person's browser: to the consent page, with its cookies */
async function startSignIn(app: App, resource: string, jar = cookieJar()) {
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
  const authorize = await fetch(url, { redirect: 'manual', headers: { cookie: jar.header() } });
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
async function signIn(
  app: App,
  resource: string,
  grantFor: (did: string) => Promise<Grant>,
  jar = cookieJar(),
) {
  const started = await startSignIn(app, resource, jar);
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
  // As a browser does, it keeps what the host set on the way.
  started.jar.take(resumed);
  const back = new URL(resumed.headers.get('location')!, redirect);
  assert.equal(back.href.split('?')[0], app.redirect, 'back to the app, where it registered');
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

  test('a second app connected from the same browser is a sign-in of its own, and the first keeps working', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const browser = cookieJar();
    const claude = await anApp(host.resource);
    const first = await signIn(claude, host.resource, (audience) => ada.grantFor(audience), browser);
    const cursor = await anApp(host.resource, 'cursor://anysphere.cursor-mcp/oauth/callback', 'Cursor');
    const second = await signIn(cursor, host.resource, (audience) => ada.grantFor(audience), browser);
    assert.notEqual(first.did, second.did, 'a key of its own');
    for (const tokens of [first.tokens, second.tokens]) {
      const client = await mcpClient(host.resource, tokens.access_token);
      assert.ok((await client.listTools()).tools.length > 0);
    }
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

  test('an app can’t register a place a code may not go: another site, or a browser by its scheme', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const host = await aHost(hub);
    for (const redirect of [
      'https://collector.example/callback',
      'x-safari-https://collector.example/callback',
      'googlechromes://collector.example/callback',
    ]) {
      // Beside one that may: every place it names must be one a code may go.
      const answer = await register(host.issuer, {
        client_name: 'Claude',
        redirect_uris: [CLAUDE, redirect],
      });
      assert.equal(answer.status, 400, redirect);
      assert.equal(field(await answer.json())('error'), 'invalid_redirect_uri', redirect);
    }
    const long = await register(host.issuer, { client_name: 'x'.repeat(61), redirect_uris: [CLAUDE] });
    assert.equal(long.status, 400, 'nor a name too long to show');
  });

  test('a browser that connected an app is shown the consent page again the next time, not let through', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    // A web app, which `oidc-provider` would otherwise let through on the browser's earlier sign-in.
    const app = await anApp(host.resource, CLAUDE, 'Claude', { application_type: 'web' });
    const browser = cookieJar();
    await signIn(app, host.resource, (audience) => ada.grantFor(audience), browser);
    // Started by anyone, the same app's next sign-in in that browser still waits for the person.
    const again = await startSignIn(app, host.resource, browser);
    assert.match(again.consent.pathname, /^\/oauth\/interaction\//, again.consent.href);
  });

  test('registering and starting sign-ins are counted by who asks, however the path is spelled', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const host = await aHost(hub);
    const answers: number[] = [];
    for (let i = 0; i < 201; i++)
      answers.push((await register(host.issuer, { client_name: 'App', redirect_uris: [CLAUDE] })).status);
    assert.deepEqual(answers.slice(0, 200), Array(200).fill(201));
    assert.equal(answers[200], 429, 'two hundred a day from one address');
    // Spelled another way, a path the provider would take is not one the host serves.
    for (const other of ['/oauth/register/', '/oauth/REGISTER', '/oauth/Register/', '/OAUTH/register'])
      assert.equal(
        (
          await fetch(`${host.issuer}${other}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none' }),
          })
        ).status,
        404,
        other,
      );
    assert.equal(
      (await fetch(`${host.issuer}/oauth/Authorize?client_id=x`, { redirect: 'manual' })).status,
      404,
    );
  });

  test('an app registers no more than it needs: a few places to go back to, nothing the host would fetch', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const host = await aHost(hub);
    const many = Array.from({ length: 6 }, (_, i) => `http://127.0.0.1:${4000 + i}/cb`);
    assert.equal((await register(host.issuer, { redirect_uris: many })).status, 400, 'six places');
    for (const extra of [
      { jwks_uri: 'https://example.com/jwks' },
      { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://example.com/jwks' },
    ])
      assert.equal(
        (await register(host.issuer, { redirect_uris: [CLAUDE], ...extra })).status,
        400,
        JSON.stringify(extra),
      );
    // Nor any place to send people after signing out: there is no signing out here, and the field goes.
    const withLogout = await register(host.issuer, {
      redirect_uris: [CLAUDE],
      post_logout_redirect_uris: ['https://example.com/'],
    });
    assert.equal(field(await withLogout.json())('post_logout_redirect_uris'), undefined);
    assert.equal((await fetch(`${host.issuer}/oauth/logout`)).status, 404);
    assert.equal(
      (await register(host.issuer, { redirect_uris: [`${CLAUDE}?next=https://example.com`] })).status,
      400,
      'a known callback exactly, nothing added',
    );
  });

  test('a connection that can’t act any more is forgotten, key and spaces, and its token stops working', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const { tokens } = await signIn(app, host.resource, (audience) => ada.grantFor(audience, 2));
    const client = await mcpClient(host.resource, tokens.access_token);
    await client.callTool({ name: 'spaces_list', arguments: {} });
    assert.equal(await host.connections(), 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await host.remote.sweep();
    assert.equal(await host.connections(), 0, 'its key is gone from the host');
    assert.equal(host.dropped.length, 1, 'and the spaces its agent kept');
    const after = await fetch(host.resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(after.status, 401, 'the app is asked to sign in again');
  });

  test('an account keeps its newest ten connections here, and a host runs only so many agents at once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub, { running: 2 });
    const app = await anApp(host.resource);
    const signedIn = [];
    for (let i = 0; i < 11; i++)
      signedIn.push(await signIn(app, host.resource, (audience) => ada.grantFor(audience)));
    assert.equal(await host.connections(), 10);
    assert.equal(host.dropped.length, 1, 'the oldest went, spaces and all');
    for (const { tokens } of signedIn.slice(-3)) {
      const client = await mcpClient(host.resource, tokens.access_token);
      assert.equal((await client.callTool({ name: 'spaces_list', arguments: {} })).isError, false);
    }
  });

  test('only an account the host names may connect, and a sign-in is answered once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const stranger = await accountHolder(hub, { unnamed: true });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const refused = await startSignIn(app, host.resource);
    const key = await browserKey();
    const answer = await postFromPage(refused, 'allow', {
      key: key.jwk,
      grant: await stranger.grantFor(key.did),
    });
    assert.equal(answer.status, 400);
    assert.match(String(field(await answer.json())('error')), /only for the accounts it names/);
    const whole = await startSignIn(app, host.resource);
    const wholeKey = await browserKey();
    const everything = await postFromPage(whole, 'allow', {
      key: wholeKey.jwk,
      grant: await ada.wholeAccount(wholeKey.did),
    });
    assert.equal(everything.status, 400, 'nor the whole account, whose key opens every space');

    const started = await startSignIn(app, host.resource);
    const first = await browserKey();
    const allowed = await postFromPage(started, 'allow', {
      key: first.jwk,
      grant: await ada.grantFor(first.did),
    });
    assert.equal(allowed.status, 200);
    const second = await browserKey();
    const again = await postFromPage(started, 'allow', {
      key: second.jwk,
      grant: await ada.grantFor(second.did),
    });
    assert.equal(again.status, 409, 'nobody adds connections under an answered sign-in');
    assert.equal(await host.connections(), 1);
  });

  test('a hosted agent isn’t offered what would dial addresses from the host', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const { tokens } = await signIn(app, host.resource, (audience) => ada.grantFor(audience));
    const client = await mcpClient(host.resource, tokens.access_token);
    assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'spaces_preview_invite'));
    const called = await client.callTool({ name: 'spaces_preview_invite', arguments: { invite: 'x' } });
    assert.equal(called.isError, true);
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

describe('a connection’s agent', () => {
  test('calls at once for an idle connection start one agent, never two under one key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const stores = memoryStores();
    const starts: string[] = [];
    const connections = createConnections({
      accounts: named,
      store: await stores('host-mcp'),
      stores: (id) => {
        starts.push(id);
        return (where) => stores(`agents/${id}/${where}`);
      },
      drop: async () => {},
      network: () => onHub(hub),
    });
    closing.push(() => connections.close());
    const key = await browserKey();
    const connection = await connections.add({
      key: key.jwk,
      grant: await ada.grantFor(key.did),
      client: 'Claude',
    });
    const nodes = await Promise.all(
      Array.from({ length: 8 }, () => connections.use(connection.id, async (node) => node)),
    );
    assert.equal(starts.length, 1, 'one agent started');
    assert.ok(
      nodes.every((node) => node === nodes[0]),
      'and every call ran on it',
    );
  });

  test('a host runs no more agents at once than its cap: the rest wait their turn', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const stores = memoryStores();
    const cap = 2;
    const connections = createConnections({
      accounts: named,
      store: await stores('host-mcp'),
      stores: (id) => (where) => stores(`agents/${id}/${where}`),
      drop: async () => {},
      network: () => onHub(hub),
      running: cap,
    });
    closing.push(() => connections.close());
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const key = await browserKey();
      ids.push(
        (await connections.add({ key: key.jwk, grant: await ada.grantFor(key.did), client: 'Claude' })).id,
      );
    }
    let now = 0;
    let most = 0;
    await Promise.all(
      ids.map((id) =>
        connections.use(id, async () => {
          now += 1;
          most = Math.max(most, now);
          await new Promise((resolve) => setTimeout(resolve, 300));
          now -= 1;
        }),
      ),
    );
    assert.ok(most <= cap, `${most} ran at once under a cap of ${cap}`);
  });

  test('a key revoked while its agent was idle is heard the next time it runs, and the connection is then forgotten', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const ada = await accountHolder(hub);
    const space = await ada.node.spaces.create({ name: 'Diary', visibility: 'private' });
    await hold(ada.node, space.id);
    const host = await aHost(hub);
    const app = await anApp(host.resource);
    const { tokens, did } = await signIn(app, host.resource, (audience) => ada.grantFor(audience));
    const client = await mcpClient(host.resource, tokens.access_token);
    await until(
      async () => textOf(await client.callTool({ name: 'spaces_list', arguments: {} })).includes(space.id),
      8000,
      'the agent to find the space',
    );
    await ada.node.spaces.revoke(space.id, did);
    // Any call runs the agent, which hears the revoke as it syncs; the sweep then forgets it.
    await until(
      async () => {
        await client.callTool({ name: 'spaces_list', arguments: {} }).catch(() => null);
        await host.remote.sweep();
        return (await host.connections()) === 0;
      },
      10_000,
      'the host to forget the revoked connection',
    );
    assert.equal(host.dropped.length, 1);
    const after = await fetch(host.resource, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(after.status, 401);
  });
});

describe('where a code may go', () => {
  test('known chat apps over https, this computer over http, and known apps’ own schemes', () => {
    assert.ok(mayRedirect('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(mayRedirect('https://chatgpt.com/connector_platform_oauth_redirect'));
    assert.ok(mayRedirect('http://127.0.0.1:33418/callback'));
    assert.ok(mayRedirect('http://localhost/callback'));
    assert.ok(mayRedirect('cursor://anysphere.cursor-mcp/oauth/callback'));
    assert.ok(mayRedirect('vscode://vscode.github-authentication/did-authenticate'));
    assert.ok(mayRedirect('https://claude.com/api/mcp/auth_callback'));
    assert.ok(mayRedirect('https://chat.example.com/cb', ['chat.example.com']));
    assert.ok(mayRedirect('zed://oauth/callback', ['zed:']));
  });
  test('nowhere else', () => {
    assert.ok(!mayRedirect('https://claude.ai.evil.example/cb'));
    assert.ok(
      !mayRedirect('https://claude.ai/any/other/page'),
      'only the path a chat app finishes sign-ins at',
    );
    assert.ok(!mayRedirect('https://evil.example/cb'));
    assert.ok(!mayRedirect('http://claude.ai/api/mcp/auth_callback'), 'not in the clear');
    assert.ok(!mayRedirect('http://192.168.1.10/cb'));
    assert.ok(
      !mayRedirect('x-safari-https://evil.example/cb'),
      'a scheme that opens a browser at any address',
    );
    assert.ok(!mayRedirect('googlechromes://evil.example/cb'));
    assert.ok(!mayRedirect('microsoft-edge-https://evil.example/cb'));
    assert.ok(!mayRedirect('zed://oauth/callback'), 'an app’s scheme only once named');
    assert.ok(!mayRedirect('javascript:alert(1)'));
    assert.ok(!mayRedirect('data:text/html,hi'));
    assert.ok(!mayRedirect('not a url'));
  });
});
