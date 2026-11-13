/**
 * The account's own automations: "let me know when…", across its spaces.
 *
 * Kept in the account registry (`sys.automation`) rather than a space, one
 * is the account's alone, and looks at the spaces it names, or all of them.
 * It only notifies: new records of one collection, perhaps only those a
 * filter matches. Automations that act in a space are `std.automation`, in
 * `@minca/std`, and nothing here knows them.
 *
 * Only an app proposes them (`AutomationProposal`), when the person asks; the
 * home writes them into the registry once the person says yes.
 */
import type { Link } from '../types.js';
import { checkFilter, matches } from '../query/filter.js';
import type { Filter } from '../query/types.js';
import { COLLECTION_NAME, schemaProblem, type JsonSchema } from '../schema/collection-def.js';
import { isObject } from '../utils/guards.js';

/** In a filter, whoever it is read for: the account, for one of its own automations */
export const ME = '$me';

/** `$me` wherever it is a value, as the account the filter is read for */
export function asRunner<T>(value: T, me: string): T {
  // eslint-disable-next-line typescript/consistent-type-assertions -- the same shape, with one string swapped for another
  return JSON.parse(JSON.stringify(value), (_key, found: unknown) => (found === ME ? me : found)) as T;
}

/** The record fields an account's own automation may read besides the body: what an app sees of any record */
const WHERE_FIELDS = ['@key', '@collection', '@createdBy', '@createdAt'];

/** What an account's own automation finds: new records of one collection, perhaps only those `where` matches */
export interface OwnQuery {
  readonly collection: string;
  readonly where?: Filter;
}

/** Every space of the account, or these */
export type AutomationSpaces = 'all' | ReadonlyArray<string>;

/** The app that proposed an account's own automation, by the origin the browser reported */
export interface AutomationApp {
  readonly origin: string;
  /** What the app called itself. Shown, never trusted. */
  readonly name?: string;
}

/** One of the account's own automations, as its registry keeps it */
export interface OwnAutomation {
  /** What people call it */
  readonly name: string;
  /** The records that set it off; with `others`, only ones someone else wrote */
  readonly when: { readonly query: OwnQuery; readonly others?: boolean };
  /** What the notification says */
  readonly then: { readonly kind: 'notify'; readonly text: string };
  /** The spaces it looks at */
  readonly spaces: AutomationSpaces;
  /** Where clicking its notification goes: an app's `https://` address. Default: the account home. */
  readonly open?: string;
  /** The app that proposed it. Absent: the person made it themselves. */
  readonly app?: AutomationApp;
  /** Kept, but not on */
  readonly paused?: boolean;
  /** Nothing written before this sets it off */
  readonly since: string;
}

const said = (max: number): JsonSchema => ({ type: 'string', pattern: '\\S', maxLength: max });

const OWN_AUTOMATION: JsonSchema = {
  type: 'object',
  properties: {
    name: said(120),
    when: {
      type: 'object',
      properties: { query: { type: 'object' }, others: { type: 'boolean' } },
      required: ['query'],
      additionalProperties: false,
    },
    then: {
      type: 'object',
      properties: { kind: { const: 'notify' }, text: said(500) },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    spaces: {
      anyOf: [{ const: 'all' }, { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } }],
    },
    open: { type: 'string', maxLength: 2000 },
    app: {
      type: 'object',
      properties: { origin: { type: 'string', maxLength: 200 }, name: { type: 'string', maxLength: 80 } },
      required: ['origin'],
      additionalProperties: false,
    },
    paused: { type: 'boolean' },
    since: { type: 'string' },
  },
  required: ['name', 'when', 'then', 'spaces', 'since'],
  additionalProperties: false,
};

/** Why this can't be one of the account's own automations, or null */
export function checkOwnAutomation(value: unknown): string | null {
  const shape = schemaProblem(OWN_AUTOMATION, value, 'automation');
  if (shape || !isObject(value)) return shape ?? 'An automation must be an object';
  if (!Number.isFinite(Date.parse(String(value.since)))) return 'since must be a date';
  if (value.open !== undefined && !isWebAddress(value.open)) return 'open must be an https:// address';
  if (isObject(value.app) && !isOrigin(value.app.origin)) return 'app.origin must be a web origin';
  return checkOwnQuery(isObject(value.when) ? value.when.query : undefined);
}

