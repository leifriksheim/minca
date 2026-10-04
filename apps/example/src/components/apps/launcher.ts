/**
 * The launcher: which apps a space has, in what order, kept in the space as
 * `launcher.app` records, one per app. Everyone in the space sees the same
 * apps in the same order.
 *
 * A built-in app's record only names it (`builtIn: "chat"`). A made app's
 * record is the app: its title, the collections it uses, what it notifies
 * about, and maybe a screen of its own, with a link to the blueprint that
 * proposed its collections. Anyone may write one, an agent too; it counts as
 * added only once someone who may define collections in the space has written
 * its current version, with a key whose note let them, and its collections are
 * there. Until then it is a proposal. That is what lets a screen run: someone
 * who may define collections put it there.
 *
 * Removing an app deletes its record and nothing else: its collections and
 * their records stay, and adding it again picks them up.
 *
 * This is the example app's own convention, not the library's. Agents learn it
 * from the guide it writes in the space (`std.guide`, `LAUNCHER_GUIDE`).
 */
import {
  checkAppNotify,
  DEFINE,
  roleHolds,
  type DefineCollection,
  type NodeCollection,
  type NodeRecord,
  type P2PNode,
  type SpaceAccess,
} from '@weaveprotocol/core';
import {
  applyBlueprint,
  blueprint,
  fragments,
  positionBetween,
  proposeCollections,
  // Defines what a space lacks; not a React hook, whatever its name says.
  useSchemas as addSchemas,
  writeGuide,
  type AppNotify,
  type DraftCollection,
} from '@weaveprotocol/core/schemas';
import { checkScreenNetwork, MAX_SCREEN_BYTES, SCREEN_GUIDE, offLimits } from './screens';

export interface LauncherApp {
  /** A built-in app, by its id: `chat`. A made app leaves it out and says the rest. */
  readonly builtIn?: string;
  readonly title?: string;
  /** What it is for, in its proposer's words */
  readonly description?: string;
  /** The collections it shows, by name */
  readonly collections?: ReadonlyArray<string>;
  /** What in it is worth hearing about */
  readonly notify?: ReadonlyArray<AppNotify>;
  /** Its own screen: one HTML document, run sealed (`screens.ts`) */
  readonly screen?: string;
  /** Exact origins that screen may connect to; none keeps it sealed */
  readonly network?: ReadonlyArray<string>;
  /** Sorts where it goes on the launcher (`positionBetween`) */
  readonly position?: string;
  /** For a proposed change: the key of the app it is a new version of */
  readonly updates?: string;
}

/** An app on the space's launcher, or one proposed for it. */
export const launcherApp = fragments.typed<LauncherApp>()({
  name: 'launcher.app',
  title: 'App',
  description: 'An app on the space’s launcher, or one proposed for it.',
  schema: {
    type: 'object',
    properties: {
      builtIn: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      collections: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 200 },
      },
      notify: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' } },
      screen: { type: 'string', minLength: 1, maxLength: MAX_SCREEN_BYTES },
      network: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
      position: { type: 'string', minLength: 1, maxLength: 200 },
      updates: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  links: {
    blueprint: {
      to: ['std.blueprint'],
      cardinality: 'one',
      description: 'The blueprint proposing the collections it needs',
    },
  },
  rules: { edit: 'member', delete: 'member' },
});

/** Why this can't be a launcher record, or null */
export function checkLauncherApp(body: LauncherApp): string | null {
  if (body.builtIn !== undefined)
    return body.title === undefined ? null : 'A built-in app is named, not described';
  if (!body.title?.trim()) return 'An app needs a title';
  const names = new Set(body.collections ?? []);
  if (names.size === 0) return 'An app needs the collections it shows';
  // Its screen writes these as whoever looks: the launcher's own would let it add apps.
  const kept = [...names].find(offLimits);
  if (kept) return `${kept} is the space's own, not an app's to show`;
  if (body.screen !== undefined) {
    const bytes = new TextEncoder().encode(body.screen).length;
    if (bytes > MAX_SCREEN_BYTES)
      return `screen is ${Math.ceil(bytes / 1024)} KB; at most ${MAX_SCREEN_BYTES / 1024} KB`;
  }
  const network = checkScreenNetwork(body.network, body.screen !== undefined);
  if (network) return network;
  for (const [index, entry] of (body.notify ?? []).entries()) {
    const problem = checkAppNotify(entry);
    if (problem) return `notify[${index}]: ${problem}`;
    if (!names.has(entry.collection))
      return `notify[${index}]: ${entry.collection} is not one of its collections`;
  }
  return null;
}

