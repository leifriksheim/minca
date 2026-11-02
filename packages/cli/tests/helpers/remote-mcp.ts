/** What the MCP service's end-to-end tests share: signing in as a chat app, calling a tool, and the networks between */
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import * as oauth from 'oauth4webapi';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Grant } from '@minca/core/session';
import type { P2PNode } from '../../../core/src/node/types.js';
import { didOf } from '../../../core/src/identity/did.js';
import { until } from '../../../core/tests/helpers/until.js';
import { isRecord } from '../../src/json.js';
import { readdir, stat } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { createRelay, MAX_MESSAGE_BYTES } from '../../../relay/relay.mjs';
import net from 'node:net';
import path from 'node:path';

/** Names her carriers as a space's keepers, as her home does for a space it hands a host */
export async function keptByHosts(node: P2PNode, space: string, hosts = 1): Promise<void> {
  await until(async () => (await node.carriers.list()).length >= hosts, 10_000, 'her hosts to be carriers');
  const carriers = await node.carriers.list();
  await node.spaces.setKeepers(
    space,
    carriers.map((carrier) => ({ did: carrier.did, name: carrier.name })),
  );
}

/** A JSON object's string field, or a failed test */
export function stringField(value: unknown, name: string): string {
  const found = isRecord(value) ? value[name] : undefined;
  assert.ok(typeof found === 'string', `no ${name} in ${JSON.stringify(value)}`);
  return found;
}

export const closing: Array<() => Promise<unknown>> = [];
after(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => {});
});

export const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
export const insecure = { [oauth.allowInsecureRequests]: true };

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Something on the host's own machine that nobody outside should reach: it notes every request */
export async function internalService() {
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

/** Signs in at the host as a chat app, answering the consent page with `grantFor(key)` and that key */
export async function signInWith(
  issuer: string,
  grantFor: (audience: string) => Promise<Grant>,
): Promise<string> {
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

export async function callTool(issuer: string, token: string, name: string, args: Record<string, unknown>) {
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

export async function bytesUnder(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await bytesUnder(at);
    else if (entry.isFile()) bytes += (await stat(at)).size;
  }
  return bytes;
}

/** A TCP proxy to a host: the network between the service and it, whose answers can be lost, or which can refuse */
export async function between(target: number) {
  let backCut = false;
  let refusing = false;
  const open = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (refusing) return void client.destroy();
    const upstream = net.connect(target, '127.0.0.1');
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      socket.on('error', () => {});
    }
    client.on('data', (data) => upstream.write(data));
    upstream.on('data', (data) => {
      if (!backCut) client.write(data);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    /** What the host says is lost on the way back; what the service sends still arrives */
    cutBack() {
      backCut = true;
    },
    /** Nobody gets through */
    refuse() {
      refusing = true;
      for (const socket of open) socket.destroy();
    },
    mend() {
      backCut = false;
      refusing = false;
      for (const socket of open) socket.destroy();
    },
  };
}

/** A relay on this machine, as a deployment runs one */
export async function aRelay() {
  const relay = createRelay({});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.upgrade(wss, req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  closing.push(async () => {
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `ws://127.0.0.1:${address.port}`;
}
