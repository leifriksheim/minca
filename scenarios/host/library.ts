/**
 * The scenarios' grants, judged by the real library: each story is turned
 * into a space's genesis and access history (spec 03 §1–§4) and replayed by
 * `strong-remove/1` in `packages/core/src/space/roles.ts`, and every question
 * is asked of the state the replay gives. Only the story's shape is the
 * scenarios' own: a place in one linear history (`at`), and what each entry
 * had seen (`view`), become each event's `seen`.
 *
 * Entries the protocol has no record for count for nothing, as the plan says
 * they must: a delegation outside a definition (a founder's later one
 * included), or to anything but its role, or a nesting outside a
 * definition by someone other than the founder, which is written as the
 * definition it would have to be, and refused unless its author may define
 * the role.
 */
import {
  may as libraryMay,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessGenesis,
  type AccessHistory,
  type AccessState,
} from '../../packages/core/src/space/roles.js';
import { RECORD_DELETE, RECORD_WRITE, type FoundingRole } from '../../packages/core/src/space/grants.js';
import type { SpaceGrant as Grant } from '../../packages/core/src/types.js';
import { isRecord, type Json, type Policy } from './ucan-policy.js';

/** A place in the history, and what was seen there */
interface Placed {
  readonly at?: number;
  /** The last place it had seen; by default everything before `at` */
  readonly view?: number;
}

/** `iss` delegates `cmd` under `pol` to `aud`; part of the definition `def` when it names one */
export interface Delegation extends Placed {
  readonly iss: string;
  readonly aud: string;
  readonly cmd: string;
  readonly pol: Policy;
  readonly def?: string;
}

/** A definition of `role` by `by`: its grants are the delegations, and its nestings the nestings, naming it */
export interface Definition extends Placed {
  readonly id: string;
  readonly by: string;
  readonly role: string;
  /** Which definitions it saw; only its own place decides that here */
  readonly saw?: ReadonlyArray<string>;
}

/** `by` assigns the role `role` to `to` */
export interface Assignment extends Placed {
  readonly by: string;
  readonly to: string;
  readonly role: string;
}

/** `by` puts `role` inside `holds`: members of `role` hold what `holds` holds */
export interface Nesting extends Placed {
  readonly by: string;
  readonly role: string;
  readonly holds: string;
  readonly def?: string;
}

/** `by` takes `role` from `from` */
export interface Unassignment extends Placed {
  readonly by: string;
  readonly from: string;
  readonly role: string;
  readonly at: number;
}

/** `by` removes `who` from the space */
export interface Removal extends Placed {
  readonly by: string;
  readonly who: string;
  readonly at: number;
}

export interface Authority {
  /** The space's founder, alone for now (03 §2.1); a constitution with no top is played by a placeholder */
  readonly founders: ReadonlyArray<string>;
  readonly delegations: ReadonlyArray<Delegation>;
  readonly assignments: ReadonlyArray<Assignment>;
  readonly definitions?: ReadonlyArray<Definition>;
  readonly nestings?: ReadonlyArray<Nesting>;
  readonly unassignments?: ReadonlyArray<Unassignment>;
  readonly removals?: ReadonlyArray<Removal>;
}

const NOW = Number.POSITIVE_INFINITY;
const GENESIS = 'scenario-space';
const roleOf = (aud: string) => (aud.startsWith('role:') ? aud.slice('role:'.length) : null);

/** Where an entry is judged: as of its view, or its place; founding state before everything */
const judgedAt = (e: Placed) => (e.view !== undefined ? e.view + 0.5 : (e.at ?? Number.NEGATIVE_INFINITY));

interface Built {
  readonly genesis: AccessGenesis;
  readonly events: ReadonlyArray<AccessEvent & { readonly placedAt: number }>;
}

/**
 * The genesis and the events a story makes. Founding entries (no `at`) come
 * first, in the order given, each having seen those before it; placed ones
 * follow, each having seen everything placed before what it judged at.
 */
