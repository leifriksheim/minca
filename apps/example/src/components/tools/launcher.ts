/**
 * The launcher: which tools a space has, in what order, kept in the space as
 * `launcher.app` records, one per tool. Everyone in the space sees the same
 * tools in the same order.
 *
 * A tool's record is the tool: its title, the collections it uses, what it
 * notifies about, and maybe a screen of its own, with a link to the blueprint
 * that proposed its collections. The ready-made ones (`templates/`) are copied
 * in the same way. Anyone may write one, an agent too; it counts as
 * added only once someone who may define collections in the space has written
 * its current version, with a key whose note let them, and its collections are
 * there. Until then it is a proposal. That is what lets a screen run: someone
 * who may define collections put it there.
 *
 * Removing a tool deletes its record and nothing else: its collections and
 * their records stay, and adding it again picks them up.
 *
 * This is the example app's own convention, not the library's. Agents learn it
 * from the guide it writes in the space (`std.guide`, `LAUNCHER_GUIDE`).
 */
import {
  checkAppAutomation,
  COLLECTION_DEFINE,
  grantFits,
  type DefineCollection,
  type NodeCollection,
  type NodeRecord,
  type P2PNode,
  type SpaceAccess,
} from '@minca/core';
import {
  applyBlueprint,
  blueprint,
  fragments,
  notifyOn,
  positionBetween,
  proposeCollections,
  // Defines what a space lacks; not a React hook, whatever its name says.
  useSchemas as addSchemas,
  writeGuide,
  type AppAutomation,
  type DraftCollection,
} from '@minca/core/schemas';
import { checkScreenNetwork, MAX_SCREEN_BYTES, SCREEN_GUIDE, offLimits } from './screens';

export interface LauncherTool {
  readonly title?: string;
  /** What it is for, in its proposer's words */
  readonly description?: string;
  /** The collections it shows, by name */
  readonly collections?: ReadonlyArray<string>;
  /**
   * Of those, the ones whose records it is where to open: a message anywhere
   * opens in the tool that shows `std.message`, at that message.
   */
  readonly shows?: ReadonlyArray<string>;
  /** What in it is worth hearing about */
  readonly notify?: ReadonlyArray<AppAutomation>;
  /** Its own screen: one HTML document, run sealed (`screens.ts`) */
  readonly screen?: string;
  /** Exact origins that screen may connect to; none keeps it sealed */
  readonly network?: ReadonlyArray<string>;
  /** Sorts where it goes on the launcher (`positionBetween`) */
  readonly position?: string;
  /** For a proposed change: the key of the tool it is a new version of */
  readonly updates?: string;
  /** The ready-made tool it began as, by id: `kanban`. The space's copy is its own to change. */
  readonly template?: string;
  /** What whoever adds it fills in once for everyone, like an API key; its screen reads them as `minca.settings` */
  readonly settings?: ReadonlyArray<ToolSetting>;
}

/** A setting a tool asks for, and its value once someone who may add tools has given one */
export interface ToolSetting {
  /** How its screen reads it: `minca.settings.giphy` */
  readonly key: string;
  readonly title: string;
  /** Where to get it, or what it is for */
  readonly description?: string;
  readonly value?: string;
}

/** A tool on the space's launcher, or one proposed for it. */
export const launcherTool = fragments.typed<LauncherTool>()({
  name: 'launcher.app',
  title: 'Tool',
  description: 'A tool on the space’s launcher, or one proposed for it.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      collections: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 200 },
      },
      shows: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 200 },
      },
      notify: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' } },
      screen: { type: 'string', minLength: 1, maxLength: MAX_SCREEN_BYTES },
      network: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
      position: { type: 'string', minLength: 1, maxLength: 200 },
      updates: { type: 'string', minLength: 1, maxLength: 128 },
      template: { type: 'string', minLength: 1, maxLength: 100 },
      settings: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 40 },
            title: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
            value: { type: 'string', maxLength: 2000 },
          },
          required: ['key', 'title'],
        },
      },
    },
  },
  links: {
    blueprint: {
      to: ['std.blueprint'],
      cardinality: 'one',
      description: 'The blueprint proposing the collections it needs',
    },
  },
});