/** Whether this account's role in the space holds `define` */
function mayDefine(access: SpaceAccess | null | undefined, did: string | null): boolean {
  const member = access?.members.find((m) => m.did === did);
  return (
    !!member &&
    roleHolds(
      access?.roles.find((r) => r.name === member.role),
      DEFINE,
    )
  );
}

/**
 * Whether a launcher record's current version stands for the space: written
 * by someone whose role may define collections, with a key whose note let
 * them. An agent's write, or an edit by anyone else, makes it a proposal again.
 */
const vouchedFor = (record: NodeRecord<LauncherApp>, access: SpaceAccess | null | undefined) =>
  !record.recordsOnly && mayDefine(access, record.root);

const defined = (collections: ReadonlyArray<NodeCollection>) =>
  new Set(collections.filter((c) => c.version !== null).map((c) => c.name));

const byPosition = (a: NodeRecord<LauncherApp>, b: NodeRecord<LauncherApp>) => {
  const pa = a.body?.position ?? '~';
  const pb = b.body?.position ?? '~';
  return pa < pb ? -1 : pa > pb ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

export interface Launcher {
  /** On the launcher, in order: each built-in app once, and made apps that stand */
  readonly placed: ReadonlyArray<NodeRecord<LauncherApp>>;
  /** Made apps waiting for someone who may define collections to add them */
  readonly proposed: ReadonlyArray<NodeRecord<LauncherApp>>;
}

/**
 * Sorts a space's launcher records into what is on it, in order, and what is
 * proposed. `needsOf` names the collections a built-in app needs, by its id;
 * a built-in this app doesn't know is left out. A built-in counts only when
 * someone who may define collections put it there and its collections are
 * here; anything else naming one is ignored, not proposed.
 */
export function sortLauncher(
  records: ReadonlyArray<NodeRecord<LauncherApp>>,
  collections: ReadonlyArray<NodeCollection>,
  access: SpaceAccess | null | undefined,
  needsOf: (id: string) => ReadonlyArray<string> | undefined,
): Launcher {
  const here = defined(collections);
  const placed: NodeRecord<LauncherApp>[] = [];
  const proposed: NodeRecord<LauncherApp>[] = [];
  const builtIns = new Set<string>();
  for (const record of [...records].sort(byPosition)) {
    const body = record.body;
    if (!body || record.deleted || checkLauncherApp(body)) continue;
    if (body.builtIn !== undefined) {
      const needs = needsOf(body.builtIn);
      const stands = needs !== undefined && vouchedFor(record, access) && needs.every((n) => here.has(n));
      // Two people adding the same app at once: the first one placed counts.
      if (stands && !builtIns.has(body.builtIn)) placed.push(record);
      if (stands) builtIns.add(body.builtIn);
      continue;
    }
    const stands =
      body.updates === undefined &&
      vouchedFor(record, access) &&
      (body.collections ?? []).every((name) => here.has(name));
    (stands ? placed : proposed).push(record);
  }
  return { placed, proposed };
}

/** A position after every app on the launcher */
function atEnd(placed: ReadonlyArray<NodeRecord<LauncherApp>>): string {
  const last = placed.map((record) => record.body?.position ?? '').reduce((a, b) => (b > a ? b : a), '');
  return positionBetween(last || null);
}

/** The made app on the launcher a proposal updates, if it still is one */
export const updated = (
  proposal: NodeRecord<LauncherApp>,
  placed: ReadonlyArray<NodeRecord<LauncherApp>>,
): NodeRecord<LauncherApp> | undefined =>
  proposal.body?.updates === undefined
    ? undefined
    : placed.find((record) => record.key === proposal.body?.updates && record.body?.builtIn === undefined);

/**
 * What agents read to propose an app here, written in the space as a guide
 * on `launcher.app`, so one finds it with `collections_list`.
 */
const LAUNCHER_GUIDE = `To make an app for this space that people open from its launcher:

1. Propose the collections it needs with collections_propose (one std.blueprint). Use standard ones by name where they fit. Note its key.
2. Write one launcher.app record with records_put:
   { "title": "Carpool", "description": "What it is for, in a sentence", "collections": ["carpool.trip", "carpool.seat"],
     "notify": [{ "label": "New trip", "collection": "carpool.trip" }] }
   with links [{ "rel": "blueprint", "to": "<the blueprint's key>" }].
   "collections" names every collection it shows. "notify" is optional: what is worth hearing about, each naming one of
   its collections; add "topic": { "field": "driver", "me": true } for only records naming the person looking.
3. If plain lists and forms can't show it (a game board, a calendar, a whiteboard), add "screen": its own HTML UI, one
   document, and, only if it must reach the network, "network": the exact origins. The screen is described below.

Nothing changes until someone who may define collections adds it from the Apps page: that applies the blueprint and
writes the record again as theirs. A launcher.app record that person did not write is only a proposal, and its screen
never runs. To change an app that is already added, write a new launcher.app record with "updates": the key of the one
it replaces, and, if its collections change, a new blueprint whose "updates" names the old blueprint.

Removing an app deletes its launcher.app record; its records stay. A made app may not show launcher.app,
std.blueprint, std.guide or sys.* collections.

How a screen works:

${SCREEN_GUIDE}`;

/**
 * Makes the space ready for apps: defines `launcher.app` and `std.blueprint`
 * when it lacks them, and writes the guide agents read. Only for someone who
 * may define collections; for anyone else it does nothing.
 */
export async function prepareLauncher(node: P2PNode, spaceId: string): Promise<void> {
  if (!mayDefine(await node.spaces.access(spaceId), node.did)) return;
  const here = defined(await node.collections.list(spaceId));
  for (const definition of [launcherApp, blueprint])
    if (!here.has(definition.name)) await node.collections.define(spaceId, definition);
  await writeGuide(node, spaceId, {
    name: 'launcher.apps',
    title: 'Making an app for this space',
    text: LAUNCHER_GUIDE,
    collections: [launcherApp.name, blueprint.name],
  });
}

/** What adding a built-in app needs to know of it */
export interface BuiltIn {
  readonly id: string;
  readonly needs: ReadonlyArray<DefineCollection>;
  readonly uses?: ReadonlyArray<DefineCollection>;
  readonly setup?: (node: P2PNode, spaceId: string) => Promise<void>;
}

/**
 * Adds a built-in app: defines every collection it can use, not only the
 * ones it needs, so an agent asked to do something in it finds them all
 * there; runs its setup; and puts it on the launcher.
 */
export async function addBuiltIn(
  node: P2PNode,
  spaceId: string,
  app: BuiltIn,
  placed: ReadonlyArray<NodeRecord<LauncherApp>>,
): Promise<void> {
  await addSchemas(node, spaceId, [...app.needs, ...(app.uses ?? [])]);
  await app.setup?.(node, spaceId);
  await placeBuiltIn(node, spaceId, app.id, placed);
}

/** Puts a built-in app on the launcher, at the end */
export async function placeBuiltIn(
  node: P2PNode,
  spaceId: string,
  id: string,
  placed: ReadonlyArray<NodeRecord<LauncherApp>>,
): Promise<void> {
  if (placed.some((record) => record.body?.builtIn === id)) return;
  await prepareLauncher(node, spaceId);
  await node.records.put(spaceId, launcherApp, { builtIn: id, position: atEnd(placed) });
}

/** An app as it stands once added: its place is the launcher's, and it updates nothing */
function settled(body: LauncherApp): LauncherApp {
  const { title, description, collections, notify, screen, network } = body;
  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(collections !== undefined ? { collections } : {}),
    ...(notify !== undefined ? { notify } : {}),
    ...(screen !== undefined ? { screen } : {}),
    ...(network !== undefined ? { network } : {}),
  };
}