function build(auth: Authority): Built {
  const founder = auth.founders[0]!;
  if (auth.founders.length !== 1)
    throw new Error('One founder for now: the constitution record comes in step 5');
  const definitions = auth.definitions ?? [];
  const nestings = auth.nestings ?? [];
  // The constitution: the founder's founding grants and nestings, and every role the story names.
  const founding = (e: Placed & { readonly def?: string }) =>
    e.at === undefined &&
    (e.def === undefined ||
      definitions.some((d) => d.id === e.def && d.at === undefined && d.by === founder));
  const names = new Set<string>();
  for (const d of auth.delegations) if (roleOf(d.aud)) names.add(roleOf(d.aud)!);
  for (const a of auth.assignments) names.add(a.role);
  for (const d of definitions) names.add(d.role);
  for (const n of nestings) names.add(n.role).add(n.holds);
  const roles: FoundingRole[] = [...names].sort().map((name) => ({
    name,
    grants: auth.delegations
      .filter((d) => d.iss === founder && d.aud === `role:${name}` && founding(d))
      .map((d): Grant => ({ cmd: d.cmd, pol: d.pol })),
    nests: nestings
      .filter((n) => n.by === founder && n.role === name && founding(n) && n.holds !== name)
      .map((n) => n.holds),
  }));
  const genesis: AccessGenesis = { id: GENESIS, creator: founder, roles };

  const entries: Array<{
    readonly placed: Placed;
    readonly make: (seen: string[], id: string) => AccessEvent;
  }> = [];
  const base = (id: string, root: string, seen: string[]) => ({
    id,
    root,
    author: root,
    seen,
    cutoff: new Map(),
  });
  for (const a of auth.assignments)
    entries.push({
      placed: a,
      make: (seen, id) => ({
        ...base(id, a.by, seen),
        key: `assign:${a.to}|${a.role}`,
        kind: 'assign',
        did: a.to,
        role: a.role,
        assigned: true,
      }),
    });
  for (const u of auth.unassignments ?? [])
    entries.push({
      placed: u,
      make: (seen, id) => ({
        ...base(id, u.by, seen),
        key: `assign:${u.from}|${u.role}`,
        kind: 'assign',
        did: u.from,
        role: u.role,
        assigned: false,
      }),
    });
  for (const r of auth.removals ?? [])
    entries.push({
      placed: r,
      make: (seen, id) => ({ ...base(id, r.by, seen), key: `remove:${r.who}`, kind: 'remove', did: r.who }),
    });
  const definition = (role: string, by: string, def: string | undefined, placed: Placed) =>
    entries.push({
      placed,
      make: (seen, id) => ({
        ...base(def ?? id, by, seen),
        key: `role:${role}`,
        kind: 'role',
        name: role,
        grants: auth.delegations
          .filter((d) => def !== undefined && d.def === def && d.iss === by && d.aud === `role:${role}`)
          .map((d): Grant => ({ cmd: d.cmd, pol: d.pol })),
        nests: nestings
          .filter(
            (n) =>
              (def !== undefined ? n.def === def : n.def === undefined && n.at === placed.at) &&
              n.by === by &&
              n.role === role,
          )
          .map((n) => n.holds),
      }),
    });
  for (const d of definitions)
    if (!(d.at === undefined && d.by === founder)) definition(d.role, d.by, d.id, d);
  // A nesting outside any definition, by anyone but the founder: the definition it would have to be.
  for (const n of nestings)
    if (n.def === undefined && !(n.at === undefined && n.by === founder))
      definition(n.role, n.by, undefined, n);

  const ordered = entries
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => (a.placed.at ?? -Infinity) - (b.placed.at ?? -Infinity) || a.i - b.i);
  const events: Array<AccessEvent & { readonly placedAt: number }> = [];
  ordered.forEach((entry, n) => {
    const id = `e${String(n).padStart(4, '0')}`;
    const cut = judgedAt(entry.placed);
    // Founding entries saw the founding ones before them; placed ones, everything placed before their view.
    const seen = events
      .filter((e, k) =>
        entry.placed.at === undefined ? true : e.placedAt < cut || (e.placedAt === -Infinity && k < n),
      )
      .map((e) => e.id);
    const event = entry.make(seen.length ? seen : [GENESIS], id);
    events.push({ ...event, placedAt: entry.placed.at ?? -Infinity });
  });
  return { genesis, events };
}

