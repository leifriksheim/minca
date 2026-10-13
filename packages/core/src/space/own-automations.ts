/**
 * The account's own automations: "let me know when…", across its spaces,
 * noticed by nodes that can't read.
 *
 * An automation kept in the account registry instead of a space — the body
 * of a `std.automation` (`schemas/automations.ts`), in `sys.automation` — is
 * the account's alone: nobody else sees it, and it looks at the spaces it
 * names, or all of them. For now
 * it only notifies: new records a query finds in those spaces, perhaps only
 * other people's. Not protocol: a peer that has never heard of it syncs and
 * judges it like any other record (docs/automations.md).
 *
 * The account's carriers — its extension, its hosts — are the ones online to
 * notice, and they can't read. So every device holding the account key copies
 * each one into each carry space as a **wake** (`sys.wake`): the collection,
 * the spaces, and the tags of the topic values its `where` asks for, never the
 * values. A carrier learns "tag X, in Club", never what X stands for, and can
 * match arriving records on their outside — what it needs to wake an app that
 * is closed. That much is protocol (spec 03 §15).
 *
 * Only an app proposes them (`AutomationProposal`), when the person asks it
 * to — "Notify me" — as a node already connected (`proposeToHome`); never
 * while connecting, and never a carrier or the home on its own. The person
 * says yes to each on the home's approval screen, and the home writes them
 * into the registry naming the app — the app never writes there itself. In
 * the home they can pause or remove them, not add any.
 *
 * The app that asked shows the notifications: an app given the whole account
 * reads the registry and matches what it sees arrive (`matchesRecord`,
 * `node/watch-notifications.ts`), with the body in hand.
 */
import type { Version, Link } from '../types.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import { parseDelegation } from '../identity/ucan.js';
import { topicKey, topicTag } from '../records/topics.js';
import { checkFilter, matches } from '../query/filter.js';
import { nameOf, type Filter } from '../query/types.js';
import { canonicalize } from '../schema/version.js';
import { COLLECTION_NAME, schemaProblem, type JsonSchema } from '../schema/collection-def.js';
import {
  asRunner,
  checkAutomation,
  type Automation,
  type AutomationApp,
  type AutomationSpaces,
} from '../schemas/automations.js';
import { isObject } from '../utils/guards.js';

/** Wakes, as a carrier holds them in its carry space: key `wake:<the automation's key>` */
export const WAKE_COLLECTION = 'sys.wake';

/** The record fields an account's own automation may read besides the body: what an app sees of any record */
const WHERE_FIELDS = ['@key', '@collection', '@createdBy', '@createdAt'];

/** What an account's own automation finds: new records of one collection, perhaps only those `where` matches */
export interface OwnQuery {
  readonly collection: string;
  readonly where?: Filter;
}

/** Why this can't be one of the account's own automations, or null */
export function checkOwnAutomation(value: unknown): string | null {
  const problem = checkAutomation(value);
  if (problem) return problem;
  if (!isObject(value) || !isObject(value.when) || !isObject(value.then)) return 'An automation needs a when';
  if (value.then.kind !== 'notify') return 'An automation of the account’s own only notifies, for now';
  if (value.every !== undefined || value.by !== undefined)
    return 'An automation of the account’s own runs on new records, by the account';
  if (value.spaces === undefined) return 'spaces must be "all" or a list of spaces';
  if (value.when.holds !== undefined || value.when.from !== undefined)
    return 'An automation of the account’s own reads each record alone: no holds, no from';
  return checkOwnQuery(value.when.query);
}

/** Why a query can't be an account's own automation's, or null: one collection, and a filter over each record alone */
function checkOwnQuery(query: unknown): string | null {
  if (!isObject(query)) return 'when.query must be an object';
  for (const key of Object.keys(query))
    if (key !== 'collection' && key !== 'where')
      return `when.query.${key}: an automation of the account’s own reads only collection and where`;
  if (typeof query.collection !== 'string' || !COLLECTION_NAME.test(query.collection))
    return 'when.query.collection must be a collection name';
  if (query.collection.startsWith('sys.'))
    return 'when.query.collection must be one of the space’s collections';
  if (query.where === undefined) return null;
  return checkFilter(query.where, 'when.query.where', { meta: WHERE_FIELDS });
}

