/**
 * Automations: "when a channel has more than 10 messages, post in it". Not the
 * rules a definition carries, which every peer checks (spec 02 §7) and which
 * can only refuse; these act, as whoever runs them.
 *
 * An automation is an ordinary record (`std.automation`), so everyone in the space can see
 * what runs and who made it. What sets it off is a query, in the format
 * `records.query` takes, and a condition over each result, in the language of
 * checks, that may read what the query's `include` found; or the times it
 * names (`every`). It does one thing: notify, add a record, change the record,
 * or ask an agent. Its maker's own devices and agent run it, or, with `by`, a
 * bot the maker may instruct. Whatever it writes is written as its runner, so
 * an automation can do nothing its runner couldn't do by hand.
 *
 * Each time it acts on a record it leaves a run (`std.automation-run`), one per
 * rule per record by construction (`onePer`): that is how it acts once for
 * each record, whichever device or agent looks, and the automation's history for
 * anyone. A run names the record the automation wrote, and nothing an automation wrote sets
 * off an automation: "when a message is added, post a message" would otherwise answer
 * itself forever, and so would two automations that answer each other.
 *
 * Not protocol: a peer that has never heard of automations syncs and judges these
 * records like any other. See `packages/core/docs/automations.md`.
 */
import type { NodeRecord, P2PNode, SpaceAccess } from '../node/types.js';
import {
  nameOf,
  plainQuery,
  type BodyOf,
  type Filter,
  type Query,
  type QueryRecord,
} from '../query/types.js';
import { checkFilter, checkQuery, matches } from '../query/filter.js';
import { causeOf, namedComputed } from '../query/computed.js';
import { quickAddBody } from '../schema/quick-add.js';
import { schemaProblem, type JsonSchema } from '../schema/collection-def.js';
import { isObject } from '../utils/guards.js';
import { checkCron, cronMatches } from './cron.js';
import { about, define, one, person, text, typed, when as moment, words } from './fragments.js';

/** A link an automation's new record carries: to a record by key, or to `$it`, the record the automation holds for */
export interface AutomationLink {
  readonly rel: string;
  readonly to: string;
}

/**
 * What an automation does. In text, `{title}` is what the record is called,
 * `{<include>}` how many an include found. `add` makes a record in any
 * collection one line of text can make one of (`quickAddBody`): a message, a
 * comment, a task, or one someone defined yesterday, with the links it names.
 * `ask` gives its text, in the maker's words, to an agent that runs automations.
 */
export type AutomationAction =
  | { readonly kind: 'notify'; readonly text: string }
  | {
      readonly kind: 'add';
      readonly collection: string;
      readonly text: string;
      readonly links?: ReadonlyArray<AutomationLink>;
    }
  | { readonly kind: 'set'; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: 'ask'; readonly text: string };

/** What sets an automation off: the records a query finds, those a condition holds for */
export interface AutomationWhen {
  /** `records.query`'s format; `include` is how an automation counts or reads what points at a record */
  readonly query: Query;
  /** A filter over each result, which may also read `include:<name>`, what the query included (`checkFilter`) */
  readonly holds?: Filter;
  /** Only records by someone holding one of these roles: a role name, or `member` for any */
  readonly from?: ReadonlyArray<string>;
  /** Only records someone other than its runner wrote */
  readonly others?: boolean;
}

/** The spaces an account's own automation looks at: every space of the account, or these */
export type AutomationSpaces = 'all' | ReadonlyArray<string>;

/** The app that proposed an account's own automation, by the origin the browser reported */
export interface AutomationApp {
  readonly origin: string;
  /** What the app called itself. Shown, never trusted. */
  readonly name?: string;
}

export interface Automation {
  readonly name: string;
  /** What records set it off. An automation has this, `every`, or both. */
  readonly when?: AutomationWhen;
  /** When it runs by itself: five cron fields, minute hour day month weekday, in the runner's local time */
  readonly every?: string;
  readonly then: AutomationAction;
  /** The bot that runs it, when its maker may instruct bots here; else its maker's own devices and agent */
  readonly by?: string;
  /** How an app's builder showed it, so it can be shown and changed again. Never read to run it. */
  readonly picked?: Readonly<Record<string, unknown>>;
  readonly paused?: boolean;
  /** Nothing that came to hold before this sets it off */
  readonly since: string;
  /**
   * The spaces it looks at, for one kept in the account's registry rather
   * than in a space (`space/own-automations.ts`)
   */
  readonly spaces?: AutomationSpaces;
  /** Where clicking its notification goes: an app's address. Default: the account home. */
  readonly open?: string;
  /** The app that proposed it. Absent: the person made it themselves. */
  readonly app?: AutomationApp;
}

