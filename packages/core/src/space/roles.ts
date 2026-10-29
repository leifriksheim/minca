/**
 * Who may do what in a space: its roles and their grants, the accounts
 * assigned to them, its invites, and the history of changes to them, replayed
 * the same way on every peer by `strong-remove/1`.
 *
 * It answers one question: *may this account invoke this command with these
 * arguments here, as of this point in the space's history?*
 *
 * **Grants.** A role holds grants (`space/grants.ts`). The constitution's
 * grants are a role's first definition; a later one replaces them. A
 * definition holds only what its author could do, and rival definitions hold
 * only what they share.
 *
 * **Accounts.** An account holds power only through its roles. Under
 * `top: { founders }` the founders hold every command, and only each founder
 * itself can remove one, change its roles or make it step down.
 *
 * **The access history.** Every change names in `seen` the latest changes its
 * author knew of. No order over that graph decides anything (spec 03 §4):
 *
 * 1. A change is allowed when its author had the power in its own view.
 * 2. A removal or unassignment strikes what its account did that it hadn't
 *    seen. A revoke, a fork proof or a closed invite strikes what it reaches.
 *    Changes that strike each other all stand.
 * 3. The state is a merge of the valid changes: on each record the latest.
 */

import { commandCovers } from '../identity/ucan.js';
import { canonicalize } from '../schema/version.js';
import { isObject } from '../utils/guards.js';
import {
  COLLECTION_DEFINE,
  grantFits,
  grantShape,
  KEY_CHANGE,
  MEMBER_REMOVE,
  ROLE_ASSIGN,
  ROLE_DEFINE,
  ROLE_UNASSIGN,
  SPACE_KEEPERS,
  SPACE_RELAYS,
  SPACE_SUCCEED,
  type FoundingRole,
} from './grants.js';
import type { SpaceGrant as Grant } from '../types.js';

export const ROLE_COLLECTION = 'sys.role';
/** Assigning a role to an account, and taking it away */
export const ASSIGN_COLLECTION = 'sys.assign';
export const REMOVE_COLLECTION = 'sys.remove';
export const INVITE_COLLECTION = 'sys.invite';
export const REVOKE_COLLECTION = 'sys.revoke';
/** Collection definitions: what a version must keep to */
export const DEFINITION_COLLECTION = 'sys.collection';
/** Which of a private space's keys is current; the key itself travels sealed (`sys.box`) */
export const KEY_COLLECTION = 'sys.key';
/** The relays the space's members meet at */
export const RELAYS_COLLECTION = 'sys.relays';
/** Nodes that hold the whole space, and how many a write should reach */
export const KEEPERS_COLLECTION = 'sys.keepers';
/** A fork proof: two versions one key signed at one place in its line (02 §4.10) */
export const FORK_COLLECTION = 'sys.fork';
/** A founder stepping down: it keeps its roles, and is a founder no more */
export const STEPDOWN_COLLECTION = 'sys.stepdown';
/** A space that succeeds this one, by its id. It changes nothing here. */
export const SUCCEED_COLLECTION = 'sys.succeed';

/** The one resolver there is: a removal strikes what its account did concurrently (spec 03 §4) */
export const STRONG_REMOVE = 'strong-remove/1';
/** Every resolver this peer knows. A space naming another is not judged here. */
export const RESOLVERS: ReadonlySet<string> = new Set([STRONG_REMOVE]);

const accessKind = (collection: string, prefix: string, clear = true) =>
  Object.freeze({ collection, prefix, clear });

/**
 * Each kind of change: its collection, its record keys' prefix, and whether a
 * private space keeps it in the clear so a peer without the key can judge it.
 * Collection definitions stay sealed: only readers need their rules.
 */
export const ACCESS_KINDS: Readonly<Record<AccessEvent['kind'], ReturnType<typeof accessKind>>> =
  Object.freeze({
    role: accessKind(ROLE_COLLECTION, 'role:'),
    assign: accessKind(ASSIGN_COLLECTION, 'assign:'),
    remove: accessKind(REMOVE_COLLECTION, 'remove:'),
    invite: accessKind(INVITE_COLLECTION, 'invite:'),
    revoke: accessKind(REVOKE_COLLECTION, 'revoke:'),
    definition: accessKind(DEFINITION_COLLECTION, 'collection:', false),
    key: accessKind(KEY_COLLECTION, 'key:'),
    relays: accessKind(RELAYS_COLLECTION, 'relays:'),
    keepers: accessKind(KEEPERS_COLLECTION, 'keepers:'),
    fork: accessKind(FORK_COLLECTION, 'fork:'),
    stepdown: accessKind(STEPDOWN_COLLECTION, 'stepdown:'),
    succeed: accessKind(SUCCEED_COLLECTION, 'succeed:'),
  });

/** Every collection whose records are part of the access history */
export const ACCESS_COLLECTIONS: ReadonlySet<string> = new Set(
  Object.values(ACCESS_KINDS).map(({ collection }) => collection),
);

// ─── Events ───────────────────────────────────────────────────────────

interface EventBase {
  readonly id: string;
  /** The record key it changes: `role:moderator`, `assign:…`, `collection:…` */
  readonly key: string;
  /** The account behind the key that signed it */
  readonly root: string;
  /** The key that signed it */
  readonly author: string;
  /** The latest access changes its author knew of */
  readonly seen: ReadonlyArray<string>;
  /** Its place in its key's line for its collection: what forks and cutoffs reach */
  readonly line?: number;
  /** What it leaves standing of what it takes */
  readonly cutoff: Cutoff;
}

/** A key whose line for a collection forked, and the place from which its versions there stop counting */
export interface ForkedLine {
  readonly writer: string;
  readonly collection: string;
  readonly from: number;
}

/** Key DID → collection → the place in that line at and below which is covered */
export type Cutoff = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type AccessEvent = EventBase &
  (
    | {
        /** A role's definition: it replaces the definitions it saw */
        readonly kind: 'role';
        readonly name: string;
        readonly title?: string;
        readonly grants: ReadonlyArray<Grant>;
        readonly nests: ReadonlyArray<string>;
      }
    | {
        /** `/role/assign`, or with `assigned: false` `/role/unassign` */
        readonly kind: 'assign';
        readonly did: string;
        readonly role: string;
        readonly assigned: boolean;
        /** The invite's public key, when the runtime checked the invite's signature on this record */
        readonly viaInvite?: string;
      }
    | { readonly kind: 'remove' | 'stepdown'; readonly did: string }
    | { readonly kind: 'succeed'; readonly space: string }
    | { readonly kind: 'invite'; readonly inviteKey: string; readonly role: string; readonly open: boolean }
    /** `target`: every version that key signed for this account, past the cutoff, stops counting */
    | { readonly kind: 'revoke'; readonly target: string }
    | { readonly kind: 'definition'; readonly name: string; readonly deleted: boolean }
    /** `keyId`: the new key's hash; `readKey`: what readers prove they hold */
    | { readonly kind: 'key'; readonly keyId: string; readonly readKey: string }
    | ({ readonly kind: 'fork' } & ForkedLine)
    | { readonly kind: 'relays'; readonly relays: ReadonlyArray<string> }
    /** `copies`: how many keepers a write should reach; null for the default */
    | { readonly kind: 'keepers'; readonly keepers: ReadonlyArray<Keeper>; readonly copies: number | null }
  );

/** A node that keeps a space whole: its key, as it appears to peers, and a name for people */
export interface Keeper {
  readonly did: string;
  readonly name: string;
}

/** How many keepers a space may name */
export const MAX_KEEPERS = 16;

/** Why a list of keepers can't be a space's, or null */
export function checkKeepers(keepers: unknown, copies: unknown = null): string | null {
  if (!Array.isArray(keepers) || keepers.length > MAX_KEEPERS)
    return `A space names at most ${MAX_KEEPERS} keepers`;
  const list: unknown[] = keepers;
  for (const keeper of list) {
    if (!isObject(keeper) || !isKeeperDid(keeper.did)) return 'A keeper is named by its did:key';
    if (typeof keeper.name !== 'string' || keeper.name.length > 80)
      return 'A keeper has a name of at most 80 characters';
  }
  const dids = new Set(list.map((keeper) => isObject(keeper) && keeper.did));
  if (dids.size !== list.length) return 'A keeper is named twice';
  if (copies !== null && !isCopies(copies)) return `Copies is a whole number from 1 to ${MAX_KEEPERS}`;
  return null;
}

const isKeeperDid = (did: unknown) =>
  typeof did === 'string' && did.startsWith('did:key:') && did.length <= 200;

const isCopies = (copies: unknown) =>
  typeof copies === 'number' && Number.isSafeInteger(copies) && copies >= 1 && copies <= MAX_KEEPERS;

/** How many relays a space may name */
export const MAX_RELAYS = 8;

