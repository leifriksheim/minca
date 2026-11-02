/**
 * Minca's MCP service, so a chat app connects to someone's spaces by an
 * address alone: Claude, ChatGPT, an IDE, from the web, the desktop or a
 * phone. The app's own model does the thinking, on the person's own plan; the
 * service runs the tools.
 *
 *   POST /mcp                                          MCP over Streamable HTTP, with a bearer token
 *   GET  /.well-known/oauth-protected-resource[/mcp]   where to get a token (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server       the authorization server (RFC 8414)
 *   GET  /.well-known/openid-configuration             the same, as OpenID clients look for it
 *        /oauth/...                                    registering, signing in, tokens (`oauth.ts`)
 *        /oauth/interaction/:uid                       where the person allows the app (`consent.ts`)
 *
 * Each token carries an agent of the person's account: a key, with a
 * records-only note their account home signed for the spaces they picked
 * (`sessions.ts`). It writes as them, "via agent", and can't add collections
 * or change who is in a space. The tools are `NODE_ACTIONS`, as `minca mcp`
 * offers them (`mcp.ts`). The token holds the key; the service holds a
 * copy of the spaces only while their node runs (`sessions.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  requireBearerAuth,
  getOAuthProtectedResourceMetadataUrl,
  Server,
  type AuthInfo,
  type JSONObject,
  type JSONValue,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  callAction,
  NODE_ACTIONS,
  type NodeConfig,
  type StorageAdapter,
  type StoreFactory,
} from '@minca/core';
import { createSessions, type Granted } from './sessions.js';
import { isRecord, messageOf } from '../json.js';
import { mcpTools, toolInstructions } from '../mcp.js';
import { createConsent } from './consent.js';
import { createOAuth, MCP_SCOPE } from './oauth.js';
import { mayRedirect } from './redirects.js';

/** Where the endpoint is */
const MCP_PATH = '/mcp';

/** The authorization server's paths, as `oauth.ts` names them: a sign-in resumes at `authorize/<uid>` */
const PROVIDER_PATH = /^\/oauth\/(authorize|authorize\/[A-Za-z0-9_-]{1,64}|token|register|jwks)$/;

/** What a connection may do: an agent's tools, as `minca mcp` offers them to a connected agent */
const AGENT = { agent: true } as const;

/**
 * Not offered here: previewing an invite dials the places its short link
 * names, and on a server that would be any address a caller chose, its own
 * network included. An agent can't join a space anyway.
 */
const NOT_HOSTED = new Set(['spaces_preview_invite']);

/** The tools a connection is offered */
const hostedTools = () => mcpTools(AGENT).filter((tool) => !NOT_HOSTED.has(tool.name));

/** A plain copy, as the SDK types JSON: the actions' schemas are frozen, read-only data */
function json(value: unknown): JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) return value.map(json);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, json(inner)]));
  return null;
}

function objectOf(value: unknown): JSONObject {
  const copied = json(value);
  return copied !== null && typeof copied === 'object' && !Array.isArray(copied) ? copied : {};
}

/** How long a call that writes waits for an always-on node to say it stored what it wrote */
const STORED_MS = 10_000;

export interface RemoteMcpOptions {
  /** The service's address as people reach it, https://: the issuer, and where the endpoint is */
  readonly publicUrl: string;
  /** 32 bytes only this service holds: every token is sealed under them */
  readonly secret: Uint8Array;
  /** Where the authorization server keeps what it must: apps registered, sign-ins under way */
  readonly store: StorageAdapter;
  /** A folder of stores for a session's node while it runs, and where its key (by DID) has signed */
  readonly stores: (session: string, key: string) => StoreFactory;
  /** Removes that folder once the node stops with what it wrote held by an always-on node */
  readonly drop: (session: string, key: string) => Promise<void>;
  /** Who is asking, for counting sign-ins */
  readonly addressOf: (req: IncomingMessage) => string;
  /** How a session's node reaches the spaces it was given: the hosts the service names */
  readonly network: () => NodeConfig['network'];
  /** What the service calls itself */
  readonly name: string;
  readonly version: string;
  /** The account home the consent page suggests. Default `https://home.minca.social`. */
  readonly accountHome?: string;
  /** More chat apps a sign-in may go back to, by host (`chat.example.com`) or scheme (`zed:`) */
  readonly moreApps?: ReadonlyArray<string>;
  /** How long a session's node stays up after its last call */
  readonly idleMs?: number;
  /** Nodes running at once */
  readonly running?: number;
  readonly log?: (line: string) => void;
}

