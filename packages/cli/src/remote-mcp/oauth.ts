/**
 * The MCP service as an OAuth 2.1 authorization server, so a chat app
 * (Claude, ChatGPT, an IDE) connects with the sign-in flow it already has.
 * `oidc-provider` does the protocol: dynamic client registration, PKCE,
 * resource indicators, codes and tokens. What is Minca's is the step it hands
 * over, the interaction: the person allows the app at their own account home
 * (`consent.ts`), which signs a records-only note for a key the page made.
 *
 * That key and note are kept here sealed under a key that only the access
 * token carries, an encrypted JWT under a key only this service holds: the
 * token stays a few hundred bytes however many spaces were picked, where
 * the grant itself is a few kilobytes a space, more than a request's headers
 * may hold. Neither the disk nor a token alone opens it. Only between the
 * person allowing it and the app collecting its token is it kept unsealed,
 * a few minutes at most. There is no refresh token; a token lasts as long as
 * the note, and disconnecting at the account home, which drops what it
 * opens, is what ends it sooner.
 *
 * What else it keeps (registered apps, codes, sign-ins under way) is small,
 * runs out, and holds no key.
 */
import Provider, { errors, type Adapter, type AdapterPayload, type Configuration } from 'oidc-provider';
import type { IncomingMessage } from 'node:http';
import { createSecretKey, type KeyObject } from 'node:crypto';
import { jwtDecrypt } from 'jose';
import type { StorageAdapter } from '@minca/core';
import { isRecord } from '../json.js';
import { checkGranted, type Granted } from './sessions.js';

/** The one scope: use the account's spaces through this MCP endpoint, as the person allowed */
export const MCP_SCOPE = 'mcp';

/** Where the person allows an app: `oidc-provider` sends them here with the interaction's id */
export const INTERACTION_PATH = '/oauth/interaction/';

/** How long an access token lasts: as long as the note it carries can (`consent.ts`, `CONNECT_DAYS`) */
const ACCESS_TOKEN_SECONDS = 30 * 86_400;
/** How long what a person allowed waits for the app to collect its token */
const PENDING_SECONDS = 600;
/** Where it waits */
const PENDING = 'oauth:Pending:';
/** What each token opens, by its id, sealed under a key the token alone carries */
const GRANTED = 'oauth:Granted:';

/** `oidc-provider`'s session cookie and its signature, by their default names */
const SESSION_COOKIE = /^\s*_session(\.[a-z]+)?=/;