/** Why a list of relays can't be a space's, or null */
export function checkRelays(relays: unknown): string | null {
  if (!Array.isArray(relays) || relays.length > MAX_RELAYS)
    return `A space names at most ${MAX_RELAYS} relays`;
  for (const url of relays) {
    const problem = relayProblem(url);
    if (problem) return problem;
  }
  return new Set(relays).size === relays.length ? null : 'A relay is named twice';
}

function relayProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 200) return 'A relay is a URL of at most 200 characters';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a URL`;
  }
  // Another kind of relay goes before the scheme (`nostr+wss://`). Plain ws:// only on this
  // machine: anywhere else it would show the room to everyone on the way.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const transport = /^(?:[a-z][a-z0-9-]*\+)?(wss?):$/.exec(parsed.protocol)?.[1];
  return transport === 'wss' || (transport === 'ws' && local) ? null : `"${url}" is not a wss:// relay`;
}

/** One of a private space's keys, as the history names it */
export interface SpaceKeyEpoch {
  readonly keyId: string;
  readonly readKey: string;
  /** The change that made it current; the space id for the key it started with */
  readonly event: string;
}

/** One definition of a role: its grants count only as far as its author could invoke them, as of `view` */
export interface RoleDefinition {
  /** The definition's id; the space id for the constitution's */
  readonly event: string;
  /** Its author's account; null for the constitution's */
  readonly by: string | null;
  readonly title?: string;
  readonly grants: ReadonlyArray<Grant>;
  /** Roles whose grants members of this one hold too */
  readonly nests: ReadonlyArray<string>;
  /** Where its author's power is judged. Null for the constitution's */
  readonly view: AccessState | null;
}

/** Who holds what, at one point in the history */
export interface AccessState {
  /** They hold every command, and only each founder itself takes its place or its roles */
  readonly founders: ReadonlySet<string>;
  /** Role name → its current definitions: one, or rivals, which hold only the grants they share */
  readonly roles: ReadonlyMap<string, ReadonlyArray<RoleDefinition>>;
  /** Account DID → the roles assigned to it → the assignment's id */
  readonly assigned: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Invite public key → its role, whether open, and who opened it: a join is judged as their assignment */
  readonly invites: ReadonlyMap<
    string,
    {
      readonly role: string;
      readonly open: boolean;
      readonly event: string;
      /** The accounts whose latest changes opened it, sorted */
      readonly by: ReadonlyArray<string>;
    }
  >;
  /** Collection name → the definition in force, and who first defined it (null for rivals' different accounts) */
  readonly definitions: ReadonlyMap<string, { readonly event: string; readonly definedBy: string | null }>;
  /** Collections whose rival first definitions no later one settles → their ids, lowest first (02 §6.3) */
  readonly contested: ReadonlyMap<string, ReadonlyArray<string>>;
  /** A private space's keys, oldest first; the last is current. Empty in a public space. */
  readonly keys: ReadonlyArray<SpaceKeyEpoch>;
  /** Whether someone lost their place since the current key, so a new one is due: the current state's only */
  readonly keyDue: boolean;
  readonly relays: ReadonlyArray<string>;
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach; null for whatever each node defaults to */
  readonly copies: number | null;
  /** Spaces named as successors → the accounts that named each, sorted. Every one stands. */
  readonly successors: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** What a space starts with, from its constitution (`space/constitution.ts`) */
export interface AccessGenesis {
  /** The space id: also the id every change implicitly comes after */
  readonly id: string;
  /** How changes made apart resolve. Only `strong-remove/1` is known */
  readonly resolver: string;
  /** The founders: none under `top: "none"` */
  readonly founders: ReadonlyArray<string>;
  /** The constitution's grants for each are its first definition */
  readonly roles: ReadonlyArray<FoundingRole>;
  /** The roles the constitution assigns: account → role names */
  readonly assigned?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** A private space's first key */
  readonly key?: { readonly keyId: string; readonly readKey: string };
}

export type EventStatus =
  | { readonly status: 'applied'; readonly index: number }
  | { readonly status: 'dropped'; readonly reason: string }
  | { readonly status: 'waiting' };

export type RecordVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly later?: boolean;
      /** Allowed when written, and taken away by a later change: kept, so a version citing it can count it */
      readonly withdrawn?: true;
    };

/** What a record asks of its author, in a state: whether they may do what it does */
export type Needs = (state: AccessState) => boolean;

export interface AccessHistory {
  /** Who holds what once everything held is replayed */
  readonly current: AccessState;
  /** What became of one change */
  status(id: string): EventStatus | null;
  /** The latest applied changes, which a new record's `seen` names: no revokes or fork proofs */
  heads(): ReadonlyArray<string>;
  /** At most `max` heads: first ones that saw the latest change to each of `keys`, then the most recent */
  headsFor(keys: ReadonlyArray<string>, max: number): ReadonlyArray<string>;
  /**
   * The state as of what `seen` names and saw, counting the changes valid in the whole history, or
   * with `within` valid among what both name. Null until all of it is here.
   */
  at(seen: ReadonlyArray<string>, within?: ReadonlyArray<string>): AccessState | null;
  /** The state as its writer saw it: what `seen` names and saw, judged among themselves alone */
  seenAs(seen: ReadonlyArray<string>): AccessState | null;
  /**
   * Whether a record stands: its key not revoked or forked past what covers it, `needs` met as of
   * what it saw and as of the changes that stand, and no unseen removal of its account taking it.
   * With `within`, for a version another cites, only changes the citer saw can take it away.
   */
  judge(
    record: {
      readonly id: string;
      readonly root: string;
      readonly seen: ReadonlyArray<string>;
      /** The key that signed it, its collection, and its place in that key's line there */
      readonly writer?: string;
      readonly collection?: string;
      readonly line?: number;
    },
    needs: Needs,
    within?: ReadonlyArray<string>,
  ): RecordVerdict;
  /** The applied changes by an account that revoked one of its keys */
  revoked(key: string, root: string): ReadonlyArray<string>;
  /** Where a key's line for a collection forked, as the lowest place any applied change proves */
  forked(writer: string, collection: string): { readonly event: string; readonly from: number } | null;
  /** Every key whose line for a collection forked, and from where */
  forks(): ReadonlyArray<ForkedLine>;
  /** Whether any founder, constitution or assignment names an account: it only grows */
  named(did: string): boolean;
  /** Whether any change held opens an invite with this key */
  knownInvite(inviteKey: string): boolean;
  /** The history with one more change, exactly as replaying all gives; null when only a whole replay can say */
  extend(event: AccessEvent): AccessHistory | null;
}

interface MutableState {
  founders: Set<string>;
  roles: Map<string, ReadonlyArray<RoleDefinition>>;
  assigned: Map<string, ReadonlyMap<string, string>>;
  invites: Map<string, { role: string; open: boolean; event: string; by: ReadonlyArray<string> }>;
  definitions: Map<string, { event: string; definedBy: string | null }>;
  contested: Map<string, ReadonlyArray<string>>;
  keys: SpaceKeyEpoch[];
  keyDue: boolean;
  relays: ReadonlyArray<string>;
  keepers: ReadonlyArray<Keeper>;
  copies: number | null;
  successors: Map<string, ReadonlyArray<string>>;
}

function roleDefinition(
  event: string,
  by: string | null,
  role: {
    readonly title?: string;
    readonly grants: ReadonlyArray<Grant>;
    readonly nests?: ReadonlyArray<string>;
  },
  view: AccessState | null,
): RoleDefinition {
  return Object.freeze({
    event,
    by,
    ...(role.title !== undefined ? { title: role.title } : {}),
    grants: role.grants,
    nests: role.nests ?? [],
    view,
  });
}

/** A role's definition from a change, judged in `view` */
function definitionFrom(event: AccessEvent, view: AccessState): RoleDefinition | null {
  return event.kind === 'role' ? roleDefinition(event.id, event.root, event, view) : null;
}

function startState(genesis: AccessGenesis): MutableState {
  // The constitution's assignments are as if made by the space itself: their id is the space's.
  const assigned = new Map<string, ReadonlyMap<string, string>>();
  for (const [did, roles] of Object.entries(genesis.assigned ?? {}))
    assigned.set(did, new Map(roles.map((role) => [role, genesis.id])));
  return {
    founders: new Set(genesis.founders),
    roles: new Map(genesis.roles.map((role) => [role.name, [roleDefinition(genesis.id, null, role, null)]])),
    assigned,
    invites: new Map(),
    definitions: new Map(),
    contested: new Map(),
    keys: genesis.key ? [{ ...genesis.key, event: genesis.id }] : [],
    keyDue: false,
    relays: [],
    keepers: [],
    copies: null,
    successors: new Map(),
  };
}

/** The roles assigned to an account in a state, by name */
export function rolesOf(state: AccessState, did: string): ReadonlyArray<string> {
  return [...(state.assigned.get(did)?.keys() ?? [])].sort();
}