/** The history a story gives, replayed by the library */
function replay(
  auth: Authority,
  more: ReadonlyArray<AccessEvent> = [],
): { built: Built; history: AccessHistory } {
  const built = build(auth);
  return { built, history: replayAccess(built.genesis, [...built.events, ...more]) };
}

/** What had been placed before `at`: the events a version judged there names as seen */
const cutBefore = (built: Built, at: number) => {
  const ids = built.events.filter((e) => e.placedAt < at).map((e) => e.id);
  return ids.length ? ids : [GENESIS];
};

/** The state as of `at`: the events placed before it, as the replay judges them */
function stateAt(auth: Authority, at: number): AccessState {
  const { built, history } = replay(auth);
  return history.at(cutBefore(built, at))!;
}

/** Whether `who` may invoke `cmd` with `args`, as of `at` */
export function mayIn(auth: Authority, who: string, cmd: string, args: Json, at = NOW): boolean {
  return libraryMay(stateAt(auth, at), who, cmd, args);
}

/** The arguments of a command about a target, as a peer fills them in: `{ role?, self, roles }` */
export function argsFor(auth: Authority, invoker: string, target: string, role?: string, at = NOW): Json {
  const roles = [...rolesOf(stateAt(auth, at), target)];
  const self = invoker === target;
  return role === undefined ? { self, roles } : { role, self, roles };
}

/**
 * Whether a reduction strikes an action made concurrently with it: the
 * action, made having seen what was placed before `at`, and the reduction
 * (the story's own, placed after the action, or else one the founder makes
 * having seen the story) that the action had not seen. A record command is
 * judged as a record; any other as a change to the access history.
 */
export function strikes(
  auth: Authority,
  reduction: { readonly who: string; readonly role?: string },
  action: { readonly who: string; readonly cmd: string; readonly args: Json; readonly at: number },
): boolean {
  const built = build(auth);
  const founder = auth.founders[0]!;
  const existing =
    reduction.role === undefined
      ? (auth.removals ?? []).some((r) => r.who === reduction.who && r.at > action.at)
      : (auth.unassignments ?? []).some(
          (u) => u.from === reduction.who && u.role === reduction.role && u.at > action.at,
        );
  const everything = built.events.map((e) => e.id);
  const reductionEvent: AccessEvent[] = existing
    ? []
    : [
        reduction.role === undefined
          ? {
              id: 'zz-reduction',
              root: founder,
              author: founder,
              seen: everything,
              cutoff: new Map(),
              key: `remove:${reduction.who}`,
              kind: 'remove',
              did: reduction.who,
            }
          : {
              id: 'zz-reduction',
              root: founder,
              author: founder,
              seen: everything,
              cutoff: new Map(),
              key: `assign:${reduction.who}|${reduction.role}`,
              kind: 'assign',
              did: reduction.who,
              role: reduction.role,
              assigned: false,
            },
      ];
  const seen = cutBefore(built, action.at);
  if (action.cmd === RECORD_WRITE || action.cmd === RECORD_DELETE || action.cmd.startsWith('/record')) {
    const history = replayAccess(built.genesis, [...built.events, ...reductionEvent]);
    const needs = (state: AccessState, without?: string) =>
      libraryMay(state, action.who, action.cmd, action.args, without ? { without } : {});
    const verdict = history.judge({ id: 'zz-action', root: action.who, seen }, needs);
    return !verdict.ok && verdict.withdrawn === true;
  }
  const role = isRecord(action.args) && typeof action.args.role === 'string' ? action.args.role : '';
  const event: AccessEvent = {
    id: 'zz-action',
    root: action.who,
    author: action.who,
    seen,
    cutoff: new Map(),
    key: `assign:x|${role}`,
    kind: 'assign',
    did: 'did:key:target',
    role,
    assigned: true,
  };
  const without = replayAccess(built.genesis, [...built.events, event]);
  if (without.status(event.id)?.status !== 'applied') return false;
  const history = replayAccess(built.genesis, [...built.events, ...reductionEvent, event]);
  return history.status(event.id)?.status !== 'applied';
}