/** Why this can't be a launcher record, or null */
export function checkLauncherTool(body: LauncherTool): string | null {
  if (!body.title?.trim()) return 'A tool needs a title';
  const names = new Set(body.collections ?? []);
  if (names.size === 0) return 'A tool needs the collections it shows';
  // Its screen writes these as whoever looks: the launcher's own would let it add tools.
  const kept = [...names].find(offLimits);
  if (kept) return `${kept} is the space's own, not a tool's to show`;
  const stray = body.shows?.find((name) => !names.has(name));
  if (stray) return `shows: ${stray} is not one of its collections`;
  if (body.screen !== undefined) {
    const bytes = new TextEncoder().encode(body.screen).length;
    if (bytes > MAX_SCREEN_BYTES)
      return `screen is ${Math.ceil(bytes / 1024)} KB; at most ${MAX_SCREEN_BYTES / 1024} KB`;
  }
  const network = checkScreenNetwork(body.network, body.screen !== undefined);
  if (network) return network;
  const keys = (body.settings ?? []).map((setting) => setting.key);
  const odd = keys.find((key) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key));
  if (odd !== undefined) return `settings: "${odd}" is not a key a screen can read as minca.settings.${odd}`;
  const twice = keys.find((key, at) => keys.indexOf(key) !== at);
  if (twice) return `settings: ${twice} is there twice`;
  for (const [index, entry] of (body.notify ?? []).entries()) {
    const problem = checkAppAutomation(entry);
    if (problem) return `notify[${index}]: ${problem}`;
    if (!names.has(entry.when.query.collection))
      return `notify[${index}]: ${entry.when.query.collection} is not one of its collections`;
  }
  return null;
}

/**
 * Whether an account may define collections here, as its roles' grants say
 * now: a founder, or a role every current definition of which grants
 * `/collection/define`. For showing, not judging: each definition's grants
 * also count only as far as its author could give them, which the node checks.
 */
function mayDefine(access: SpaceAccess | null | undefined, did: string | null): boolean {
  const member = access?.members.find((m) => m.did === did);
  if (!member) return false;
  if (member.founder) return true;
  return member.roles.some((name) => {
    const definitions = access?.roles.find((r) => r.name === name)?.definitions ?? [];
    return (
      definitions.length > 0 &&
      definitions.every((d) => d.grants.some((g) => grantFits(g, COLLECTION_DEFINE, { collection: '' })))
    );
  });
}

/**
 * Whether a launcher record's current version stands for the space: written
 * by someone whose role may define collections, with a key whose note let
 * them. A records-only write (an agent's), or an edit by anyone else, makes it a proposal again.
 */
const vouchedFor = (record: NodeRecord<LauncherTool>, access: SpaceAccess | null | undefined) =>
  !record.recordsOnly && mayDefine(access, record.root);

const defined = (collections: ReadonlyArray<NodeCollection>) =>
  new Set(collections.filter((c) => c.version !== null).map((c) => c.name));