export type AutomationRun = BodyOf<typeof automationRun>;

export const automation = typed<Automation>()({
  name: 'std.automation',
  title: 'Automation',
  description: 'When records in the space are a certain way, or at set times, do something.',
  schema: {
    type: 'object',
    properties: {
      name: words(120),
      when: { type: 'object' },
      every: text(100, 'Five cron fields, minute hour day month weekday, local time', 9),
      then: { type: 'object' },
      by: person('The bot that runs it'),
      picked: { type: 'object' },
      paused: { type: 'boolean' },
      since: moment('Nothing that came to hold before this sets it off'),
      spaces: { description: 'Every space of the account ("all"), or a list of their ids' },
      open: words(2000),
      app: {
        type: 'object',
        properties: { origin: words(200), name: words(80) },
        required: ['origin'],
      },
    },
    required: ['name', 'then', 'since'],
  },
});

export const automationRun = define({
  name: 'std.automation-run',
  title: 'Automation run',
  description: 'An automation acted on a record: once each, whichever device did it.',
  schema: {
    type: 'object',
    properties: { did: words(500), ok: { type: 'boolean' }, at: moment(), made: words(256) },
    required: ['did', 'ok', 'at'],
  },
  links: {
    automation: one([automation.name], 'The automation that ran'),
    about: about('The record it ran for'),
  },
  rules: { onePer: ['link:automation', 'link:about'] },
});

/** Where a bot, an agent or anyone's work on something stands */
export type ActivityState = 'working' | 'waiting' | 'done' | 'failed';
export const ACTIVITY_STATES: ReadonlyArray<ActivityState> = ['working', 'waiting', 'done', 'failed'];

export type Activity = BodyOf<typeof activity>;

/**
 * Someone at work on a record, for apps to show while it lasts: "My bot is
 * replying…" under a message, a spinner on a task. One per account per
 * record, changed in place as the work goes on. Its writer's word, like a
 * status, and only theirs to change.
 */
export const activity = define({
  name: 'std.activity',
  title: 'Activity',
  description: 'Someone at work on a record: working, waiting, done or failed.',
  schema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: [...ACTIVITY_STATES] },
      label: words(120),
      at: moment('When it came to this state'),
    },
    required: ['state', 'at'],
  },
  links: { about: about('What the work is on') },
  rules: { onePer: ['@author', 'link:about'] },
});

/**
 * How long a `working` or `waiting` activity is believed without a change:
 * one whose writer went away mid-way would otherwise show forever.
 */
export const ACTIVITY_STALE_SECONDS = 300;

/** Whether an activity says someone is at work on it now: working or waiting, and not gone stale */
export function activeNow(body: Activity | null | undefined, now: number = Date.now()): boolean {
  if (!body || (body.state !== 'working' && body.state !== 'waiting')) return false;
  const at = Date.parse(body.at);
  return Number.isFinite(at) && now - at < ACTIVITY_STALE_SECONDS * 1000;
}

/**
 * Says where this account's work on a record stands: its one `std.activity`
 * about it, made or changed. Without a label, the one it had stays. Null
 * where the space keeps no `std.activity`.
 */
export async function setActivity(
  node: P2PNode,
  space: string,
  on: string,
  state: ActivityState,
  label?: string,
): Promise<NodeRecord | null> {
  if (!(await node.collections.list(space)).some((c) => c.name === activity.name && c.version !== null))
    return null;
  const kept =
    label ??
    (await node.records.linked<Activity>(space, on, { rel: 'about', collection: activity.name })).find(
      (record) => record.root === node.did && !record.deleted,
    )?.body?.label;
  const body: Activity = {
    state,
    ...(kept ? { label: kept.slice(0, 120) } : {}),
    at: new Date().toISOString(),
  };
  // One per account per record: a put for one it already has is that record's next version.
  return node.records.put(space, activity.name, body, { links: [{ rel: 'about', to: on }] });
}

