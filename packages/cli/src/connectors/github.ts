/**
 * The host's GitHub App: what connects a community's bot to GitHub
 * (packages/core/docs/bots.md). The host's operator registers the App once;
 * the host keeps its private key and asks GitHub for a token for an
 * installation when a bot needs one, which lasts an hour. No GitHub secret
 * enters a space.
 *
 * Plain `fetch` to GitHub's REST API, so tests replace it.
 */
import { createHmac, createPrivateKey, createSign, timingSafeEqual } from 'node:crypto';
import { isRecord } from '../json.js';

/** The App, as its operator registered it */
export interface GitHubAppConfig {
  readonly id: string;
  /** Its name in its address, github.com/apps/<slug> */
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** PEM, as GitHub gives it */
  readonly privateKey: string;
  /** What GitHub signs its webhook calls with; without it the host takes none */
  readonly webhookSecret?: string;
}

export interface GitHubApp {
  /** Where a browser picks an org and its repos, coming back with `state` */
  installUrl(state: string): string;
  /**
   * The account an installation is on, if the GitHub user who came back with
   * `code` may decide for it: it is their own account, or an organisation they
   * are an admin of. Null otherwise. GitHub doesn't vouch for the installation
   * id in its redirect, and lists an installation to anyone with access to one
   * of its repositories, so reaching it is not enough.
   */
  confirm(code: string, installation: number): Promise<{ readonly account: string } | null>;
  /** The repos an installation reaches, owner/name */
  repos(installation: number): Promise<ReadonlyArray<string>>;
  /** A token acting as the App on an installation, kept until a minute before it lapses */
  token(installation: number): Promise<string>;
  /** Whether the App takes webhook calls */
  readonly hooks: boolean;
  /** Whether a webhook call's body is GitHub's, by its `X-Hub-Signature-256` */
  signed(body: string, signature: string | undefined): boolean;
}

const API = 'https://api.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');

export function createGitHubApp(
  config: GitHubAppConfig,
  options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): GitHubApp {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const key = createPrivateKey(config.privateKey);
  const tokens = new Map<number, { readonly token: string; readonly until: number }>();

  /** The App's own JWT: ten minutes at most, a minute back for clocks that differ */
  const jwt = () => {
    const at = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat: at - 60, exp: at + 540, iss: config.id }));
    const sign = createSign('RSA-SHA256');
    sign.update(`${head}.${body}`);
    return `${head}.${body}.${b64url(sign.sign(key))}`;
  };

  async function json(url: string, init: RequestInit): Promise<unknown> {
    const res = await request(url, init);
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  }

  const get = (url: string, authorization: string) => json(url, { headers: { ...HEADERS, authorization } });

  /** Every item of a list GitHub pages, up to ten pages of a hundred */
  async function pages(url: string, field: string, authorization: string): Promise<ReadonlyArray<unknown>> {
    const all: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const answer = await get(
        `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        authorization,
      );
      const items: ReadonlyArray<unknown> =
        isRecord(answer) && Array.isArray(answer[field]) ? answer[field] : [];
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }

  async function userToken(code: string): Promise<string | null> {
    const answer = await json('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    });
    return isRecord(answer) && typeof answer.access_token === 'string' ? answer.access_token : null;
  }

  async function myLogin(auth: string): Promise<string | null> {
    const me = await get(`${API}/user`, auth);
    return isRecord(me) && typeof me.login === 'string' ? me.login : null;
  }

  /** The account an installation is on, among those this user reaches */
  async function installedOn(installation: number, auth: string) {
    const found = (await pages(`${API}/user/installations`, 'installations', auth)).find(
      (one) => isRecord(one) && one.id === installation,
    );
    const account = isRecord(found) && isRecord(found.account) ? found.account : null;
    if (!account || typeof account.login !== 'string') return null;
    return { login: account.login, type: account.type };
  }

  async function isOrgAdmin(org: string, auth: string): Promise<boolean> {
    const membership = await get(`${API}/user/memberships/orgs/${encodeURIComponent(org)}`, auth).catch(
      () => null,
    );
    return isRecord(membership) && membership.state === 'active' && membership.role === 'admin';
  }

  /** A token acting as the App on an installation, kept until a minute before it lapses */
  async function token(installation: number): Promise<string> {
    const kept = tokens.get(installation);
    if (kept && kept.until - 60_000 > now()) return kept.token;
    const answer = await json(`${API}/app/installations/${installation}/access_tokens`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${jwt()}` },
    });
    if (!isRecord(answer) || typeof answer.token !== 'string' || typeof answer.expires_at !== 'string')
      throw new Error('GitHub gave no token for the installation');
    tokens.set(installation, { token: answer.token, until: Date.parse(answer.expires_at) });
    return answer.token;
  }

  return Object.freeze({
    installUrl: (state: string) =>
      `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`,

    async confirm(code: string, installation: number) {
      const user = await userToken(code);
      if (!user) return null;
      const auth = `Bearer ${user}`;
      const login = await myLogin(auth);
      const account = login ? await installedOn(installation, auth) : null;
      if (!login || !account) return null;
      // Their own account; or an organisation, which only its admins may hand to a bot.
      const mayDecide =
        account.type === 'User'
          ? account.login.toLowerCase() === login.toLowerCase()
          : account.type === 'Organization' && (await isOrgAdmin(account.login, auth));
      return mayDecide ? { account: account.login } : null;
    },

    async repos(installation: number) {
      const list = await pages(
        `${API}/installation/repositories`,
        'repositories',
        `Bearer ${await token(installation)}`,
      );
      return list.flatMap((repo) =>
        isRecord(repo) && typeof repo.full_name === 'string' ? [repo.full_name] : [],
      );
    },

    token,

    hooks: !!config.webhookSecret,
    signed(body: string, signature: string | undefined) {
      if (!config.webhookSecret || !signature?.startsWith('sha256=')) return false;
      const expected = Buffer.from(
        `sha256=${createHmac('sha256', config.webhookSecret).update(body).digest('hex')}`,
      );
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  });
}
