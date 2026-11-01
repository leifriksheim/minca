/**
 * The host as an OAuth 2.1 authorization server for its MCP endpoint, so a
 * chat app (Claude, ChatGPT, an IDE) connects with the sign-in flow it already
 * has. `oidc-provider` does the protocol: dynamic client registration, PKCE,
 * resource indicators, codes, tokens and refresh. What is Minca's is the one
 * step it hands over, the interaction: the person allows the app at their own
 * account home (`remote-mcp/consent.ts`), and the account the token acts for
 * is the connection that made (`remote-mcp/connections.ts`).
 *
 * Its state (clients, grants, codes, tokens) is kept in the host's own
 * stores, so a restart signs nobody out.
 */
import Provider, { errors, type Adapter, type AdapterPayload, type Configuration } from 'oidc-provider';
import type { StorageAdapter } from '@minca/core';
import { isRecord } from '../json.js';
import type { Connections } from './connections.js';

/** The one scope: use the account's spaces through this host's MCP endpoint, as the person allowed */
export const MCP_SCOPE = 'mcp';

/** Where the person allows an app: `oidc-provider` sends them here with the interaction's id */
export const INTERACTION_PATH = '/oauth/interaction/';

/** How long an access token lasts: an app refreshes it, and the host checks the connection each time */
const ACCESS_TOKEN_SECONDS = 3600;
/** How long a refresh token lasts: as long as the note a connection gets (`consent.ts`, `CONNECT_DAYS`) */
const REFRESH_TOKEN_SECONDS = 30 * 86_400;

const now = () => Math.floor(Date.now() / 1000);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** What each kept entry holds: the payload, and when it runs out (unix seconds) */
interface Kept {
  readonly payload: AdapterPayload;
  readonly expiresAt?: number;
}

const isKept = (value: unknown): value is Kept => isRecord(value) && isRecord(value.payload);

/** Models whose entries belong to a grant, and go when it is revoked */
const GRANTABLE = new Set(['AccessToken', 'AuthorizationCode', 'RefreshToken']);

/**
 * `oidc-provider`'s storage on one of the host's stores: an entry per model
 * and id, and an index from each session's uid. Small by nature: a client per
 * app registration, a grant per connection, a few tokens each.
 */
function storeAdapter(store: StorageAdapter): (model: string) => Adapter {
  const read = async (key: string): Promise<AdapterPayload | undefined> => {
    const bytes = await store.get(key);
    if (!bytes) return undefined;
    let kept: unknown;
    try {
      kept = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return undefined;
    }
    if (!isKept(kept)) return undefined;
    if (kept.expiresAt !== undefined && kept.expiresAt <= now()) {
      await store.delete(key);
      return undefined;
    }
    return kept.payload;
  };

  return (model) => {
    const key = (id: string) => `oauth:${model}:${id}`;
    return {
      async upsert(id, payload, expiresIn) {
        const kept: Kept = { payload, ...(expiresIn ? { expiresAt: now() + expiresIn } : {}) };
        await store.put(key(id), encode(kept));
        if (model === 'Session' && payload.uid)
          await store.put(`oauth:SessionUid:${payload.uid}`, encode(id));
      },
      find: (id) => read(key(id)),
      async findByUid(uid) {
        const bytes = await store.get(`oauth:SessionUid:${uid}`);
        if (!bytes) return undefined;
        const id: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return typeof id === 'string' ? read(key(id)) : undefined;
      },
      // Device codes only, which this host doesn't offer.
      findByUserCode: async () => undefined,
      async consume(id) {
        const payload = await read(key(id));
        if (!payload) return;
        const bytes = await store.get(key(id));
        const kept: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        await store.put(
          key(id),
          encode({ ...(isKept(kept) ? kept : {}), payload: { ...payload, consumed: now() } }),
        );
      },
      async destroy(id) {
        await store.delete(key(id));
      },
      async revokeByGrantId(grantId) {
        // Every token of the grant, whatever its model: few enough to look through.
        for (const kind of GRANTABLE)
          for (const entry of await store.list(`oauth:${kind}:`)) {
            const payload = await read(entry);
            if (payload?.grantId === grantId) await store.delete(entry);
          }
      },
    };
  };
}