/**
 * Adds a proposed app: applies the blueprint it points at, if any, then writes
 * the app again as this account's, at the end of the launcher. A proposed
 * change goes into the app it `updates`, which keeps its place, and the
 * proposal goes. Returns the key of the app now on the launcher.
 */
export async function addMade(
  node: P2PNode,
  spaceId: string,
  proposal: NodeRecord<LauncherApp>,
  placed: ReadonlyArray<NodeRecord<LauncherApp>>,
): Promise<string> {
  const body = proposal.body;
  if (!body) throw new Error('This app could not be read');
  const problem = checkLauncherApp(body);
  if (problem) throw new Error(problem);
  await prepareLauncher(node, spaceId);
  const plan = proposal.links.find((link) => link.rel === 'blueprint')?.to;
  if (plan) await applyBlueprint(node, spaceId, plan);
  const here = defined(await node.collections.list(spaceId));
  const missing = (body.collections ?? []).filter((name) => !here.has(name));
  if (missing.length)
    throw new Error(`The space has no ${missing.join(' or ')}, and this app proposes no collections to add`);
  const rest = settled(body);
  // A change to an app no longer on the launcher, or to a built-in one, is added as an app of its own.
  const target = updated(proposal, placed);
  if (target) {
    await node.records.update<LauncherApp>(
      spaceId,
      target.key,
      { ...rest, ...(target.body?.position ? { position: target.body.position } : {}) },
      { links: proposal.links },
    );
    await node.records.delete(spaceId, proposal.key);
    return target.key;
  }
  await node.records.update<LauncherApp>(spaceId, proposal.key, { ...rest, position: atEnd(placed) });
  return proposal.key;
}