/** The collection and filter an account's own automation reads */
export function ownQuery(own: Automation): OwnQuery {
  const query = own.when?.query;
  return {
    collection: query ? nameOf(query.collection) : '',
    ...(query?.where !== undefined ? { where: query.where } : {}),
  };
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

/** Whether an offered automation is about records that name the person: its `where` reads `$me` */
export const namesTheRunner = (own: Pick<AppAutomation, 'when'>): boolean =>
  JSON.stringify(own.when.query.where ?? null).includes('"$me"');

/** At most this many proposals in one request */
export const MAX_PROPOSALS = 8;

const PROPOSAL: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    when: {
      type: 'object',
      properties: { query: { type: 'object' }, others: { type: 'boolean' } },
      required: ['query'],
      additionalProperties: false,
    },
    then: {
      type: 'object',
      properties: { kind: { const: 'notify' }, text: { type: 'string' } },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    spaces: { type: 'array', items: { type: 'string' } },
    open: { type: 'string' },
  },
  required: ['name', 'when'],
  additionalProperties: false,
};

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
  const shape = schemaProblem(PROPOSAL, proposal, 'proposal');
  if (shape || !isObject(proposal)) return shape ?? 'A proposed automation must be an object';
  const p = proposal;
  const when = isObject(p.when) ? p.when : {};
  const name = typeof p.name === 'string' ? p.name.trim() : p.name;
  // What it would become, with the defaults the home fills in: checked as the account's own.
  const candidate = {
    name,
    when: { query: when.query, others: when.others ?? true },
    then: p.then ?? { kind: 'notify', text: name },
    spaces: p.spaces ?? 'all',
    ...(p.open !== undefined ? { open: p.open } : {}),
    since: new Date(0).toISOString(),
  };
  const problem = checkOwnAutomation(candidate);
  if (problem) return problem;
  if (origin === undefined) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- checkOwnAutomation has passed it as a web address, the way URL reads it
  if (p.open !== undefined && new URL(String(p.open)).origin !== origin)
    return 'open must be an address on the app’s own site';
  return null;
}

/**
 * The spaces a proposal looks at, given the ones the app may reach; null when
 * it names one outside them.
 */
export function proposalSpaces(
  proposal: AutomationProposal,
  reach: AutomationSpaces,
): AutomationSpaces | null {
  if (!proposal.spaces) return reach;
  if (reach !== 'all' && proposal.spaces.some((id) => !reach.includes(id))) return null;
  return [...new Set(proposal.spaces)];
}

/** The automation a proposal becomes, once the person says yes to it */
export function fromProposal(
  proposal: AutomationProposal,
  context: { readonly app: AutomationApp; readonly spaces: AutomationSpaces; readonly since?: string },
): Automation {
  const name = typeof proposal.name === 'string' ? proposal.name.trim() : proposal.name;
  const own: Automation = {
    name,
    when: { query: proposal.when?.query, others: proposal.when?.others ?? true },
    then: proposal.then ?? { kind: 'notify', text: name },
    spaces: context.spaces,
    open: proposal.open ?? `${context.app.origin}/`,
    since: context.since ?? new Date().toISOString(),
    app: context.app,
  };
  // An app on plain http elsewhere than this machine: a click goes to the home instead.
  if (checkOwnAutomation(own) === null || proposal.open !== undefined) return own;
  const { open: _open, ...rest } = own;
  return rest;
}

/** Whether two of the account's automations ask about the same thing: an app connecting again adds nothing twice */
export function sameAutomation(a: Automation, b: Automation): boolean {
  const spaces = (s: AutomationSpaces | undefined) =>
    s === undefined || s === 'all' ? 'all' : [...s].sort().join(',');
  return (
    canonicalize(ownQuery(a)) === canonicalize(ownQuery(b)) &&
    spaces(a.spaces) === spaces(b.spaces) &&
    (a.when?.others ?? false) === (b.when?.others ?? false) &&
    canonicalize(a.then) === canonicalize(b.then)
  );
}

/** A space the account follows, as far as a wake needs: its id, its current key when private, and the topics it declares */
export interface WakeSpace {
  readonly id: string;
  readonly key: SpaceKey | null;
  readonly visibility: 'public' | 'private';
  /** The topic fields a collection declares in this space */
  readonly topics: (collection: string) => ReadonlyArray<string>;
}

/** At most this many tags a wake holds for one space; a `where` that names more values wakes on any record there */
const MAX_WAKE_TAGS = 16;

/** An automation as a carrier holds it: no values, only tags */
export interface Wake {
  readonly v: 1;
  readonly collection: string;
  readonly spaces: AutomationSpaces;
  /**
   * Per space: a record matches only when it carries one of these. A space
   * with no entry: any record of the collection.
   */
  readonly tags?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly others: boolean;
  readonly open?: string;
  readonly paused: boolean;
  readonly since: string;
}

/**
 * The topic values a filter requires of a declared topic field: the first
 * condition on one that names values — `field: v`, `$eq`, `$contains` or
 * `$in` — at its top or in an `$and` there. Those all hold, so a record the
 * filter matches carries a tag for one of these values.
 */
function requiredValues(
  where: Filter | undefined,
  topics: ReadonlyArray<string>,
): { field: string; values: Array<string | number | boolean> } | null {
  if (!where) return null;
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  for (const [field, condition] of Object.entries(where)) {
    if (field === '$and' && Array.isArray(condition)) {
      for (const part of condition) {
        const found = isObject(part) ? requiredValues(part, topics) : null;
        if (found) return found;
      }
      continue;
    }
    if (field.startsWith('$') || !topics.includes(field)) continue;
    if (scalar(condition)) return { field, values: [condition] };
    if (!isObject(condition)) continue;
    if (scalar(condition.$eq)) return { field, values: [condition.$eq] };
    if (scalar(condition.$contains)) return { field, values: [condition.$contains] };
    if (Array.isArray(condition.$in) && condition.$in.length > 0 && condition.$in.every(scalar))
      return { field, values: condition.$in };
  }
  return null;
}

