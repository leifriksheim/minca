/**
 * Connecting a bot a host runs to GitHub (spec/08-hosting.md §3.1,
 * packages/core/docs/bots.md).
 *
 * Someone who may configure the bot writes a `std.connect` in the space with
 * the hash of a secret only their browser holds, and opens the host's connect
 * page with the secret. The host reads the request through the bot, which is
 * a member, and checks it the way any peer would; then sends the browser to
 * GitHub's install screen. GitHub sends it back with an installation, which
 * the host confirms with the GitHub user's own token before it keeps it. The
 * bot then says in its own `std.connector` what it is connected to.
 *
 * Disconnecting is the same request with `disconnect`, checked the same way.
 * GitHub's webhook says when an installation goes or its repositories change.
 */
import type { NodeRecord, P2PNode, StorageAdapter } from '@minca/core';
import { CONNECT_REQUEST_SECONDS, connector, mayConfigure, type Connect } from '@minca/core/schemas';
import { isRecord } from './json.js';
import type { GitHubApp } from './connectors/github.js';

/** What a host keeps of a bot's connection: GitHub's installation, and who made it */
export interface Connection {
  readonly bot: string;
  readonly space: string;
  readonly installation: number;
  readonly account: string;
  readonly repos: ReadonlyArray<string>;
  readonly by: string;
  readonly since: string;
}

type Refusal = { readonly ok: false; readonly status: number; readonly said: string };
/** Where a browser goes next, or why it can't */
export type ConnectStep =
  | {
      readonly ok: true;
      readonly to: string;
      /** A cookie to set on the browser going to GitHub, which it must bring back: `name=value` */
      readonly cookie: { readonly name: string; readonly value: string };
    }
  | Refusal;
export type ConnectDone = { readonly ok: true; readonly connection: Connection } | Refusal;

/** What a request names, as the page that opens it passes it on */
export interface ConnectParams {
  readonly space: string;
  readonly request: string;
  readonly secret: string;
}

export interface BotConnect {
  /** The connect page: checks the request, and answers GitHub's install screen */
  start(bot: string, params: ConnectParams): Promise<ConnectStep>;
  /**
   * GitHub's redirect back, with what was installed, and the cookies the
   * browser brought: only the browser that opened the connect page finishes.
   */
  finish(params: {
    state: string;
    code: string;
    installation: number;
    cookies: Readonly<Record<string, string>>;
  }): Promise<ConnectDone>;
  /** Disconnects a bot in a space, for a request with `disconnect` */
  disconnect(bot: string, params: ConnectParams): Promise<{ readonly ok: true } | Refusal>;
  /** What GitHub's webhook said happened; what the host did about it, for its log */
  hook(event: string, payload: unknown): Promise<string>;
  /** A bot's connection in a space, if it has one */
  connection(bot: string, space: string): Promise<Connection | null>;
  /**
   * A bot's connection in a space if it still stands: the bot holds a role
   * there and whoever connected it may still configure it. Otherwise the
   * host forgets it, and the bot takes back its record where it can.
   */
  usable(bot: string, space: string): Promise<Connection | null>;
}

/** A secret's length at least: 32 bytes, in base64url */
const MIN_SECRET = 43;

/** How long a browser may take at GitHub's install screen */
const STATE_SECONDS = 900;

const PREFIX = 'connection:github:';

/** The cookie that ties GitHub's return to the browser that left: named for its state, so two at once don't collide */
const cookieName = (state: string) => `minca_connect_${state.slice(0, 16)}`;

const refuse = (status: number, said: string): Refusal => ({ ok: false, status, said });

/** base64url(SHA-256(secret)), as a `std.connect` carries it */
export async function verifierOf(secret: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Buffer.from(hash).toString('base64url');
}

/** Whether two strings are equal, in time that doesn't say where they differ */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differ === 0;
}