/** Whether an account is a member in a state: a founder, or assigned a role */
export function isMember(state: AccessState, did: string): boolean {
  return state.founders.has(did) || (state.assigned.get(did)?.size ?? 0) > 0;
}

/** Every member: who can read, as far as the history is concerned */
export function readers(state: AccessState): Set<string> {
  const out = new Set(state.founders);
  for (const [did, roles] of state.assigned) if (roles.size > 0) out.add(did);
  return out;
}

/**
 * Whether nobody can run the space any more: no founder is left, and no
 * member may define or assign any role. The library's word, not the
 * protocol's: the way on from a headless space is a successor.
 */
export function headless(state: AccessState): boolean {
  if (state.founders.size > 0) return false;
  const roles = [...state.roles.keys()];
  return ![...readers(state)].some((did) =>
    roles.some(
      (role) =>
        may(state, did, ROLE_DEFINE, { role }) ||
        may(state, did, ROLE_ASSIGN, { role, self: false, roles: [] }),
    ),
  );
}

/** How a question to {@link may} is asked */
export interface MayOptions {
  /** The invocation's body couldn't be read here: policies on `.body` that find no data are left to readers */
  readonly opaque?: boolean;
}

/**
 * Whether an account may invoke a command with these arguments in a state:
 * a founder may invoke anything; anyone else, what a role assigned to it
 * holds, each definition only as far as its author could invoke it (UCAN's
 * attenuation), with what the roles it nests hold.
 */
export function may(
  state: AccessState,
  did: string,
  cmd: string,
  args: unknown,
  options: MayOptions = {},
): boolean {
  if (state.founders.has(did)) return true;
  const roles = rolesOf(state, did);
  if (roles.length === 0) return false;
  const opaque = !!options.opaque;
  const question = `${did}\n${cmd}\n${canonicalize(args)}\n${opaque ? 1 : 0}`;
  return remembered(state, question, () =>
    roles.some((role) =>
      roleHolds(
        state,
        role,
        (grant) => grantFits(grant, cmd, args, opaque),
        (view, by) => may(view, by, cmd, args, { opaque }),
      ),
    ),
  );
}

/** Answers already given in a state, which never changes once made */
const answers = new WeakMap<AccessState, Map<string, boolean>>();

function remembered(state: AccessState, question: string, answer: () => boolean): boolean {
  let known = answers.get(state);
  if (!known) answers.set(state, (known = new Map<string, boolean>()));
  const given = known.get(question);
  if (given !== undefined) return given;
  const result = answer();
  known.set(question, result);
  return result;
}

/** A role as its rival definitions leave it: what they all hold, and the authors whose power bounds it */
function effectiveRole(state: AccessState, role: string) {
  const heads = state.roles.get(role);
  if (!heads?.length) return null;
  const [first, ...rivals] = heads;
  return {
    grants: first!.grants.filter((grant) =>
      rivals.every((rival) => rival.grants.some((other) => grantShape(other) === grantShape(grant))),
    ),
    nests: first!.nests.filter((nested) => rivals.every((rival) => rival.nests.includes(nested))),
    authors: heads.flatMap(({ view, by }) => (view === null || by === null ? [] : [{ view, by }])),
  };
}

/** Whether a role, or one it nests, holds a grant that `fits`, as far as each definition's author did */
function roleHolds(
  state: AccessState,
  role: string,
  fits: (grant: Grant) => boolean,
  authorHolds: (view: AccessState, by: string) => boolean,
  visiting: ReadonlySet<string> = new Set(),
): boolean {
  if (visiting.has(role)) return false;
  const found = effectiveRole(state, role);
  if (!found) return false;
  const inner = new Set(visiting).add(role);
  const held =
    found.grants.some(fits) ||
    found.nests.some((nested) => nested !== role && roleHolds(state, nested, fits, authorHolds, inner));
  return held && found.authors.every(({ view, by }) => authorHolds(view, by));
}

/**
 * Whether an account holds every grant a role gives, each as wide or wider:
 * what it may hand a bot of its own. Only the policies' words are compared, so
 * it may say no where they would allow, never yes where they wouldn't.
 */
export function holdsRole(state: AccessState, did: string, role: string): boolean {
  return grantsOfRole(state, role, new Set()).every((grant) => holdsGrant(state, did, grant));
}

/** What a role gives its members: its current definitions' shared grants, and its nested roles' */
function grantsOfRole(state: AccessState, role: string, visiting: ReadonlySet<string>): ReadonlyArray<Grant> {
  const found = effectiveRole(state, role);
  if (!found || visiting.has(role)) return [];
  const inner = new Set(visiting).add(role);
  return [...found.grants, ...found.nests.flatMap((nested) => grantsOfRole(state, nested, inner))];
}

/** Whether an account holds a grant as wide as `wanted` or wider */
function holdsGrant(state: AccessState, did: string, wanted: Grant): boolean {
  if (state.founders.has(did)) return true;
  const statements = new Set(wanted.pol.map((statement) => canonicalize(statement)));
  const widens = (grant: Grant) =>
    commandCovers(grant.cmd, wanted.cmd) &&
    grant.pol.every((statement) => statements.has(canonicalize(statement)));
  return rolesOf(state, did).some((role) =>
    roleHolds(state, role, widens, (view, by) => holdsGrant(view, by, wanted)),
  );
}

/** The arguments of a command about another account: `{ role?, self, roles }` */
const targetArgs = (state: AccessState, invoker: string, target: string, role?: string) => ({
  ...(role !== undefined ? { role } : {}),
  self: invoker === target,
  roles: rolesOf(state, target),
});

/** Whether any member holds `/space/succeed`, once per state */
const maySucceed = new WeakMap<AccessState, boolean>();
function anyMaySucceed(state: AccessState): boolean {
  let found = maySucceed.get(state);
  if (found === undefined) {
    found = [...readers(state)].some((did) => may(state, did, SPACE_SUCCEED, {}));
    maySucceed.set(state, found);
  }
  return found;
}

/**
 * Why a change is not allowed in a state, or null: its author holds the grant, or it is one of the
 * few things anyone may do for themselves, or it names a successor where no one holds the grant.
 */
export function refusal(event: AccessEvent, state: AccessState): string | null {
  const root = event.root;
  switch (event.kind) {
    case 'role':
      return may(state, root, ROLE_DEFINE, { role: event.name })
        ? null
        : 'Its author may not define this role';
    case 'assign':
      return assignRefusal(event, state);
    case 'remove': {
      if (!isMember(state, event.did)) return 'Not a member';
      // Leaving is built in, for a founder too.
      if (root === event.did) return null;
      if (state.founders.has(event.did)) return 'No one but a founder itself removes a founder';
      return may(state, root, MEMBER_REMOVE, targetArgs(state, root, event.did))
        ? null
        : 'Its author may not remove them';
    }
    case 'invite': {
      // An invite assigns to whoever holds its secret: someone else, holding nothing yet.
      const assigns = (role: string) =>
        state.roles.has(role) && may(state, root, ROLE_ASSIGN, { role, self: false, roles: [] });
      const existing = state.invites.get(event.inviteKey);
      if (existing && !assigns(existing.role)) return 'Its author may not change this invite';
      if (!event.open) return existing ? null : 'There is no such invite to close';
      if (!state.roles.has(event.role)) return `There is no role "${event.role}"`;
      return assigns(event.role) ? null : 'Its author may not invite to this role';
    }
    case 'stepdown':
      if (root !== event.did) return 'Only a founder itself steps down';
      return state.founders.has(event.did) ? null : 'Not a founder';
    case 'succeed': {
      // A successor binds no one, so where no one holds the command, any member may name one.
      if (!isMember(state, root)) return 'Only a member may name a successor';
      if (may(state, root, SPACE_SUCCEED, {})) return null;
      return anyMaySucceed(state) ? 'Its author may not name a successor' : null;
    }
    // A revoke only ever takes from its own account.
    case 'revoke':
      return isMember(state, root) ? null : 'Only a member may revoke a key here';
    // The proof was checked before it got here; a member only has to bring it.
    case 'fork':
      return isMember(state, root) ? null : 'Only a member may report a fork';
    case 'definition':
      return definitionRefusal(event, state);
    case 'key': {
      if (state.keys.length === 0) return 'A public space has no key to change';
      if (!may(state, root, KEY_CHANGE, {})) return "Its author may not change the space's key";
      // Going back to a key a removed member still holds would undo the change.
      return state.keys.some((known) => known.keyId === event.keyId || known.readKey === event.readKey)
        ? 'That key was used before'
        : null;
    }
    case 'relays':
      return may(state, root, SPACE_RELAYS, {})
        ? checkRelays(event.relays)
        : 'Its author may not change where the space meets';
    case 'keepers':
      return may(state, root, SPACE_KEEPERS, {})
        ? checkKeepers(event.keepers, event.copies)
        : 'Its author may not change who keeps the space';
  }
}

