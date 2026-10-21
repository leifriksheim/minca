/**
 * Who may do what in a space: its roles and their grants, the accounts
 * assigned to them, its invites, and the history of changes to them —
 * replayed the same way on every peer, by `strong-remove/1`.
 *
 * This module knows people and grants. It knows nothing about polls or
 * todos: it answers one question, *may this account invoke this command with
 * these arguments here, as of this point in the space's history?*
 *
 * **Grants.** A role holds grants (`space/grants.ts`): delegations to the
 * role of a command path under a UCAN policy. The constitution's grants for
 * a role are its first definition; a later definition replaces them. A
 * definition holds only what its author could do as of the definition, and
 * definitions written apart hold only the grants they share.
 *
 * **Accounts.** An account holds power only through the roles assigned to
 * it, and invokes nothing with none. Under `top: { founders }` the founders
 * hold every command, and no one but each founder itself can remove one,
 * change its roles or make it step down. Under `top: "none"` there are no
 * founders, and anyone may be removed by whoever holds the grant.
 *
 * **The access history.** Every change to a role, an assignment, a removal,
 * an invite, a revoked key or a collection definition is a record whose
 * `seen` names the latest changes its author knew of. That makes a small
 * graph, and no order over it decides anything (spec 03 §4):
 *
 * 1. A change is allowed when its author had the power in its own view: the
 *    changes it saw that are valid among what it saw.
 * 2. A removal or an unassignment strikes what its account did that it
 *    hadn't seen, whatever that needed. A revoke, a fork proof or a closed
 *    invite strikes what it reaches. Changes that strike each other all
 *    stand.
 * 3. The state is a merge of the valid changes: on each record the latest.
 *    Rival definitions of a role hold what they share, an unassignment beats
 *    an assignment, and a closed invite an open one.
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

/** A role's definitions */
export const ROLE_COLLECTION = 'sys.role';
/** Assigning a role to an account, and taking it away */
export const ASSIGN_COLLECTION = 'sys.assign';
/** Removing an account from the space */
export const REMOVE_COLLECTION = 'sys.remove';
export const INVITE_COLLECTION = 'sys.invite';
export const REVOKE_COLLECTION = 'sys.revoke';
/** Collection definitions are part of the access history too: what a version must keep to */
export const DEFINITION_COLLECTION = 'sys.collection';
/**
 * A private space's key changes: the new key's id and public read key. The
 * key itself travels sealed to each member (`sys.box`); this record only says
 * which key is current, so a peer without any key can still check readers.
 */
export const KEY_COLLECTION = 'sys.key';
/**
 * Where the space's members meet: the relays it names, so two people whose
 * apps use different relays still find each other. Like a Nostr relay list,
 * but the space's, and changed only by someone granted `/space/relays`.
 */
export const RELAYS_COLLECTION = 'sys.relays';
/**
 * Who keeps the space whole: nodes that hold every record of it — a host, an
 * extension — and how many copies a write should reach before a node that
 * holds only part of the space lets go of it.
 */
export const KEEPERS_COLLECTION = 'sys.keepers';
/**
 * A writer's log forked: two versions one key signed at one place in its line
 * for one collection of this space (02 §4.10). The record carries both, so
 * every peer checks the proof for itself, and the key's versions in that
 * collection from that place on stop counting.
 */
export const FORK_COLLECTION = 'sys.fork';
/** A founder stepping down: it stays, with the roles it holds, and is a founder no more */
export const STEPDOWN_COLLECTION = 'sys.stepdown';
/** A space that succeeds this one, by its id. It changes nothing here. */
export const SUCCEED_COLLECTION = 'sys.succeed';

/** The one resolver there is: a removal strikes what its account did concurrently (spec 03 §4) */
export const STRONG_REMOVE = 'strong-remove/1';
/** Every resolver this peer knows. A space naming another is not judged here. */
export const RESOLVERS: ReadonlySet<string> = new Set([STRONG_REMOVE]);

/** Every collection whose records are part of the access history */
export const ACCESS_COLLECTIONS: ReadonlySet<string> = new Set([
  ROLE_COLLECTION,
  ASSIGN_COLLECTION,
  REMOVE_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  DEFINITION_COLLECTION,
  KEY_COLLECTION,
  RELAYS_COLLECTION,
  KEEPERS_COLLECTION,
  FORK_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
]);

// ─── Events ───────────────────────────────────────────────────────────

interface EventBase {
  readonly id: string;
  /** The record key it changes: `role:moderator`, `assign:…`, `remove:…`, `invite:…`, `collection:…` */
  readonly key: string;
  /** The account behind the key that signed it */
  readonly root: string;
  /** The key that signed it */
  readonly author: string;
  /** The latest access changes its author knew of */
  readonly seen: ReadonlyArray<string>;
  /** Its place in its key's line for its collection here: what forks and cutoffs reach */
  readonly line?: number;
  /**
   * What this change leaves standing of what it takes away: for each key of
   * the account it takes power from, and each collection, the end of the
   * unbroken line of that key's versions in that collection its author held.
   * Versions at or below it are covered.
   */
  readonly cutoff: Cutoff;
}

/** A key whose line for a collection forked, and the place from which its versions there stop counting */
export interface ForkedLine {
  readonly writer: string;
  readonly collection: string;
  readonly from: number;
}

/** Key DID → collection → the place in that key's line for that collection, at and below which is covered */
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
        /** `/role/assign`, or with `assigned: false` `/role/unassign` (leaving, when it is the account's own) */
        readonly kind: 'assign';
        readonly did: string;
        readonly role: string;
        readonly assigned: boolean;
        /** The invite's public key, when the runtime checked the invite's signature on this record */
        readonly viaInvite?: string;
      }
    | {
        /** `/member/remove`, or leaving when it is the account's own */
        readonly kind: 'remove';
        readonly did: string;
      }
    | {
        /** A founder stepping down, built in: only its own */
        readonly kind: 'stepdown';
        readonly did: string;
      }
    | {
        /** `/space/succeed`: the id of a space that succeeds this one */
        readonly kind: 'succeed';
        readonly space: string;
      }
    | { readonly kind: 'invite'; readonly inviteKey: string; readonly role: string; readonly open: boolean }
    | {
        readonly kind: 'revoke';
        /** The key revoked: every version it signed for this change's account, past the cutoff, stops counting */
        readonly target: string;
      }
    | { readonly kind: 'definition'; readonly name: string; readonly deleted: boolean }
    | {
        readonly kind: 'key';
        /** The new key's id: the hash of its bytes, as encrypted bodies name it */
        readonly keyId: string;
        /** The public half of the read key derived from it, which readers prove they hold */
        readonly readKey: string;
      }
    | {
        readonly kind: 'fork';
        /** The key whose log forked */
        readonly writer: string;
        /** The collection whose line forked */
        readonly collection: string;
        /** Where: its versions in that collection here and after no longer count */
        readonly from: number;
      }
    | {
        readonly kind: 'relays';
        /** WebSocket URLs, at most `MAX_RELAYS` */ readonly relays: ReadonlyArray<string>;
      }
    | {
        readonly kind: 'keepers';
        /** Nodes that keep the space whole, at most `MAX_KEEPERS` */
        readonly keepers: ReadonlyArray<Keeper>;
        /** How many keepers a write should reach before a partial node lets go of it; null for the default */
        readonly copies: number | null;
      }
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
  const dids = new Set<string>();
  for (const keeper of list) {
    if (
      !isObject(keeper) ||
      typeof keeper.did !== 'string' ||
      !keeper.did.startsWith('did:key:') ||
      keeper.did.length > 200
    )
      return 'A keeper is named by its did:key';
    if (typeof keeper.name !== 'string' || keeper.name.length > 80)
      return 'A keeper has a name of at most 80 characters';
    dids.add(keeper.did);
  }
  if (dids.size !== list.length) return 'A keeper is named twice';
  if (
    copies !== null &&
    !(typeof copies === 'number' && Number.isSafeInteger(copies) && copies >= 1 && copies <= MAX_KEEPERS)
  ) {
    return `Copies is a whole number from 1 to ${MAX_KEEPERS}`;
  }
  return null;
}