const now = () => Math.floor(Date.now() / 1000);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** AES-GCM under `key`, bound to the token `id` it belongs to: the nonce, then the ciphertext */
async function seal(key: Uint8Array<ArrayBuffer>, id: string, value: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aes = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
    aes,
    encode(value),
  );
  return base64url(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

/** What {@link seal} sealed, or null when the key or the id isn't its */
async function open(key: Uint8Array<ArrayBuffer>, id: string, sealed: string): Promise<unknown> {
  const bytes = new Uint8Array(Buffer.from(sealed, 'base64url'));
  try {
    const aes = await globalThis.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(id) },
      aes,
      bytes.subarray(12),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

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
        // An app registered and never connected goes after a day: anyone may register one.
        const lasts = expiresIn ?? (model === 'Client' ? UNUSED_CLIENT_SECONDS : undefined);
        const kept: Kept = { payload, ...(lasts ? { expiresAt: now() + lasts } : {}) };
        await store.put(key(id), encode(kept));
        if (model === 'Session' && payload.uid)
          await store.put(
            `oauth:SessionUid:${payload.uid}`,
            encode({ payload: { id }, ...(lasts ? { expiresAt: now() + lasts } : {}) }),
          );
      },
      find: (id) => read(key(id)),
      async findByUid(uid) {
        const id = (await read(`oauth:SessionUid:${uid}`))?.id;
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

/** How long a registered app is kept with no connection made through it */
const UNUSED_CLIENT_SECONDS = 86_400;
/** Most places an app may register to be sent back to, and how long each may be */
const MAX_REDIRECTS = 5;
const MAX_REDIRECT_LENGTH = 512;

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
const SWEEP_MS = 10 * 60_000;
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
  /** 32 bytes only this service holds: tokens are sealed under it */
  readonly secret: Uint8Array;
  /** Whether a code may go to a place an app registers (`redirects.ts`) */
  readonly mayRedirect: (uri: string) => boolean;
  /** Who is asking, for counting: the address the host trusts for it (`addressOf` in `host.ts`) */
  readonly addressOf: (req: IncomingMessage) => string;
}

/** The authorization server, and how the MCP endpoint checks a token it issued */
export async function createOAuth(options: OAuthOptions) {
  const { issuer, resource } = options;
  if (options.secret.length !== 32) throw new Error('The token secret must be 32 bytes');
  const sealing: KeyObject = createSecretKey(options.secret);

  /** What a person allowed, until the app collects it */
  const pending = {
    async take(id: string): Promise<Granted | null> {
      const bytes = await options.store.get(`${PENDING}${id}`);
      if (!bytes) return null;
      await options.store.delete(`${PENDING}${id}`);
      const kept: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isKept(kept) || (kept.expiresAt ?? 0) <= now()) return null;
      return checkGranted(kept.payload.key, kept.payload.grant).catch(() => null);
    },
    async has(id: string): Promise<boolean> {
      return (await options.store.get(`${PENDING}${id}`)) !== null;
    },
  };
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
      grant_types: ['authorization_code'],
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
        if (Array.isArray(uris) && uris.length > MAX_REDIRECTS)
          throw new errors.InvalidClientMetadata(`at most ${MAX_REDIRECTS} redirect_uris`);
        // Nothing the host would fetch, nor a place to send people after signing out.
        for (const field of ['jwks_uri', 'jwks', 'post_logout_redirect_uris', 'sector_identifier_uri'])
          if (metadata[field] !== undefined)
            throw new errors.InvalidClientMetadata(`${field} is not taken here`);
        if (
          Array.isArray(uris) &&
          !uris.every(
            (uri) => typeof uri === 'string' && uri.length <= MAX_REDIRECT_LENGTH && options.mayRedirect(uri),
          )
        )
          throw Object.assign(new errors.InvalidRedirectUri(), {
            error_description:
              'a code may go only to a chat app this host knows over https, this computer, or a known app’s scheme',
          });
        if (value !== undefined && (typeof value !== 'string' || value.length > MAX_CLIENT_NAME))
          throw new errors.InvalidClientMetadata(
            `client_name must be a string of at most ${MAX_CLIENT_NAME} characters`,
          );
      },
    },
    // The authorization code flow, with PKCE, for apps with no secret, and nothing else.
    responseTypes: ['code'],
    clientAuthMethods: ['none'],
    scopes: [MCP_SCOPE],
    // The account is what the person allowed, until the app collects it.
    findAccount: async (_ctx, id) =>
      (await pending.has(id)) ? { accountId: id, claims: () => ({ sub: id }) } : undefined,
    // The key and the note are kept sealed, and the key that opens them leaves the service in the token.
    extraTokenClaims: async (_ctx, token) => {
      if (token.kind !== 'AccessToken' || !token.accountId) return undefined;
      const granted = await pending.take(token.accountId);
      if (!granted) throw new errors.InvalidGrant('what was allowed has run out; connect again');
      const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
      await options.store.put(
        `${GRANTED}${token.jti}`,
        encode({
          payload: { sealed: await seal(key, token.jti, granted) },
          expiresAt: now() + ACCESS_TOKEN_SECONDS,
        }),
      );
      return { minca: base64url(key) };
    },
    features: {
      devInteractions: { enabled: false },
      // Any app may register itself; the person sees its name and where it sends them back before allowing it.
      // No token to manage a registration with afterwards: this service offers none of that.
      registration: { enabled: true, issueRegistrationAccessToken: false },
      // A sealed token is the service's to read, not to remember: there is nothing here to revoke.
      revocation: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
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
            accessTokenFormat: 'jwt',
            jwt: { encrypt: { alg: 'dir', enc: 'A256GCM', key: sealing } },
          };
        },
      },
    },
    // No refresh token: it would be kept here, and with it what it renews.
    issueRefreshToken: async () => false,
    // Nor does a token end with the browser's sign-in here, which lasts only for the one sign-in.
    expiresWithSession: async () => false,
    pkce: { required: () => true },
    ttl: {
      AccessToken: ACCESS_TOKEN_SECONDS,
      AuthorizationCode: 60,
      Grant: PENDING_SECONDS,
      Interaction: 3600,
      // Only as long as one sign-in takes: nothing reads it after (see `provider.use` below).
      Session: 600,
    },
    interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}${interaction.uid}` },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      registration: '/oauth/register',
      jwks: '/oauth/jwks',
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
  const registers = perAddress(200, 24 * 3600_000);
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

  // What an earlier run left past its time, a key never collected among it, goes at once.
  await sweepExpired(options.store).catch(() => {});
  const sweeping = setInterval(() => void sweepExpired(options.store).catch(() => {}), SWEEP_MS);
  sweeping.unref();

  return {
    provider,
    stop: () => clearInterval(sweeping),
    /** Refuses a token from now on, by dropping what it opens: its key was revoked, so the person disconnected the app */
    async revoke(session: string) {
      await options.store.delete(`${GRANTED}${session}`);
    },
    /** Keeps what a person allowed until the app collects its token: the id the sign-in names */
    async pend(granted: Granted): Promise<string> {
      const id = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
      await options.store.put(
        `${PENDING}${id}`,
        encode({ payload: granted, expiresAt: now() + PENDING_SECONDS }),
      );
      return id;
    },
    /**
     * What an access token carries, checked: sealed here, for the MCP
     * endpoint, not run out, and a key and note that still check out.
     * @throws `errors.InvalidToken` otherwise
     */
    async verify(token: string) {
      let payload;
      try {
        ({ payload } = await jwtDecrypt(token, sealing, { issuer, audience: resource }));
      } catch {
        throw new errors.InvalidToken('not a token this service sealed, or run out');
      }
      const { jti, minca } = payload;
      if (typeof jti !== 'string' || typeof minca !== 'string')
        throw new errors.InvalidToken('it carries nothing');
      const bytes = await options.store.get(`${GRANTED}${jti}`);
      const kept: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
      if (!isKept(kept) || typeof kept.payload.sealed !== 'string')
        throw new errors.InvalidToken('disconnected at the account home, or run out; connect again');
      const carried = await open(new Uint8Array(Buffer.from(minca, 'base64url')), jti, kept.payload.sealed);
      const granted = isRecord(carried)
        ? await checkGranted(carried.key, carried.grant).catch(() => null)
        : null;
      if (!granted) throw new errors.InvalidToken('what it opens no longer checks out; connect again');
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      return {
        session: jti,
        granted,
        clientId: typeof payload.client_id === 'string' ? payload.client_id : '',
        scopes,
        ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
      };
    },
  };
}

export type OAuth = Awaited<ReturnType<typeof createOAuth>>;