/** A secret kept in the store, made the first time it is asked for */
async function keptSecret<T>(store: StorageAdapter, name: string, make: () => Promise<T>): Promise<T> {
  const bytes = await store.get(`oauth-secret:${name}`);
  if (bytes) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- written below by this function, with the same `make`
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  const made = await make();
  await store.put(`oauth-secret:${name}`, encode(made));
  return made;
}

/** The key `oidc-provider` signs with: it issues no ID tokens here, but wants one to publish */
async function signingKey(): Promise<JsonWebKey & { kid: string }> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    ...jwk,
    kid: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(9))).toString('base64url'),
  };
}

const cookieKeys = async () => [
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
];

export interface OAuthOptions {
  /** The host's public address: the issuer, e.g. `https://mcp.minca.social` */
  readonly issuer: string;
  /** The MCP endpoint, the one resource tokens are for, e.g. `https://mcp.minca.social/mcp` */
  readonly resource: string;
  readonly store: StorageAdapter;
  readonly connections: Connections;
}

/** The authorization server, and how the MCP endpoint checks a token it issued */
export async function createOAuth(options: OAuthOptions) {
  const { issuer, resource, connections } = options;
  const jwk = await keptSecret(options.store, 'signing-key', signingKey);
  const keys = await keptSecret(options.store, 'cookie-keys', cookieKeys);

  const configuration: Configuration = {
    adapter: storeAdapter(options.store),
    jwks: { keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] },
    enabledJWA: { idTokenSigningAlgValues: ['ES256'] },
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256',
    },
    cookies: { keys },
    // The authorization code flow, with PKCE, and nothing else.
    responseTypes: ['code'],
    scopes: ['offline_access', MCP_SCOPE],
    // The account is a connection: there while it can still act for the person.
    findAccount: async (_ctx, id) =>
      (await connections.usable(id)) ? { accountId: id, claims: () => ({ sub: id }) } : undefined,
    features: {
      devInteractions: { enabled: false },
      // Any app may register itself; the person sees its name and where it sends them back before allowing it.
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return {
            scope: MCP_SCOPE,
            audience: resource,
            accessTokenTTL: ACCESS_TOKEN_SECONDS,
            accessTokenFormat: 'opaque',
          };
        },
      },
    },
    // Every app gets a refresh token, so a connection lasts as long as its note, not an hour.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    pkce: { required: () => true },
    ttl: {
      AccessToken: ACCESS_TOKEN_SECONDS,
      AuthorizationCode: 60,
      RefreshToken: REFRESH_TOKEN_SECONDS,
      Grant: REFRESH_TOKEN_SECONDS,
      Interaction: 3600,
      Session: 3600,
    },
    interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}${interaction.uid}` },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      registration: '/oauth/register',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
      end_session: '/oauth/logout',
    },
    renderError: (ctx, out) => {
      ctx.type = 'json';
      ctx.body = out;
    },
  };

  const provider = new Provider(issuer, configuration);
  // Behind whatever terminates TLS: the address people reach comes from its headers.
  provider.proxy = true;

  return {
    provider,
    /**
     * The connection an access token acts for, checked: issued here, for the
     * MCP endpoint, not run out, and its connection still able to act.
     * @throws `errors.InvalidToken` otherwise
     */
    async verify(token: string) {
      const found = await provider.AccessToken.find(token);
      if (!found || found.isExpired || !found.accountId) throw new errors.InvalidToken('unknown token');
      if (found.aud !== resource) throw new errors.InvalidToken('not for this resource');
      if (!(await connections.usable(found.accountId)))
        throw new errors.InvalidToken('the connection can no longer act for the account');
      return {
        connection: found.accountId,
        clientId: found.clientId,
        scopes: [...(found.scopes ?? [])],
        expiresAt: found.exp,
      };
    },
  };
}

export type OAuth = Awaited<ReturnType<typeof createOAuth>>;
