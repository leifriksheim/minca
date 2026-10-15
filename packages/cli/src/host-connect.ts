/**
 * Connecting a bot a host runs to a service (spec/08-hosting.md §3.1,
 * packages/core/docs/bots.md). Which services, and everything about each, is
 * its connector's (`packages/cli/src/connectors/connector.ts`); this is the
 * exchange with the person's app around them.
 *
 * Someone who may configure the bot writes a `std.connect` in the space with
 * the hash of a secret only their browser holds, and opens the host's connect
 * page with the secret. The host reads the request through the bot, which is
 * a member, and checks it the way any peer would; then sends the browser to
 * the service's consent screen, tied to that browser by a cookie. When it
 * comes back, the connector says what was connected, and the bot says so in
 * its own `std.connector`.
 *
 * Disconnecting is the same request with `disconnect`, checked the same way.
 * A service's own calls (webhooks) may forget a connection, or narrow what it
 * reaches, never widen it.
 */
import type { NodeRecord, P2PNode, StorageAdapter } from '@minca/core';
import { CONNECT_REQUEST_SECONDS, connector, mayConfigure, type Connect } from '@minca/core/schemas';
import type { IncomingMessage } from 'node:http';
import { isRecord } from './json.js';
import type { Connected, HostConnector } from './connectors/connector.js';

/** What a host keeps of a bot's connection to a service, and who made it */
export interface Connection extends Connected {
  readonly bot: string;
  readonly space: string;
  /** The connector's id */
  readonly kind: string;
  readonly by: string;
  readonly since: string;
}

type Refusal = { readonly ok: false; readonly status: number; readonly said: string };
/** Where a browser goes next, or why it can't */
export type ConnectStep =
  | {
      readonly ok: true;
      readonly to: string;
      /** A cookie to set on the browser going to the service, which it must bring back */
      readonly cookie: { readonly name: string; readonly value: string };
    }
  | Refusal;
export type ConnectDone =
  { readonly ok: true; readonly connection: Connection; readonly name: string } | Refusal;

/** What a request names, as the page that opens it passes it on */
export interface ConnectParams {
  readonly space: string;
  readonly request: string;
  readonly secret: string;
}

export interface BotConnect {
  /** The connectors this host offers */
  readonly offered: ReadonlyArray<HostConnector>;
  /** The connect page: checks the request, and answers the service's consent screen */
  start(bot: string, kind: string, params: ConnectParams, callback: string): Promise<ConnectStep>;
  /**
   * The browser back from the service, with the callback's query, and the
   * cookies it brought: only the browser that opened the connect page finishes.
   */
  finish(
    kind: string,
    query: URLSearchParams,
    cookies: Readonly<Record<string, string>>,
    callback: string,
  ): Promise<ConnectDone>;
  /** Disconnects a bot from a service in a space, for a request with `disconnect` */
  disconnect(bot: string, kind: string, params: ConnectParams): Promise<{ readonly ok: true } | Refusal>;
  /** A call from the service itself; null when it isn't the service's, otherwise what the host did */
  hook(kind: string, body: string, headers: IncomingMessage['headers']): Promise<string | null>;
  /** A bot's connection to a service in a space, if it has one */
  connection(bot: string, space: string, kind: string): Promise<Connection | null>;
  /**
   * A bot's connections in a space that still stand: the bot holds a role
   * there and whoever connected each may still configure it. The host forgets
   * one that doesn't, and the bot takes back its record where it can.
   */
  usable(bot: string, space: string): Promise<ReadonlyArray<Connection>>;
}

/** A secret's length at least: 32 bytes, in base64url */
const MIN_SECRET = 43;

/** How long a browser may take at the service's consent screen */
const STATE_SECONDS = 900;

const PREFIX = 'connection:';

/** The cookie that ties the service's return to the browser that left: named for its state, so two at once don't collide */
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
    typeof value.kind === 'string' &&
    typeof value.account === 'string' &&
    Array.isArray(value.reaches) &&
    isRecord(value.data)
  );
}