function assignRefusal(event: Extract<AccessEvent, { kind: 'assign' }>, state: AccessState): string | null {
  const root = event.root;
  // Roles go to accounts: putting one role inside another is part of a definition.
  if (event.did.startsWith('role:')) return 'A role is assigned to accounts, not to roles';
  const holds = rolesOf(state, event.did).includes(event.role);
  if (event.viaInvite !== undefined) return inviteJoinRefusal(event, event.viaInvite, state, holds);
  // Leaving a role is built in.
  if (!event.assigned && root === event.did) return holds ? null : 'It does not hold that role';
  if (state.founders.has(event.did) && root !== event.did)
    return "No one but a founder itself changes a founder's roles";
  if (!state.roles.has(event.role)) return `There is no role "${event.role}"`;
  const args = targetArgs(state, root, event.did, event.role);
  if (event.assigned)
    return may(state, root, ROLE_ASSIGN, args) ? null : 'Its author may not assign them this role';
  if (!holds) return 'They do not hold that role';
  return may(state, root, ROLE_UNASSIGN, args) ? null : 'Its author may not take this role from them';
}

/** Joining with an invite: your own record, judged as the assignment its openers make */
function inviteJoinRefusal(
  event: Extract<AccessEvent, { kind: 'assign' }>,
  inviteKey: string,
  state: AccessState,
  holds: boolean,
): string | null {
  const invite = state.invites.get(inviteKey);
  if (!event.assigned) return 'An invite only assigns';
  if (event.root !== event.did) return 'Only the person joining can use an invite for themselves';
  if (!invite?.open) return 'The invite is not open';
  if (invite.role !== event.role) return 'The invite is for another role';
  if (holds) return 'Already holds that role';
  if (!state.roles.has(event.role)) return `There is no role "${event.role}"`;
  const openersMay = invite.by.every((opener) =>
    may(state, opener, ROLE_ASSIGN, targetArgs(state, opener, event.did, event.role)),
  );
  return openersMay ? null : 'Whoever opened the invite may not assign this role to them';
}

function definitionRefusal(
  event: Extract<AccessEvent, { kind: 'definition' }>,
  state: AccessState,
): string | null {
  const root = event.root;
  const existing = state.definitions.get(event.name);
  const contested = state.contested.has(event.name);
  const defines = may(state, root, COLLECTION_DEFINE, { collection: event.name });
  if (!existing && !contested) {
    if (event.deleted) return 'There is no such definition to remove';
    return defines ? null : 'Its author may not define this collection';
  }
  if (defines) return null;
  if (contested) return 'Rival definitions of it stand: only someone who may define it may settle them';
  return isMember(state, root) && existing?.definedBy === root
    ? null
    : 'Only whoever defined it, or someone who may define it, may change it';
}

type Reach =
  | { readonly kind: 'account'; readonly root: string }
  | { readonly kind: 'key'; readonly root: string; readonly key: string }
  | { readonly kind: 'line'; readonly key: string; readonly collection: string; readonly from: number }
  | { readonly kind: 'invite'; readonly invite: string };

/**
 * A change that takes from others. A revoke or a fork proof reaches its key's changes whatever
 * either saw, and is never struck; any other reaches only what it had not seen and what had not seen it.
 */
interface Reduction {
  readonly id: string;
  readonly reach: Reach;
  readonly cutoff: Cutoff;
}

/** The lowest fork proof of a line */
type Fork = Reduction & { readonly reach: Extract<Reach, { readonly kind: 'line' }> };

/** A change, or a record judged against the history */
interface Subject {
  readonly root: string;
  readonly writer?: string;
  readonly collection?: string;
  readonly line?: number;
  readonly viaInvite?: string;
}

const NO_CUTOFF: Cutoff = new Map();

/** Whether a reduction reaches its key's changes whatever either saw */
const reachesBack = (reduction: Reduction) =>
  reduction.reach.kind === 'key' || reduction.reach.kind === 'line';

/** What a change takes, in its own view: null when it takes nothing */
function reductionOf(event: AccessEvent, view: AccessState): Reduction | null {
  const of = (reach: Reach, cutoff = event.cutoff): Reduction => ({ id: event.id, reach, cutoff });
  const account = (holds: boolean, did: string) => (holds ? of({ kind: 'account', root: did }) : null);
  switch (event.kind) {
    case 'remove':
      return account(isMember(view, event.did), event.did);
    case 'stepdown':
      return account(view.founders.has(event.did), event.did);
    case 'assign':
      return account(!event.assigned && rolesOf(view, event.did).includes(event.role), event.did);
    case 'invite':
      return event.open ? null : of({ kind: 'invite', invite: event.inviteKey });
    case 'revoke':
      return of({ kind: 'key', root: event.root, key: event.target });
    // A fork proof carries no cutoff: its place is where it starts to reach.
    case 'fork':
      return of(
        { kind: 'line', key: event.writer, collection: event.collection, from: event.from },
        NO_CUTOFF,
      );
    default:
      return null;
  }
}

/** Whether a reduction reaches a change or a record that its cutoff doesn't cover */
function reaches(reduction: Reduction, subject: Subject): boolean {
  if (coveredBy(reduction.cutoff, subject)) return false;
  const { writer, collection, line } = subject;
  const reach = reduction.reach;
  switch (reach.kind) {
    // Everything its account did: what an action needed is judged in a view its author chooses.
    case 'account':
      return subject.root === reach.root;
    case 'key':
      return subject.root === reach.root && writer === reach.key;
    case 'line':
      return writer === reach.key && collection === reach.collection && (line ?? 0) >= reach.from;
    case 'invite':
      return subject.viaInvite === reach.invite;
  }
}

function coveredBy(cutoff: Cutoff, { writer, collection, line }: Subject): boolean {
  if (writer === undefined || collection === undefined || line === undefined) return false;
  return (cutoff.get(writer)?.get(collection) ?? -1) >= line;
}

/** Adds a valid reduction to what judging looks up: by the account or key it reaches, and each line's lowest fork */
function indexReduction(
  taken: Map<string, ReadonlyArray<Reduction>>,
  forks: Map<string, Fork>,
  reduction: Reduction,
): void {
  const reach = reduction.reach;
  if (reach.kind === 'line') {
    const line = lineOf(reach.key, reach.collection);
    if (reach.from < (forks.get(line)?.reach.from ?? Infinity)) forks.set(line, { ...reduction, reach });
  } else if (reach.kind !== 'invite') {
    const who = reach.kind === 'key' ? reach.key : reach.root;
    taken.set(who, [...(taken.get(who) ?? []), reduction]);
  }
}

function setAssigned(state: MutableState, did: string, role: string, event: string | null): void {
  const roles = new Map(state.assigned.get(did) ?? []);
  if (event === null) roles.delete(role);
  else roles.set(role, event);
  if (roles.size === 0) state.assigned.delete(did);
  else state.assigned.set(did, roles);
}

/** Applies a change that saw everything in `state`, in which `view` is the state it saw */
function change(event: AccessEvent, state: MutableState, view: AccessState): void {
  switch (event.kind) {
    case 'role':
      state.roles.set(event.name, [definitionFrom(event, view)!]);
      return;
    case 'assign':
      setAssigned(state, event.did, event.role, event.assigned ? event.id : null);
      return;
    case 'remove':
      // It ends every assignment it saw; a founder who leaves steps down.
      state.assigned.delete(event.did);
      if (event.root === event.did) state.founders.delete(event.did);
      return;
    case 'stepdown':
      state.founders.delete(event.did);
      return;
    case 'succeed':
      state.successors.set(
        event.space,
        sortedUnique([...(state.successors.get(event.space) ?? []), event.root]),
      );
      return;
    case 'invite':
      state.invites.set(event.inviteKey, {
        role: event.role,
        open: event.open,
        event: event.id,
        by: [event.root],
      });
      return;
    case 'revoke':
    case 'fork':
      return;
    case 'definition': {
      // It saw what it changes, so it settles any rivals it saw.
      state.contested.delete(event.name);
      if (event.deleted) {
        state.definitions.delete(event.name);
        return;
      }
      const definedBy = state.definitions.get(event.name)?.definedBy;
      state.definitions.set(event.name, {
        event: event.id,
        definedBy: definedBy !== undefined ? definedBy : event.root,
      });
      return;
    }
    case 'key':
      state.keys.push(keyEpoch(event));
      return;
    case 'relays':
      state.relays = [...event.relays];
      return;
    case 'keepers':
      state.keepers = event.keepers.map((k) => ({ did: k.did, name: k.name }));
      state.copies = event.copies;
      return;
  }
}

// ─── The convergent replay (spec/03-spaces.md §4) ──────────

/**
 * The changes one change saw, directly or not: every change placed before `prefix`, and those in
 * `extra`, by their place in the replay. Changes are placed after everything they saw, so this is
 * mostly one number, where a set of ids would grow with the history.
 */