/** In an action, the record the automation holds for */
export const IT = '$it';

/** In an automation's query or condition, whoever runs it: its maker, or the bot named in `by` */
export const ME = '$me';

/**
 * The command a maker needs a grant of in a space for a bot there to run
 * their rules: a library command, which no peer checks (docs/automations.md)
 */
export const INSTRUCT = `/${automation.name}/instruct`;

const said = { type: 'string', pattern: '\\S' };
const named = { type: 'string', minLength: 1 };
const saying = { type: 'object', properties: { text: { ...said, maxLength: 500 } }, required: ['text'] };
/** Each kind of action's shape, which the stored schema leaves open */
const ACTIONS: Readonly<Record<string, JsonSchema>> = {
  notify: saying,
  ask: saying,
  add: {
    type: 'object',
    properties: {
      collection: named,
      text: said,
      links: {
        type: 'array',
        items: { type: 'object', properties: { rel: named, to: named }, required: ['rel', 'to'] },
      },
    },
    required: ['collection', 'text'],
  },
  set: {
    type: 'object',
    properties: { field: named, value: { type: ['string', 'number', 'boolean'] } },
    required: ['field', 'value'],
  },
};
/** An automation's shape, with what sets it off spelled out */
const AUTOMATION: JsonSchema = {
  ...automation.schema,
  properties: {
    ...automation.schema.properties,
    when: {
      type: 'object',
      properties: { from: { type: 'array', items: named }, others: { type: 'boolean' } },
    },
    spaces: {
      anyOf: [{ const: 'all' }, { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } }],
    },
  },
};

/** Why this can't be an automation, or null when it can */
export function checkAutomation(value: unknown): string | null {
  if (!isObject(value)) return 'An automation must be an object';
  const shape = schemaProblem(AUTOMATION, value);
  if (shape) return shape;
  if (typeof value.name !== 'string' || !value.name.trim()) return 'An automation needs a name';
  if (value.when === undefined && value.every === undefined)
    return 'An automation needs a when: { query, holds? }, an every, or both';
  if (isObject(value.when)) {
    const query = checkQuery(value.when.query);
    if (query) return `when.query: ${query}`;
    const holds =
      value.when.holds === undefined ? null : checkFilter(value.when.holds, 'when.holds', { include: true });
    if (holds) return holds;
  }
  const every = typeof value.every === 'string' ? checkCron(value.every) : null;
  if (every) return `every: ${every}`;
  const then = value.then;
  const action = isObject(then) && typeof then.kind === 'string' ? ACTIONS[then.kind] : undefined;
  if (!isObject(then) || !action) return `then.kind must be one of ${Object.keys(ACTIONS).join(', ')}`;
  const actionShape = schemaProblem(action, then, 'then');
  if (actionShape) return actionShape;
  if (then.kind === 'set' && value.when === undefined)
    return 'An automation that changes a record needs a when';
  if (typeof value.since !== 'string' || !Number.isFinite(Date.parse(value.since)))
    return 'since must be a date';
  if (value.open !== undefined && (typeof value.open !== 'string' || !isWebAddress(value.open)))
    return 'open must be an https:// address';
  if (isObject(value.app) && (typeof value.app.origin !== 'string' || !isOrigin(value.app.origin)))
    return 'app.origin must be a web origin';
  return null;
}

/** An https:// address, or http:// on this machine */
function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * `https://chat.example`, nothing after it: what a browser reports as a
 * message's origin. A browser extension's origin (`chrome-extension://<id>`)
 * is one too, though `URL` gives it none.
 */
function isOrigin(value: string): boolean {
  if (/^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]{1,64}$/i.test(value)) return true;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const isAutomation = (value: unknown): value is Automation => checkAutomation(value) === null;

/** An automation record's body, when it is one */
export const automationOf = (record: { readonly body: unknown }): Automation | null =>
  isAutomation(record.body) ? record.body : null;

/** `$me` wherever it is a value, as the account running the automation */
export function asRunner<T>(value: T, me: string): T {
  // eslint-disable-next-line typescript/consistent-type-assertions -- the same shape, with one string swapped for another
  return JSON.parse(JSON.stringify(value), (_key, found: unknown) => (found === ME ? me : found)) as T;
}

