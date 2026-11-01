/**
 * A host's MCP endpoint, so a chat app connects to Minca by its address alone:
 * Claude, ChatGPT, an IDE, from the web, the desktop or a phone. The app's
 * own model does the thinking, on the person's own plan; the host runs the
 * tools.
 *
 *   POST /mcp                                          MCP over Streamable HTTP, with a bearer token
 *   GET  /.well-known/oauth-protected-resource[/mcp]   where to get a token (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server       the authorization server (RFC 8414)
 *   GET  /.well-known/openid-configuration             the same, as OpenID clients look for it
 *        /oauth/...                                    registering, signing in, tokens (`oauth.ts`)
 *        /oauth/interaction/:uid                       where the person allows the app (`consent.ts`)
 *
 * Each connection is an agent of the person's account, with a records-only
 * note their account home signed, in the spaces they picked
 * (`connections.ts`): it writes as them, "via agent", and can't add
 * collections or change who is in a space. The tools are `NODE_ACTIONS`, as
 * `minca mcp` offers them (`mcp.ts`).
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
import { callAction, type NodeConfig, type StorageAdapter, type StoreFactory } from '@minca/core';
import { isRecord, messageOf } from '../json.js';
import { mcpTools, toolInstructions } from '../mcp.js';
import { createConnections } from './connections.js';
import { createConsent } from './consent.js';
import { createOAuth, MCP_SCOPE } from './oauth.js';
import { mayRedirect } from './redirects.js';

/** Where the endpoint is, on the host */
const MCP_PATH = '/mcp';

/** What a connection may do: an agent's tools, as `minca mcp` offers them to a connected agent */
const AGENT = { agent: true } as const;

/**
 * Not offered here: previewing an invite dials the places its short link
 * names, and on a host that would be any address a caller chose, its own
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

export interface RemoteMcpOptions {
  /** The host's address as people reach it, https://: the issuer, and where the endpoint is */
  readonly publicUrl: string;
  /** The accounts that may connect, by DID: no account's room or fund pays for a connection yet */
  readonly accounts: ReadonlyArray<string>;
  /** Where connections and the authorization server's state are kept */
  readonly store: StorageAdapter;
  /** Where each connection's agent keeps its spaces */
  readonly stores: (connection: string) => StoreFactory;
  /** Removes what a connection's agent kept, once the connection is forgotten */
  readonly drop: (connection: string) => Promise<void>;
  /** Who is asking, for counting sign-ins: the address the host trusts for it */
  readonly addressOf: (req: IncomingMessage) => string;
  /** How a connection's agent reaches its spaces: the host's own socket */
  readonly network: () => NodeConfig['network'];
  /** What the host calls itself */
  readonly name: string;
  readonly version: string;
  /** The account home the consent page suggests. Default `https://home.minca.social`. */
  readonly accountHome?: string;
  /** More chat apps a sign-in may go back to, by host (`chat.example.com`) or scheme (`zed:`) */
  readonly moreApps?: ReadonlyArray<string>;
  /** How long a connection's agent stays up after its last call */
  readonly idleMs?: number;
  /** Agents running at once */
  readonly running?: number;
  readonly log?: (line: string) => void;
}

export interface RemoteMcp {
  /** Answers the request if it is the endpoint's, the authorization server's or the consent page's */
  routes(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Forgets every connection that can't act any more: it runs by itself every hour */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

export async function createRemoteMcp(options: RemoteMcpOptions): Promise<RemoteMcp> {
  const log = options.log ?? (() => {});
  const issuer = options.publicUrl.replace(/\/+$/, '');
  const resource = `${issuer}${MCP_PATH}`;
  const resourceUrl = new URL(resource);

  const connections = createConnections({
    accounts: options.accounts,
    store: options.store,
    stores: options.stores,
    drop: options.drop,
    network: options.network,
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.running !== undefined ? { running: options.running } : {}),
    log,
  });
  const oauth = await createOAuth({
    issuer,
    resource,
    store: options.store,
    connections,
    mayRedirect: (uri) => mayRedirect(uri, options.moreApps),
    addressOf: options.addressOf,
  });
  const provider = oauth.provider.callback();
  const consent = createConsent({
    oauth,
    connections,
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
            extra: { connection: found.connection },
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
      const connection = typeof authInfo?.extra?.connection === 'string' ? authInfo.extra.connection : null;
      const kept = connection ? await connections.get(connection) : null;
      const server = new Server(
        { name: 'minca', version: options.version },
        {
          capabilities: { tools: {} },
          // Who it acts for, from the grant: said without starting the agent.
          ...(kept ? { instructions: toolInstructions({ did: kept.grant.did }, AGENT) } : {}),
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
        if (!connection) return { content: [{ type: 'text', text: 'Not signed in.' }], isError: true };
        let said: Awaited<ReturnType<typeof callAction>>;
        try {
          said = await connections.use(connection, (node) =>
            callAction(node, name, request.params.arguments ?? {}),
          );
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
      if (path === '/.well-known/openid-configuration' || path.startsWith('/oauth/')) {
        await provider(req, res);
        return true;
      }
      return false;
    },
    sweep: () => connections.sweep(),
    async close() {
      oauth.stop();
      await mcp.close();
      await connections.close();
    },
  };
}