interface Seen extends Iterable<string> {
  has(id: string): boolean;
  readonly prefix: number;
  readonly extra: ReadonlySet<number>;
  /** A change's own place in the replay */
  placeOf(id: string): number | undefined;
}

/** What a change names in `seen`, once each, leaving out the space itself */
const parentsOf = (event: AccessEvent, genesisId: string) => [
  ...new Set(event.seen.filter((parent) => parent !== genesisId)),
];

/** What a change saw, from what its parents saw, placed by `order` and `index` */
function seenOf(
  parents: ReadonlyArray<string>,
  saw: ReadonlyMap<string, Seen>,
  order: ReadonlyArray<string>,
  index: ReadonlyMap<string, number>,
): Seen {
  let prefix = 0;
  for (const parent of parents) prefix = Math.max(prefix, saw.get(parent)!.prefix);
  const extra = new Set<number>();
  for (const parent of parents)
    for (const n of [...saw.get(parent)!.extra, index.get(parent)!]) if (n >= prefix) extra.add(n);
  while (extra.delete(prefix)) prefix++;
  return {
    prefix,
    extra,
    placeOf: (id: string) => index.get(id),
    has(id: string) {
      const i = index.get(id);
      return i !== undefined && (i < prefix || extra.has(i));
    },
    *[Symbol.iterator]() {
      for (let i = 0; i < prefix; i++) yield order[i]!;
      for (const i of extra) yield order[i]!;
    },
  };
}

interface Replay {
  readonly genesis: AccessGenesis;
  readonly byId: ReadonlyMap<string, AccessEvent>;
  readonly waiting: ReadonlySet<string>;
  /** Placeable changes, ancestors first; ties by id */
  readonly order: ReadonlyArray<string>;
  /** Every change each placeable change saw, directly or not */
  readonly saw: ReadonlyMap<string, Seen>;
  /** Not allowed in their own view, with the reason */
  readonly refused: ReadonlyMap<string, string>;
  /** Valid: allowed, and not struck */
  readonly valid: ReadonlySet<string>;
  readonly struck: ReadonlyMap<string, string>;
  /** The allowed reductions, in order */
  readonly taking: ReadonlyMap<string, Reduction>;
  /** Valid removals, unassignments and stepping down by the account they reach, and revokes by the key */
  readonly taken: ReadonlyMap<string, ReadonlyArray<Reduction>>;
  /** The lowest applied fork of each key's line for each collection, by {@link lineOf} */
  readonly forks: ReadonlyMap<string, Fork>;
  readonly state: AccessState;
  readonly named: ReadonlySet<string>;
  readonly invites: ReadonlySet<string>;
  readonly views: Map<string, AccessState>;
  readonly allowedIds: ReadonlySet<string>;
  /** Each role definition's own view, among the allowed changes */
  readonly defViews: ReadonlyMap<string, AccessState>;
  /** Each valid role definition's view among the valid changes: where the current state judges its grants */
  readonly validDefViews: ReadonlyMap<string, AccessState>;
  /** Which allowed change strikes which: a function of the changes alone */
  readonly strikes: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly index: ReadonlyMap<string, number>;
}

/** The state a set of changes gives, merged: no order, only what saw what (spec 03 §4.4) */
function merge(
  genesis: AccessGenesis,
  events: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  defViews: ReadonlyMap<string, AccessState>,
): MutableState {
  const state = startState(genesis);
  const byKey = new Map<string, AccessEvent[]>();
  // A revoke or a fork proof changes no state.
  for (const event of events)
    if (event.kind !== 'revoke' && event.kind !== 'fork') pushTo(byKey, event.key, event);

  // Removals first: an assignment counts only if it saw every one of its account's.
  const removals = new Map<string, ReadonlyArray<AccessEvent>>();
  for (const group of byKey.values()) {
    if (group[0]?.kind !== 'remove') continue;
    const did = group[0].did;
    removals.set(did, latestOf(group, saw));
    // A founder who leaves is one no more; no one else can remove one.
    if (group.some((event) => event.root === did)) state.founders.delete(did);
    // Every removal saw the constitution: it ends the roles the constitution assigned.
    state.assigned.delete(did);
  }
  let currentKey: AccessEvent | null = null;
  const keyEvents: AccessEvent[] = [];
  for (const group of byKey.values()) {
    const tops = [...latestOf(group, saw)].sort(idOrder);
    const win = tops[0];
    if (!win) continue;
    switch (win.kind) {
      case 'remove':
        continue;
      case 'stepdown':
        state.founders.delete(win.did);
        continue;
      case 'succeed':
        // Every one stands, whoever named it: none is first.
        state.successors.set(win.space, sortedUnique(group.map((event) => event.root)));
        continue;
      case 'role':
        // Rivals all stand: the role holds what they share.
        state.roles.set(
          win.name,
          tops.map((event) => definitionFrom(event, defViews.get(event.id)!)!),
        );
        continue;
      case 'assign': {
        // Taking a role away beats giving it; an assignment counts only if it saw its account's removals.
        const gone = removals.get(win.did) ?? [];
        const counted = tops.some((event) => event.kind === 'assign' && !event.assigned)
          ? undefined
          : tops.find((event) => gone.every((removal) => saw.get(event.id)!.has(removal.id)));
        setAssigned(state, win.did, win.role, counted ? counted.id : null);
        continue;
      }
      case 'invite':
        mergeInvites(tops, win, state);
        continue;
      case 'key':
        // Every key stands; an id picks which is current among keys any author could have made current alone.
        keyEvents.push(...group);
        currentKey = win;
        continue;
      case 'definition':
        mergeDefinitions(tops, group, saw, state);
        continue;
      // `relays` and `keepers`: an id picks among lists any of their authors could have set alone.
      default:
        change(win, state, state);
    }
  }
  if (currentKey) {
    // The current key goes last, the rest by id: only which is current matters.
    const current = currentKey;
    const rest = [...keyEvents].sort(idOrder).filter((event) => event !== current);
    for (const event of [...rest, current]) if (event.kind === 'key') state.keys.push(keyEpoch(event));
  }
  return state;
}

/** The latest changes on one record: those no other on it saw */
function latestOf(
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
): ReadonlyArray<AccessEvent> {
  if (group.length <= 1) return group;
  // In one pass: an event is seen when it is below another's prefix, or among its exceptions.
  let top = -1;
  let topBy = '';
  let second = -1;
  const exceptions = new Set<number>();
  for (const event of group) {
    const seen = saw.get(event.id)!;
    if (seen.prefix > top) {
      second = top;
      top = seen.prefix;
      topBy = event.id;
    } else if (seen.prefix > second) second = seen.prefix;
    for (const n of seen.extra) exceptions.add(n);
  }
  return group.filter((event) => {
    const place = saw.get(event.id)!.placeOf(event.id)!;
    const below = event.id === topBy ? second : top;
    return !(place < below || exceptions.has(place));
  });
}

/**
 * Closed beats open, and open ones naming different roles close it. Rival
 * openers all stand: a join must be one each of them could have made.
 */
function mergeInvites(tops: ReadonlyArray<AccessEvent>, win: AccessEvent, state: MutableState): void {
  const roles = new Set(tops.map((event) => (event.kind === 'invite' ? event.role : '')));
  const closed = tops.find((event) => event.kind === 'invite' && !event.open);
  const pick = closed ?? win;
  if (pick.kind !== 'invite') return;
  state.invites.set(pick.inviteKey, {
    role: pick.role,
    open: !closed && roles.size === 1,
    event: pick.id,
    by: sortedUnique(tops.map((event) => event.root)),
  });
}

/**
 * A state with one change applied on top: the change saw all of it, so it is
 * the latest on its record. Who defined a collection is worked out among `counted`.
 */
function applied(
  state: AccessState,
  event: AccessEvent,
  r: Pick<Replay, 'genesis' | 'saw' | 'byId'>,
  counted: ReadonlySet<string>,
): MutableState {
  const next: MutableState = {
    ...state,
    founders: new Set(state.founders),
    roles: new Map(state.roles),
    assigned: new Map(state.assigned),
    invites: new Map(state.invites),
    definitions: new Map(state.definitions),
    contested: new Map(state.contested),
    keys: [...state.keys],
    successors: new Map(state.successors),
  };
  change(event, next, state);
  if (event.kind === 'key') next.keys = inMergeOrder(next.keys, r.genesis.id);
  if (event.kind === 'definition' && !event.deleted) {
    const group = [...r.saw.get(event.id)!]
      .filter((other) => counted.has(other) && r.byId.get(other)!.key === event.key)
      .map((other) => r.byId.get(other)!)
      .concat(event);
    next.definitions.set(event.name, { event: event.id, definedBy: definerOf(event, group, r.saw) });
  }
  return next;
}