/** One record an automation holds for now */
export interface AutomationMatch {
  readonly record: QueryRecord;
  /** What its query's `include` found, as the condition read it: a count as a number */
  readonly included: Readonly<Record<string, unknown>>;
  /**
   * When it came to hold, as far as can be told: its last change, the newest
   * record an include found, or the newest its computed fields read
   */
  readonly moment: number;
  /**
   * What made it hold: the record itself, or, for a filter on a computed
   * field, the record that field read whose coming made it hold (`causeOf`).
   * `from`, `others` and "not by the runner's own agent" judge this one's
   * writer. Absent: the record.
   */
  readonly cause?: NodeRecord;
}

/**
 * The records an automation holds for now, most recently changed first, for `me`,
 * who runs it. Includes that count are run as lists and counted here, so the
 * newest of them can tell when the automation came to hold.
 */
export async function matching(
  node: P2PNode,
  space: string,
  ruleWhen: AutomationWhen,
  me: string,
  limit = 200,
): Promise<ReadonlyArray<AutomationMatch>> {
  const when = asRunner(ruleWhen, me);
  const query = plainQuery(when.query);
  const counted = new Set<string>();
  const include = Object.fromEntries(
    Object.entries(query.include ?? {}).map(([name, found]) => {
      if (!found.count) return [name, found];
      counted.add(name);
      const { count: _count, limit: _limit, ...listed } = found;
      return [name, listed];
    }),
  );
  const { records } = await node.records.query(space, {
    ...query,
    include,
    sort: query.sort ?? { '@updatedAt': 'desc' },
    limit: query.limit ?? limit,
  });
  // A computed field the automation reads changes when what it reads is written: a 👍 can make a todo done.
  const name = nameOf(query.collection);
  const fields = (await node.collections.list(space)).find((c) => c.name === name)?.computed ?? {};
  const named = { ...namedComputed(fields, query.where), ...namedComputed(fields, when.holds) };
  const reads = Object.keys(named).length > 0;
  const source = {
    linked: (key: string, o: { rel?: string; collection?: string }) => node.records.linked(space, key, o),
  };
  const found: AutomationMatch[] = [];
  for (const record of records) {
    let latest = Date.parse(record.updatedAt);
    const included: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record.included)) {
      if (typeof value === 'number') {
        included[name] = value;
        continue;
      }
      for (const one of value) latest = Math.max(latest, Date.parse(one.createdAt));
      included[name] = counted.has(name) ? value.length : value;
    }
    if (when.holds !== undefined && !matches({ ...record, included }, when.holds)) continue;
    // What made it hold, not what came last: a 😡 after the second 👍 sets nothing off.
    const cause = reads
      ? await causeOf(source, record, named, (computed) => {
          const subject = { ...record, included, computed };
          return (
            matches(subject, query.where ?? {}) && (when.holds === undefined || matches(subject, when.holds))
          );
        })
      : record;
    // What made it hold can't be told: better quiet than set off by the wrong one.
    if (!cause) continue;
    if (cause !== record) latest = Math.max(latest, Date.parse(cause.updatedAt));
    found.push({ record, included, moment: latest, cause });
  }
  return found;
}

/** What a record is called, for `{title}`: its first text among the usual names, or its key */
function titleOf(record: QueryRecord): string {
  const body = isObject(record.body) ? record.body : {};
  for (const name of ['title', 'name', 'question', 'text']) {
    const value = body[name];
    if (typeof value === 'string' && value.trim())
      return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return record.key;
}

/** `{title}`, and `{<include>}` as a count, filled in */
export function fillAutomationText(
  text: string,
  match: Pick<AutomationMatch, 'record' | 'included'> | undefined,
  title = titleOf,
) {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (!match) return whole;
    if (name === 'title') return title(match.record);
    const value = match.included[name];
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return String(value.length);
    return whole;
  });
}

/** An automation as it runs: where it is kept, who made it, and what it says */
export interface ActiveAutomation {
  readonly space: string;
  readonly key: string;
  /** The account that made it */
  readonly maker: string;
  readonly body: Automation;
}

/** An automation set off: by a record it came to hold for, or by the time */
export interface AutomationTrigger {
  readonly automation: ActiveAutomation;
  readonly match?: AutomationMatch;
  /** When a time set it off */
  readonly at?: Date;
}

/** What a device does for an automation's `notify`: shows it, and says whether it could */
export type AutomationNotifier = (title: string, text: string, record?: QueryRecord) => boolean;