/**
 * Takes an app off the launcher. Its collections and records stay. For a
 * built-in app, every record naming it goes, so one two people added at once
 * doesn't come back.
 */
export async function removeApp(
  node: P2PNode,
  spaceId: string,
  record: NodeRecord<LauncherApp>,
  records: ReadonlyArray<NodeRecord<LauncherApp>>,
): Promise<void> {
  const id = record.body?.builtIn;
  const all = id === undefined ? [record] : records.filter((one) => one.body?.builtIn === id && !one.deleted);
  for (const one of all) await node.records.delete(spaceId, one.key);
}

/**
 * Moves an app on the launcher to sit at `to` among the others. Usually only
 * it is written. Records with no position, or two with the same one, get new
 * positions too, so the order shown is the order kept.
 */
export async function moveApp(
  node: P2PNode,
  spaceId: string,
  placed: ReadonlyArray<NodeRecord<LauncherApp>>,
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
      await node.records.update<LauncherApp>(spaceId, record.key, { ...record.body, position });
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
        permissions: held.permissions,
        rules: held.rules,
        topics: held.topics,
      };

/**
 * Proposes an app in another space: its collections as this space holds them,
 * as a blueprint there, and the app pointing at it. People there decide for
 * themselves.
 */
export async function copyApp(
  node: P2PNode,
  fromSpace: string,
  record: NodeRecord<LauncherApp>,
  toSpace: string,
): Promise<void> {
  const body = record.body;
  if (!body) throw new Error('This app could not be read');
  const held = await node.collections.list(fromSpace);
  const drafts = (body.collections ?? []).flatMap((name) => {
    const found = held.find((c) => c.name === name);
    const draft = found ? toDraft(found) : null;
    return draft ? [draft] : [];
  });
  const plan = await proposeCollections(node, toSpace, {
    title: body.title ?? 'An app',
    ...(body.description !== undefined ? { description: body.description } : {}),
    collections: drafts,
    from: `${fromSpace}/${record.key}`,
  });
  await node.records.put(toSpace, launcherApp, settled(body), {
    links: [{ rel: 'blueprint', to: plan.key }],
  });
}