/** Keys in the order a merge gives: the space's own first, the rest by id, the newest last */
function inMergeOrder(keys: ReadonlyArray<SpaceKeyEpoch>, genesisId: string): SpaceKeyEpoch[] {
  const earlier = keys.slice(0, -1);
  const own = earlier.filter((key) => key.event === genesisId);
  const rest = earlier.filter((key) => key.event !== genesisId).sort((a, b) => compare(a.event, b.event));
  return [...own, ...rest, keys.at(-1)!];
}

/**
 * The latest changes to one collection's definition, merged (02 §6.3). One
 * account's alone, or changes by accounts that may each change it, are picked
 * between by id: each could have made its own the latest alone. Anything else
 * (rival first definitions by two accounts, or a delete beside another
 * account's change) is contested: an id can be ground, so no id decides.
 */
function mergeDefinitions(
  tops: ReadonlyArray<AccessEvent>,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  state: MutableState,
): void {
  const sorted = [...tops].sort(idOrder);
  const win = sorted[0]!;
  if (win.kind !== 'definition') return;
  const definitions = sorted.filter((top) => !isDelete(top));
  // Who first defined it, as each latest definition sees it: null where rivals stand.
  const definers = new Set(definitions.map((top) => definerOf(top, group, saw)));
  // Rival firsts are settled only once every latest change saw them all.
  const settled = definitions.every((top) =>
    firstsOf(top, group, saw).every((first) => first === top || saw.get(top.id)?.has(first.id)),
  );
  const oneAccount = new Set(sorted.map((top) => top.root)).size === 1;
  const agreed =
    sorted.length === 1 ||
    oneAccount ||
    (definers.size === 1 && !sorted.some(isDelete) && (!definers.has(null) || settled));
  if (!agreed) {
    state.definitions.delete(win.name);
    state.contested.set(
      win.name,
      sorted.map((top) => top.id),
    );
  } else if (win.deleted) change(win, state, state);
  else state.definitions.set(win.name, { event: win.id, definedBy: definerOf(win, group, saw) });
}

const isDelete = (event: AccessEvent) => event.kind === 'definition' && event.deleted;

/**
 * Whoever defined a collection this time (02 §6.3): the account of its first
 * definitions, if they are all one account's. Rival firsts by two accounts
 * give no one, so only someone who may define it may change it.
 */
function definerOf(
  win: AccessEvent,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
): string | null {
  const roots = new Set(firstsOf(win, group, saw).map((event) => event.root));
  if (roots.size === 0) return win.root;
  return roots.size === 1 ? [...roots][0]! : null;
}

/** The first definitions of the life `win` is in: those of `group` that saw every removal it saw, and no other */
function firstsOf(
  win: AccessEvent,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
): ReadonlyArray<AccessEvent> {
  const removals = group.filter((event) => isDelete(event) && saw.get(win.id)?.has(event.id));
  const life = group.filter(
    (event) =>
      event.kind === 'definition' &&
      !isDelete(event) &&
      (event === win || removals.every((removal) => saw.get(event.id)?.has(removal.id))),
  );
  return life.filter((event) => !life.some((other) => other !== event && saw.get(event.id)?.has(other.id)));
}

/**
 * A graph's strongly connected components, each after those with an edge into
 * it. Tarjan's, without recursion, so a long history can't overflow the stack.
 */
function componentsOf(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): { readonly of: ReadonlyMap<string, number>; readonly list: ReadonlyArray<ReadonlyArray<string>> } {
  let counter = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const work: Array<{ readonly id: string; next: number }> = [];
  const visit = (id: string) => {
    indices.set(id, counter);
    low.set(id, counter++);
    stack.push(id);
    onStack.add(id);
    work.push({ id, next: 0 });
  };
  for (const root of nodes) {
    if (indices.has(root)) continue;
    visit(root);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const out = edges.get(frame.id) ?? [];
      if (frame.next < out.length) {
        const next = out[frame.next++]!;
        if (!indices.has(next)) visit(next);
        else if (onStack.has(next)) low.set(frame.id, Math.min(low.get(frame.id)!, indices.get(next)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === indices.get(frame.id)) {
        const members: string[] = [];
        let top: string;
        do {
          top = stack.pop()!;
          onStack.delete(top);
          members.push(top);
        } while (top !== frame.id);
        found.push(members);
      }
    }
  }
  // Tarjan's finds components sinks first.
  const list = found.reverse();
  const of = new Map<string, number>();
  list.forEach((members, i) => members.forEach((id) => of.set(id, i)));
  return { of, list };
}

const STRUCK = "Its author's power was taken away by a change it had not seen, or rested on one that was";

/** Replays a space's access history. */
export function replayAccess(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  // Another resolver would judge the same changes differently, so this peer doesn't judge the space.
  if (!RESOLVERS.has(genesis.resolver))
    throw new Error(`This peer doesn't know the resolver ${genesis.resolver}, so it can't judge this space`);
  const byId = new Map<string, AccessEvent>();
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);

  const waiting = waitingOf(genesis.id, byId);
  const placeable = [...byId.values()].filter((event) => !waiting.has(event.id));
  const order = ancestorsFirst(placeable, genesis.id);
  const placed = new Set(order);
  for (const event of placeable) if (!placed.has(event.id)) waiting.add(event.id);

  const index = new Map(order.map((id, i) => [id, i]));
  const saw = new Map<string, Seen>();
  for (const id of order) saw.set(id, seenOf(parentsOf(byId.get(id)!, genesis.id), saw, order, index));

  const judged = judgeInOrder(order, { genesis, saw, byId });
  const { allowedIds, taking, strikes, defViews } = judged;
  const within = validWithin(order, { genesis, byId, saw, allowedIds, strikes, defViews });
  const valid = within.valid;
  const struck = new Map<string, string>();
  for (const id of order) if (allowedIds.has(id) && !valid.has(id)) struck.set(id, STRUCK);

  const taken = new Map<string, ReadonlyArray<Reduction>>();
  const forks = new Map<string, Fork>();
  for (const id of order) {
    const reduction = valid.has(id) && taking.get(id);
    if (reduction) indexReduction(taken, forks, reduction);
  }
  const named = new Set<string>([...genesis.founders, ...Object.keys(genesis.assigned ?? {})]);
  const invites = new Set<string>();
  for (const event of byId.values()) {
    if (event.kind === 'assign' && event.assigned) named.add(event.did);
    if (event.kind === 'invite') invites.add(event.inviteKey);
  }
  const state = merge(
    genesis,
    order.filter((id) => valid.has(id)).map((id) => byId.get(id)!),
    saw,
    within.defViews,
  );
  state.keyDue = keyDue(state, { genesis, order, byId, saw, valid, ...judged });
  return historyOf({
    genesis,
    byId,
    waiting,
    order,
    saw,
    index,
    refused: judged.refused,
    valid,
    struck,
    taking,
    taken,
    forks,
    state,
    named,
    invites,
    views: new Map(),
    allowedIds,
    defViews,
    validDefViews: within.defViews,
    strikes,
  });
}

/** Changes that wait until everything they saw is here, and anything that saw them */
function waitingOf(genesisId: string, byId: ReadonlyMap<string, AccessEvent>): Set<string> {
  const waiting = new Set<string>();
  const known = (id: string) => id === genesisId || byId.has(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of byId.values()) {
      if (waiting.has(event.id)) continue;
      if (event.seen.some((parent) => parent === event.id || !known(parent) || waiting.has(parent))) {
        waiting.add(event.id);
        changed = true;
      }
    }
  }
  return waiting;
}

/** Kahn's order, ties by id. A cycle can only be forged: its changes are left out rather than hang it. */
function ancestorsFirst(placeable: ReadonlyArray<AccessEvent>, genesisId: string): string[] {
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const event of placeable) {
    const parents = parentsOf(event, genesisId);
    pending.set(event.id, parents.length);
    for (const parent of parents) pushTo(children, parent, event.id);
  }
  const ready = placeable.filter((event) => pending.get(event.id) === 0).map((event) => event.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order;
}

/**
 * Each change in order, ancestors first: its own view (the allowed changes it
 * saw), whether it is allowed there, what it takes, and the strikes it is part of.
 */