/** Why a query can't be an account's own automation's, or null: one collection, and a filter over each record alone */
function checkOwnQuery(query: unknown): string | null {
  if (!isObject(query)) return 'when.query must be an object';
  const stray = Object.keys(query).find((key) => key !== 'collection' && key !== 'where');
  if (stray !== undefined)
    return `when.query.${stray}: an automation of the account’s own reads only collection and where`;
  if (typeof query.collection !== 'string' || !COLLECTION_NAME.test(query.collection))
    return 'when.query.collection must be a collection name';
  if (query.collection.startsWith('sys.'))
    return 'when.query.collection must be one of the space’s collections';
  if (query.where === undefined) return null;
  return checkFilter(query.where, 'when.query.where', { meta: WHERE_FIELDS });
}

/** An https:// address, or http:// on this machine */
function isWebAddress(value: unknown): boolean {
  const url = parseUrl(value);
  return url?.protocol === 'https:' || (url?.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname));
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** A browser extension's origin, which `URL` gives none */
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]{1,64}$/i;

/** `https://chat.example`, nothing after it: what a browser reports as a message's origin */
function isOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return EXTENSION_ORIGIN.test(value) || parseUrl(value)?.origin === value;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * What an app says is worth hearing about, before anyone has picked spaces or
 * where a click goes: an automation it offers. Whoever shows the app proposes
 * it, as an {@link AutomationProposal} of its own, when the person asks.
 * `$me` in its `where` stands for the account, which the app may not know.
 */
export interface AppAutomation {
  readonly name: string;
  readonly when: { readonly query: OwnQuery; readonly others?: boolean };
  /** What the notification says. Default: its name. */
  readonly then?: { readonly kind: 'notify'; readonly text: string };
}

/**
 * An automation an app asks for. It looks at the spaces the app may reach —
 * every space for a whole-account app, else the spaces it was given — or at
 * `spaces`, some of those.
 */
export interface AutomationProposal extends AppAutomation {
  /** Only these of the spaces the app may reach. Default: all of them. */
  readonly spaces?: ReadonlyArray<string>;
  /** Must be on the app's own origin. Default: the app's origin. */
  readonly open?: string;
}

/**
 * An automation an app offers: new records in a collection, perhaps only
 * those `where` matches. `notifyOn('Mentions me', 'std.message', { mentions: { $contains: '$me' } })`
 */
export function notifyOn(name: string, collection: string, where?: Filter): AppAutomation {
  return { name, when: { query: { collection, ...(where ? { where } : {}) } } };
}

/** How many automations an app may propose at once */
export const MAX_PROPOSALS = 8;

/** Why an app's offered automation can't be offered, or null */
export function checkAppAutomation(value: unknown): string | null {
  if (!isObject(value)) return 'Each automation an app offers must be an object';
  if ('spaces' in value || 'open' in value)
    return 'An automation an app offers leaves out spaces and open: the app that shows it decides those';
  return checkProposal(value);
}

/**
 * Why an app's proposal can't be offered, or null. `origin` is the app's, as
 * the browser reported it: a click may only lead back to the app that asked.
 * Without it, only what the proposal says is checked.
 */
export function checkProposal(proposal: unknown, origin?: string): string | null {
  if (!isObject(proposal)) return 'A proposed automation must be an object';
  const stray = Object.keys(proposal).find((field) => !PROPOSAL_FIELDS.includes(field));
  if (stray !== undefined) return `proposal.${stray}: a proposal has name, when, then, spaces and open`;
  if (proposal.spaces !== undefined && !Array.isArray(proposal.spaces))
    return 'proposal.spaces must be a list';
  const problem = checkOwnAutomation(withDefaults(proposal));
  if (problem) return problem;
  const { open } = proposal;
  if (origin === undefined || typeof open !== 'string') return null;
  return new URL(open).origin === origin ? null : 'open must be an address on the app’s own site';
}