/** How many relays a space may name */
export const MAX_RELAYS = 8;

/** Why a list of relays can't be a space's, or null */
export function checkRelays(relays: unknown): string | null {
  if (!Array.isArray(relays) || relays.length > MAX_RELAYS)
    return `A space names at most ${MAX_RELAYS} relays`;
  for (const url of relays) {
    if (typeof url !== 'string' || url.length > 200) return 'A relay is a URL of at most 200 characters';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `"${url}" is not a URL`;
    }
    // Plain ws:// only on this machine: anywhere else it would show the room to everyone on the way.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && local))
      return `"${url}" is not a wss:// relay`;
  }
  return new Set(relays).size === relays.length ? null : 'A relay is named twice';
}

/** One of a private space's keys, as the history names it */
export interface SpaceKeyEpoch {
  readonly keyId: string;
  readonly readKey: string;
  /** The change that made it current; the space id for the key it started with */
  readonly event: string;
}

/**
 * One definition of a role: the constitution's, or one written since. The
 * grants it holds count only as far as its author could invoke them itself,
 * as of `view`.
 */
export interface RoleDefinition {
  /** The definition's id; the space id for the constitution's */
  readonly event: string;
  /** Its author's account; null for the constitution's, which the space itself issues */
  readonly by: string | null;
  readonly title?: string;
  readonly grants: ReadonlyArray<Grant>;
  /** Roles whose grants members of this one hold too */
  readonly nests: ReadonlyArray<string>;
  /** Its own view: where its author's power is judged. Null for the constitution's */
  readonly view: AccessState | null;
}