function judgeInOrder(order: ReadonlyArray<string>, r: Pick<Replay, 'genesis' | 'saw' | 'byId'>) {
  const { saw, byId } = r;
  const tookReading = new Set<string>();
  const refused = new Map<string, string>();
  const allowedIds = new Set<string>();
  const strikes = new Map<string, string[]>();
  const afterOf = new Map<string, AccessState>();
  const defViews = new Map<string, AccessState>();
  const taking = new Map<string, Reduction>();
  const allowedView = viewsAlong(r, (id) => allowedIds.has(id), afterOf, defViews);

  for (const id of order) {
    const event = byId.get(id)!;
    const result = step(event, allowedView(event), { ...r, allowedIds, taking });
    if (typeof result === 'string') {
      refused.set(id, result);
      continue;
    }
    allowedIds.add(id);
    afterOf.set(id, result.after);
    if (result.tookReading) tookReading.add(id);
    for (const by of result.reachedBy) if (strikesOn(by, event, saw)) pushTo(strikes, by.id, id);
    const reduction = result.reduction;
    if (!reduction) continue;
    taking.set(id, reduction);
    for (const other of order) {
      if (other === id) break;
      if (allowedIds.has(other) && strikesOn(reduction, byId.get(other)!, saw)) pushTo(strikes, id, other);
    }
  }

  // A stepping down that its key's revoke or fork proof reaches only ends founder status: it
  // strikes nothing, and withdraws nothing.
  const back = [...taking.values()].filter(reachesBack);
  for (const id of order) {
    const event = byId.get(id)!;
    if (event.kind !== 'stepdown' || !allowedIds.has(id)) continue;
    if (back.some((reduction) => reachedBy(reduction, event, saw))) {
      strikes.delete(id);
      taking.delete(id);
    }
  }
  return { tookReading, refused, allowedIds, strikes, afterOf, defViews, taking };
}

/**
 * Whether a new key is due: someone lost reading in a valid change the current
 * key had not seen, or someone who held the current key reads no more, however
 * that came about (two changes together can take reading where neither did alone).
 */
function keyDue(
  state: AccessState,
  r: Pick<Replay, 'genesis' | 'order' | 'byId' | 'saw' | 'valid'> & {
    readonly tookReading: ReadonlySet<string>;
    readonly afterOf: ReadonlyMap<string, AccessState>;
  },
): boolean {
  const keyEvent = state.keys.at(-1)?.event;
  if (keyEvent === undefined) return false;
  const sawByKey = r.saw.get(keyEvent);
  const unseen = (id: string) => r.valid.has(id) && id !== keyEvent && !sawByKey?.has(id);
  if (r.order.some((id) => r.tookReading.has(id) && unseen(id))) return true;
  // Whoever could read as the key was made held it, and so did whoever came to read after.
  const atKey = keyEvent === r.genesis.id ? startState(r.genesis) : r.afterOf.get(keyEvent);
  const held = new Set(atKey ? readers(atKey) : []);
  for (const id of r.order) {
    const event = r.byId.get(id)!;
    if (!r.valid.has(id) || event.kind !== 'assign' || sawByKey?.has(id)) continue;
    const after = r.afterOf.get(id);
    if (after && isMember(after, event.did)) held.add(event.did);
  }
  const now = readers(state);
  return [...held].some((did) => !now.has(did));
}

// Revokes and fork proofs are never struck: every allowed one applies.
const reachedBy = (reduction: Reduction, event: AccessEvent, saw: ReadonlyMap<string, Seen>) =>
  reduction.id !== event.id &&
  event.kind !== 'revoke' &&
  event.kind !== 'fork' &&
  (reachesBack(reduction) ||
    (!saw.get(event.id)!.has(reduction.id) && !saw.get(reduction.id)!.has(event.id))) &&
  reaches(reduction, { ...event, writer: event.author, collection: ACCESS_KINDS[event.kind].collection });

// A stepping down is never struck: founder status can't be given again.
const strikesOn = (reduction: Reduction, event: AccessEvent, saw: ReadonlyMap<string, Seen>) =>
  !(reachesBack(reduction) && event.kind === 'stepdown') && reachedBy(reduction, event, saw);

/**
 * One change judged in its own view, as replaying and extending both do: why it is refused, or the
 * state it leaves, what it takes, whether it took reading, and the reductions before it that reach it.
 */
function step(
  event: AccessEvent,
  view: AccessState,
  r: Pick<Replay, 'genesis' | 'saw' | 'byId' | 'allowedIds' | 'taking'>,
) {
  const reason = refusal(event, view);
  if (reason) return reason;
  const after = applied(view, event, r, r.allowedIds);
  const reduction = reductionOf(event, view);
  // Only a removal, an unassignment or a stepping down can take reading, and only from a member.
  const reach = reduction?.reach;
  return {
    after,
    reduction,
    tookReading: reach?.kind === 'account' && !isMember(after, reach.root),
    reachedBy: [...r.taking.values()].filter((reduction) => reachedBy(reduction, event, r.saw)),
  };
}

/**
 * Each change's view over the changes `counts` keeps among what it saw: along a chain, the one
 * before's view, with it on top when kept; where branches meet, a merge. Asked in order. A role
 * definition's view is kept in `defViews`, where its grants are judged.
 */
function viewsAlong(
  { genesis, saw, byId }: Pick<Replay, 'genesis' | 'saw' | 'byId'>,
  counts: (id: string) => boolean,
  afterOf: ReadonlyMap<string, AccessState>,
  defViews: Map<string, AccessState>,
): (event: AccessEvent) => AccessState {
  const viewOf = new Map<string, AccessState>();
  const viewFor = (event: AccessEvent): AccessState => {
    const parents = parentsOf(event, genesis.id);
    if (parents.length === 0) return startState(genesis);
    if (parents.length === 1)
      return counts(parents[0]!) ? afterOf.get(parents[0]!)! : viewOf.get(parents[0]!)!;
    const counted = [...saw.get(event.id)!].filter(counts).map((other) => byId.get(other)!);
    return merge(genesis, counted, saw, defViews);
  };
  return (event) => {
    const view = viewFor(event);
    viewOf.set(event.id, view);
    if (event.kind === 'role') defViews.set(event.id, view);
    return view;
  };
}

/**
 * The valid changes among `cut` (in replay order, closed under what they saw), and the views their
 * role definitions are judged in. First the strikes: an allowed change is struck by an unstruck one
 * from another component of the strikes inside the cut. Then, ancestors first, a change stays
 * valid only if the valid changes it saw still give its author the power.
 */
function validWithin(
  cut: ReadonlyArray<string>,
  r: Pick<Replay, 'genesis' | 'byId' | 'saw' | 'allowedIds' | 'strikes' | 'defViews'>,
): { readonly valid: ReadonlySet<string>; readonly defViews: ReadonlyMap<string, AccessState> } {
  const out = struckWithin(cut, r);
  const valid = new Set(cut.filter((id) => !out.has(id)));
  if (cut.every((id) => !r.allowedIds.has(id) || valid.has(id))) return { valid, defViews: r.defViews };
  const afterOf = new Map<string, AccessState>();
  const defViews = new Map<string, AccessState>();
  const viewOf = viewsAlong(r, (id) => valid.has(id), afterOf, defViews);
  for (const id of cut) {
    const event = r.byId.get(id)!;
    const view = viewOf(event);
    if (!valid.has(id)) continue;
    if (refusal(event, view)) {
      valid.delete(id);
      continue;
    }
    afterOf.set(id, applied(view, event, r, valid));
  }
  return { valid, defViews };
}

/** The changes in `cut` that are not allowed, or that an unstruck change from another component strikes */
function struckWithin(
  cut: ReadonlyArray<string>,
  r: Pick<Replay, 'byId' | 'allowedIds' | 'strikes'>,
): Set<string> {
  const inCut = new Set(cut);
  const out = new Set(cut.filter((id) => !r.allowedIds.has(id)));
  const edges = new Map<string, string[]>();
  for (const [from, targets] of r.strikes) {
    if (!inCut.has(from) || !r.allowedIds.has(from)) continue;
    const kept = targets.filter((to) => inCut.has(to) && r.allowedIds.has(to));
    if (kept.length > 0) edges.set(from, kept);
  }
  if (edges.size === 0) return out;
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flat()])].sort();
  const { of, list } = componentsOf(nodes, edges);
  const strikers = new Map<string, string[]>();
  for (const [from, targets] of edges)
    for (const to of targets) if (of.get(from) !== of.get(to)) pushTo(strikers, to, from);
  // Visited strikers first. A stepping down is never struck: founder status can't be given back.
  for (const members of list)
    for (const id of members)
      if (r.byId.get(id)?.kind !== 'stepdown' && (strikers.get(id) ?? []).some((from) => !out.has(from)))
        out.add(id);
  return out;
}

/**
 * The replay with one more change that saw every change placed, or null for any other. Such a change
 * strikes nothing and only a revoke or fork can strike it; its view is every allowed change, and it
 * is the latest on its record.
 */