interface Pending {
  readonly bot: string;
  readonly space: string;
  readonly kind: string;
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
  readonly connectors: ReadonlyArray<HostConnector>;
  /** How long to wait for a request to reach the bot. Default 8 s. */
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}): BotConnect {
  const { store, log } = options;
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 8000;
  const byKind = new Map(options.connectors.map((one) => [one.id, one]));
  /** Requests being checked now: a second call with one waits for nothing, it is refused */
  const checking = new Set<string>();

  const get = async (key: string): Promise<unknown> => {
    const bytes = await store.get(key);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  };
  const put = (key: string, value: unknown) =>
    store.put(key, new TextEncoder().encode(JSON.stringify(value)));
  const connectionKey = (kind: string, bot: string, space: string) => `${PREFIX}${kind}:${bot}:${space}`;
  const connections = async (prefix = PREFIX): Promise<Connection[]> => {
    const found: Connection[] = [];
    for (const key of await store.list(prefix)) {
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
    kind: string,
    params: ConnectParams,
    disconnect: boolean,
  ): Promise<{ readonly ok: true; readonly node: P2PNode; readonly writer: string } | Refusal> {
    if (!byKind.has(kind)) return refuse(404, 'This host connects bots to no such service.');
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
      const checked = await checkRecord(node, bot, kind, params, disconnect);
      if (checked.ok) await put(usedKey, { at: now() });
      return checked;
    } finally {
      checking.delete(usedKey);
    }
  }

  async function checkRecord(
    node: P2PNode,
    bot: string,
    kind: string,
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
    if (body.bot !== bot || body.kind !== kind || !!body.disconnect !== disconnect || !body.verifier)
      return refuse(403, `That isn’t a request to ${disconnect ? 'disconnect' : 'connect'} this bot there.`);
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
      kind: connection.kind,
      account: connection.account,
      reaches: [...connection.reaches].slice(0, 100),
      by: connection.by,
      since: connection.since,
    });
  }

  /** Forgets a bot's connection to a service in a space, and the bot takes back its record of it */
  async function forget(kind: string, bot: string, space: string): Promise<void> {
    await store.delete(connectionKey(kind, bot, space));
    const node = await options.botNode(bot);
    if (!node) return;
    const records = await node.records.list(space, { collection: connector.name }).catch(() => []);
    for (const record of records)
      if (record.root === bot && isRecord(record.body) && record.body.kind === kind)
        await node.records.delete(space, record.key);
  }

  return Object.freeze({
    offered: options.connectors,

    async start(bot: string, kind: string, params: ConnectParams, callback: string) {
      const checked = await check(bot, kind, params, false);
      if (!checked.ok) return checked;
      const random = () =>
        Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      const state = random();
      const browser = random();
      const pending: Pending = {
        bot,
        space: params.space,
        kind,
        by: checked.writer,
        until: now() + STATE_SECONDS * 1000,
        browser: await verifierOf(browser),
      };
      await put(`state:${state}`, pending);
      return {
        ok: true,
        to: byKind.get(kind)!.consentUrl(state, callback),
        cookie: { name: cookieName(state), value: browser },
      } as const;
    },

    async finish(
      kind: string,
      query: URLSearchParams,
      cookies: Readonly<Record<string, string>>,
      callback: string,
    ) {
      const service = byKind.get(kind);
      if (!service) return refuse(404, 'This host connects bots to no such service.');
      const state = query.get('state') ?? '';
      const kept = await get(`state:${state}`);
      // One use, whatever happens next.
      await store.delete(`state:${state}`);
      if (
        !isRecord(kept) ||
        typeof kept.bot !== 'string' ||
        typeof kept.space !== 'string' ||
        kept.kind !== kind ||
        typeof kept.by !== 'string' ||
        typeof kept.until !== 'number' ||
        typeof kept.browser !== 'string' ||
        kept.until < now()
      )
        return refuse(403, 'This link has run out. Start again from the app.');
      // The browser that opened the connect page, not one someone sent the service's link to.
      const cookie = cookies[cookieName(state)];
      if (!cookie || !same(await verifierOf(cookie), kept.browser))
        return refuse(
          403,
          'This was started in another browser. Connect from your Minca app, in this browser.',
        );
      const done = await service.complete(query, callback);
      if ('status' in done) return refuse(done.status, done.said);
      const node = await options.botNode(kept.bot);
      if (!node) return refuse(404, 'This host runs no such bot.');
      // Asked again: a quarter of an hour may have passed at the service.
      if (!(await mayConfigure(node, kept.space, kept.bot, kept.by)))
        return refuse(403, 'You may no longer configure this bot.');

      const connection: Connection = {
        bot: kept.bot,
        space: kept.space,
        kind,
        account: done.account,
        reaches: done.reaches,
        data: done.data,
        by: kept.by,
        since: new Date(now()).toISOString(),
      };
      await put(connectionKey(kind, kept.bot, kept.space), connection);
      await announce(connection);
      log(`bot ${kept.bot} connected to ${service.name} ${connection.account} in space ${kept.space}`);
      return { ok: true, connection, name: service.name } as const;
    },

    async disconnect(bot: string, kind: string, params: ConnectParams) {
      const checked = await check(bot, kind, params, true);
      if (!checked.ok) return checked;
      await forget(kind, bot, params.space);
      log(`bot ${bot} disconnected from ${kind} in space ${params.space}`);
      return { ok: true } as const;
    },

    async hook(kind: string, body: string, headers: IncomingMessage['headers']) {
      const service = byKind.get(kind);
      if (!service?.hook) return null;
      const change = await service.hook(body, headers);
      if (change.kind === 'unsigned') return null;
      if (change.kind === 'nothing') return change.said;
      const affected = (await connections(`${PREFIX}${kind}:`)).filter((one) => change.which(one.data));
      for (const one of affected) {
        if (change.kind === 'forget') {
          await forget(kind, one.bot, one.space);
          continue;
        }
        // Only narrowed: one account at a service may serve several communities, and what one adds isn't another's.
        const reaches = new Set(change.reaches);
        const next = { ...one, reaches: one.reaches.filter((item) => reaches.has(item)) };
        await put(connectionKey(kind, one.bot, one.space), next);
        await announce(next);
      }
      return `${change.said}: ${affected.length} connection(s) ${change.kind === 'forget' ? 'gone' : 'narrowed'}`;
    },

    async connection(bot: string, space: string, kind: string) {
      const kept = await get(connectionKey(kind, bot, space));
      return isConnection(kept) ? kept : null;
    },

    async usable(bot: string, space: string) {
      const kept = (await connections()).filter((one) => one.bot === bot && one.space === space);
      if (!kept.length) return [];
      const node = await options.botNode(bot);
      // A read that fails says nothing either way: the bot gets no tools now, and the connections stay.
      const access = node ? await node.spaces.access(space).catch(() => null) : null;
      if (!node || !access) return [];
      const member = access.members.some((m) => m.did === bot && m.roles.length > 0);
      const said = await node.records.list(space, { collection: connector.name }).catch(() => []);
      const standing: Connection[] = [];
      for (const one of kept) {
        if (member && (await mayConfigure(node, space, bot, one.by).catch(() => false))) {
          // Someone who may edit others' records could take back what the bot said while it still acts: it says it again.
          const record = said.find((r) => r.root === bot && isRecord(r.body) && r.body.kind === one.kind);
          const body = isRecord(record?.body) ? record.body : null;
          if (
            !body ||
            body.account !== one.account ||
            JSON.stringify(body.reaches) !== JSON.stringify(one.reaches.slice(0, 100))
          )
            await announce(one).catch(() => {});
          standing.push(one);
          continue;
        }
        log(`bot ${bot}'s ${one.kind} connection in space ${space} no longer stands: forgotten`);
        await forget(one.kind, bot, space).catch(() => store.delete(connectionKey(one.kind, bot, space)));
      }
      return standing;
    },
  });
}
