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
import type { IncomingMessage } from 'node:http';
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

/** `oidc-provider`'s session cookie and its signature, by their default names */
const SESSION_COOKIE = /^\s*_session(\.[a-z]+)?=/;

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
 * app registration, a grant per connection, a few tokens each; and what runs
 * out is swept ({@link sweepExpired}).
 */
function storeAdapter(store: StorageAdapter): (model: string) => Adapter {
  const keptAt = async (key: string): Promise<Kept | undefined> => {
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
    return kept;
  };
  const read = async (key: string) => (await keptAt(key))?.payload;

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
        const kept = await keptAt(key(id));
        if (kept)
          await store.put(key(id), encode({ ...kept, payload: { ...kept.payload, consumed: now() } }));
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

/** Drops every kept entry that has run out: a sign-in started and never finished, a token past its time */
async function sweepExpired(store: StorageAdapter): Promise<void> {
  for (const key of await store.list('oauth:')) {
    const bytes = await store.get(key);
    if (!bytes) continue;
    let kept: unknown;
    try {
      kept = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (isKept(kept) && kept.expiresAt !== undefined && kept.expiresAt <= now()) await store.delete(key);
  }
}

/** How often what has run out is swept */
const SWEEP_MS = 3600_000;
/** Longest name an app may register with: the consent page shows it */
const MAX_CLIENT_NAME = 60;

/**
 * At most `limit` requests in `windowMs` from one address: registering and
 * starting a sign-in need no account, so they are what anyone can make a
 * host keep.
 */
function perAddress(limit: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  return (address: string): boolean => {
    const recent = (seen.get(address) ?? []).filter((at) => Date.now() - at < windowMs);
    if (recent.length >= limit) return false;
    seen.set(address, [...recent, Date.now()]);
    // Forget addresses whose window is over, so the map can't grow without end.
    if (seen.size > 10_000)
      for (const [known, times] of seen)
        if (!times.some((at) => Date.now() - at < windowMs)) seen.delete(known);
    return true;
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
  /** Whether a code may go to a place an app registers (`redirects.ts`) */
  readonly mayRedirect: (uri: string) => boolean;
  /** Who is asking, for counting: the address the host trusts for it (`addressOf` in `host.ts`) */
  readonly addressOf: (req: IncomingMessage) => string;
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
      // Most MCP apps don't say. Native takes what they use: https at a chat app's own site, this
      // computer at any port (RFC 8252), or an app's scheme; which of those may get a code is
      // `mayRedirect`, checked below.
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256',
    },
    cookies: { keys },
    // Checked when an app registers: every place it may be sent back to is one a code may go, so
    // no sign-in for it can send one anywhere else; and a name short enough to show.
    extraClientMetadata: {
      properties: ['client_name'],
      validator: (_ctx, _key, value, metadata) => {
        const uris: unknown = metadata.redirect_uris;
        if (Array.isArray(uris) && !uris.every((uri) => typeof uri === 'string' && options.mayRedirect(uri)))
          throw new errors.InvalidRedirectUri(
            'a code may go only to a chat app this host knows, this computer, or a known app',
          );
        if (value !== undefined && (typeof value !== 'string' || value.length > MAX_CLIENT_NAME))
          throw new errors.InvalidClientMetadata(
            `client_name must be a string of at most ${MAX_CLIENT_NAME} characters`,
          );
      },
    },
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
    // Nor do its tokens end with the browser's sign-in here, which lasts only for the one sign-in.
    expiresWithSession: async () => false,
    pkce: { required: () => true },
    ttl: {
      AccessToken: ACCESS_TOKEN_SECONDS,
      AuthorizationCode: 60,
      RefreshToken: REFRESH_TOKEN_SECONDS,
      Grant: REFRESH_TOKEN_SECONDS,
      Interaction: 3600,
      // Only as long as one sign-in takes: nothing reads it after (see `provider.use` below).
      Session: 600,
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
  // No single sign-on: signing in is allowing an app at the account home, every time, and each
  // allowing is a connection of its own. So a browser's earlier sign-in here is never read, and
  // can't stand in the way of the next app it connects.
  //
  // Its addresses are the issuer's, whatever a request's forwarded headers say, and registering and
  // starting a sign-in are counted by who asks.
  const issued = new URL(issuer);
  const registers = perAddress(20, 24 * 3600_000);
  const starts = perAddress(120, 3600_000);
  provider.use(async (ctx, next) => {
    const cookie = ctx.get('cookie');
    if (cookie)
      ctx.request.header.cookie = cookie
        .split(';')
        .filter((pair) => !SESSION_COOKIE.test(pair))
        .join(';');
    ctx.request.header['x-forwarded-host'] = issued.host;
    ctx.request.header['x-forwarded-proto'] = issued.protocol.slice(0, -1);
    const counted =
      ctx.method === 'POST' && ctx.path === '/oauth/register'
        ? registers
        : ctx.path === '/oauth/authorize'
          ? starts
          : null;
    if (counted && !counted(options.addressOf(ctx.req))) {
      ctx.status = 429;
      ctx.type = 'json';
      ctx.body = { error: 'slow_down', error_description: 'Too many from here. Try again later.' };
      return;
    }
    await next();
  });

  const sweeping = setInterval(() => void sweepExpired(options.store).catch(() => {}), SWEEP_MS);
  sweeping.unref();

  return {
    provider,
    stop: () => clearInterval(sweeping),
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