function extended(r: Replay, event: AccessEvent): Replay | null {
  const { genesis } = r;
  // A revoke or a fork proof reaches back, whatever it saw: only replaying whole can say what it strikes.
  if (event.kind === 'revoke' || event.kind === 'fork') return null;
  // With something allowed but not valid, the allowed changes are not the state; and whether a key
  // change is due rests on everyone who held the key. Both are worked out whole.
  if (r.struck.size > 0 || r.state.keyDue) return null;
  const parents = parentsOf(event, genesis.id);
  if (parents.some((parent) => !r.saw.has(parent))) return null;
  const order = [...r.order, event.id];
  const index = new Map(r.index).set(event.id, r.order.length);
  const mine = seenOf(parents, r.saw, order, index);
  if (mine.prefix !== r.order.length || mine.extra.size > 0 || r.waiting.size > 0) return null;

  const saw = new Map(r.saw).set(event.id, mine);
  const byId = new Map(r.byId).set(event.id, event);
  const named = new Set(r.named);
  if (event.kind === 'assign' && event.assigned) named.add(event.did);
  const invites = new Set(r.invites);
  if (event.kind === 'invite') invites.add(event.inviteKey);
  // It saw everything: its view is the current state.
  const view = r.state;
  const withView = (views: ReadonlyMap<string, AccessState>) =>
    event.kind === 'role' ? new Map(views).set(event.id, view) : views;
  const base = {
    genesis,
    byId,
    waiting: r.waiting,
    order,
    saw,
    index,
    named,
    invites,
    views: new Map<string, AccessState>(),
    defViews: withView(r.defViews),
  };

  const result = step(event, view, { ...r, saw, byId });
  if (typeof result === 'string') return { ...r, ...base, refused: new Map(r.refused).set(event.id, result) };
  // It saw every reduction, so only a revoke or fork of its key can strike it.
  const strikers = result.reachedBy;
  // A stepping down its key's revoke reaches only ends founder status: only a whole replay says.
  if (strikers.length > 0 && event.kind === 'stepdown') return null;
  const taking = result.reduction ? new Map(r.taking).set(event.id, result.reduction) : r.taking;
  const allowedIds = new Set(r.allowedIds).add(event.id);
  if (strikers.length > 0) {
    const strikes = new Map(r.strikes);
    for (const { id } of strikers) strikes.set(id, [...(strikes.get(id) ?? []), event.id]);
    return { ...r, ...base, strikes, struck: new Map(r.struck).set(event.id, STRUCK), allowedIds, taking };
  }
  // Every allowed change is valid: the state is it on top of the current one.
  const state = result.after;
  // Due once it takes reading from someone: the key saw everything else.
  state.keyDue = result.tookReading && state.keys.length > 0 && event.kind !== 'key';
  const taken = new Map(r.taken);
  const forks = new Map(r.forks);
  if (result.reduction) indexReduction(taken, forks, result.reduction);
  return {
    ...r,
    ...base,
    validDefViews: withView(r.validDefViews),
    valid: new Set(r.valid).add(event.id),
    allowedIds,
    taking,
    state,
    taken,
    forks,
  };
}

function historyOf(r: Replay): AccessHistory {
  const { genesis } = r;
  const seen = (ids: ReadonlyArray<string>) =>
    ids.every((id) => id === genesis.id || (r.byId.has(id) && !r.waiting.has(id)));
  /** Everything these ids name, and everything they saw */
  const cutOf = (ids: ReadonlyArray<string>) => {
    const cut = new Set<string>();
    for (const id of ids) {
      if (id === genesis.id) continue;
      cut.add(id);
      for (const above of r.saw.get(id) ?? []) cut.add(above);
    }
    return cut;
  };
  const inOrder = (ids: Iterable<string>) => [...ids].sort((a, b) => r.index.get(a)! - r.index.get(b)!);
  const idsKey = (ids: ReadonlyArray<string>) => [...new Set(ids)].sort().join(',');
  /** The merge of what `ids` name and saw, counting the changes valid in all, or among what `within` names and saw */
  const at = (ids: ReadonlyArray<string>, within?: ReadonlyArray<string>): AccessState => {
    const key = `${idsKey(ids)}|${within ? idsKey(within) : '*'}`;
    const known = r.views.get(key);
    if (known) return known;
    const among = within
      ? validWithin(inOrder(cutOf([...ids, ...within])), r)
      : { valid: r.valid, defViews: r.validDefViews };
    const counted = inOrder(cutOf(ids)).flatMap((id) => (among.valid.has(id) ? [r.byId.get(id)!] : []));
    const view = merge(genesis, counted, r.saw, among.defViews);
    r.views.set(key, view);
    return view;
  };
  const changesState = (id: string) => !['revoke', 'fork'].includes(r.byId.get(id)!.kind);
  let heads: ReadonlyArray<string> | null = null;

  const history: AccessHistory = Object.freeze({
    current: r.state,
    status(id: string): EventStatus | null {
      if (r.waiting.has(id)) return { status: 'waiting' };
      if (r.valid.has(id)) return { status: 'applied', index: r.index.get(id)! };
      const reason = r.refused.get(id) ?? r.struck.get(id);
      return reason ? { status: 'dropped', reason } : null;
    },
    heads() {
      if (heads) return heads;
      const live = r.order.filter((id) => r.valid.has(id) && changesState(id));
      heads = Object.freeze(
        live.filter((id) => !live.some((other) => other !== id && r.saw.get(other)!.has(id))).sort(),
      );
      return heads;
    },
    headsFor(keys: ReadonlyArray<string>, max: number) {
      const all = history.heads();
      if (all.length <= max) return all;
      const recent = [...all].sort((a, b) => r.index.get(b)! - r.index.get(a)!);
      const sawOrIs = (head: string, id: string) => head === id || r.saw.get(head)!.has(id);
      const chosen: string[] = [];
      for (const key of keys) {
        const latest = r.order.filter((id) => r.valid.has(id) && r.byId.get(id)!.key === key).at(-1);
        if (!latest || chosen.some((head) => sawOrIs(head, latest))) continue;
        const head = recent.find((id) => sawOrIs(id, latest));
        if (head && !chosen.includes(head)) chosen.push(head);
      }
      for (const id of recent) if (chosen.length < max && !chosen.includes(id)) chosen.push(id);
      return chosen.slice(0, max).sort();
    },
    at(ids: ReadonlyArray<string>, within?: ReadonlyArray<string>) {
      return seen(ids) && (!within || seen(within)) ? at(ids, within) : null;
    },
    seenAs(ids: ReadonlyArray<string>) {
      return seen(ids) ? at(ids, ids) : null;
    },
    judge(record, needs, within) {
      if (!seen(record.seen) || (within && !seen(within)))
        return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      // For a cited version, only what the citer had seen can take it away (02 §7.6).
      const known = within ? cutOf(within) : null;
      const takes = (reduction: Reduction) =>
        (!known || known.has(reduction.id)) && reaches(reduction, record);
      const signed = record.writer === undefined ? [] : (r.taken.get(record.writer) ?? []);
      if (signed.some((reduction) => reduction.reach.kind === 'key' && takes(reduction)))
        return { ok: false, reason: 'The key that signed it was revoked', withdrawn: true };
      const fork =
        record.writer === undefined || record.collection === undefined
          ? undefined
          : r.forks.get(lineOf(record.writer, record.collection));
      if (fork && takes(fork))
        return { ok: false, reason: 'Its writer’s log forked at or before it', withdrawn: true };
      if (!needs(at(record.seen, record.seen)))
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      // A removal or an unassignment it had not seen takes everything.
      const cut = cutOf(record.seen);
      const reduced = (reduction: Reduction) =>
        reduction.reach.kind === 'account' && !cut.has(reduction.id) && takes(reduction);
      if ((r.taken.get(record.root) ?? []).some(reduced))
        return { ok: false, reason: "Its author's access was taken away", withdrawn: true };
      // What it saw counts only as far as it stands: a struck change gives nothing, even cited.
      if (!needs(at(record.seen, within)))
        return {
          ok: false,
          reason: 'It rests on a change to who may do what that was struck',
          withdrawn: true,
        };
      return { ok: true };
    },
    revoked: (key: string, root: string) =>
      (r.taken.get(key) ?? [])
        .filter(({ reach }) => reach.kind === 'key' && reach.root === root)
        .map((revoke) => revoke.id),
    forked: (writer: string, collection: string) => {
      const fork = r.forks.get(lineOf(writer, collection));
      return fork ? { event: fork.id, from: fork.reach.from } : null;
    },
    forks: () =>
      [...r.forks.values()].map(({ reach }) => ({
        writer: reach.key,
        collection: reach.collection,
        from: reach.from,
      })),
    named: (did: string) => r.named.has(did),
    knownInvite: (key: string) => r.invites.has(key),
    extend(event: AccessEvent) {
      if (r.byId.has(event.id)) return history;
      const next = extended(r, event);
      return next && historyOf(next);
    },
  } satisfies AccessHistory);
  return history;
}

// ─── Plumbing ─────────────────────────────────────────────────────────

/** A key's line for one collection, as a map key */
const lineOf = (writer: string, collection: string) => `${writer}\n${collection}`;

const keyEpoch = (event: { readonly keyId: string; readonly readKey: string; readonly id: string }) => ({
  keyId: event.keyId,
  readKey: event.readKey,
  event: event.id,
});

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const idOrder = (a: { readonly id: string }, b: { readonly id: string }) => compare(a.id, b.id);

const sortedUnique = (values: ReadonlyArray<string>) => [...new Set(values)].sort();

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