export interface RunAutomationsOptions {
  /** A bot, running as an account of its own: nothing it writes sets an automation off */
  readonly bot?: boolean;
  /** Shows a notification. Without it, a `notify` automation's run says nothing could. */
  readonly notify?: AutomationNotifier;
  /** Does what an automation asks an agent. Without it, automations that ask are left to a runner that can. */
  readonly ask?: (trigger: AutomationTrigger) => Promise<Pick<AutomationRun, 'did' | 'ok'>>;
  /** What a record is called, for `{title}` */
  readonly title?: (record: QueryRecord) => string;
  /** Records being acted on now, shared across calls so a second look leaves them alone */
  readonly busy?: Set<string>;
  /**
   * How long to wait after claiming a record before acting, to hear whether a
   * device of the same account claimed it too; the earlier claim acts and the
   * later steps back. 0, the default, doesn't wait.
   */
  readonly claimMs?: number;
  /** Each time an automation acted */
  readonly onRun?: (trigger: AutomationTrigger, run: AutomationRun) => void;
}

/** Does what an automation says, as whoever runs it; says what happened */
export async function act(
  node: P2PNode,
  trigger: AutomationTrigger,
  options: RunAutomationsOptions = {},
): Promise<AutomationRun> {
  const { automation: active, match } = trigger;
  const space = active.space;
  const body = active.body;
  const at = new Date().toISOString();
  const text = (template: string) => fillAutomationText(template, match, options.title);
  const then = body.then;
  try {
    switch (then.kind) {
      case 'notify': {
        const shown = options.notify?.(body.name, text(then.text), match?.record) ?? false;
        return { did: shown ? `Notified: ${text(then.text)}` : 'Nothing here could notify', ok: shown, at };
      }
      case 'ask': {
        if (!options.ask) return { did: 'Nothing here can ask an agent', ok: false, at };
        return { ...(await options.ask(trigger)), at };
      }
      case 'add': {
        const collections = await node.collections.list(space);
        const target = collections.find((c) => c.name === then.collection && c.version !== null);
        const thing = (target?.title ?? then.collection.split('.').pop() ?? then.collection).toLowerCase();
        const fresh = target ? quickAddBody(target.schema, text(then.text)) : null;
        if (!target || !fresh)
          return { did: `This space can't add a ${thing} from a line of text`, ok: false, at };
        // Without a record, as when the time set it off, a link to it has nothing to point at.
        const links = (then.links ?? []).flatMap((l) =>
          l.to !== IT ? [l] : match ? [{ rel: l.rel, to: match.record.key }] : [],
        );
        const made = await node.records.put(space, target.name, fresh, { links });
        return { did: `Added a ${thing}: ${text(then.text)}`, ok: true, at, made: made.key };
      }
      case 'set': {
        const current = match ? await node.records.get(space, match.record.key) : null;
        const was = isObject(current?.body) ? current.body : null;
        if (!current || !was) return { did: 'It is not there any more', ok: false, at };
        if (!(await node.records.can(space, 'edit', current.key)))
          return { did: 'Only whoever made it can change it', ok: false, at };
        await node.records.update(space, current.key, { ...was, [then.field]: then.value });
        return { did: `${text('“{title}”')}: set ${then.field} to ${String(then.value)}`, ok: true, at };
      }
    }
  } catch (error) {
    return { did: error instanceof Error ? error.message : String(error), ok: false, at };
  }
}

/** Whether someone holds one of these roles; `member` is any place at all, and a founder holds every role's power */
const holdsOneOf = (access: SpaceAccess | undefined, did: string, names: ReadonlyArray<string>) => {
  const member = access?.members.find((one) => one.did === did);
  return (
    !!member &&
    (member.founder || names.includes('member') || member.roles.some((role) => names.includes(role)))
  );
};

/**
 * The automations in a space that `account` runs, none paused and none whose
 * current version an agent wrote: those it made without `by`, and those
 * naming it in `by` whose maker may instruct it here (`std.automation/instruct`).
 */