/** Who holds what, at one point in the history */
export interface AccessState {
  /** The founders: they hold every command, and only each founder itself takes its place or its roles */
  readonly founders: ReadonlySet<string>;
  /**
   * Role name → its current definitions: one, or rivals none of which saw
   * the others, which hold only the grants they share
   */
  readonly roles: ReadonlyMap<string, ReadonlyArray<RoleDefinition>>;
  /** Account DID → the roles assigned to it → the assignment's id */
  readonly assigned: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Invite public key → its role, whether it is open, and who opened it: a
   * join through it is judged as their assignment
   */
  readonly invites: ReadonlyMap<
    string,
    {
      readonly role: string;
      readonly open: boolean;
      readonly event: string;
      /** The accounts whose latest changes opened it, sorted: one, or rivals for the same role */
      readonly by: ReadonlyArray<string>;
    }
  >;
  /**
   * Collection name → the id of the definition in force, and who first
   * defined it: null when rival first definitions name different accounts
   */
  readonly definitions: ReadonlyMap<string, { readonly event: string; readonly definedBy: string | null }>;
  /**
   * Collections whose rival first definitions, by different accounts, no
   * later one settles → the ids of the latest of them, lowest first. Which is
   * in force is not the replay's to say (02 §6.3: none, unless they all say
   * the same), and only someone who may define it may define it again.
   */
  readonly contested: ReadonlyMap<string, ReadonlyArray<string>>;
  /** A private space's keys, oldest first; the last is current. Empty in a public space. */
  readonly keys: ReadonlyArray<SpaceKeyEpoch>;
  /**
   * Whether someone lost their place in the space since the current key — so
   * a new one is due. Worked out for the history's current state only.
   */
  readonly keyDue: boolean;
  /** The relays the space names — empty until someone names some */
  readonly relays: ReadonlyArray<string>;
  /** The nodes that keep the space whole — empty until someone names some */
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach; null for whatever each node defaults to */
  readonly copies: number | null;
  /**
   * Spaces named as this one's successors → the accounts that named each,
   * sorted. Every one stands, and none is first: which to follow is each
   * member's choice.
   */
  readonly successors: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** What a space starts with, from its constitution (`space/constitution.ts`) */
export interface AccessGenesis {
  /** The space id — also the id every change implicitly comes after */
  readonly id: string;
  /** How changes made apart resolve. Only `strong-remove/1` is known; the replay refuses any other */
  readonly resolver: string;
  /** The founders, who hold every command: none under `top: "none"` */
  readonly founders: ReadonlyArray<string>;
  /** The founding roles: the constitution's grants for each are its first definition */
  readonly roles: ReadonlyArray<FoundingRole>;
  /** The roles the constitution assigns: account → role names */
  readonly assigned?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** A private space's first key, from its constitution */
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
      /**
       * Allowed when written, and refused only because a later change took
       * its author's access away or revoked its key. It is kept, so a
       * version that cites it, and had not seen that change, can count it.
       */
      readonly withdrawn?: true;
    };

/** What a record asks of its author, in a state: whether they may do what it does */
export type Needs = (state: AccessState) => boolean;

export interface AccessHistory {
  /** Who holds what once everything held is replayed */
  readonly current: AccessState;
  /** What became of one change */
  status(id: string): EventStatus | null;
  /**
   * The latest applied changes to who holds what — what a new record's `seen`
   * names. A dropped change is never a head, nor a revoke or a fork proof:
   * none changes the state, and a writer need not name them.
   */
  heads(): ReadonlyArray<string>;
  /**
   * At most `max` heads, chosen so that what they saw holds the latest applied
   * change to each of `keys` (the records a writer's standing rests on), then
   * the most recently applied: what a writer names when there are more.
   */
  headsFor(keys: ReadonlyArray<string>, max: number): ReadonlyArray<string>;
  /**
   * The state a record is judged by, as of what `seen` names: the changes it
   * names and everything they saw, counting only those valid in the whole
   * history, so a change struck since gives nothing even to a record that
   * cites it. With `within`, valid among what `within` and `seen` name
   * instead (a version another cites). Null when some of it is not here.
   */
  at(seen: ReadonlyArray<string>, within?: ReadonlyArray<string>): AccessState | null;
  /**
   * The state as its writer saw it: the changes `seen` names and everything
   * they saw, judged among themselves alone. A record its author couldn't
   * have written here is refused; one that fails only in {@link at} is
   * withdrawn. Null when some of it is not here.
   */
  seenAs(seen: ReadonlyArray<string>): AccessState | null;
  /**
   * Whether a record stands as of what it saw: its key not revoked or forked
   * past where the change that did so covers it, its author allowed by
   * `needs` as of what it saw, still allowed counting only the changes that
   * stand ({@link at}), and no removal or unassignment of its account it had
   * not seen and that doesn't cover it.
   * @param record The record's id, its account, what it saw, and the key that signed it
   * @param needs What the record asks of its author
   * @param within For a version another cites: what the citing version saw.
   *   Only changes among those, and what they saw, can take it away.
   */
  judge(
    record: {
      readonly id: string;
      readonly root: string;
      readonly seen: ReadonlyArray<string>;
      /** The key that signed it */
      readonly writer?: string;
      /** Its collection, and its place in its key's line for that collection */
      readonly collection?: string;
      readonly line?: number;
    },
    needs: Needs,
    within?: ReadonlyArray<string>,
  ): RecordVerdict;
  /** The applied changes by an account that revoked one of its keys */
  revoked(key: string, root: string): ReadonlyArray<string>;
  /** Where a key's line for a collection forked, as the lowest place any applied change proves, if it did */
  forked(writer: string, collection: string): { readonly event: string; readonly from: number } | null;
  /** Every key whose line for a collection forked, and from where */
  forks(): ReadonlyArray<ForkedLine>;
  /**
   * Whether an account appears anywhere in the history — a founder, assigned
   * a role by the constitution, or named by any assignment, whatever became of it. Only grows as changes
   * arrive, so it can decide what to store without two peers ever disagreeing
   * for good.
   */
  named(did: string): boolean;
  /** Whether any change held opens an invite with this key */
  knownInvite(inviteKey: string): boolean;
  /**
   * The history with one more change, made without replaying the rest:
   * exactly what `replayAccess` with every change held and this one gives.
   * Null when only a whole replay can say where it goes — it did not see
   * every change here, or it could change an order already chosen. This
   * history stays as it was.
   */
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

/** The constitution's definition of a founding role */
function founding(genesis: AccessGenesis, role: FoundingRole): RoleDefinition {
  return Object.freeze({
    event: genesis.id,
    by: null,
    ...(role.title !== undefined ? { title: role.title } : {}),
    grants: role.grants,
    nests: role.nests ?? [],
    view: null,
  });
}

function startState(genesis: AccessGenesis): MutableState {
  // The constitution's assignments are as if made by the space itself: their id is the space's.
  const assigned = new Map<string, ReadonlyMap<string, string>>();
  for (const [did, roles] of Object.entries(genesis.assigned ?? {}))
    assigned.set(did, new Map(roles.map((role) => [role, genesis.id])));
  return {
    founders: new Set(genesis.founders),
    roles: new Map(genesis.roles.map((role) => [role.name, [founding(genesis, role)]])),
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

/** Every member — who can read, as far as the history is concerned */
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

/** Answers already given in a state, which never changes once made */
const answers = new WeakMap<AccessState, Map<string, boolean>>();

/**
 * Whether an account may invoke a command with these arguments in a state:
 * a founder may invoke anything; anyone else, what a role assigned to it
 * holds. A role holds what its current definitions all hold, each only as far
 * as its author could invoke it, as of that definition (UCAN's attenuation),
 * and what the roles it nests hold.
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
  const key = `${did}\n${cmd}\n${canonicalize(args)}\n${options.opaque ? 1 : 0}`;
  let cache = answers.get(state);
  if (!cache) answers.set(state, (cache = new Map<string, boolean>()));
  const known = cache.get(key);
  if (known !== undefined) return known;
  const opaque = !!options.opaque;
  const answer = roles.some((role) =>
    roleHolds(
      state,
      role,
      (grant) => grantFits(grant, cmd, args, opaque),
      (view, by) => may(view, by, cmd, args, { opaque }),
    ),
  );
  cache.set(key, answer);
  return answer;
}

/** What a role's current definitions all hold, and the authors whose power bounds it */
interface EffectiveRole {
  /** The grants every current definition holds, by command and policy */
  readonly grants: ReadonlyArray<Grant>;
  /** The roles every current definition nests */
  readonly nests: ReadonlyArray<string>;
  /** Each written definition's author, and its view: it holds only what they could do there */
  readonly authors: ReadonlyArray<{ readonly view: AccessState; readonly by: string }>;
}

const effective = new WeakMap<AccessState, Map<string, EffectiveRole | null>>();

/** A role as its rival definitions leave it: only what they share. Once per state: a state never changes. */
function effectiveRole(state: AccessState, role: string): EffectiveRole | null {
  let cache = effective.get(state);
  if (!cache) effective.set(state, (cache = new Map<string, EffectiveRole | null>()));
  const known = cache.get(role);
  if (known !== undefined) return known;
  const heads = state.roles.get(role);
  let found: EffectiveRole | null = null;
  if (heads && heads.length > 0) {
    const [first, ...rivals] = heads;
    found = {
      grants: first!.grants.filter((grant) =>
        rivals.every((rival) => rival.grants.some((other) => grantShape(other) === grantShape(grant))),
      ),
      nests: first!.nests.filter((nested) => rivals.every((rival) => rival.nests.includes(nested))),
      authors: heads.flatMap((head) =>
        head.view === null || head.by === null ? [] : [{ view: head.view, by: head.by }],
      ),
    };
  }
  cache.set(role, found);
  return found;
}

/**
 * Whether a role, or a role it nests, holds a grant that `fits`, and every
 * author of its definitions could do as much as of it (`authorHolds`).
 */
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
  // Each definition holds only what its author could do itself, as of it.
  return held && found.authors.every(({ view, by }) => authorHolds(view, by));
}

/**
 * Whether an account holds every grant a role gives, each as wide or wider:
 * what it may hand on to a bot or an agent of its own without handing on more
 * than it holds. A grant is as wide when its command covers the other's and
 * every statement of its policy is among the other's, held through the
 * account's roles as {@link may} holds it (rivals sharing it, attenuated by
 * each definition's author). A founder holds every grant. Only the policies'
 * words are compared, so it may say no where the policies would in fact
 * allow; never yes where they wouldn't.
 */
export function holdsRole(state: AccessState, did: string, role: string): boolean {
  return grantsOfRole(state, role, new Set()).every((grant) => holdsGrant(state, did, grant));
}

/** What a role gives its members, as grants: its current definitions' shared ones, and its nested roles' */
function grantsOfRole(state: AccessState, role: string, visiting: ReadonlySet<string>): ReadonlyArray<Grant> {
  const found = effectiveRole(state, role);
  if (!found || visiting.has(role)) return [];
  const inner = new Set(visiting).add(role);
  return [...found.grants, ...found.nests.flatMap((nested) => grantsOfRole(state, nested, inner))];
}

/** Whether an account holds a grant as wide as `wanted` or wider, in a state */
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

/** Whether any member holds `/space/succeed`, once per state: a state never changes */
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
 * Why a change is not allowed in a state, or null when it is: its author
 * held a grant for its command with these arguments, or it is one of the
 * few things anyone may do for themselves (leave a role, leave the space,
 * step down as a founder), or it names a successor where no one holds
 * `/space/succeed`.
 */
export function refusal(event: AccessEvent, state: AccessState): string | null {
  const root = event.root;
  switch (event.kind) {
    case 'role':
      return may(state, root, ROLE_DEFINE, { role: event.name })
        ? null
        : 'Its author may not define this role';
    case 'assign': {
      // Roles go to accounts: putting a role inside another is part of a definition, and grants.
      if (event.did.startsWith('role:')) return 'A role is assigned to accounts, not to roles';
      const holds = rolesOf(state, event.did).includes(event.role);
      // Joining with an invite: your own record, for the invite's role, judged as the assignment
      // its opener makes, with the joiner's own `self` and `roles`.
      if (event.viaInvite !== undefined) {
        const invite = state.invites.get(event.viaInvite);
        if (!event.assigned) return 'An invite only assigns';
        if (root !== event.did) return 'Only the person joining can use an invite for themselves';
        if (!invite?.open) return 'The invite is not open';
        if (invite.role !== event.role) return 'The invite is for another role';
        if (holds) return 'Already holds that role';
        if (!state.roles.has(event.role)) return `There is no role "${event.role}"`;
        return invite.by.every((opener) =>
          may(state, opener, ROLE_ASSIGN, targetArgs(state, opener, event.did, event.role)),
        )
          ? null
          : 'Whoever opened the invite may not assign this role to them';
      }
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
    case 'remove': {
      if (!isMember(state, event.did)) return 'Not a member';
      // Leaving the space is built in, for a founder too.
      if (root === event.did) return null;
      if (state.founders.has(event.did)) return 'No one but a founder itself removes a founder';
      return may(state, root, MEMBER_REMOVE, targetArgs(state, root, event.did))
        ? null
        : 'Its author may not remove them';
    }
    case 'invite': {
      // An invite is an assignment to whoever holds its secret: to someone else, holding nothing yet.
      const assigns = (role: string) =>
        state.roles.has(role) && may(state, root, ROLE_ASSIGN, { role, self: false, roles: [] });
      const existing = state.invites.get(event.inviteKey);
      if (existing && !assigns(existing.role)) return 'Its author may not change this invite';
      if (!event.open) return existing ? null : 'There is no such invite to close';
      if (!state.roles.has(event.role)) return `There is no role "${event.role}"`;
      return assigns(event.role) ? null : 'Its author may not invite to this role';
    }
    // Stepping down is built in, and only a founder's own.
    case 'stepdown':
      if (root !== event.did) return 'Only a founder itself steps down';
      return state.founders.has(event.did) ? null : 'Not a founder';
    // A successor binds no one, so where no one holds the command, any member may name one.
    case 'succeed': {
      if (!isMember(state, root)) return 'Only a member may name a successor';
      if (may(state, root, SPACE_SUCCEED, {})) return null;
      return anyMaySucceed(state) ? 'Its author may not name a successor' : null;
    }
    // An account revokes its own keys: what a revoke takes away is only ever its own account's.
    case 'revoke':
      return isMember(state, root) ? null : 'Only a member may revoke a key here';
    // The proof stands on its own (checked before it got here); a member only has to bring it.
    case 'fork':
      return isMember(state, root) ? null : 'Only a member may report a fork';
    case 'definition': {
      const existing = state.definitions.get(event.name);
      const contested = state.contested.has(event.name);
      const defines = may(state, root, COLLECTION_DEFINE, { collection: event.name });
      if (!existing && !contested) {
        if (event.deleted) return 'There is no such definition to remove';
        return defines ? null : 'Its author may not define this collection';
      }
      if (defines) return null;
      // Rivals no one settled: no one first defined it, so only someone who may define it settles them.
      if (contested) return 'Rival definitions of it stand: only someone who may define it may settle them';
      return isMember(state, root) && existing?.definedBy === root
        ? null
        : 'Only whoever defined it, or someone who may define it, may change it';
    }
    case 'key': {
      if (state.keys.length === 0) return 'A public space has no key to change';
      if (!may(state, root, KEY_CHANGE, {})) return "Its author may not change the space's key";
      // Going back to a key a removed member still holds would undo the point of changing it.
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

/** What a reduction reaches */
type Reach =
  /** Everything an account did: a removal, an unassignment, a stepping down */
  | { readonly kind: 'account'; readonly root: string }
  /** What one key signed for its account: a revoke */
  | { readonly kind: 'key'; readonly root: string; readonly key: string }
  /** One key's line for one collection, from a place on: a fork proof */
  | { readonly kind: 'line'; readonly key: string; readonly collection: string; readonly from: number }
  /** Joins through an invite: closing it */
  | { readonly kind: 'invite'; readonly invite: string };

/**
 * A change that takes from others. A revoke or a fork proof reaches its
 * key's changes whatever either saw, and is never struck; any other reaches
 * only what it had not seen and what had not seen it.
 */
interface Reduction {
  readonly id: string;
  readonly reach: Reach;
  /** What it leaves standing: a key's versions in a collection at or below a place */
  readonly cutoff: Cutoff;
}

/** The lowest fork proof of a line */
type Fork = Reduction & { readonly reach: Extract<Reach, { readonly kind: 'line' }> };

/** What a reduction may reach: a change, or a record judged against the history */
interface Subject {
  readonly root: string;
  readonly author?: string | undefined;
  readonly collection?: string | undefined;
  readonly line?: number | undefined;
  readonly viaInvite?: string | undefined;
}

const NO_CUTOFF: Cutoff = new Map();

/** Whether a reduction reaches its key's changes whatever either saw */
const reachesBack = (reduction: Reduction) =>
  reduction.reach.kind === 'key' || reduction.reach.kind === 'line';

/**
 * What a change takes, in its own view: a removal of a member, an
 * unassignment of a role the account holds (its own leaving included), a
 * founder stepping down, a revoke, a fork proof or a closed invite. Null when
 * it takes nothing: it is no reduction.
 */
function reductionOf(event: AccessEvent, view: AccessState): Reduction | null {
  const of = (reach: Reach): Reduction => ({ id: event.id, reach, cutoff: event.cutoff });
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
      return {
        id: event.id,
        reach: { kind: 'line', key: event.writer, collection: event.collection, from: event.from },
        cutoff: NO_CUTOFF,
      };
    default:
      return null;
  }
}

/** Whether a reduction reaches a change or a record that its cutoff doesn't cover */
function reaches(reduction: Reduction, subject: Subject): boolean {
  const { author, collection, line } = subject;
  if (
    author !== undefined &&
    collection !== undefined &&
    line !== undefined &&
    (reduction.cutoff.get(author)?.get(collection) ?? -1) >= line
  )
    return false;
  const reach = reduction.reach;
  switch (reach.kind) {
    // A removal or an unassignment reaches everything its account did: what an action needed is
    // judged in a view its author chooses, so it can't decide what a strike leaves.
    case 'account':
      return subject.root === reach.root;
    case 'key':
      return subject.root === reach.root && author === reach.key;
    case 'line':
      return author === reach.key && collection === reach.collection && (line ?? 0) >= reach.from;
    case 'invite':
      return subject.viaInvite === reach.invite;
  }
}

/** A change as what a reduction may reach */
const subjectOf = (event: AccessEvent): Subject => ({
  root: event.root,
  author: event.author,
  collection: KIND_COLLECTION[event.kind],
  line: event.line,
  viaInvite: event.kind === 'assign' ? event.viaInvite : undefined,
});

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

/** The people whose reading a change may end */
function affected(event: AccessEvent): ReadonlyArray<string> {
  return event.kind === 'assign' || event.kind === 'remove' || event.kind === 'stepdown' ? [event.did] : [];
}

/** A role's definition from a change, judged in `view` */
function definitionFrom(event: AccessEvent, view: AccessState): RoleDefinition | null {
  if (event.kind !== 'role') return null;
  return Object.freeze({
    event: event.id,
    by: event.root,
    ...(event.title !== undefined ? { title: event.title } : {}),
    grants: event.grants,
    nests: event.nests,
    view,
  });
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
      // It ends every assignment it saw, since none of them saw it; a founder who leaves steps down.
      state.assigned.delete(event.did);
      if (event.root === event.did) state.founders.delete(event.did);
      return;
    case 'stepdown':
      state.founders.delete(event.did);
      return;
    case 'succeed':
      state.successors.set(
        event.space,
        [...new Set([...(state.successors.get(event.space) ?? []), event.root])].sort(),
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
      const existing = state.definitions.get(event.name);
      state.definitions.set(event.name, {
        event: event.id,
        definedBy: existing ? existing.definedBy : event.root,
      });
      return;
    }
    case 'key':
      state.keys.push({ keyId: event.keyId, readKey: event.readKey, event: event.id });
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
//
// No order decides anything. A change is allowed when its author had the
// power in the state its own view gives (the changes it saw that were
// allowed, merged). A removal or an unassignment, judged in its own view, is
// a reduction; it strikes every change of its account that it had not seen,
// past its cutoff. Reductions that strike each other all stand. The state is a
// merge of the valid changes: on each record, the latest wins, and of latest
// changes that didn't see each other, the one that gives least.

/** A key's line for one collection, as a map key */
const lineOf = (writer: string, collection: string) => `${writer}\n${collection}`;

/** The kind's collection: where a change's place in its key's line is counted */
const KIND_COLLECTION: Record<AccessEvent['kind'], string> = {
  role: ROLE_COLLECTION,
  assign: ASSIGN_COLLECTION,
  remove: REMOVE_COLLECTION,
  invite: INVITE_COLLECTION,
  revoke: REVOKE_COLLECTION,
  definition: DEFINITION_COLLECTION,
  key: KEY_COLLECTION,
  relays: RELAYS_COLLECTION,
  keepers: KEEPERS_COLLECTION,
  fork: FORK_COLLECTION,
  stepdown: STEPDOWN_COLLECTION,
  succeed: SUCCEED_COLLECTION,
};

/**
 * The changes one change saw, directly or not: every change placed before
 * `prefix`, and those in `extra`, by their place in the replay. Changes are
 * placed after everything they saw, so without much concurrency `extra`
 * stays empty and this is one number, where a set of ids would grow with the
 * history.
 */
interface Seen extends Iterable<string> {
  has(id: string): boolean;
  readonly size: number;
  readonly prefix: number;
  readonly extra: ReadonlySet<number>;
  /** A change's own place in the replay */
  placeOf(id: string): number | undefined;
}

function seenOf(
  prefix: number,
  extra: ReadonlySet<number>,
  order: ReadonlyArray<string>,
  index: ReadonlyMap<string, number>,
): Seen {
  return {
    prefix,
    extra,
    size: prefix + extra.size,
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
  /** Placeable changes, ancestors first; ties by id. Only gives `status` an index. */
  readonly order: ReadonlyArray<string>;
  /** Every change each placeable change saw, directly or not */
  readonly saw: ReadonlyMap<string, Seen>;
  /** Allowed in their own view, with the reason when not */
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
  readonly ancestry: ReadonlyMap<string, Ancestry>;
}

type Ancestry = ReturnType<typeof seenOf>;

const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The state a set of changes gives, merged: no order, only what saw what.
 * Rival definitions of a role all stand, and hold what they share; an
 * unassignment beats an assignment; an assignment counts only if it saw every
 * removal of its account; a closed invite beats an open one, and open ones
 * for different roles close it.
 */
function merge(
  genesis: AccessGenesis,
  events: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  defViews: ReadonlyMap<string, AccessState>,
): MutableState {
  const state = startState(genesis);
  const byKey = new Map<string, AccessEvent[]>();
  for (const event of events) {
    // A revoke or a fork proof changes no state.
    if (event.kind === 'revoke' || event.kind === 'fork') continue;
    (byKey.get(event.key) ?? byKey.set(event.key, []).get(event.key)!).push(event);
  }
  /**
   * The latest on a key: those no other on it saw. One pass: a change was seen by another if its
   * place is below that one's prefix, or among its exceptions.
   */
  const latest = (group: ReadonlyArray<AccessEvent>) => {
    if (group.length <= 1) return group;
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
  };

  // Removals first: an assignment counts only if it saw every one of its account's.
  const removals = new Map<string, ReadonlyArray<AccessEvent>>();
  for (const group of byKey.values()) {
    if (group[0]?.kind !== 'remove') continue;
    const did = group[0].did;
    removals.set(did, latest(group));
    // A founder who leaves is one no more; no one else can remove one.
    if (group.some((event) => event.root === did)) state.founders.delete(did);
    // Every removal saw the constitution: it ends the roles the constitution assigned.
    state.assigned.delete(did);
  }
  let currentKey: AccessEvent | null = null;
  const keyEvents: AccessEvent[] = [];
  for (const group of byKey.values()) {
    const tops = [...latest(group)].sort(byId);
    const win = tops[0];
    if (!win) continue;
    switch (win.kind) {
      case 'remove':
        continue;
      case 'stepdown':
        state.founders.delete(win.did);
        continue;
      case 'succeed': {
        // Every one stands, whoever named it: none is first.
        const space = win.space;
        state.successors.set(space, [...new Set(group.map((event) => event.root))].sort());
        continue;
      }
      case 'role':
        // Rivals all stand: the role holds what they share.
        state.roles.set(
          win.name,
          tops.map((event) => definitionFrom(event, defViews.get(event.id)!)!),
        );
        continue;
      case 'assign': {
        // Taking a role away beats giving it; an assignment counts only if it saw its account's removals.
        // The changes on its key all saw the constitution, so they decide over its assignment too.
        const gone = removals.get(win.did) ?? [];
        const counted = tops.some((event) => event.kind === 'assign' && !event.assigned)
          ? undefined
          : tops.find((event) => gone.every((removal) => saw.get(event.id)!.has(removal.id)));
        setAssigned(state, win.did, win.role, counted ? counted.id : null);
        continue;
      }
      case 'invite': {
        // Closed beats open, and open ones that name different roles close it. Rival openers
        // all stand: a join must be one each of them could have made.
        const roles = new Set(tops.map((event) => (event.kind === 'invite' ? event.role : '')));
        const closed = tops.find((event) => event.kind === 'invite' && !event.open);
        const pick = closed ?? win;
        if (pick.kind === 'invite')
          state.invites.set(pick.inviteKey, {
            role: pick.role,
            open: !closed && roles.size === 1,
            event: pick.id,
            by: [...new Set(tops.map((event) => event.root))].sort(),
          });
        continue;
      }
      case 'key':
        keyEvents.push(...group);
        // Only those granted it change the key, and every key stands: an id picks which is current
        // among keys any of them could have made current alone.
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
  if (keyEvents.length > 0) {
    // Every key stands; the current one goes last, the rest by id: only which is current matters.
    const sorted = [...keyEvents].sort(byId);
    const current = currentKey!;
    for (const event of [...sorted.filter((e) => e !== current), current])
      if (event.kind === 'key')
        state.keys.push({ keyId: event.keyId, readKey: event.readKey, event: event.id });
  }
  return state;
}

/** A state with one change applied on top: the change saw all of it, so it is the latest on its record */
function applied(state: AccessState, event: AccessEvent, genesisId: string): MutableState {
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
  if (event.kind === 'key') {
    // The keys before it in the order a merge gives: the space's own first, the rest by id.
    const earlier = next.keys.slice(0, -1);
    const own = earlier.filter((key) => key.event === genesisId);
    const rest = earlier
      .filter((key) => key.event !== genesisId)
      .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
    next.keys = [...own, ...rest, next.keys.at(-1)!];
  }
  return next;
}

/**
 * The latest changes to one collection's definition, merged (02 §6.3). One
 * account's alone, or changes by accounts that may each change it (its first
 * definer and those who may define it, or only those once no one first
 * defined it), are picked between by id: each could have made its own the
 * latest alone. Anything else, rival first definitions by two accounts or a
 * delete beside another account's change, is contested: no id decides, since
 * an id can be ground, and readers judge the rivals by what they say.
 */
function mergeDefinitions(
  tops: ReadonlyArray<AccessEvent>,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  state: MutableState,
): void {
  const sorted = [...tops].sort(byId);
  const win = sorted[0]!;
  if (win.kind !== 'definition') return;
  // Who first defined it, as each latest definition sees the whole group: null where rivals stand.
  const definitions = sorted.filter((top) => !isDelete(top));
  const definers = new Set(definitions.map((top) => definerOf(top, group, saw)));
  // No first definer is agreed on only once every latest change saw the rival firsts, which a
  // settling change did; rival firsts that are themselves latest are not agreement.
  const settled = definitions.every((top) =>
    firstsOf(top, group, saw).every((first) => first === top || saw.get(top.id)?.has(first.id)),
  );
  const oneAccount = new Set(sorted.map((top) => top.root)).size === 1;
  const agreed =
    sorted.length === 1 ||
    oneAccount ||
    (definers.size === 1 && !sorted.some(isDelete) && (!definers.has(null) || settled));
  if (agreed) {
    if (win.deleted) change(win, state, state);
    else state.definitions.set(win.name, { event: win.id, definedBy: definerOf(win, group, saw) });
    return;
  }
  state.definitions.delete(win.name);
  state.contested.set(
    win.name,
    sorted.map((top) => top.id),
  );
}

const isDelete = (event: AccessEvent) => event.kind === 'definition' && event.deleted;

/**
 * Whoever defined a collection this time (02 §6.3): of the definitions in
 * `group` that saw every removal the winning one saw, those that saw no
 * other, if they are all one account's. Rival first definitions by two
 * accounts give no one: no id decides it, since an id can be ground, so only
 * someone who may define it may change it.
 */
function definerOf(
  win: AccessEvent,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
): string | null {
  const firsts = firstsOf(win, group, saw);
  const roots = new Set(firsts.map((event) => event.root));
  return roots.size === 1 ? [...roots][0]! : roots.size === 0 ? win.root : null;
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
 * The strongly connected components of a graph (Tarjan's, without
 * recursion: a long history must not overflow the stack), listed so that
 * every component comes after those with an edge into it.
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
  const of = new Map<string, number>();
  for (const root of nodes) {
    if (indices.has(root)) continue;
    const work: Array<{ readonly id: string; next: number }> = [{ id: root, next: 0 }];
    indices.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const out = edges.get(frame.id) ?? [];
      if (frame.next < out.length) {
        const next = out[frame.next++]!;
        if (!indices.has(next)) {
          indices.set(next, counter);
          low.set(next, counter++);
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, next: 0 });
        } else if (onStack.has(next)) low.set(frame.id, Math.min(low.get(frame.id)!, indices.get(next)!));
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
  list.forEach((members, i) => members.forEach((id) => of.set(id, i)));
  return { of, list };
}

const STRUCK = "Its author's power was taken away by a change it had not seen, or rested on one that was";

/** Replays a space's access history. */
export function replayAccess(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  // Another resolver would judge the same changes differently: this peer doesn't judge the space at all.
  if (!RESOLVERS.has(genesis.resolver))
    throw new Error(`This peer doesn't know the resolver ${genesis.resolver}, so it can't judge this space`);
  const byIdMap = new Map<string, AccessEvent>();
  for (const event of events) if (!byIdMap.has(event.id)) byIdMap.set(event.id, event);

  // A change waits until everything it saw is here, and so does anything that saw it.
  const waiting = new Set<string>();
  const known = (id: string) => id === genesis.id || byIdMap.has(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of byIdMap.values()) {
      if (waiting.has(event.id)) continue;
      if (event.seen.some((parent) => parent === event.id || !known(parent) || waiting.has(parent))) {
        waiting.add(event.id);
        changed = true;
      }
    }
  }

  // Ancestors first (Kahn's order, ties by id): a cycle can only be forged, and must not hang it.
  const placeable = [...byIdMap.values()].filter((event) => !waiting.has(event.id));
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const event of placeable) {
    const parents = [...new Set(event.seen.filter((p) => p !== genesis.id))];
    pending.set(event.id, parents.length);
    for (const parent of parents)
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(event.id);
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
  const placed = new Set(order);
  for (const event of placeable) if (!placed.has(event.id)) waiting.add(event.id);

  const index = new Map(order.map((id, i) => [id, i]));
  const saw = new Map<string, Ancestry>();
  for (const id of order) {
    const parents = [...new Set(byIdMap.get(id)!.seen.filter((parent) => parent !== genesis.id))];
    let prefix = 0;
    for (const parent of parents) prefix = Math.max(prefix, saw.get(parent)!.prefix);
    const extra = new Set<number>();
    for (const parent of parents)
      for (const n of [...saw.get(parent)!.extra, index.get(parent)!]) if (n >= prefix) extra.add(n);
    while (extra.delete(prefix)) prefix++;
    saw.set(id, seenOf(prefix, extra, order, index));
  }

  // In order, ancestors first: each change's own view (the allowed changes it saw), whether it is
  // allowed there, what it takes, and the strikes it is part of.
  const tookReading = new Set<string>();
  const refused = new Map<string, string>();
  const allowedIds = new Set<string>();
  const strikes = new Map<string, string[]>();
  const afterOf = new Map<string, AccessState>();
  const defViews = new Map<string, AccessState>();
  /** The allowed reductions, in order */
  const taking = new Map<string, Reduction>();
  const strike = (by: string, id: string) => (strikes.get(by) ?? strikes.set(by, []).get(by)!).push(id);
  const allowedView = viewsAlong(byIdMap, saw, genesis, (id) => allowedIds.has(id), afterOf, defViews);

  for (const id of order) {
    const event = byIdMap.get(id)!;
    const result = step(event, allowedView(event), {
      genesis,
      saw,
      byId: byIdMap,
      counted: allowedIds,
      taking,
    });
    if (result.refused !== null) {
      refused.set(id, result.refused);
      continue;
    }
    allowedIds.add(id);
    afterOf.set(id, result.after);
    if (result.tookReading) tookReading.add(id);
    // Strikes it is part of, with the allowed changes before it.
    for (const by of result.reachedBy) if (strikesOn(by, event, saw)) strike(by.id, id);
    const reduction = result.reduction;
    if (!reduction) continue;
    taking.set(id, reduction);
    for (const other of order) {
      if (other === id) break;
      if (allowedIds.has(other) && strikesOn(reduction, byIdMap.get(other)!, saw)) strike(id, other);
    }
  }

  // A stepping down its key's revoke or fork proof reaches only ends founder status: it strikes
  // nothing, and withdraws nothing, as a reduction would.
  const back = [...taking.values()].filter(reachesBack);
  for (const id of order) {
    const event = byIdMap.get(id)!;
    if (event.kind !== 'stepdown' || !allowedIds.has(id)) continue;
    if (back.some((reduction) => reachedBy(reduction, event, saw))) {
      strikes.delete(id);
      taking.delete(id);
    }
  }

  const within = validWithin(order, {
    genesis,
    byId: byIdMap,
    saw,
    allowedIds,
    strikes,
    defViews,
  });
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
  for (const event of byIdMap.values()) {
    if (event.kind === 'assign' && event.assigned) named.add(event.did);
    if (event.kind === 'invite') invites.add(event.inviteKey);
  }
  const state = merge(
    genesis,
    order.filter((id) => valid.has(id)).map((id) => byIdMap.get(id)!),
    saw,
    within.defViews,
  );
  // Due: someone lost reading in a valid change the current key had not seen. They may hold it.
  const keyEvent = state.keys.at(-1)?.event;
  const sawByKey = keyEvent === undefined ? undefined : saw.get(keyEvent);
  state.keyDue =
    keyEvent !== undefined &&
    order.some((id) => valid.has(id) && tookReading.has(id) && id !== keyEvent && !sawByKey?.has(id));
  // Due, too, when someone who held the current key reads no more, however that came about: two
  // changes together can take reading where neither did alone. Whoever could read as the key was
  // made held it, and so did whoever came to read after, by a change the key had not seen.
  if (keyEvent !== undefined && !state.keyDue) {
    const atKey = keyEvent === genesis.id ? startState(genesis) : afterOf.get(keyEvent);
    const now = readers(state);
    const held = new Set(atKey ? readers(atKey) : []);
    for (const id of order) {
      const event = byIdMap.get(id)!;
      if (!valid.has(id) || event.kind !== 'assign' || sawByKey?.has(id)) continue;
      const after = afterOf.get(id);
      if (after && isMember(after, event.did)) held.add(event.did);
    }
    if ([...held].some((did) => !now.has(did))) state.keyDue = true;
  }
  return historyOf({
    genesis,
    byId: byIdMap,
    waiting,
    order,
    saw,
    ancestry: saw,
    index,
    refused,
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

// Revokes and fork proofs are never struck: every allowed one applies.
const reachedBy = (reduction: Reduction, event: AccessEvent, saw: ReadonlyMap<string, Seen>) =>
  reduction.id !== event.id &&
  event.kind !== 'revoke' &&
  event.kind !== 'fork' &&
  (reachesBack(reduction) ||
    (!saw.get(event.id)!.has(reduction.id) && !saw.get(reduction.id)!.has(event.id))) &&
  reaches(reduction, subjectOf(event));

// A stepping down is never struck (`invalidWithin`): founder status can't be given again. One a
// revoke or a fork proof reaches ends founder status and does nothing more.
const strikesOn = (reduction: Reduction, event: AccessEvent, saw: ReadonlyMap<string, Seen>) =>
  !(reachesBack(reduction) && event.kind === 'stepdown') && reachedBy(reduction, event, saw);

/**
 * One change judged in its own view, as replaying in order and extending by
 * one both do: why it is refused, or the state it leaves, what it takes,
 * whether it took reading from someone, and the reductions before it that reach it.
 */
function step(
  event: AccessEvent,
  view: AccessState,
  c: {
    readonly genesis: AccessGenesis;
    readonly saw: ReadonlyMap<string, Seen>;
    readonly byId: ReadonlyMap<string, AccessEvent>;
    /** The allowed changes, which say who defined a collection */
    readonly counted: ReadonlySet<string>;
    readonly taking: ReadonlyMap<string, Reduction>;
  },
):
  | { readonly refused: string }
  | {
      readonly refused: null;
      readonly after: MutableState;
      readonly reduction: Reduction | null;
      readonly tookReading: boolean;
      readonly reachedBy: ReadonlyArray<Reduction>;
    } {
  const reason = refusal(event, view);
  if (reason) return { refused: reason };
  const after = stepped(view, event, c.genesis, c.saw, c.byId, c.counted);
  return {
    refused: null,
    after,
    reduction: reductionOf(event, view),
    tookReading: affected(event).some((did) => isMember(view, did) && !isMember(after, did)),
    reachedBy: [...c.taking.values()].filter((reduction) => reachedBy(reduction, event, c.saw)),
  };
}

/** A state with one change on top, and who defined it when it defines a collection */
function stepped(
  view: AccessState,
  event: AccessEvent,
  genesis: AccessGenesis,
  saw: ReadonlyMap<string, Seen>,
  byIdMap: ReadonlyMap<string, AccessEvent>,
  counted: ReadonlySet<string>,
): MutableState {
  const after = applied(view, event, genesis.id);
  if (event.kind === 'definition' && !event.deleted) {
    const group = [...saw.get(event.id)!]
      .filter((other) => counted.has(other) && byIdMap.get(other)!.key === event.key)
      .map((other) => byIdMap.get(other)!)
      .concat(event);
    after.definitions.set(event.name, { event: event.id, definedBy: definerOf(event, group, saw) });
  }
  return after;
}

/**
 * Each change's view over the changes `counts` keeps among what it saw. Along a chain, the one
 * before's view, with it on top when kept; where branches meet, a merge. Asked in order. A role
 * definition's view is kept in `defViews`, where its grants are judged.
 */
function viewsAlong(
  byIdMap: ReadonlyMap<string, AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  genesis: AccessGenesis,
  counts: (id: string) => boolean,
  afterOf: ReadonlyMap<string, AccessState>,
  defViews: Map<string, AccessState>,
): (event: AccessEvent) => AccessState {
  const viewOf = new Map<string, AccessState>();
  return (event) => {
    const parents = [...new Set(event.seen.filter((parent) => parent !== genesis.id))];
    let view: AccessState;
    if (parents.length === 0) view = startState(genesis);
    else if (parents.length === 1)
      view = counts(parents[0]!) ? afterOf.get(parents[0]!)! : viewOf.get(parents[0]!)!;
    else
      view = merge(
        genesis,
        [...saw.get(event.id)!].filter(counts).map((other) => byIdMap.get(other)!),
        saw,
        defViews,
      );
    viewOf.set(event.id, view);
    if (event.kind === 'role') defViews.set(event.id, view);
    return view;
  };
}

/**
 * The valid changes among `cut` (in replay order, closed under what they saw), and the views
 * their role definitions are judged in. First the strikes: an allowed change is struck by a valid
 * one from another component of the strikes inside the cut. Then, ancestors first, a change stays
 * valid only if the valid changes it saw still give its author the power: so a struck grant gives
 * none, to anything downstream, and a struck definition is dropped before anything resting on it
 * is judged.
 */
function validWithin(
  cut: ReadonlyArray<string>,
  r: {
    readonly genesis: AccessGenesis;
    readonly byId: ReadonlyMap<string, AccessEvent>;
    readonly saw: ReadonlyMap<string, Seen>;
    readonly allowedIds: ReadonlySet<string>;
    readonly strikes: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly defViews: ReadonlyMap<string, AccessState>;
  },
): { readonly valid: ReadonlySet<string>; readonly defViews: ReadonlyMap<string, AccessState> } {
  // A stepping down is never struck: founder status can't be given back.
  const invalid = invalidWithin(cut, r.allowedIds, r.strikes, (id) => r.byId.get(id)?.kind === 'stepdown');
  const valid = new Set(cut.filter((id) => !invalid.has(id)));
  if (cut.every((id) => !r.allowedIds.has(id) || valid.has(id))) return { valid, defViews: r.defViews };
  const afterOf = new Map<string, AccessState>();
  const defViews = new Map<string, AccessState>();
  const viewOf = viewsAlong(r.byId, r.saw, r.genesis, (id) => valid.has(id), afterOf, defViews);
  for (const id of cut) {
    const event = r.byId.get(id)!;
    const view = viewOf(event);
    if (!valid.has(id)) continue;
    if (refusal(event, view)) {
      valid.delete(id);
      continue;
    }
    afterOf.set(id, stepped(view, event, r.genesis, r.saw, r.byId, valid));
  }
  return { valid, defViews };
}

/**
 * The allowed changes among `cut` that are not valid there: struck by a
 * valid change in it, components of the strikes inside it visited so that
 * strikes come before what they strike, and strikes within one component not
 * counting. With refused changes, what a view leaves out.
 */
function invalidWithin(
  cut: Iterable<string>,
  allowedIds: ReadonlySet<string>,
  strikes: ReadonlyMap<string, ReadonlyArray<string>>,
  immune: (id: string) => boolean,
): ReadonlySet<string> {
  const inCut = new Set(cut);
  const out = new Set([...inCut].filter((id) => !allowedIds.has(id)));
  const edges = new Map<string, string[]>();
  for (const [from, targets] of strikes) {
    if (!inCut.has(from) || !allowedIds.has(from)) continue;
    const kept = targets.filter((to) => inCut.has(to) && allowedIds.has(to));
    if (kept.length > 0) edges.set(from, kept);
  }
  if (edges.size === 0) return out;
  const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flat()])].sort();
  const { of, list } = componentsOf(nodes, edges);
  const strikers = new Map<string, string[]>();
  for (const [from, targets] of edges)
    for (const to of targets)
      if (of.get(from) !== of.get(to)) (strikers.get(to) ?? strikers.set(to, []).get(to)!).push(from);
  for (const members of list)
    for (const id of members)
      if (!immune(id) && (strikers.get(id) ?? []).some((from) => !out.has(from))) out.add(id);
  return out;
}

/**
 * The replay with one more change that saw every change placed, or null for
 * any other: then only replaying whole can say. Such a change can't be struck
 * by a reduction (it saw every one) and strikes nothing (it saw everything),
 * so it is valid exactly when it is allowed and no revoke or fork reaches it,
 * its view is every allowed change, and it is the latest on its record.
 */
function extended(r: Replay, event: AccessEvent): Replay | null {
  const { genesis } = r;
  // A revoke or a fork proof reaches back, whatever it saw: only replaying whole can say what it strikes.
  if (event.kind === 'revoke' || event.kind === 'fork') return null;
  // Where something allowed is not valid, its view (the allowed changes) is not the state; and
  // whether a key change is due rests on everyone who held the key. Both are worked out whole.
  if (r.struck.size > 0 || r.state.keyDue) return null;
  const parents = [...new Set(event.seen.filter((parent) => parent !== genesis.id))];
  if (parents.some((parent) => !r.ancestry.has(parent))) return null;
  let prefix = 0;
  for (const parent of parents) prefix = Math.max(prefix, r.ancestry.get(parent)!.prefix);
  const extra = new Set<number>();
  for (const parent of parents)
    for (const n of [...r.ancestry.get(parent)!.extra, r.index.get(parent)!]) if (n >= prefix) extra.add(n);
  while (extra.delete(prefix)) prefix++;
  if (prefix !== r.order.length || extra.size > 0 || r.waiting.size > 0) return null;

  const order = [...r.order, event.id];
  const index = new Map(r.index).set(event.id, r.order.length);
  const mine = seenOf(prefix, extra, order, index);
  const ancestry = new Map(r.ancestry).set(event.id, mine);
  const byIdMap = new Map(r.byId).set(event.id, event);
  const named = new Set(r.named);
  if (event.kind === 'assign' && event.assigned) named.add(event.did);
  const invites = new Set(r.invites);
  if (event.kind === 'invite') invites.add(event.inviteKey);
  // It saw everything: its view is the current state.
  const view = r.state;
  const defViews = event.kind === 'role' ? new Map(r.defViews).set(event.id, view) : r.defViews;
  const validDefViews =
    event.kind === 'role' ? new Map(r.validDefViews).set(event.id, view) : r.validDefViews;
  const base = {
    genesis,
    byId: byIdMap,
    waiting: r.waiting,
    order,
    saw: ancestry,
    ancestry,
    index,
    named,
    invites,
    views: new Map<string, AccessState>(),
    defViews,
  };

  const result = step(event, view, {
    genesis,
    saw: ancestry,
    byId: byIdMap,
    counted: r.allowedIds,
    taking: r.taking,
  });
  if (result.refused !== null)
    return { ...r, ...base, refused: new Map(r.refused).set(event.id, result.refused) };
  // Valid, besides allowed, when no revoke or fork of its key reaches it, whatever it saw: no other
  // reduction can, since it saw them all.
  const strikers = result.reachedBy.map((reduction) => reduction.id);
  // A stepping down its key's revoke reaches ends founder status and does nothing else: only a whole replay says.
  if (strikers.length > 0 && event.kind === 'stepdown') return null;
  const taking = result.reduction ? new Map(r.taking).set(event.id, result.reduction) : r.taking;
  const allowedIds = new Set(r.allowedIds).add(event.id);
  if (strikers.length > 0) {
    const strikes = new Map(r.strikes);
    for (const by of strikers) strikes.set(by, [...(strikes.get(by) ?? []), event.id]);
    return { ...r, ...base, strikes, struck: new Map(r.struck).set(event.id, STRUCK), allowedIds, taking };
  }
  // Its view is every allowed change, and those are the valid ones: it is the state with it on top.
  const state = result.after;
  // Due once it takes reading from someone: the key saw everything else, and no one else lost it.
  state.keyDue = result.tookReading && state.keys.length > 0 && event.kind !== 'key';
  const taken = new Map(r.taken);
  const forks = new Map(r.forks);
  if (result.reduction) indexReduction(taken, forks, result.reduction);
  return {
    ...r,
    ...base,
    validDefViews,
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
  /** The merge of what `ids` name and saw, counting those of them in `among` */
  const stateOf = (
    ids: ReadonlyArray<string>,
    among: { readonly valid: ReadonlySet<string>; readonly defViews: ReadonlyMap<string, AccessState> },
  ) =>
    merge(
      genesis,
      inOrder(cutOf(ids))
        .filter((id) => among.valid.has(id))
        .map((id) => r.byId.get(id)!),
      r.saw,
      among.defViews,
    );
  const cached = (key: string, make: () => AccessState): AccessState => {
    const known = r.views.get(key);
    if (known) return known;
    const view = make();
    r.views.set(key, view);
    return view;
  };
  /** Valid in the whole history, or among what `within` names and saw */
  const at = (ids: ReadonlyArray<string>, within?: ReadonlyArray<string>): AccessState =>
    cached(`at:${idsKey(ids)}|${within ? idsKey(within) : '*'}`, () =>
      stateOf(
        ids,
        within
          ? validWithin(inOrder(cutOf([...ids, ...within])), r)
          : { valid: r.valid, defViews: r.validDefViews },
      ),
    );
  /** Valid among what `ids` name and saw alone */
  const seenAs = (ids: ReadonlyArray<string>): AccessState =>
    cached(`seen:${idsKey(ids)}`, () => stateOf(ids, validWithin(inOrder(cutOf(ids)), r)));
  const index = new Map(r.order.map((id, i) => [id, i]));
  const changesState = (id: string) => !['revoke', 'fork'].includes(r.byId.get(id)!.kind);
  let heads: ReadonlyArray<string> | null = null;

  const history: AccessHistory = Object.freeze({
    current: r.state,
    status(id: string): EventStatus | null {
      if (r.waiting.has(id)) return { status: 'waiting' };
      if (r.valid.has(id)) return { status: 'applied', index: index.get(id)! };
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
      const recent = [...all].sort((a, b) => index.get(b)! - index.get(a)!);
      const sawOrIs = (head: string, id: string) => head === id || r.saw.get(head)!.has(id);
      const chosen: string[] = [];
      for (const key of keys) {
        const mine = r.order.filter((id) => r.valid.has(id) && r.byId.get(id)!.key === key);
        const latest = mine.at(-1);
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
      return seen(ids) ? seenAs(ids) : null;
    },
    judge(record, needs, within) {
      if (!seen(record.seen) || (within && !seen(within)))
        return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      // For a cited version, only what the citer had seen can take it away (02 §7.6).
      const known = within ? cutOf(within) : null;
      const subject: Subject = {
        root: record.root,
        author: record.writer,
        collection: record.collection,
        line: record.line,
      };
      const takes = (reduction: Reduction) =>
        (!known || known.has(reduction.id)) && reaches(reduction, subject);
      const signed = record.writer === undefined ? [] : (r.taken.get(record.writer) ?? []);
      if (signed.some((reduction) => reduction.reach.kind === 'key' && takes(reduction)))
        return { ok: false, reason: 'The key that signed it was revoked', withdrawn: true };
      const fork =
        record.writer === undefined || record.collection === undefined
          ? undefined
          : r.forks.get(lineOf(record.writer, record.collection));
      if (fork && takes(fork))
        return { ok: false, reason: 'Its writer’s log forked at or before it', withdrawn: true };
      if (!needs(seenAs(record.seen)))
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      // What it had not seen of its author's standing: a removal or an unassignment takes everything.
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