export interface RemoteMcp {
  /** Answers the request if it is the endpoint's, the authorization server's or the consent page's */
  routes(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

export async function createRemoteMcp(options: RemoteMcpOptions): Promise<RemoteMcp> {
  const log = options.log ?? (() => {});
  const issuer = options.publicUrl.replace(/\/+$/, '');
  const resource = `${issuer}${MCP_PATH}`;
  const resourceUrl = new URL(resource);

  const sessions = createSessions({
    stores: options.stores,
    drop: options.drop,
    network: options.network,
    // Refused again by the next node that sees the revoke, if keeping it fails now.
    onRevoked: (session) =>
      void oauth
        .revoke(session)
        .catch((error: unknown) => log(`could not refuse a disconnected token: ${String(error)}`)),
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.running !== undefined ? { running: options.running } : {}),
    log,
  });
  const oauth = await createOAuth({
    issuer,
    resource,
    store: options.store,
    secret: options.secret,
    mayRedirect: (uri) => mayRedirect(uri, options.moreApps),
    addressOf: options.addressOf,
  });
  const provider = oauth.provider.callback();
  const consent = createConsent({
    oauth,
    issuer,
    resource,
    name: options.name,
    accountHome: options.accountHome ?? 'https://home.minca.social',
    ...(options.moreApps ? { moreApps: options.moreApps } : {}),
    log,
  });

  // The resource's own metadata, built by the SDK; the authorization server's comes from `oidc-provider` itself.
  const metadata = {
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ['code'],
    },
    resourceServerUrl: resourceUrl,
    scopesSupported: [MCP_SCOPE],
    resourceName: `Minca at ${options.name}`,
  };
  buildOAuthProtectedResourceMetadata(metadata);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        try {
          const found = await oauth.verify(token);
          return {
            token,
            clientId: found.clientId ?? '',
            scopes: found.scopes,
            ...(found.expiresAt !== undefined ? { expiresAt: found.expiresAt } : {}),
            resource: resourceUrl,
            extra: { session: found.session, granted: found.granted },
          };
        } catch (error) {
          // A 401 with the challenge, so the app signs in again.
          throw new OAuthError(OAuthErrorCode.InvalidToken, messageOf(error));
        }
      },
    },
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });

  /** A server for one request, acting as the connection the token names */
  const mcp = createMcpHandler(
    async ({ authInfo }) => {
      const session = typeof authInfo?.extra?.session === 'string' ? authInfo.extra.session : null;
      // Put there by the verifier above, from the token it opened.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checked by checkGranted in oauth.verify
      const granted = (authInfo?.extra?.granted ?? null) as Granted | null;
      const server = new Server(
        { name: 'minca', version: options.version },
        {
          capabilities: { tools: {} },
          // Who it acts for, from the grant: said without starting the agent.
          ...(granted ? { instructions: toolInstructions({ did: granted.grant.did }, AGENT) } : {}),
        },
      );
      server.setRequestHandler('tools/list', () => ({
        tools: hostedTools().map((tool) => ({
          ...tool,
          inputSchema: { ...objectOf(tool.inputSchema), type: 'object' },
        })),
      }));
      server.setRequestHandler('tools/call', async (request) => {
        const name = request.params.name;
        if (!hostedTools().some((tool) => tool.name === name))
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        if (!session || !granted)
          return { content: [{ type: 'text', text: 'Not signed in.' }], isError: true };
        let said: Awaited<ReturnType<typeof callAction>>;
        try {
          const args = request.params.arguments ?? {};
          const space = typeof args.space === 'string' ? args.space : undefined;
          const writes = !NODE_ACTIONS.find((action) => action.name === name)?.readOnly;
          said = await sessions.use(session, granted, space, async (node) => {
            const before = writes && space !== undefined ? new Set(await node.spaces.unsent(space)) : null;
            const done = await callAction(node, name, args);
            if (done.isError || !before || space === undefined) return done;
            // The node's folder goes when it stops: a version this call signed that no always-on node
            // stored would go with it, and the place it was signed at, which is kept, would point at nothing.
            const signed = (await node.spaces.unsent(space)).filter((id) => !before.has(id));
            if (await node.spaces.delivered(space, STORED_MS, signed)) return done;
            throw new Error(
              'Saved on this connection, but no always-on node has confirmed it yet: it is sent when one ' +
                'is reachable, unless this connection is idle for 10 minutes first. Don’t write it again; ' +
                'check later that it is there.',
            );
          });
        } catch (error) {
          return { content: [{ type: 'text', text: messageOf(error) }], isError: true };
        }
        const { text, isError, value } = said;
        return {
          content: [{ type: 'text', text }],
          ...(isError ? {} : { structuredContent: isRecord(value) ? value : { result: value } }),
          isError,
        };
      });
      return server;
    },
    { onerror: (error) => log(`mcp: ${error.message}`) },
  );

  const serveMcp = toNodeHandler(
    {
      fetch: async (request: Request) => {
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        return mcp.fetch(request, { authInfo: auth });
      },
    },
    { onerror: (error) => log(`mcp: ${error.message}`) },
  );

  const serveMetadata = toNodeHandler({
    fetch: async (request: Request) =>
      oauthMetadataResponse(request, metadata) ?? new Response('Not found', { status: 404 }),
  });

  return {
    async routes(req, res) {
      const url = new URL(req.url ?? '/', 'http://host');
      const path = url.pathname;
      if (path === MCP_PATH) {
        await serveMcp(req, res);
        return true;
      }
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        await serveMetadata(req, res);
        return true;
      }
      if (path === '/.well-known/oauth-authorization-server') {
        // The same document `oidc-provider` publishes for OpenID clients: one source for both.
        req.url = `/.well-known/openid-configuration${url.search}`;
        await provider(req, res);
        return true;
      }
      if (await consent(req, res, path)) return true;
      // Only the provider's own paths, exactly: what it would also match spelled another way is not
      // what the service counts (`oauth.ts`).
      if (path === '/.well-known/openid-configuration' || PROVIDER_PATH.test(path)) {
        await provider(req, res);
        return true;
      }
      if (path.toLowerCase().startsWith('/oauth')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return true;
      }
      return false;
    },
    async close() {
      oauth.stop();
      await mcp.close();
      await sessions.close();
    },
  };
}
