/**
 * The MCP service's nodes reach only the always-on nodes it was given. What a
 * connection brings, the invites in its grant and the records its node reads,
 * is the account's to fill in, so none of it may choose where the service
 * connects or what it keeps: anyone can make an account, and sign a grant of
 * their own. Found by adversarial review; each test was the attack, and fails
 * without `network.only` (`packages/core/src/node/types.ts`).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import * as oauth from 'oauth4webapi';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Grant } from '@minca/core/session';
import { createNode } from '../../core/src/node/node.js';
import { createIdentityManager } from '../../core/src/identity/identity-manager.js';
import { createLocalRootSigner } from '../../core/src/identity/root-signer.js';
import { deriveAccountKey } from '../../core/src/identity/account-vault.js';
import { generateSeed } from '../../core/src/identity/recovery-code.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { didOf } from '../../core/src/identity/did.js';
import { GRANT_VERSION } from '../../core/src/session/connect.js';
import { noteTerms } from '../../core/src/identity/abilities.js';
import { encodeInvitation, readInvitation } from '../../core/src/space/invitation.js';
import { memoryStores } from '../../core/tests/helpers/memory-stores.js';
import { createFakeHub } from '../../core/tests/helpers/fake-transport.js';
import { startMcpServer } from '../src/remote-mcp/server.js';
import { startHost } from '../src/host.js';
import { until } from '../../core/tests/helpers/until.js';
import { isRecord } from '../src/json.js';
import { onHub, tempDir } from './helpers/nodes.js';
import { openHome, createAccount, unlock, chooseAccount } from '../src/home.js';
import { startDaemon } from '../src/daemon.js';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** A JSON object's string field, or a failed test */
function stringField(value: unknown, name: string): string {
  const found = isRecord(value) ? value[name] : undefined;
  assert.ok(typeof found === 'string', `no ${name} in ${JSON.stringify(value)}`);
  return found;
}