/**
 * What a carrier gets: the automation, with each value its `where` requires
 * of a topic replaced by the space's tag for it. A private space whose key
 * this device doesn't hold gets an empty list, so it never matches — better
 * quiet than wrong. A space where `where` names no topic gets no entry: every
 * new record wakes, and the app turns down what `where` doesn't match.
 */
export async function wakeFor(
  own: Automation,
  spaces: ReadonlyArray<WakeSpace>,
  account: string,
): Promise<Wake> {
  const { collection, where } = ownQuery(own);
  const resolved = where === undefined ? undefined : asRunner(where, account);
  const only = own.spaces ?? 'all';
  const looked = only === 'all' ? spaces : spaces.filter((s) => only.includes(s.id));
  const tags: Record<string, string[]> = {};
  for (const space of looked) {
    // Without its key a device can read neither the space's records nor its topics: never wake there.
    if (space.visibility === 'private' && !space.key) {
      tags[space.id] = [];
      continue;
    }
    const required = requiredValues(resolved, space.topics(collection));
    if (!required || new Set(required.values).size > MAX_WAKE_TAGS) continue;
    const key = await topicKey(
      space.visibility === 'private' ? { spaceKey: space.key!.raw } : { spaceId: space.id },
    );
    tags[space.id] = await Promise.all(
      [...new Set(required.values)].map((value) => topicTag(key, collection, required.field, value)),
    );
  }
  return {
    v: 1,
    collection,
    spaces: only,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    others: own.when?.others ?? false,
    ...(own.open ? { open: own.open } : {}),
    paused: own.paused ?? false,
    since: own.since,
  };
}

const WAKE: JsonSchema = {
  type: 'object',
  properties: {
    v: { const: 1 },
    collection: { type: 'string', pattern: COLLECTION_NAME.source },
    spaces: {
      anyOf: [{ const: 'all' }, { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } }],
    },
    tags: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        maxItems: MAX_WAKE_TAGS,
        items: { type: 'string', maxLength: 64 },
      },
    },
    others: { type: 'boolean' },
    open: { type: 'string' },
    paused: { type: 'boolean' },
    since: { type: 'string' },
  },
  required: ['v', 'collection', 'spaces', 'others', 'paused', 'since'],
};

/** A wake as read back from a carry space, or null when it isn't one */
export function readWake(body: unknown): Wake | null {
  if (schemaProblem(WAKE, body) !== null || !isObject(body)) return null;
  if (String(body.collection).startsWith('sys.') || !Number.isFinite(Date.parse(String(body.since))))
    return null;
  // eslint-disable-next-line typescript/consistent-type-assertions -- checked against WAKE just above
  return body as unknown as Wake;
}

/** Who a version was written for: the account that issued its note, else its own key */
function rootOf(version: Version): string {
  if (!version.proof) return version.author;
  return parseDelegation(version.proof)?.payload.iss ?? version.author;
}

/** How long after it was written a record may still notify: a carrier catching up on last week stays quiet */
const NOTIFY_WITHIN_MS = 24 * 60 * 60 * 1000;

/** What a carrier and an app both check: it is on, looks at the space, and the record is new enough */
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

/**
 * Whether a record that just arrived in a space is one a wake asks about —
 * decided from its outside alone.
 */
export function wakes(
  wake: Wake,
  spaceId: string,
  version: Version,
  account: string,
  now = Date.now(),
): boolean {
  if (version.collection !== wake.collection || version.seq !== 0 || version.deleted) return false;
  if (!inWindow(wake, spaceId, version.createdAt, now)) return false;
  if (wake.others && rootOf(version) === account) return false;
  const wanted = wake.tags?.[spaceId];
  if (wanted && !version.tags?.some((tag) => wanted.includes(tag))) return false;
  return true;
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
}

/**
 * Whether a record an app just saw is one of the account's own automations
 * asks about. The app can read, so `where` is judged on the body: never
 * fewer records than a carrier's wake lets through, only fewer.
 */
export function matchesRecord(
  own: Automation,
  record: ReadableRecord,
  account: string,
  now = Date.now(),
): boolean {
  const { collection, where } = ownQuery(own);
  if (!record.verified || record.deleted || record.collection !== collection) return false;
  if (!inWindow(own, record.space, record.createdAt, now)) return false;
  if (own.when?.others && record.createdBy === account) return false;
  if (where === undefined) return true;
  return matches(
    {
      key: record.key,
      collection: record.collection,
      body: record.body,
      links: record.links ?? [],
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    },
    asRunner(where, account),
  );
}

/**
 * The collection the account's own automations are kept in, in its registry:
 * a system one, which nothing defines, so no other key of the account can
 * redefine it to lock the person out of pausing or removing one.
 */
export const OWN_AUTOMATIONS = 'sys.automation';
