/**
 * A service a host connects its bots to: GitHub, a calendar, a drive. Each
 * host offers the ones it likes; the app shows what the host names in its
 * description, and opens the host's pages for the one chosen. Everything
 * about the service, its consent screen, what the host keeps and what the bot
 * may do there, is here; the exchange with the app around it is the host's
 * (packages/cli/src/host-connect.ts, spec/08-hosting.md §3.1).
 */
import type { IncomingMessage } from 'node:http';
import type { ChatTool } from '../agent-chat.js';

/** What a connection reached, as the service gave it */
export interface Connected {
  /** Whose account at the service, as people read it: a GitHub organisation, an email address */
  readonly account: string;
  /** What it reaches, as people read it: repositories, calendars, folders */
  readonly reaches: ReadonlyArray<string>;
  /** What the connector keeps to act on it later: an installation id, a refresh token. Never shown. */
  readonly data: Readonly<Record<string, unknown>>;
}

/** A refusal, for the page the person sees */
export interface Refused {
  readonly status: number;
  readonly said: string;
}

/** What a call from the service itself says changed, for the connections it names */
export type ServiceChange =
  /** Not the service's: refused */
  | { readonly kind: 'unsigned' }
  | { readonly kind: 'nothing'; readonly said: string }
  /** These connections are gone, as an uninstall says */
  | {
      readonly kind: 'forget';
      readonly which: (data: Readonly<Record<string, unknown>>) => boolean;
      readonly said: string;
    }
  /**
   * These connections now reach at most this: a host only ever narrows what
   * a connection reaches, as one account at a service may serve several communities.
   */
  | {
      readonly kind: 'reaches';
      readonly which: (data: Readonly<Record<string, unknown>>) => boolean;
      readonly reaches: ReadonlyArray<string>;
      readonly said: string;
    };

export interface HostConnector {
  /** Its name in addresses and records: lowercase letters, digits and dashes */
  readonly id: string;
  /** Its name for people */
  readonly name: string;
  /**
   * Where the browser goes to consent. It must come back to `callback`,
   * `<host>/host/connect/<id>/callback`, with `state`.
   */
  consentUrl(state: string, callback: string): string;
  /**
   * The browser back from consenting, with the callback's query: what was
   * connected, or why not. The host has checked the state and the browser.
   */
  complete(query: URLSearchParams, callback: string): Promise<Connected | Refused>;
  /**
   * The bot's tools on a connection: writing only with `mayWrite`. Each call
   * to the service takes one from `budget`, the bot's for the day, and fails
   * once it says no.
   */
  tools(
    connection: Connected,
    options: { readonly mayWrite: boolean; readonly budget: () => boolean },
  ): ReadonlyArray<ChatTool>;
  /** A call from the service itself, to `<host>/host/connect/<id>/hook`, if it makes any */
  hook?(body: string, headers: IncomingMessage['headers']): Promise<ServiceChange>;
}

/** Whether a connector's id fits in an address and a record */
export const isConnectorId = (id: string) => /^[a-z0-9-]{1,40}$/.test(id);

/** Calls a bot may make to its services a day, across its spaces: enough for work, not for a loop */
const DAILY_CALLS = 200;

/** Counts a bot's calls to its services for the day; false once there are none left */
export function dailyBudget(limit = DAILY_CALLS, now: () => number = Date.now): () => boolean {
  let day = '';
  let used = 0;
  return () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) [day, used] = [today, 0];
    if (used >= limit) return false;
    used++;
    return true;
  };
}