function isConnect(body: unknown): body is Connect {
  return (
    isRecord(body) &&
    typeof body.bot === 'string' &&
    typeof body.kind === 'string' &&
    typeof body.expires === 'string' &&
    (body.verifier === undefined || typeof body.verifier === 'string')
  );
}

function isConnection(value: unknown): value is Connection {
  return (
    isRecord(value) &&
    typeof value.bot === 'string' &&
    typeof value.space === 'string' &&
    typeof value.installation === 'number' &&
    typeof value.account === 'string' &&
    Array.isArray(value.repos)
  );
}

interface Pending {
  readonly bot: string;
  readonly space: string;
  readonly by: string;
  readonly until: number;
  /** SHA-256 of the cookie the browser was given */
  readonly browser: string;
}

export function createBotConnect(options: {
  readonly store: StorageAdapter;
  /** A bot's node, when this host runs it */
  readonly botNode: (did: string) => Promise<P2PNode | null>;
  /** Whether this host runs an account as a bot: never one to connect another */
  readonly isBot?: (did: string) => Promise<boolean>;
  readonly github: GitHubApp;
  /** How long to wait for a request to reach the bot. Default 8 s. */
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): BotConnect {
  const { store, github, log } = options;
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 8000;
  /** Requests being checked now: a second call with one waits for nothing, it is refused */
  const checking = new Set<string>();

  const get = async (key: string): Promise<unknown> => {
    const bytes = await store.get(key);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  };
  const put = (key: string, value: unknown) =>
    store.put(key, new TextEncoder().encode(JSON.stringify(value)));
  const connectionKey = (bot: string, space: string) => `${PREFIX}${bot}:${space}`;
  const connections = async (): Promise<Connection[]> => {
    const found: Connection[] = [];
    for (const key of await store.list(PREFIX)) {
      const kept = await get(key);
      if (isConnection(kept)) found.push(kept);
    }
    return found;
  };

  /** The request, once the bot holds it: it may have been written a moment before the page opened */
  async function arrived(node: P2PNode, space: string, key: string): Promise<NodeRecord | null> {
    const until = now() + waitMs;
    for (;;) {
      const record = await node.records.get(space, key).catch(() => null);
      if (record || now() >= until) return record;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Checks a request as spec 08 §3.1 says, and marks it used: the bot's node
   * and who wrote it, or why not. `disconnect` is what the request must ask.
   */
  async function check(
    bot: string,
    params: ConnectParams,
    disconnect: boolean,
  ): Promise<{ readonly ok: true; readonly node: P2PNode; readonly writer: string } | Refusal> {
    // 32 random bytes at least, so the verifier in the space can't be worked back to it.
    if (params.secret.length < MIN_SECRET)
      return refuse(400, 'This link is incomplete. Start again from the app.');
    const node = await options.botNode(bot);
    if (!node) return refuse(404, 'This host runs no such bot.');
    if (!(await node.spaces.list()).some((space) => space.id === params.space))
      return refuse(404, 'The bot isn’t in that space.');
    const usedKey = `used:${params.space}:${params.request}`;
    // Taken before anything waits, so two calls at once can't both pass.
    if (checking.has(usedKey)) return refuse(403, 'This link has been used. Start again from the app.');
    checking.add(usedKey);
    try {
      if (await get(usedKey)) return refuse(403, 'This link has been used. Start again from the app.');
      const checked = await checkRecord(node, bot, params, disconnect);
      if (checked.ok) await put(usedKey, { at: now() });
      return checked;
    } finally {
      checking.delete(usedKey);
    }
  }

  async function checkRecord(
    node: P2PNode,
    bot: string,
    params: ConnectParams,
    disconnect: boolean,
  ): Promise<{ readonly ok: true; readonly node: P2PNode; readonly writer: string } | Refusal> {
    const record = await arrived(node, params.space, params.request);
    if (!record) return refuse(404, 'The request hasn’t reached the host yet. Try again in a moment.');
    const writer = record.createdBy;
    const body = record.body;
    // The person's own first version, under a note that could do more than write records: not an agent's.
    if (
      !record.verified ||
      record.deleted ||
      record.seq !== 0 ||
      record.recordsOnly ||
      record.collection !== 'std.connect' ||
      !writer ||
      record.root !== writer ||
      !isConnect(body)
    )
      return refuse(403, 'That isn’t a request about this bot.');
    if (body.bot !== bot || body.kind !== 'github' || !!body.disconnect !== disconnect || !body.verifier)
      return refuse(
        403,
        `That isn’t a request to ${disconnect ? 'disconnect' : 'connect'} this bot and GitHub.`,
      );
    const expires = Date.parse(body.expires);
    if (!(expires > now()) || expires > now() + CONNECT_REQUEST_SECONDS * 1000)
      return refuse(403, 'This request has run out. Start again from the app.');
    if (!same(await verifierOf(params.secret), body.verifier))
      return refuse(403, 'This link doesn’t match the request. Start again from the app.');
    if ((await options.isBot?.(writer)) || !(await mayConfigure(node, params.space, bot, writer)))
      return refuse(
        403,
        'Only someone who may instruct this bot, and holds every role it holds, may do that.',
      );
    return { ok: true, node, writer };
  }

  /** The bot says in its own record what it is connected to in a space, where its community sees it */
  async function announce(connection: Connection): Promise<void> {
    const node = await options.botNode(connection.bot);
    await node?.records.put(connection.space, connector, {
      bot: connection.bot,
      kind: 'github',
      account: connection.account,
      repos: [...connection.repos].slice(0, 100),
      by: connection.by,
      since: connection.since,
    });
  }

  /** Forgets a bot's connection in a space, and the bot takes back its record of it */
  async function forget(bot: string, space: string): Promise<void> {
    await store.delete(connectionKey(bot, space));
    const node = await options.botNode(bot);
    if (!node) return;
    const records = await node.records.list(space, { collection: connector.name }).catch(() => []);
    for (const record of records)
      if (record.root === bot && isRecord(record.body) && record.body.kind === 'github')
        await node.records.delete(space, record.key);
  }

  return Object.freeze({
    async start(bot: string, params: ConnectParams) {
      const checked = await check(bot, params, false);
      if (!checked.ok) return checked;
      const random = () =>
        Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const state = random();
      const browser = random();
      const pending: Pending = {
        bot,
        space: params.space,
        by: checked.writer,
        until: now() + STATE_SECONDS * 1000,
        browser: await verifierOf(browser),
      };
      await put(`state:${state}`, pending);
      return {
        ok: true,
        to: github.installUrl(state),
        cookie: { name: cookieName(state), value: browser },
      } as const;
    },

    async finish(params: {
      state: string;
      code: string;
      installation: number;
      cookies: Readonly<Record<string, string>>;
    }) {
      const kept = await get(`state:${params.state}`);
      // One use, whatever happens next.
      await store.delete(`state:${params.state}`);
      if (
        !isRecord(kept) ||
        typeof kept.bot !== 'string' ||
        typeof kept.space !== 'string' ||
        typeof kept.by !== 'string' ||
        typeof kept.until !== 'number' ||
        typeof kept.browser !== 'string' ||
        kept.until < now()
      )
        return refuse(403, 'This link has run out. Start again from the app.');
      // The browser that opened the connect page, not one someone sent GitHub's link to.
      const cookie = params.cookies[cookieName(params.state)];
      if (!cookie || !same(await verifierOf(cookie), kept.browser))
        return refuse(
          403,
          'This was started in another browser. Connect from your Minca app, in this browser.',
        );
      if (!params.code)
        return refuse(
          400,
          'GitHub sent no sign-in. The host’s GitHub App must ask for it during installation.',
        );
      const confirmed = await github.confirm(params.code, params.installation).catch(() => null);
      if (!confirmed)
        return refuse(
          403,
          'Only the GitHub account it was installed on, or an admin of that organisation, may connect it.',
        );
      const node = await options.botNode(kept.bot);
      if (!node) return refuse(404, 'This host runs no such bot.');
      // Asked again: a quarter of an hour may have passed at GitHub.
      if (!(await mayConfigure(node, kept.space, kept.bot, kept.by)))
        return refuse(403, 'You may no longer configure this bot.');

      const connection: Connection = {
        bot: kept.bot,
        space: kept.space,
        installation: params.installation,
        account: confirmed.account,
        repos: await github.repos(params.installation),
        by: kept.by,
        since: new Date(now()).toISOString(),
      };
      await put(connectionKey(kept.bot, kept.space), connection);
      await announce(connection);
      log(`bot ${kept.bot} connected to GitHub ${connection.account} in space ${kept.space}`);
      return { ok: true, connection } as const;
    },

    async disconnect(bot: string, params: ConnectParams) {
      const checked = await check(bot, params, true);
      if (!checked.ok) return checked;
      await forget(bot, params.space);
      log(`bot ${bot} disconnected from GitHub in space ${params.space}`);
      return { ok: true } as const;
    },

    async hook(event: string, payload: unknown) {
      if (!isRecord(payload) || !isRecord(payload.installation)) return 'nothing to do';
      const installation = payload.installation.id;
      if (typeof installation !== 'number') return 'nothing to do';
      const affected = (await connections()).filter((one) => one.installation === installation);
      if (!affected.length) return 'no bot uses that installation';
      // Uninstalled or suspended on GitHub: the bots it reached are connected no more.
      if (event === 'installation' && (payload.action === 'deleted' || payload.action === 'suspend')) {
        for (const one of affected) await forget(one.bot, one.space);
        return `installation ${installation} ${String(payload.action)}: ${affected.length} connection(s) gone`;
      }
      // Repositories added or taken away: what each bot may reach, and says it reaches, follows.
      if (
        event === 'installation_repositories' ||
        (event === 'installation' && payload.action === 'unsuspend')
      ) {
        const repos = new Set(await github.repos(installation));
        for (const one of affected) {
          // Only narrowed: one installation may serve several communities, and what one adds isn't another's.
          const next = { ...one, repos: one.repos.filter((repo) => repos.has(repo)) };
          await put(connectionKey(one.bot, one.space), next);
          await announce(next);
        }
        return `installation ${installation}: ${repos.size} repositories now`;
      }
      return 'nothing to do';
    },

    async connection(bot: string, space: string) {
      const kept = await get(connectionKey(bot, space));
      return isConnection(kept) ? kept : null;
    },

    async usable(bot: string, space: string) {
      const kept = await get(connectionKey(bot, space));
      if (!isConnection(kept)) return null;
      const node = await options.botNode(bot);
      // A read that fails says nothing either way: the bot gets no tools now, and the connection stays.
      const access = node ? await node.spaces.access(space).catch(() => null) : null;
      if (!node || !access) return null;
      const member = access.members.some((m) => m.did === bot && m.roles.length > 0);
      if (member && (await mayConfigure(node, space, bot, kept.by).catch(() => false))) {
        // Someone who may edit others' records could take back what the bot said while it still acts: it says it again.
        const said = (await node.records.list(space, { collection: connector.name }).catch(() => [])).find(
          (record) => record.root === bot && isRecord(record.body) && record.body.kind === 'github',
        );
        const body = isRecord(said?.body) ? said.body : null;
        if (
          !body ||
          body.account !== kept.account ||
          JSON.stringify(body.repos) !== JSON.stringify(kept.repos.slice(0, 100))
        )
          await announce(kept).catch(() => {});
        return kept;
      }
      log(`bot ${bot}'s GitHub connection in space ${space} no longer stands: forgotten`);
      await forget(bot, space).catch(() => store.delete(connectionKey(bot, space)));
      return null;
    },
  });
}
