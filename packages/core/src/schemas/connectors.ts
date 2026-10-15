/**
 * Connectors: a bot reaching a service outside the space for its community,
 * GitHub first. Someone who may configure the bot asks with a `std.connect`;
 * the bot's host checks it, sends them through the service's own consent
 * screen, and the bot says what is connected in its own `std.connector`.
 *
 * No secret is kept here. The host holds what reaches the service; a
 * `std.connect` carries only the hash of a secret the asker's browser keeps.
 *
 * Not protocol for peers: a peer that has never heard of connectors syncs and
 * judges these records like any other. What a host checks of a `std.connect`
 * is in spec/08-hosting.md §3; see `packages/core/docs/bots.md`.
 */
import type { BodyOf } from '../query/types.js';
import type { P2PNode } from '../node/types.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { define, person, text, when, words } from './fragments.js';
import { INSTRUCT } from './automations.js';

/**
 * Whether `who` may configure `bot` in a space: tell it what to do, give it
 * instructions, connect it to a service. Not the bot itself; someone who
 * holds the grant to instruct bots and every role the bot holds, so nobody
 * reaches past their own grants through it. Asked of `node`'s view of the space; a bot, its host and an app
 * all ask this one.
 */
export async function mayConfigure(node: P2PNode, space: string, bot: string, who: string): Promise<boolean> {
  // Never the bot itself: one steered run could otherwise leave itself instructions that count.
  if (who === bot) return false;
  if (!(await node.spaces.may(space, INSTRUCT, {}, who).catch(() => false))) return false;
  return holdsBotRoles(node, space, bot, who);
}

/** Whether `who` holds every role `bot` holds in a space */
export async function holdsBotRoles(
  node: P2PNode,
  space: string,
  bot: string,
  who: string,
): Promise<boolean> {
  const { members } = await node.spaces.access(space);
  const roles = members.find((member) => member.did === bot)?.roles ?? [];
  for (const role of roles) if (!(await node.spaces.holdsRole(space, role, who))) return false;
  return true;
}

/** The services a bot may be connected to */
export const CONNECTOR_KINDS = ['github'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** How long a request may stand, from when it was written: long enough for a consent screen */
export const CONNECT_REQUEST_SECONDS = 600;

/**
 * Someone asking to connect a bot to a service, or to disconnect it. Counts
 * only when its writer may configure the bot; its host checks that.
 */
export const connect = define({
  name: 'std.connect',
  title: 'Connect request',
  description: 'Someone asking to connect a bot to a service, or to disconnect it.',
  schema: {
    type: 'object',
    properties: {
      bot: person('The bot to connect'),
      kind: { type: 'string', enum: [...CONNECTOR_KINDS] },
      verifier: text(64, 'base64url(SHA-256(secret)): the secret stays in the asker’s browser', 43),
      expires: when('After this it counts for nothing'),
      disconnect: { type: 'boolean' },
    },
    required: ['bot', 'kind', 'expires'],
  },
});
export type Connect = BodyOf<typeof connect>;

/** What a bot is connected to, in its own words: an app shows one only when the bot wrote it */
export const connector = define({
  name: 'std.connector',
  title: 'Connector',
  description: 'A service a bot is connected to, said by the bot.',
  schema: {
    type: 'object',
    properties: {
      bot: person('The bot, which writes this'),
      kind: { type: 'string', enum: [...CONNECTOR_KINDS] },
      account: words(100, 'Whose account at the service: a GitHub user or organisation'),
      repos: { type: 'array', items: words(200), maxItems: 100 },
      by: person('Who connected it'),
      since: when(),
    },
    required: ['bot', 'kind', 'account', 'by', 'since'],
  },
  rules: { onePer: ['@author', 'kind'] },
});
export type Connector = BodyOf<typeof connector>;

/** The most a bot's instructions may say, in characters */
export const BOT_INSTRUCTIONS_MAX = 2000;

/**
 * How a community wants its bot to be: a name to go by, a tone, what to know.
 * Read into the bot's system prompt after its fixed rules, so it can't undo
 * them, and only from someone who may configure the bot. One per writer, so
 * nobody's words overwrite another's; the bot takes the newest that counts.
 */
export const botSettings = define({
  name: 'std.bot',
  title: 'Bot',
  description: 'How a community wants its bot to be, in the words of someone who may configure it.',
  schema: {
    type: 'object',
    properties: {
      bot: person('The bot'),
      instructions: text(BOT_INSTRUCTIONS_MAX, 'What the bot is told, after its own rules'),
    },
    required: ['bot', 'instructions'],
  },
  rules: { onePer: ['@author', 'bot'] },
});
export type BotSettings = BodyOf<typeof botSettings>;

/** A request written, and the secret that goes with it: kept by the asker, never written down */
export interface ConnectAsk {
  readonly space: string;
  readonly bot: string;
  readonly request: string;
  readonly secret: string;
}

/**
 * Writes a request to connect a bot to a service, or with `disconnect` to
 * disconnect it, for the bot's host to check. The secret it returns is for
 * the host's page alone: it is the only proof the request is the asker's.
 */
export async function askToConnect(
  node: P2PNode,
  space: string,
  bot: string,
  options: { readonly kind?: ConnectorKind; readonly disconnect?: boolean } = {},
): Promise<ConnectAsk> {
  const secret = base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  // A little under the most a host takes, for clocks that differ.
  const expires = new Date(Date.now() + (CONNECT_REQUEST_SECONDS - 60) * 1000).toISOString();
  const record = await node.records.put(space, connect, {
    bot,
    kind: options.kind ?? 'github',
    verifier: base64UrlEncode(new Uint8Array(hash)),
    expires,
    ...(options.disconnect ? { disconnect: true } : {}),
  });
  return { space, bot, request: record.key, secret };
}

/** The host's page that connects a bot, for a request `askToConnect` wrote */
export function connectPage(hostUrl: string, ask: ConnectAsk, kind: ConnectorKind = 'github'): string {
  const query = new URLSearchParams({ space: ask.space, request: ask.request, secret: ask.secret });
  return `${hostUrl.replace(/\/+$/, '')}/host/bots/${encodeURIComponent(ask.bot)}/connect/${kind}?${query}`;
}

/** Asks a bot's host to disconnect it, for a request `askToConnect` wrote with `disconnect` */
export async function askToDisconnect(
  hostUrl: string,
  ask: ConnectAsk,
  kind: ConnectorKind = 'github',
): Promise<void> {
  const res = await fetch(
    `${hostUrl.replace(/\/+$/, '')}/host/bots/${encodeURIComponent(ask.bot)}/disconnect/${kind}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ space: ask.space, request: ask.request, secret: ask.secret }),
    },
  );
  if (!res.ok) {
    const answer: unknown = await res.json().catch(() => null);
    throw new Error(
      typeof answer === 'object' && answer !== null && 'error' in answer && typeof answer.error === 'string'
        ? answer.error
        : `The host answered ${res.status}`,
    );
  }
}