export async function automationsFor(
  node: P2PNode,
  space: string,
  account: string,
  access?: SpaceAccess,
): Promise<ReadonlyArray<ActiveAutomation>> {
  const records = await node.records.list(space, { collection: automation.name });
  const active: ActiveAutomation[] = [];
  for (const record of records) {
    const maker = record.createdBy;
    const body = automationOf(record);
    // A key given records only, an agent's, may suggest an automation; it runs once the person saves it themselves.
    if (!record.verified || record.recordsOnly || !maker || !body || body.paused) continue;
    const runs =
      body.by === undefined
        ? maker === account
        : body.by === account &&
          (maker === account ||
            (!!access?.members.some((member) => member.did === maker) &&
              (await node.spaces.may(space, INSTRUCT, {}, maker))));
    if (runs) active.push({ space, key: record.key, maker, body });
  }
  return active;
}

/** How many automations in a space an agent wrote for `account`, waiting for the person to save them */
export async function suggestedAutomations(node: P2PNode, space: string, account: string): Promise<number> {
  const records = await node.records.list(space, { collection: automation.name });
  return records.filter((record) => record.createdBy === account && record.recordsOnly).length;
}

/** The records each automation has run for, by automation key, and the records automations wrote */
async function runsIn(
  node: P2PNode,
  space: string,
): Promise<{ by: Map<string, Set<string>>; made: Set<string> }> {
  const by = new Map<string, Set<string>>();
  const made = new Set<string>();
  for (const run of await node.records.list(space, { collection: automationRun.name })) {
    if (isObject(run.body) && typeof run.body.made === 'string') made.add(run.body.made);
    const ran = run.links.find((l) => l.rel === 'automation')?.to;
    const on = run.links.find((l) => l.rel === 'about')?.to;
    if (!ran || !on) continue;
    const seen = by.get(ran) ?? new Set<string>();
    seen.add(on);
    by.set(ran, seen);
  }
  return { by, made };
}

/**
 * Whether this claim is the one that acts. Two devices of one account may both
 * claim a record before either hears the other; after a wait, the earlier
 * claim (by time, then key) acts and the later is taken back.
 */
async function first(node: P2PNode, space: string, mine: NodeRecord, wait: number): Promise<boolean> {
  if (wait <= 0) return true;
  await new Promise((resolve) => setTimeout(resolve, wait));
  const ran = mine.links.find((l) => l.rel === 'automation')?.to;
  const on = mine.links.find((l) => l.rel === 'about')?.to;
  if (!ran || !on) return true;
  const claims = (
    await node.records.linked(space, on, { rel: 'about', collection: automationRun.name })
  ).filter((run) => run.links.some((l) => l.rel === 'automation' && l.to === ran));
  const earliest = [...claims].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key),
  )[0];
  if (!earliest || earliest.key === mine.key) return true;
  await node.records.delete(space, mine.key).catch(() => {});
  return false;
}

/**
 * Runs, once, every automation `account` runs in a space: acts for each record a
 * automation newly holds for, and leaves a run for it. `startAutomations` calls it when
 * records change; a device can call it itself.
 */
export async function runAutomations(
  node: P2PNode,
  space: string,
  account: string,
  options: RunAutomationsOptions = {},
): Promise<void> {
  const collections = await node.collections.list(space);
  const defined = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  if (!defined(automation.name) || !defined(automationRun.name)) return;
  const access = await node.spaces.access(space).catch(() => undefined);
  const rules = (await automationsFor(node, space, account, access)).filter(
    (r) => r.body.when && (r.body.then.kind !== 'ask' || options.ask),
  );
  if (rules.length === 0) return;
  const busy = options.busy ?? new Set<string>();
  const { by: runs, made } = await runsIn(node, space);
  for (const active of rules) {
    const when = active.body.when!;
    if (!defined(nameOf(when.query.collection))) continue;
    const since = Date.parse(active.body.since);
    for (const match of await matching(node, space, when, account)) {
      const record = match.record;
      const cause = match.cause ?? record;
      const by = cause.createdBy ?? cause.root;
      const claim = `${active.key} ${record.key}`;
      if (
        match.moment < since ||
        made.has(record.key) ||
        runs.get(active.key)?.has(record.key) ||
        busy.has(claim)
      )
        continue;
      // What the runner's agent, or the bot, wrote itself never sets an automation off: an agent asked to act can't set itself off.
      if (by === account && (cause.recordsOnly || options.bot)) continue;
      if (when.from && !holdsOneOf(access, by ?? '', when.from)) continue;
      if (when.others && by === account) continue;
      busy.add(claim);
      try {
        const links = [
          { rel: 'automation', to: active.key },
          { rel: 'about', to: record.key },
        ];
        // Claimed first, so a second look while this acts leaves it alone.
        const run = await node.records.put(
          space,
          automationRun.name,
          { did: 'Running…', ok: true, at: new Date().toISOString() },
          { links },
        );
        if (!(await first(node, space, run, options.claimMs ?? 0))) continue;
        const trigger = { automation: active, match };
        const done = await act(node, trigger, options);
        if (done.made) made.add(done.made);
        await node.records.update(space, run.key, done, { links });
        options.onRun?.(trigger, done);
      } finally {
        busy.delete(claim);
      }
    }
  }
}