const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => {});
});

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const insecure = { [oauth.allowInsecureRequests]: true };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Something on the host's own machine that nobody outside should reach: it notes every request */
async function internalService() {
  const seen: Array<{ url: string; upgrade: boolean }> = [];
  const note = (req: IncomingMessage, upgrade: boolean) => seen.push({ url: req.url ?? '', upgrade });
  const server = createServer((req, res) => {
    note(req, false);
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    note(req, true);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  closing.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: address.port, seen };
}

test('a stranger’s grant can’t make the service’s node dial an address the stranger chose', async () => {
  const internal = await internalService();

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  // Given one node to reach, which isn't there: what's tested is where else it goes.
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: ['ws://127.0.0.1:9/peer'],
    data: await tempDir('mcp-server-'),
    port,
    version: '0',
    accountHome: 'https://home.test',
  });
  closing.push(() => service.close());

  // The stranger: an account of their own, made just now, and a space of theirs.
  const hub = createFakeHub({ latencyMs: 1 });
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const node = await createNode({
    signer,
    stores: memoryStores(),
    accountKey: await deriveAccountKey(seed),
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  closing.push(() => node.close());
  const space = await node.spaces.create({ name: 'Anything', visibility: 'private' });

  // An invitation to it naming, as its always-on node, a port on the host's own machine. Signed by
  // a key with no note at all: its inviter is that key, and joining takes it.
  const provider = createP256Provider();
  const inviterKeys = await provider.generateKeyPair();
  const inviter = { did: await didOf(inviterKeys.publicKey), key: inviterKeys.privateKey };
  const body = readInvitation(await node.spaces.invite(space.id, { write: false })).version.body;
  const target = `ws://127.0.0.1:${internal.port}/anything-at-all#did:key:zDnaeWhoever`;
  const invite = await encodeInvitation(inviter, { ...body, nodes: [target] }, provider);

  // Register as a chat app, start a sign-in, and answer the consent page with a grant of our own.
  const registered: unknown = await (
    await fetch(`${issuer}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [CLAUDE],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json();
  const as = await oauth.processDiscoveryResponse(
    new URL(issuer),
    await oauth.discoveryRequest(new URL(issuer), { algorithm: 'oauth2', ...insecure }),
  );
  const client: oauth.Client = {
    client_id: stringField(registered, 'client_id'),
    token_endpoint_auth_method: 'none',
  };
  const cookies = new Map<string, string>();
  const take = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
  };
  const jar = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const authorize = new URL(as.authorization_endpoint!);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: CLAUDE,
    response_type: 'code',
    scope: 'mcp',
    resource: `${issuer}/mcp`,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  const started = await fetch(authorize, { redirect: 'manual' });
  take(started);
  const consent = new URL(started.headers.get('location')!, authorize);

  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const audience = await didOf(keys.publicKey);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const grant: Grant = {
    v: GRANT_VERSION,
    did: me.did,
    name: 'Stranger',
    note: await signer.delegate({ audience, expiration: expiresAt, ...noteTerms('/record', [space.id]) }),
    access: 'write',
    scope: 'spaces',
    // Not under any signature: whatever the stranger puts here.
    spaces: [{ id: space.id, name: 'Anything', invite }],
    expiresAt,
    home: 'https://home.test/connect',
  };
  const allowed = await fetch(`${consent.href}/allow`, {
    method: 'POST',
    // A script sets Origin as it likes: only a browser can't.
    headers: { 'content-type': 'application/json', origin: issuer, cookie: jar() },
    body: JSON.stringify({
      grant,
      key: {
        privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
        publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
      },
    }),
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  take(allowed);
  const redirect = stringField(await allowed.json(), 'redirect');
  const resumed = await fetch(redirect, { redirect: 'manual', headers: { cookie: jar() } });
  const back = new URL(resumed.headers.get('location')!, redirect);
  const params = oauth.validateAuthResponse(as, client, back, state);
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, CLAUDE, verifier, {
      additionalParameters: { resource: `${issuer}/mcp` },
      ...insecure,
    }),
  );

  // One tool call starts the agent.
  const mcp = new Client({ name: 'probe', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  closing.push(() => mcp.close());
  await mcp.callTool({ name: 'spaces_list', arguments: {} });

  // Time enough for the agent to join, sync and reach every node it would.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.deepEqual(internal.seen, [], 'the host connected nowhere the grant named');
});

/** Signs in at the host as a chat app, answering the consent page with `grantFor(key)` and that key */
async function signInWith(issuer: string, grantFor: (audience: string) => Promise<Grant>): Promise<string> {
  // Register as a chat app, start a sign-in, and answer the consent page with a grant of our own.
  const registered: unknown = await (
    await fetch(`${issuer}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [CLAUDE],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json();
  const as = await oauth.processDiscoveryResponse(
    new URL(issuer),
    await oauth.discoveryRequest(new URL(issuer), { algorithm: 'oauth2', ...insecure }),
  );
  const client: oauth.Client = {
    client_id: stringField(registered, 'client_id'),
    token_endpoint_auth_method: 'none',
  };
  const cookies = new Map<string, string>();
  const take = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
  };
  const jar = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const authorize = new URL(as.authorization_endpoint!);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: CLAUDE,
    response_type: 'code',
    scope: 'mcp',
    resource: `${issuer}/mcp`,
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  const started = await fetch(authorize, { redirect: 'manual' });
  take(started);
  const consent = new URL(started.headers.get('location')!, authorize);

  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const grant = await grantFor(await didOf(keys.publicKey));
  const allowed = await fetch(`${consent.href}/allow`, {
    method: 'POST',
    // A script sets Origin as it likes: only a browser can't.
    headers: { 'content-type': 'application/json', origin: issuer, cookie: jar() },
    body: JSON.stringify({
      grant,
      key: {
        privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
        publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
      },
    }),
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  take(allowed);
  const redirect = stringField(await allowed.json(), 'redirect');
  const resumed = await fetch(redirect, { redirect: 'manual', headers: { cookie: jar() } });
  const back = new URL(resumed.headers.get('location')!, redirect);
  const params = oauth.validateAuthResponse(as, client, back, state);
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, CLAUDE, verifier, {
      additionalParameters: { resource: `${issuer}/mcp` },
      ...insecure,
    }),
  );

  return tokens.access_token;
}

async function callTool(issuer: string, token: string, name: string, args: Record<string, unknown>) {
  const mcp = new Client({ name: 'probe', version: '1' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return JSON.stringify(await mcp.callTool({ name, arguments: args }));
  } finally {
    await mcp.close();
  }
}

async function bytesUnder(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await bytesUnder(at);
    else if (entry.isFile()) bytes += (await stat(at)).size;
  }
  return bytes;
}

test('a stranger’s own node can’t fill the service’s disk', async () => {
  // The stranger runs an always-on node of their own, with a space the host has never carried.
  const home = await openHome(await tempDir());
  const created = await createAccount(home, { name: 'Stranger' });
  const unlocked = await unlock(home, await chooseAccount(home), { code: created.code! });
  const daemon = await startDaemon({ unlocked, port: 0, host: '127.0.0.1', rescanMs: 100 });
  closing.push(() => daemon.close());
  const space = await daemon.node.spaces.create({ name: 'Bulk', visibility: 'private' });
  const filler = 'x'.repeat(16_000);
  for (let i = 0; i < 40; i++) await daemon.node.records.put(space.id, 'app.bulk', { i, filler });

  // The service, given one node to reach that isn't the stranger's.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const folder = await tempDir('mcp-server-');
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: ['ws://127.0.0.1:9/peer'],
    data: folder,
    port,
    version: '0',
    accountHome: 'https://home.test',
  });
  closing.push(() => service.close());

  // An invitation naming the stranger's own node, pinned to it, signed by a key of no account.
  const provider = createP256Provider();
  const inviterKeys = await provider.generateKeyPair();
  const inviter = { did: await didOf(inviterKeys.publicKey), key: inviterKeys.privateKey };
  const body = readInvitation(await daemon.node.spaces.invite(space.id, { write: false })).version.body;
  const own = `ws://127.0.0.1:${daemon.port}/peer#${daemon.node.did}`;
  const invite = await encodeInvitation(inviter, { ...body, nodes: [own] }, provider);

  const token = await signInWith(issuer, async (audience) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      v: GRANT_VERSION,
      did: unlocked.account.did,
      name: 'Stranger',
      note: await unlocked.signer.delegate({
        audience,
        expiration: expiresAt,
        ...noteTerms('/record', [space.id]),
      }),
      access: 'write',
      scope: 'spaces',
      spaces: [{ id: space.id, name: 'Anything', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });

  // Time enough for the agent to sync whatever it could reach.
  const seen = await callTool(issuer, token, 'records_list', {
    space: space.id,
    collection: 'app.bulk',
    limit: 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const again = await callTool(issuer, token, 'records_list', {
    space: space.id,
    collection: 'app.bulk',
    limit: 100,
  });
  assert.equal(
    (seen.match(/"i":/g) ?? []).length + (again.match(/"i":/g) ?? []).length,
    0,
    'nothing of it reached',
  );
  assert.ok((await bytesUnder(folder)) < 40 * 16_000, 'nor the host’s disk');
});

test('with every device of theirs offline, a chat app reads and writes through the free host', async () => {
  // A free host, and Ada's laptop handing it her space, as the home does for every new account.
  const served = await startHost({
    key: await createP256Provider().generateKeyPair(),
    stores: memoryStores(),
    port: 0,
    free: true,
  });
  closing.push(() => served.close());
  const peer = `ws://127.0.0.1:${served.port}/peer`;
  const manager = createIdentityManager();
  const seed = generateSeed();
  const me = await manager.fromSeed(seed);
  const signer = createLocalRootSigner(me, manager.getProvider());
  const accountKey = await deriveAccountKey(seed);
  const onHost = async () => {
    const node = await createNode({
      signer,
      stores: memoryStores(),
      accountKey,
      watchIntervalMs: 0,
      network: { nodes: [peer] },
    });
    closing.push(() => node.close());
    return node;
  };
  const laptop = await onHost();
  const space = await laptop.spaces.create({ name: 'Club', visibility: 'private' });
  await laptop.records.put(space.id, 'app.note', { text: 'Soup on Friday' });
  await laptop.hosting.use(`http://127.0.0.1:${served.port}`);
  // Its registry too, which is how her other devices learn of the space: as `host.test.ts` waits.
  await until(
    async () => {
      const reached = (await served.node.spaces()).filter((one) => one.peers > 0).map((one) => one.name);
      return reached.includes('Account registry') && reached.includes('Club');
    },
    15_000,
    'the host to carry her registry and the space',
  );
  const invite = await laptop.spaces.invite(space.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await laptop.close();

  // The service, reaching spaces through that host alone.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const service = await startMcpServer({
    publicUrl: issuer,
    nodes: [peer],
    data: await tempDir('mcp-server-'),
    port,
    version: '0',
    accountHome: 'https://home.test',
  });
  closing.push(() => service.close());
  const token = await signInWith(issuer, async (audience) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return {
      v: GRANT_VERSION,
      did: me.did,
      name: 'Ada',
      note: await signer.delegate({ audience, expiration: expiresAt, ...noteTerms('/record', [space.id]) }),
      access: 'write',
      scope: 'spaces',
      spaces: [{ id: space.id, name: 'Club', invite }],
      expiresAt,
      home: 'https://home.test/connect',
    };
  });

  await until(
    async () =>
      (await callTool(issuer, token, 'records_list', { space: space.id, collection: 'app.note' })).includes(
        'Soup on Friday',
      ),
    20_000,
    'the chat app to read what the laptop wrote, from the host',
  );
  const put = await callTool(issuer, token, 'records_put', {
    space: space.id,
    collection: 'app.note',
    body: { text: 'Bread too' },
  });
  assert.match(put, /"isError":false/);
  // Her phone, later, gets it from the host, as hers and "via agent".
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const phone = await onHost();
  // Asked only once it holds the space: listing one it hasn't joined yet waits for it.
  await until(
    async () => (await phone.spaces.list()).some((one) => one.id === space.id),
    40_000,
    'the phone to learn of the space',
  );
  await until(
    async () =>
      (await phone.records.list(space.id, { collection: 'app.note' })).some(
        (record) => isRecord(record.body) && record.body.text === 'Bread too',
      ),
    40_000,
    'the phone to get what the chat app wrote',
  );
  const written = (await phone.records.list(space.id, { collection: 'app.note' })).find(
    (record) => isRecord(record.body) && record.body.text === 'Bread too',
  );
  assert.equal(written?.root, me.did, 'written as Ada');
  assert.equal(written?.recordsOnly, true, 'via agent');
});