const PROPOSAL_FIELDS = ['name', 'when', 'then', 'spaces', 'open'];

/** A proposal as the automation it would become, with what it leaves out filled in */
function withDefaults(proposal: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const name = typeof proposal.name === 'string' ? proposal.name.trim() : proposal.name;
  const when = isObject(proposal.when) ? proposal.when : {};
  return {
    name,
    when: { ...when, others: when.others ?? true },
    then: proposal.then ?? { kind: 'notify', text: name },
    spaces: proposal.spaces ?? 'all',
    ...(proposal.open !== undefined ? { open: proposal.open } : {}),
    since: new Date(0).toISOString(),
  };
}

/** How long after it was written a record may still notify: a node catching up on last week stays quiet */
const NOTIFY_WITHIN_MS = 24 * 60 * 60 * 1000;

/** It is on, looks at the space, and the record is new enough */
function inWindow(
  own: { readonly paused?: boolean; readonly spaces?: AutomationSpaces; readonly since: string },
  space: string,
  createdAt: string,
  now: number,
): boolean {
  const spaces = own.spaces ?? 'all';
  if (own.paused || (spaces !== 'all' && !spaces.includes(space))) return false;
  const written = Date.parse(createdAt);
  return Number.isFinite(written) && written >= Date.parse(own.since) && now - written <= NOTIFY_WITHIN_MS;
}

/** What an app sees of a record, enough to match an automation: its outside and, where it can open it, its body */
export interface ReadableRecord {
  readonly key: string;
  readonly space: string;
  readonly collection: string;
  readonly createdAt: string;
  /** Who created it: the account, not the key that signed */
  readonly createdBy: string | null;
  readonly body: unknown;
  /** What it points at, for a `where` that reads `links` */
  readonly links?: ReadonlyArray<Link>;
  readonly verified: boolean;
  readonly deleted?: true;
  /** Its collection's computed fields, as a query works them out, for a `where` that names one */
  readonly computed?: Readonly<Record<string, unknown>>;
}

/** What was written that set a notification off: the record itself, or something its computed fields read */
export interface Trigger {
  readonly createdAt: string;
  /** Who wrote it: the account, not the key that signed */
  readonly createdBy: string | null;
}

/**
 * Whether one of the account's own automations holds for a record: it is in
 * the collection, and `where` holds of its body and computed fields. The app
 * can read, so this is judged on the body.
 */
export function holdsFor(own: OwnAutomation, record: ReadableRecord, account: string): boolean {
  const { collection, where } = own.when.query;
  if (!record.verified || record.deleted || record.collection !== collection) return false;
  if (where === undefined) return true;
  return matches(
    {
      key: record.key,
      collection: record.collection,
      body: record.body,
      links: record.links ?? [],
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      ...(record.computed ? { computed: record.computed } : {}),
    },
    asRunner(where, account),
  );
}

/**
 * Whether what was written may set one of the account's own automations off
 * in a space: it is on, looks there, the writing is new enough, and, with
 * `others`, someone else's. A carrier checks the same of a record's outside.
 */
export function setsOff(
  own: OwnAutomation,
  space: string,
  trigger: Trigger,
  account: string,
  now = Date.now(),
): boolean {
  if (!inWindow(own, space, trigger.createdAt, now)) return false;
  return !(own.when.others && trigger.createdBy === account);
}

/** Whether a new record an app just saw is one an automation of the account's own asks about */
export function matchesRecord(
  own: OwnAutomation,
  record: ReadableRecord,
  account: string,
  now = Date.now(),
): boolean {
  return holdsFor(own, record, account) && setsOff(own, record.space, record, account, now);
}

/**
 * The collection the account's own automations are kept in, in its registry:
 * a system one, which nothing defines, so no other key of the account can
 * redefine it to lock the person out of pausing or removing one.
 */
export const OWN_AUTOMATIONS = 'sys.automation';