const byPosition = (a: NodeRecord<LauncherTool>, b: NodeRecord<LauncherTool>) => {
  const pa = a.body?.position ?? '~';
  const pb = b.body?.position ?? '~';
  return pa < pb ? -1 : pa > pb ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

export interface Launcher {
  /** On the launcher, in order: the tools that stand */
  readonly placed: ReadonlyArray<NodeRecord<LauncherTool>>;
  /** Tools waiting for someone who may define collections to add them */
  readonly proposed: ReadonlyArray<NodeRecord<LauncherTool>>;
}

/**
 * Sorts a space's launcher records into what is on it, in order, and what is
 * proposed. A tool counts only when someone who may define collections put it
 * there and its collections are here.
 */
export function sortLauncher(
  records: ReadonlyArray<NodeRecord<LauncherTool>>,
  collections: ReadonlyArray<NodeCollection>,
  access: SpaceAccess | null | undefined,
): Launcher {
  const here = defined(collections);
  const placed: NodeRecord<LauncherTool>[] = [];
  const proposed: NodeRecord<LauncherTool>[] = [];
  for (const record of [...records].sort(byPosition)) {
    const body = record.body;
    if (!body || record.deleted) continue;
    const broken = checkLauncherTool(body) !== null;
    // A tool the launcher can't take stays a proposal, so whoever reviews it sees why.
    const stands =
      !broken &&
      body.updates === undefined &&
      vouchedFor(record, access) &&
      (body.collections ?? []).every((name) => here.has(name));
    (stands ? placed : proposed).push(record);
  }
  return { placed, proposed };
}

/**
 * The tool a space opens with: the first on its launcher. Its members put the
 * launcher in order, so a group chooses where it opens by moving a tool to
 * the top. Undefined when it has none.
 */
export async function firstTool(
  node: P2PNode,
  spaceId: string,
): Promise<NodeRecord<LauncherTool> | undefined> {
  const [records, collections, access] = await Promise.all([
    node.records.list<LauncherTool>(spaceId, { collection: launcherTool.name }),
    node.collections.list(spaceId),
    node.spaces.access(spaceId),
  ]);
  return sortLauncher(records, collections, access).placed[0];
}

/** A position after every tool on the launcher */
function atEnd(placed: ReadonlyArray<NodeRecord<LauncherTool>>): string {
  const last = placed.map((record) => record.body?.position ?? '').reduce((a, b) => (b > a ? b : a), '');
  return positionBetween(last || null);
}

/** The tool on the launcher a proposal updates, if it still is one */
export const updated = (
  proposal: NodeRecord<LauncherTool>,
  placed: ReadonlyArray<NodeRecord<LauncherTool>>,
): NodeRecord<LauncherTool> | undefined =>
  proposal.body?.updates === undefined
    ? undefined
    : placed.find((record) => record.key === proposal.body?.updates);

/**
 * The tool the guide shows agents, kept as a value rather than written out:
 * the guide prints it, its type holds it to `LauncherTool`, and a test runs it
 * through `checkLauncherTool`, so the example can't drift from what is accepted.
 */
export const EXAMPLE_TOOL = {
  title: 'Carpool',
  description: 'Who drives to the match, and who rides with them',
  collections: ['carpool.trip', 'carpool.seat'],
  shows: ['carpool.trip'],
  notify: [
    notifyOn('New trip', 'carpool.trip'),
    notifyOn('A seat on my trip', 'carpool.seat', { driver: '$me' }),
  ],
} satisfies LauncherTool;

/** A value as the guide prints it: JSON, indented to sit inside a numbered step */
const shown = (value: unknown) => JSON.stringify(value, null, 2).replaceAll('\n', '\n   ');

/**
 * What agents read to propose a tool here, written in the space as a guide
 * on `launcher.app`, so one finds it with `collections_list`.
 */
const LAUNCHER_GUIDE = `To make a tool for this space (a launcher.app record) that people open from its launcher:

1. Propose the collections it needs with collections_propose (one std.blueprint). Use standard ones by name where they fit
   (std.event, std.task, std.poll, …): their records then open in, and are shared with, the other tools here. Note its key.
2. Write one launcher.app record with records_put, like this one:
   ${shown(EXAMPLE_TOOL)}
   with links [{ "rel": "blueprint", "to": "<the blueprint's key>" }].
   "collections" names every collection it shows. "shows" is optional: of those, the ones whose records it is the
   place to open, like ["std.message"] for a chat; a record of one opened anywhere opens in this tool, which its
   screen hears through minca.onShow. "notify" is optional: what is worth hearing about, each a name and
   the query whose new records it tells of, in one of its collections. A "where" naming "$me" keeps it to records that
   name the person it would tell, as the second one does.
3. If plain lists and forms can't show it (a game board, a calendar, a whiteboard), add "screen": its own HTML UI, one
   document, and, only if it must reach the network, "network": the exact origins. The screen is described below.
4. If it needs something only the space can give, like an API key, add "settings": what to fill in, like
   [{ "key": "giphy", "title": "GIPHY API key", "description": "Free at developers.giphy.com" }]. Leave out the values:
   whoever adds the tool fills them in once for everyone, and its screen reads them as minca.settings.

Your screen is not the only way in: anyone in the space can write any record directly, through an agent or another
app. Ask what a member could do that way. Where the tool means nothing unless records keep a rule their shape and
rules can't say (whose turn it is, a legal move, a vote counted once), give the collection a "contract", as
collections_propose describes, and try it there with "examples": fair moves that must count and cheats that must not.
A screen only shows what the contract allows; it is not what stops a cheat.

Records don't change when their collection does. Change a collection that has records only by adding optional
fields; for anything else, give the new shape a name of its own, and let the old tool finish what it holds.

Nothing changes until someone who may define collections adds it from the Tools page: that applies the blueprint and
writes the record again as theirs. A launcher.app record that person did not write is only a proposal, and its screen
never runs. To change a tool that is already added, write a new launcher.app record with "updates": the key of the one
it replaces, and, if its collections change, a new blueprint whose "updates" names the old blueprint. Settings it
names keep the values the tool has.

Removing a tool deletes its launcher.app record; its records stay. A made tool may not show launcher.app,
std.blueprint, std.guide or sys.* collections.

How a screen works:

${SCREEN_GUIDE}`;

/**
 * Makes the space ready for tools: defines `launcher.app` and `std.blueprint`
 * when it lacks them, and writes the guide agents read. Only for someone who
 * may define collections; for anyone else it does nothing.
 */
export async function prepareLauncher(node: P2PNode, spaceId: string): Promise<void> {
  if (!mayDefine(await node.spaces.access(spaceId), node.did)) return;
  const here = defined(await node.collections.list(spaceId));
  for (const definition of [launcherTool, blueprint])
    if (!here.has(definition.name)) await node.collections.define(spaceId, definition);
  await writeGuide(node, spaceId, {
    name: 'launcher.apps',
    title: 'Making a tool for this space',
    text: LAUNCHER_GUIDE,
    collections: [launcherTool.name, blueprint.name],
  });
}

/** A tool as it stands once added: its place is the launcher's, and it updates nothing */
function settled(body: LauncherTool): LauncherTool {
  const { title, description, collections, shows, notify, screen, network, template, settings } = body;
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(collections !== undefined ? { collections } : {}),
    ...(shows !== undefined ? { shows } : {}),
    ...(notify !== undefined ? { notify } : {}),
    ...(screen !== undefined ? { screen } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

/** The values a tool's settings hold, by key: what its screen gets as `minca.settings` */
export const settingsOf = (body: LauncherTool): Readonly<Record<string, string>> =>
  Object.fromEntries((body.settings ?? []).flatMap((s) => (s.value ? [[s.key, s.value]] : [])));

/**
 * The settings a change asks for, holding the values the tool has now where it
 * gives none: a new screen from an agent doesn't know the space's key, and
 * adding it shouldn't lose it.
 */
const keepValues = (
  next: ReadonlyArray<ToolSetting> | undefined,
  now: ReadonlyArray<ToolSetting> | undefined,
): ReadonlyArray<ToolSetting> | undefined =>
  next?.map((setting) => {
    const value = setting.value ?? now?.find((held) => held.key === setting.key)?.value;
    return value === undefined ? setting : { ...setting, value };
  });

/** Fills in a tool's settings for everyone: only someone who may add tools writes a version that stands */
export async function saveSettings(
  node: P2PNode,
  spaceId: string,
  record: NodeRecord<LauncherTool>,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const body = record.body;
  if (!body) throw new Error('This tool could not be read');
  const settings = (body.settings ?? []).map(({ value: _, ...setting }) => {
    const value = values[setting.key]?.trim();
    return value ? { ...setting, value } : setting;
  });
  await node.records.update<LauncherTool>(
    spaceId,
    record.key,
    { ...body, settings },
    { links: record.links },
  );
}

/**
 * A ready-made tool: an ordinary tool, kept here rather than in a space, with
 * the collections it needs. Adding one copies it into the space, which then
 * changes its copy the way it changes any tool.
 */
export interface Template {
  readonly tool: LauncherTool & {
    readonly template: string;
    readonly title: string;
    readonly description: string;
  };
  readonly needs: ReadonlyArray<DefineCollection>;
  /** Defined too, so whatever the tool shows a record with (comments, attachments) has them */
  readonly uses?: ReadonlyArray<DefineCollection>;
  /** Runs once, right after it is added: a board's first columns */
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
}

/**
 * Adds a ready-made tool: defines every collection it can use, runs its
 * setup, and writes its copy at the end of the launcher, as this account's.
 * Returns the key of the tool on the launcher.
 */
export async function addTemplate(
  node: P2PNode,
  spaceId: string,
  template: Template,
  placed: ReadonlyArray<NodeRecord<LauncherTool>>,
): Promise<string> {
  const there = placed.find((record) => record.body?.template === template.tool.template);
  if (there) return there.key;
  await addSchemas(node, spaceId, [...template.needs, ...(template.uses ?? [])]);
  await template.setup?.(node, spaceId);
  await prepareLauncher(node, spaceId);
  const record = await node.records.put(spaceId, launcherTool, { ...template.tool, position: atEnd(placed) });
  return record.key;
}

/**
 * Adds a proposed tool: applies the blueprint it points at, if any, then writes
 * the tool again as this account's, at the end of the launcher. A proposed
 * change goes into the tool it `updates`, which keeps its place, and the
 * proposal goes. Returns the key of the tool now on the launcher.
 */
export async function addMade(
  node: P2PNode,
  spaceId: string,
  proposal: NodeRecord<LauncherTool>,
  placed: ReadonlyArray<NodeRecord<LauncherTool>>,
): Promise<string> {
  const body = proposal.body;
  if (!body) throw new Error('This tool could not be read');
  const problem = checkLauncherTool(body);
  if (problem) throw new Error(problem);
  await prepareLauncher(node, spaceId);
  const plan = proposal.links.find((link) => link.rel === 'blueprint')?.to;
  if (plan) await applyBlueprint(node, spaceId, plan);
  const here = defined(await node.collections.list(spaceId));
  const missing = (body.collections ?? []).filter((name) => !here.has(name));
  if (missing.length)
    throw new Error(`The space has no ${missing.join(' or ')}, and this tool proposes no collections to add`);
  const rest = settled(body);
  // A change to a tool no longer on the launcher, or to a built-in one, is added as a tool of its own.
  const target = updated(proposal, placed);
  if (target) {
    const settings = keepValues(rest.settings, target.body?.settings);
    await node.records.update<LauncherTool>(
      spaceId,
      target.key,
      {
        ...rest,
        ...(settings ? { settings } : {}),
        ...(target.body?.position ? { position: target.body.position } : {}),
      },
      { links: proposal.links },
    );
    await node.records.delete(spaceId, proposal.key);
    return target.key;
  }
  await node.records.update<LauncherTool>(spaceId, proposal.key, { ...rest, position: atEnd(placed) });
  return proposal.key;
}

/**
 * Takes a tool off the launcher. Its collections and records stay. For a
 * ready-made tool, every copy of it goes, so one two people added at once
 * doesn't come back.
 */
export async function removeTool(
  node: P2PNode,
  spaceId: string,
  record: NodeRecord<LauncherTool>,
  records: ReadonlyArray<NodeRecord<LauncherTool>>,
): Promise<void> {
  const template = record.body?.template;
  const all =
    template === undefined
      ? [record]
      : records.filter((one) => one.body?.template === template && !one.deleted);
  for (const one of all) await node.records.delete(spaceId, one.key);
}

/**
 * Moves a tool on the launcher to sit at `to` among the others. Usually only
 * it is written. Records with no position, or two with the same one, get new
 * positions too, so the order shown is the order kept.
 */
export async function moveTool(
  node: P2PNode,
  spaceId: string,
  placed: ReadonlyArray<NodeRecord<LauncherTool>>,
  key: string,
  to: number,
): Promise<void> {
  const moving = placed.find((record) => record.key === key);
  if (!moving?.body) return;
  const order = placed.filter((record) => record.key !== key);
  order.splice(Math.max(0, Math.min(to, order.length)), 0, moving);
  let before: string | null = null;
  for (const [at, record] of order.entries()) {
    const own = record.body?.position;
    // A record already after the one before it keeps its place.
    if (record !== moving && own !== undefined && (before === null || own > before)) {
      before = own;
      continue;
    }
    const next = order[at + 1];
    const nextOwn = next && next !== moving ? next.body?.position : undefined;
    const after = nextOwn !== undefined && (before === null || nextOwn > before) ? nextOwn : null;
    const position = positionBetween(before, after);
    if (record.body)
      await node.records.update<LauncherTool>(spaceId, record.key, { ...record.body, position });
    before = position;
  }
}

/** A collection as the space holds it, as a blueprint proposes it */
const toDraft = (held: NodeCollection): DraftCollection | null =>
  held.schema === null
    ? null
    : {
        name: held.name,
        schema: held.schema,
        ...(held.title !== undefined ? { title: held.title } : {}),
        ...(held.description !== undefined ? { description: held.description } : {}),
        history: held.history,
        links: held.links,
        rules: held.rules,
        ...(held.contract !== undefined ? { contract: held.contract } : {}),
        topics: held.topics,
      };

/**
 * Proposes a tool in another space: its collections as this space holds them,
 * as a blueprint there, and the tool pointing at it. People there decide for
 * themselves.
 */
export async function copyTool(
  node: P2PNode,
  fromSpace: string,
  record: NodeRecord<LauncherTool>,
  toSpace: string,
): Promise<void> {
  const body = record.body;
  if (!body) throw new Error('This tool could not be read');
  const held = await node.collections.list(fromSpace);
  const drafts = (body.collections ?? []).flatMap((name) => {
    const found = held.find((c) => c.name === name);
    const draft = found ? toDraft(found) : null;
    return draft ? [draft] : [];
  });
  const plan = await proposeCollections(node, toSpace, {
    title: body.title ?? 'A tool',
    ...(body.description !== undefined ? { description: body.description } : {}),
    collections: drafts,
    from: `${fromSpace}/${record.key}`,
  });
  // What this space filled in, a key say, is this space's: the other fills in its own.
  const { settings, ...rest } = settled(body);
  await node.records.put(
    toSpace,
    launcherTool,
    { ...rest, ...(settings ? { settings: settings.map(({ value: _, ...setting }) => setting) } : {}) },
    { links: [{ rel: 'blueprint', to: plan.key }] },
  );
}