export interface StartAutomationsOptions extends RunAutomationsOptions {
  /** The account running them: a person's, for their app or agent, or a bot's own */
  readonly account: string;
  /**
   * Whether automations run at the times they name. An app open now and then leaves
   * that to a runner that is always on. Default true.
   */
  readonly timed?: boolean;
  /** Called with the automations it runs, whenever they change */
  readonly onRules?: (rules: ReadonlyArray<ActiveAutomation>) => void;
  readonly onError?: (error: unknown) => void;
  /** How often the time is checked against `every`. Default 15 s. */
  readonly tickMs?: number;
  readonly now?: () => Date;
}

/**
 * Runs the automations `account` runs, in every space it follows, until stopped:
 * once at the start, after each change in a space, and at the times automations
 * name. The one loop every runner uses, an app, `minca agent` or a bot.
 */
export function startAutomations(node: P2PNode, options: StartAutomationsOptions): () => void {
  const { account } = options;
  const busy = options.busy ?? new Set<string>();
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let spaces: ReadonlyArray<string> = [];
  const kept = new Map<string, ReadonlyArray<ActiveAutomation>>();
  let shown: string | null = null;
  let running: Promise<void> | null = null;
  /** Spaces with a change not yet looked at; null means the list of spaces changed */
  const dirty = new Set<string | null>([null]);
  /** The minute each timed automation last ran, so it runs once in it */
  const ranAt = new Map<string, string>();
  const runnable = (r: ActiveAutomation) => r.body.then.kind !== 'ask' || !!options.ask;

  async function run(): Promise<void> {
    while (dirty.size && !stopped) {
      const changed = [...dirty];
      dirty.clear();
      try {
        if (changed.includes(null)) spaces = (await node.spaces.list()).map((space) => space.id);
        for (const space of kept.keys()) if (!spaces.includes(space)) kept.delete(space);
        const looking = changed.includes(null)
          ? spaces
          : changed.filter((s): s is string => !!s && spaces.includes(s));
        for (const space of looking) {
          if (stopped) return;
          const access = await node.spaces.access(space).catch(() => undefined);
          kept.set(space, (await automationsFor(node, space, account, access)).filter(runnable));
          await runAutomations(node, space, account, { ...options, busy });
        }
        const all = [...kept.values()].flat();
        const names = all.map((r) => `${r.space}/${r.key}/${r.body.name}`).join();
        if (names !== shown) {
          shown = names;
          options.onRules?.(all);
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  }

  function kick(): void {
    running ??= run().finally(() => {
      running = null;
      if (dirty.size && !stopped) kick();
    });
  }

  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces' || event.type === 'account') dirty.add(null);
    else if (event.type === 'records') dirty.add(spaces.includes(event.space) ? event.space : null);
    else return;
    kick();
  });
  kick();

  const tick =
    options.timed === false
      ? undefined
      : setInterval(() => {
          const at = now();
          const minute = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()} ${at.getHours()}:${at.getMinutes()}`;
          for (const active of [...kept.values()].flat()) {
            const every = active.body.every;
            const id = `${active.space}/${active.key}`;
            if (!every || ranAt.get(id) === minute || !cronMatches(every, at)) continue;
            ranAt.set(id, minute);
            const trigger = { automation: active, at };
            void act(node, trigger, options).then(
              (done) => options.onRun?.(trigger, done),
              (error: unknown) => options.onError?.(error),
            );
          }
        }, options.tickMs ?? 15_000);

  return () => {
    stopped = true;
    if (tick) clearInterval(tick);
    unsubscribe();
  };
}
