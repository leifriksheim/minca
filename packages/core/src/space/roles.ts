/**
 * Who may do what in a space: its roles, its members, its invites, and the
 * history of changes to them — replayed the same way on every peer.
 *
 * This module knows people and permissions. It knows nothing about polls or
 * todos: a collection's rules name a permission (`can:moderate`), and this
 * module answers one question about it — *does this account hold that
 * permission here, as of this point in the space's history?*
 *
 * **Roles.** A role is a name, a rank and a list of permissions. Permissions
 * are plain strings: three the protocol checks itself (`manage`, `invite`,
 * `define`) and whatever the collections in the space declare
 * (`app.poll/moderate`). A `*` in a role's permission matches any run of
 * characters, so `*` alone is every permission.
 *
 * **Rank.** You may change people and roles ranked below you, and give out
 * roles up to your own rank. Two people at the same rank can never remove each
 * other — only themselves.
 *
 * **The access history.** Every change to a role, a member, an invite, a
 * revoked note or a collection definition is a record whose `seen` names the
 * latest changes its author knew of. That makes a small graph. Replaying it:
 *
 * 1. A change comes after everything it saw.
 * 2. Changes that did not see each other go in this order: ones that take
 *    something away first — counting everything on the way to one, so a
 *    removal that also saw something else still comes first — then the
 *    author with the higher rank, then the lower id.
 * 3. A change counts only if its author had the power — both as of what they
 *    had seen, and at its turn in the replay. Of two changes to the same thing
 *    that did not see each other, the first in the replay wins.
 *
 * Everything here is pure and synchronous: the runtime checks signatures,
 * opens bodies and verifies invite signatures, and hands over plain events.
 */

import type { SpaceRole } from '../types.js';
import { isObject } from '../utils/guards.js';

/** A role, as a space defines it */
export type Role = SpaceRole;

/** The permissions the protocol checks itself. Every other one belongs to a collection. */
export const MANAGE = 'manage';
export const INVITE = 'invite';
export const DEFINE = 'define';

export const ROLE_COLLECTION = 'sys.role';
export const MEMBER_COLLECTION = 'sys.member';
export const INVITE_COLLECTION = 'sys.invite';
export const REVOKE_COLLECTION = 'sys.revoke';
/** Collection definitions are part of the access history too: they decide what a rule asks for */
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
 * but the space's, and changed only by someone who manages it.
 */
export const RELAYS_COLLECTION = 'sys.relays';
/**
 * Who keeps the space whole: nodes that hold every record of it — a host, an
 * extension — and how many copies a write should reach before a node that
 * holds only part of the space lets go of it. Changed only by someone who
 * manages the space, like its relays.
 */
export const KEEPERS_COLLECTION = 'sys.keepers';
/**
 * A writer's log forked: two versions one key signed at one place in its log
 * for this space (02 §4.10). The record carries both, so every peer checks the
 * proof for itself, and the key's versions from that place on stop counting.
 */
export const FORK_COLLECTION = 'sys.fork';

/** Every collection whose records are part of the access history */
export const ACCESS_COLLECTIONS: ReadonlySet<string> = new Set([
  ROLE_COLLECTION,
  MEMBER_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  DEFINITION_COLLECTION,
  KEY_COLLECTION,
  RELAYS_COLLECTION,
  KEEPERS_COLLECTION,
  FORK_COLLECTION,
]);

const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Why a role is malformed, or null */
export function checkRole(role: unknown): string | null {
  if (!isObject(role)) return 'A role must be an object';
  const r = role;
  if (typeof r.name !== 'string' || !ROLE_NAME_PATTERN.test(r.name))
    return 'A role name is 1–40 characters of a–z, 0–9 and . _ -';
  if (r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 80))
    return 'A role title is text of at most 80 characters';
  if (typeof r.rank !== 'number' || !Number.isFinite(r.rank)) return 'A role rank must be a number';
  if (
    !Array.isArray(r.permissions) ||
    !r.permissions.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 200)
  ) {
    return "A role's permissions must be a list of names";
  }
  return null;
}

/** Whether a role's permission (which may hold `*`) matches a permission */
export function permissionMatches(pattern: string, permission: string): boolean {
  if (pattern === permission || pattern === '*') return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(permission);
}

/** Whether a role holds a permission */
export function roleHolds(role: Role | null | undefined, permission: string): boolean {
  return !!role && role.permissions.some((pattern) => permissionMatches(pattern, permission));
}

/**
 * Whether someone holding `granted` may hand out `permission`: one of theirs
 * must cover it. A `*` in theirs matches anything, including a `*`.
 */
function covers(granted: ReadonlyArray<string>, permission: string): boolean {
  return granted.some((pattern) => permissionMatches(pattern, permission));
}

// ─── Events ───────────────────────────────────────────────────────────

interface EventBase {
  readonly id: string;
  /** The record key it changes: `role:moderator`, `member:…`, `invite:…`, `revoke:…`, `collection:…` */
  readonly key: string;
  /** The account behind the key that signed it */
  readonly root: string;
  /** The key that signed it */
  readonly author: string;
  /** The latest access changes its author knew of */
  readonly seen: ReadonlyArray<string>;
  /** Its place in its key's log here, and in its key's line for its collection: what forks and cutoffs reach */
  readonly at?: number;
  readonly line?: number;
  /**
   * What this change leaves standing of what it takes away: for each key of
   * the people it takes power from, and each collection, the end of the
   * unbroken line of that key's versions in that collection its author held.
   * Versions at or below it are covered.
   */
  readonly cutoff: Cutoff;
}

/** Key DID → collection → the place in that key's line for that collection, at and below which is covered */
export type Cutoff = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type AccessEvent = EventBase &
  (
    | {
        readonly kind: 'role';
        readonly name: string;
        /** Null: the role is removed */ readonly role: Role | null;
      }
    | {
        readonly kind: 'member';
        readonly did: string;
        /** Null: they are no longer a member */
        readonly role: string | null;
        /** The invite's public key, when the runtime checked the invite's signature on this record */
        readonly viaInvite?: string;
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
        /** Where: its versions here and after no longer count */
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

/** Who holds what, at one point in the history */
export interface AccessState {
  readonly roles: ReadonlyMap<string, Role>;
  /** Account DID → role name */
  readonly members: ReadonlyMap<string, string>;
  /** Invite public key → its role, and whether it is open */
  readonly invites: ReadonlyMap<
    string,
    { readonly role: string; readonly open: boolean; readonly event: string }
  >;
  /** Collection name → the id of the definition in force, and who first defined it */
  readonly definitions: ReadonlyMap<string, { readonly event: string; readonly definedBy: string }>;
  /** A private space's keys, oldest first; the last is current. Empty in a public space. */
  readonly keys: ReadonlyArray<SpaceKeyEpoch>;
  /** Whether someone lost their place in the space since the current key — so a new one is due */
  readonly keyDue: boolean;
  /** The relays the space names — empty until someone who manages it names some */
  readonly relays: ReadonlyArray<string>;
  /** The nodes that keep the space whole — empty until someone who manages it names some */
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach; null for whatever each node defaults to */
  readonly copies: number | null;
}

/** What a space starts with, from its genesis */
export interface AccessGenesis {
  /** The space id — also the id every change implicitly comes after */
  readonly id: string;
  readonly creator: string;
  readonly roles: ReadonlyArray<Role>;
  readonly creatorRole: string;
  /** A private space's first key, from its genesis */
  readonly key?: { readonly keyId: string; readonly readKey: string };
}

export type EventStatus =
  | { readonly status: 'applied'; readonly index: number }
  | { readonly status: 'dropped'; readonly reason: string }
  | { readonly status: 'waiting' };

export type RecordVerdict =
  | {
      readonly ok: true;
      /**
       * Applied changes to its author's standing that it had not seen and that
       * do not cover it. It must also be allowed as of what it saw plus these.
       */
      readonly unseen: ReadonlyArray<string>;
    }
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
  /** The state as of what `seen` names, or null when some of it is not here */
  at(seen: ReadonlyArray<string>): AccessState | null;
  /**
   * Whether a record stands as of what it saw: its key not revoked or forked
   * past where the change that did so covers it, and its author's standing
   * satisfying `needs`. The changes to its author's standing it had not seen,
   * and that don't cover it, are returned: it must also be allowed with them.
   * @param record The record's id, its account, what it saw, and the key that signed it
   * @param needs What the record requires of its author's role
   * @param within For a version another cites: what the citing version saw.
   *   Only changes among those, and what they saw, can take it away.
   */
  judge(
    record: {
      readonly id: string;
      readonly root: string;
      readonly seen: ReadonlyArray<string>;
      /** The key that signed it, and its place in that key's log here */
      readonly writer?: string;
      readonly at?: number;
      /** Its collection, and its place in its key's line for that collection */
      readonly collection?: string;
      readonly line?: number;
    },
    needs: (role: Role | null, state: AccessState) => boolean,
    within?: ReadonlyArray<string>,
  ): RecordVerdict;
  /** The applied changes by an account that revoked one of its keys */
  revoked(key: string, root: string): ReadonlyArray<string>;
  /** Where a key's log forked, as the lowest place any applied change proves, if it did */
  forked(writer: string): { readonly event: string; readonly from: number } | null;
  /** Every key whose log forked, and from where */
  forks(): ReadonlyArray<{ readonly writer: string; readonly from: number }>;
  /**
   * Whether an account appears anywhere in the history — the creator, or
   * named by any member change, whatever became of it. Only grows as changes
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
  roles: Map<string, Role>;
  members: Map<string, string>;
  invites: Map<string, { role: string; open: boolean; event: string }>;
  definitions: Map<string, { event: string; definedBy: string }>;
  keys: SpaceKeyEpoch[];
  keyDue: boolean;
  relays: ReadonlyArray<string>;
  keepers: ReadonlyArray<Keeper>;
  copies: number | null;
}

function startState(genesis: AccessGenesis): MutableState {
  return {
    roles: new Map(genesis.roles.map((role) => [role.name, role])),
    members: new Map([[genesis.creator, genesis.creatorRole]]),
    invites: new Map(),
    definitions: new Map(),
    keys: genesis.key ? [{ ...genesis.key, event: genesis.id }] : [],
    keyDue: false,
    relays: [],
    keepers: [],
    copies: null,
  };
}

/** Everyone holding a role that exists — who can read, as far as the history is concerned */
export function readers(state: AccessState): Set<string> {
  return new Set([...state.members].filter(([, role]) => state.roles.has(role)).map(([did]) => did));
}

function roleOf(state: AccessState, did: string): Role | null {
  const name = state.members.get(did);
  return name === undefined ? null : (state.roles.get(name) ?? null);
}

/** Whether an account holds a permission in a state */
export function holds(state: AccessState, did: string, permission: string): boolean {
  return roleHolds(roleOf(state, did), permission);
}

/** The role an account holds in a state, or null */
export function standing(state: AccessState, did: string): Role | null {
  return roleOf(state, did);
}

/**
 * Why a change is not allowed in a state, or null when it is. The one place
 * the rank rule lives.
 */
export function refusal(event: AccessEvent, state: AccessState): string | null {
  const author = roleOf(state, event.root);
  switch (event.kind) {
    case 'role': {
      if (!roleHolds(author, MANAGE)) return 'Its author may not manage roles';
      const existing = state.roles.get(event.name);
      if (existing && existing.rank >= author!.rank)
        return 'Its author may only change roles ranked below their own';
      if (!event.role) return existing ? null : 'There is no such role to remove';
      if (event.role.rank >= author!.rank) return 'Its author may only make roles ranked below their own';
      const missing = event.role.permissions.find((p) => !covers(author!.permissions, p));
      return missing ? `Its author cannot give a permission they do not hold (${missing})` : null;
    }
    case 'member': {
      const current = roleOf(state, event.did);
      // Joining with an invite: your own record, for the invite's role, while not a member.
      if (event.viaInvite !== undefined) {
        const invite = state.invites.get(event.viaInvite);
        if (event.root !== event.did) return 'Only the person joining can use an invite for themselves';
        if (!invite?.open) return 'The invite is not open';
        if (invite.role !== event.role) return 'The invite is for another role';
        if (current) return 'Already a member';
        return state.roles.has(invite.role) ? null : "The invite's role no longer exists";
      }
      // Leaving: anyone may remove themselves.
      if (event.root === event.did && event.role === null) return current ? null : 'Not a member';
      if (!roleHolds(author, MANAGE)) return 'Its author may not manage members';
      if (current && current.rank >= author!.rank)
        return 'Its author may only change people ranked below them';
      if (event.role === null) return current ? null : 'Not a member';
      const next = state.roles.get(event.role);
      if (!next) return `There is no role "${event.role}"`;
      return next.rank > author!.rank ? 'Its author may only give roles up to their own rank' : null;
    }
    case 'invite': {
      if (!roleHolds(author, INVITE)) return 'Its author may not make invites';
      const existing = state.invites.get(event.inviteKey);
      if (existing) {
        const was = state.roles.get(existing.role);
        if (was && was.rank > author!.rank) return 'Its author may only change invites up to their own rank';
      }
      if (!event.open) return existing ? null : 'There is no such invite to close';
      const role = state.roles.get(event.role);
      if (!role) return `There is no role "${event.role}"`;
      return role.rank > author!.rank ? 'Its author may only invite up to their own rank' : null;
    }
    // An account revokes its own keys: what a revoke takes away is only ever its own account's.
    case 'revoke':
      return author ? null : 'Only a member may revoke a key here';
    // The proof stands on its own (checked before it got here); a member only has to bring it.
    case 'fork':
      return author ? null : 'Only a member may report a fork';
    case 'definition': {
      const existing = state.definitions.get(event.name);
      if (!existing) return roleHolds(author, DEFINE) ? null : 'Its author may not define collections';
      // Changing one: whoever first defined it, while a member, or anyone who manages the space.
      if (roleHolds(author, MANAGE)) return null;
      return author && existing.definedBy === event.root
        ? null
        : 'Only whoever defined it, or someone who manages the space, may change it';
    }
    case 'key': {
      if (state.keys.length === 0) return 'A public space has no key to change';
      if (!roleHolds(author, MANAGE)) return "Its author may not change the space's key";
      // Going back to a key a removed member still holds would undo the point of changing it.
      return state.keys.some((known) => known.keyId === event.keyId || known.readKey === event.readKey)
        ? 'That key was used before'
        : null;
    }
    case 'relays':
      return roleHolds(author, MANAGE)
        ? checkRelays(event.relays)
        : 'Its author may not change where the space meets';
    case 'keepers':
      return roleHolds(author, MANAGE)
        ? checkKeepers(event.keepers, event.copies)
        : 'Its author may not change who keeps the space';
  }
}

/** Whether a role is lower than the one before it: gone, ranked lower, or missing a permission it had */
function lowered(before: Role | null, after: Role | null): boolean {
  if (!before) return false;
  if (!after) return true;
  return after.rank < before.rank || before.permissions.some((p) => !covers(after.permissions, p));
}

/** The people whose standing a change may lower */
function affected(event: AccessEvent, state: AccessState): ReadonlyArray<string> {
  if (event.kind === 'member') return [event.did];
  if (event.kind === 'role')
    return [...state.members].filter(([, role]) => role === event.name).map(([did]) => did);
  return [];
}

function change(event: AccessEvent, state: MutableState): void {
  switch (event.kind) {
    case 'role':
      if (event.role) state.roles.set(event.name, event.role);
      else state.roles.delete(event.name);
      return;
    case 'member':
      if (event.role === null) state.members.delete(event.did);
      else state.members.set(event.did, event.role);
      return;
    case 'invite':
      state.invites.set(event.inviteKey, { role: event.role, open: event.open, event: event.id });
      return;
    case 'revoke':
    case 'fork':
      return;
    case 'definition': {
      if (event.deleted) {
        state.definitions.delete(event.name);
        return;
      }
      const definedBy = state.definitions.get(event.name)?.definedBy ?? event.root;
      state.definitions.set(event.name, { event: event.id, definedBy });
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

// ─── The convergent replay (spec/drafts/convergent-access.md) ──────────
//
// No order decides anything. A change is allowed when its author had the
// power in the state its own view gives (the changes it saw that were
// allowed, merged). A change that lowers someone, judged in its own view, is
// a reduction; it strikes their changes it had not seen, past its cutoff.
// Reductions that strike each other all stand. The state is a merge of the
// valid changes: on each record, the latest wins, and of latest changes that
// didn't see each other, the one that gives least.

/** The kind's collection: where a change's place in its key's line is counted */
const KIND_COLLECTION: Record<AccessEvent['kind'], string> = {
  role: ROLE_COLLECTION,
  member: MEMBER_COLLECTION,
  invite: INVITE_COLLECTION,
  revoke: REVOKE_COLLECTION,
  definition: DEFINITION_COLLECTION,
  key: KEY_COLLECTION,
  relays: RELAYS_COLLECTION,
  keepers: KEEPERS_COLLECTION,
  fork: FORK_COLLECTION,
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
}

function seenOf(
  prefix: number,
  extra: ReadonlySet<number>,
  order: ReadonlyArray<string>,
  index: ReadonlyMap<string, number>,
): Seen & { readonly prefix: number; readonly extra: ReadonlySet<number> } {
  return {
    prefix,
    extra,
    size: prefix + extra.size,
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

/** Ordering by power: negative when `a` gives less than `b` */
function lessPower(a: Role | null, b: Role | null): number {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  return a.rank - b.rank || a.permissions.length - b.permissions.length;
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
  /** Valid reductions, by the account they lowered */
  readonly reductions: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly revokes: ReadonlyMap<string, ReadonlyArray<{ readonly event: string; readonly root: string }>>;
  readonly forks: ReadonlyMap<string, { readonly event: string; readonly from: number }>;
  readonly state: AccessState;
  readonly named: ReadonlySet<string>;
  readonly invites: ReadonlySet<string>;
  readonly views: Map<string, AccessState>;
  readonly allowedIds: ReadonlySet<string>;
  /** Accounts each change took reading from, in its own view */
  readonly lostReaders: ReadonlyMap<string, ReadonlyArray<string>>;
  /** What each allowed member or invite change gives, by the roles its own view had */
  readonly power: ReadonlyMap<string, Role | null>;
  /** The merge of every allowed change: the view of a change that saw them all */
  readonly allowedState: AccessState;
  readonly index: ReadonlyMap<string, number>;
  readonly ancestry: ReadonlyMap<string, Ancestry>;
}

type Ancestry = ReturnType<typeof seenOf>;

/** The state a set of changes gives, merged: no order, only what saw what, and least power between rivals */
function merge(
  genesis: AccessGenesis,
  events: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
  lostReaders: ReadonlyMap<string, ReadonlyArray<string>>,
  power: ReadonlyMap<string, Role | null>,
): AccessState {
  const state = startState(genesis);
  const byKey = new Map<string, AccessEvent[]>();
  for (const event of events) byKey.set(event.key, [...(byKey.get(event.key) ?? []), event]);
  /** The latest on a key: those no other on it saw */
  const latest = (group: ReadonlyArray<AccessEvent>) =>
    group.filter((event) => !group.some((other) => other !== event && saw.get(other.id)?.has(event.id)));
  const byId = (a: AccessEvent, b: AccessEvent) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Roles first: members' rivals are compared by the roles' rank.
  for (const group of byKey.values()) {
    const tops = latest(group).filter((event) => event.kind === 'role');
    if (tops.length === 0) continue;
    const role = (event: AccessEvent) => (event.kind === 'role' ? event.role : null);
    const [win] = [...tops].sort((a, b) => lessPower(role(a), role(b)) || byId(a, b));
    change(win!, state);
  }
  // What a change gives, by the roles as its own view had them: a later edit to a role can't reorder rivals.
  const given = (event: AccessEvent) => power.get(event.id) ?? null;
  let currentKey: AccessEvent | null = null;
  const keyEvents: AccessEvent[] = [];
  for (const group of byKey.values()) {
    const tops = latest(group);
    const kind = tops[0]?.kind;
    if (!kind || kind === 'role') continue;
    if (kind === 'key') {
      keyEvents.push(...group);
      currentKey = [...tops].sort(byId)[0]!;
      continue;
    }
    if (kind === 'revoke' || kind === 'fork') continue;
    let win: AccessEvent;
    if (kind === 'member')
      win = [...tops].sort(
        (a, b) =>
          (a.kind === 'member' && b.kind === 'member' ? lessPower(given(a), given(b)) : 0) || byId(a, b),
      )[0]!;
    else if (kind === 'invite')
      win = [...tops].sort(
        (a, b) =>
          (a.kind === 'invite' && b.kind === 'invite'
            ? Number(a.open) - Number(b.open) || lessPower(given(a), given(b))
            : 0) || byId(a, b),
      )[0]!;
    else win = [...tops].sort(byId)[0]!;
    if (win.kind === 'definition' && !win.deleted) {
      state.definitions.set(win.name, { event: win.id, definedBy: definerOf(win, group, saw) });
    } else change(win, state);
  }
  if (keyEvents.length > 0) {
    // Every key stands; the current one goes last, the rest by id: only which is current matters.
    const sorted = [...keyEvents].sort(byId);
    const current = currentKey!;
    for (const event of [...sorted.filter((e) => e !== current), current])
      if (event.kind === 'key')
        state.keys.push({ keyId: event.keyId, readKey: event.readKey, event: event.id });
  }
  // Due: someone lost reading in a change the current key had not seen. They may hold it.
  if (state.keys.length > 0) {
    const seenByKey = currentKey ? (saw.get(currentKey.id) ?? new Set<string>()) : new Set<string>();
    state.keyDue = events.some(
      (event) =>
        (lostReaders.get(event.id)?.length ?? 0) > 0 && !seenByKey.has(event.id) && event !== currentKey,
    );
  }
  return state;
}

/** A state with one change applied on top: the change saw all of it, so it is the latest on its record */
function applied(state: AccessState, event: AccessEvent, genesisId: string): MutableState {
  const next: MutableState = {
    ...state,
    roles: new Map(state.roles),
    members: new Map(state.members),
    invites: new Map(state.invites),
    definitions: new Map(state.definitions),
    keys: [...state.keys],
  };
  change(event, next);
  if (event.kind === 'key') {
    next.keyDue = false;
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

/** The role a member or invite change gives, by the roles as a state has them */
function givenIn(state: AccessState, event: AccessEvent): Role | null {
  if (event.kind === 'member' || event.kind === 'invite')
    return event.role === null ? null : (state.roles.get(event.role) ?? null);
  return null;
}

/**
 * Whoever defined a collection this time: of the definitions the winning one
 * saw, and itself, those that saw every removal it saw; of those, one that
 * saw no other, the lowest id if several.
 */
function definerOf(
  win: AccessEvent,
  group: ReadonlyArray<AccessEvent>,
  saw: ReadonlyMap<string, Seen>,
): string {
  const past = group.filter((event) => event === win || saw.get(win.id)?.has(event.id));
  const removed = (event: AccessEvent) => event.kind === 'definition' && event.deleted;
  const removals = past.filter(removed);
  const life = past.filter(
    (event) => !removed(event) && removals.every((removal) => saw.get(event.id)?.has(removal.id)),
  );
  const first = life
    .filter((event) => !life.some((other) => other !== event && saw.get(event.id)?.has(other.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return (first ?? win).root;
}

/** Replays a space's access history. */
export function replayAccess(genesis: AccessGenesis, events: ReadonlyArray<AccessEvent>): AccessHistory {
  const byId = new Map<string, AccessEvent>();
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);

  // A change waits until everything it saw is here, and so does anything that saw it.
  const waiting = new Set<string>();
  const known = (id: string) => id === genesis.id || byId.has(id);
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

  // Ancestors first (Kahn's order, ties by id): a cycle can only be forged, and must not hang it.
  const placeable = [...byId.values()].filter((event) => !waiting.has(event.id));
  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const event of placeable) {
    const parents = [...new Set(event.seen.filter((p) => p !== genesis.id))];
    pending.set(event.id, parents.length);
    for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), event.id]);
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
  for (const event of placeable) if (!order.includes(event.id)) waiting.add(event.id);

  const index = new Map(order.map((id, i) => [id, i]));
  const saw = new Map<string, ReturnType<typeof seenOf>>();
  for (const id of order) {
    const parents = [...new Set(byId.get(id)!.seen.filter((parent) => parent !== genesis.id))];
    let prefix = 0;
    for (const parent of parents) prefix = Math.max(prefix, saw.get(parent)!.prefix);
    const extra = new Set<number>();
    for (const parent of parents)
      for (const n of [...saw.get(parent)!.extra, index.get(parent)!]) if (n >= prefix) extra.add(n);
    while (extra.delete(prefix)) prefix++;
    saw.set(id, seenOf(prefix, extra, order, index));
  }

  // Allowed: by the state its own view gives, from the allowed changes it saw.
  const lostReaders = new Map<string, string[]>();
  const power = new Map<string, Role | null>();
  const refused = new Map<string, string>();
  const allowedIds = new Set<string>();
  const lowers = new Map<string, string[]>();
  const viewOf = (ids: Iterable<string>) =>
    merge(
      genesis,
      [...ids].filter((id) => allowedIds.has(id)).map((id) => byId.get(id)!),
      saw,
      lostReaders,
      power,
    );
  // A change naming one change saw what that one saw and that one: its view is that one's, with it
  // applied on top, since it saw everything before it and so is the latest on its record. Only
  // where branches meet does a view need merging whole.
  const viewAt = new Map<string, AccessState>();
  const afterOf = new Map<string, AccessState>();
  const ownView = (event: AccessEvent): AccessState => {
    const parents = [...new Set(event.seen.filter((parent) => parent !== genesis.id))];
    if (parents.length === 0) return startState(genesis);
    if (parents.length === 1) {
      const parent = parents[0]!;
      return afterOf.get(parent) ?? viewAt.get(parent)!;
    }
    return viewOf(saw.get(event.id)!);
  };
  for (const id of order) {
    const event = byId.get(id)!;
    const view = ownView(event);
    viewAt.set(id, view);
    const reason = refusal(event, view);
    if (reason) {
      refused.set(id, reason);
      continue;
    }
    allowedIds.add(id);
    power.set(id, givenIn(view, event));
    // What it takes, judged in its own view: whom it lowers, and who stops reading.
    const after = applied(view, event, genesis.id);
    if (event.kind === 'definition' && !event.deleted) {
      const group = [...saw.get(id)!]
        .filter((other) => allowedIds.has(other) && byId.get(other)!.key === event.key)
        .map((other) => byId.get(other)!)
        .concat(event);
      after.definitions.set(event.name, { event: id, definedBy: definerOf(event, group, saw) });
    }
    const lowered_ = affected(event, view).filter((did) => lowered(roleOf(view, did), roleOf(after, did)));
    if (lowered_.length > 0) lowers.set(id, lowered_);
    // Only the person a member change names, or the holders of a role, can stop reading.
    const reads = (state: AccessState, did: string) => {
      const role = state.members.get(did);
      return role !== undefined && state.roles.has(role);
    };
    const lost = affected(event, view).filter((did) => reads(view, did) && !reads(after, did));
    if (lost.length > 0) lostReaders.set(id, lost);
    if (lost.length > 0 && after.keys.length > 0 && event.kind !== 'key') after.keyDue = true;
    afterOf.set(id, after);
  }

  // Strikes: a valid reduction of an account strikes its changes it had not seen and does not cover.
  const covers = (reduction: AccessEvent, event: AccessEvent) =>
    saw.get(reduction.id)!.has(event.id) ||
    (event.line !== undefined &&
      (reduction.cutoff.get(event.author)?.get(KIND_COLLECTION[event.kind]) ?? -1) >= event.line);
  const strikes = new Map<string, string[]>();
  for (const reductionId of order) {
    if (!allowedIds.has(reductionId)) continue;
    const reduction = byId.get(reductionId)!;
    const targets = (event: AccessEvent): boolean => {
      if (reduction.kind === 'revoke')
        return event.root === reduction.root && event.author === reduction.target;
      if (reduction.kind === 'fork')
        return event.author === reduction.writer && (event.at ?? 0) >= reduction.from;
      // Closing an invite strikes joins through it that the close had not seen.
      if (reduction.kind === 'invite')
        return !reduction.open && event.kind === 'member' && event.viaInvite === reduction.inviteKey;
      return (lowers.get(reductionId) ?? []).includes(event.root);
    };
    for (const id of order) {
      if (id === reductionId || !allowedIds.has(id)) continue;
      const event = byId.get(id)!;
      if (!targets(event) || saw.get(id)!.has(reductionId) || covers(reduction, event)) continue;
      strikes.set(reductionId, [...(strikes.get(reductionId) ?? []), id]);
    }
  }

  // Components of the strike graph (Tarjan), visited sources first: strikes within one don't count.
  const component = new Map<string, number>();
  const components: string[][] = [];
  {
    let index = 0;
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visit = (id: string) => {
      indices.set(id, index);
      low.set(id, index++);
      stack.push(id);
      onStack.add(id);
      for (const next of strikes.get(id) ?? []) {
        if (!indices.has(next)) {
          visit(next);
          low.set(id, Math.min(low.get(id)!, low.get(next)!));
        } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!));
      }
      if (low.get(id) === indices.get(id)) {
        const members: string[] = [];
        let top: string;
        do {
          top = stack.pop()!;
          onStack.delete(top);
          component.set(top, components.length);
          members.push(top);
        } while (top !== id);
        components.push(members);
      }
    };
    for (const id of order) if (allowedIds.has(id) && !indices.has(id)) visit(id);
  }
  const struckBy = new Map<string, string[]>();
  for (const [from, targets] of strikes)
    for (const to of targets)
      if (component.get(from) !== component.get(to)) struckBy.set(to, [...(struckBy.get(to) ?? []), from]);
  const valid = new Set<string>();
  const struck = new Map<string, string>();
  // Tarjan emits components sinks first: walking it backwards visits strikers before what they strike.
  for (let c = components.length - 1; c >= 0; c--)
    for (const id of components[c]!) {
      const by = (struckBy.get(id) ?? []).find((from) => valid.has(from));
      if (by) struck.set(id, `Its author's power was taken away by a change it had not seen (${by})`);
      else valid.add(id);
    }

  const reductions = new Map<string, string[]>();
  const revokes = new Map<string, Array<{ event: string; root: string }>>();
  const forks = new Map<string, { event: string; from: number }>();
  for (const id of order) {
    if (!valid.has(id)) continue;
    const event = byId.get(id)!;
    for (const did of lowers.get(id) ?? []) reductions.set(did, [...(reductions.get(did) ?? []), id]);
    if (event.kind === 'revoke')
      revokes.set(event.target, [...(revokes.get(event.target) ?? []), { event: id, root: event.root }]);
    if (event.kind === 'fork' && event.from < (forks.get(event.writer)?.from ?? Infinity))
      forks.set(event.writer, { event: id, from: event.from });
  }
  const named = new Set<string>([genesis.creator]);
  const invites = new Set<string>();
  for (const event of byId.values()) {
    if (event.kind === 'member' && event.role !== null) named.add(event.did);
    if (event.kind === 'invite') invites.add(event.inviteKey);
  }
  const state = merge(
    genesis,
    order.filter((id) => valid.has(id)).map((id) => byId.get(id)!),
    saw,
    lostReaders,
    power,
  );
  const allowedState = merge(
    genesis,
    order.filter((id) => allowedIds.has(id)).map((id) => byId.get(id)!),
    saw,
    lostReaders,
    power,
  );
  return historyOf({
    genesis,
    byId,
    waiting,
    order,
    saw,
    ancestry: saw,
    index,
    allowedState,
    refused,
    valid,
    struck,
    reductions,
    revokes,
    forks,
    state,
    named,
    invites,
    views: new Map(),
    allowedIds,
    lostReaders,
    power,
  });
}

/**
 * The replay with one more change that saw every change placed, or null for
 * any other: then only replaying whole can say. Such a change can't be struck
 * (it saw every reduction) and strikes nothing (it saw everything), so it is
 * valid exactly when it is allowed, its view is every allowed change, and it
 * is the latest on its record.
 */
function extended(r: Replay, event: AccessEvent): Replay | null {
  const { genesis } = r;
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
  const byId = new Map(r.byId).set(event.id, event);
  const named = new Set(r.named);
  if (event.kind === 'member' && event.role !== null) named.add(event.did);
  const invites = new Set(r.invites);
  if (event.kind === 'invite') invites.add(event.inviteKey);
  const base = {
    genesis,
    byId,
    waiting: r.waiting,
    order,
    saw: ancestry,
    ancestry,
    index,
    named,
    invites,
    views: new Map<string, AccessState>(),
  };

  const view = r.allowedState;
  const reason = refusal(event, view);
  if (reason) {
    return {
      ...r,
      ...base,
      refused: new Map(r.refused).set(event.id, reason),
    };
  }
  const after = applied(view, event, genesis.id);
  const lowered_ = affected(event, view).filter((did) => lowered(roleOf(view, did), roleOf(after, did)));
  const reads = (state: AccessState, did: string) => {
    const role = state.members.get(did);
    return role !== undefined && state.roles.has(role);
  };
  const lost = affected(event, view).filter((did) => reads(view, did) && !reads(after, did));
  if (lost.length > 0 && after.keys.length > 0 && event.kind !== 'key') after.keyDue = true;
  const state = applied(r.state, event, genesis.id);
  if (event.kind === 'definition' && !event.deleted) {
    // Who defined it, by the same rule a merge uses: in the allowed changes for its view, the valid ones for the state.
    const ancestryWith = new Map(r.ancestry).set(event.id, mine);
    const group = (ids: ReadonlySet<string>) =>
      [...r.byId.values()].filter((other) => other.key === event.key && ids.has(other.id)).concat(event);
    after.definitions.set(event.name, {
      event: event.id,
      definedBy: definerOf(event, group(r.allowedIds), ancestryWith),
    });
    state.definitions.set(event.name, {
      event: event.id,
      definedBy: definerOf(event, group(r.valid), ancestryWith),
    });
  }
  if (lost.length > 0 && state.keys.length > 0 && event.kind !== 'key') state.keyDue = true;
  const reductions = new Map(r.reductions);
  for (const did of lowered_) reductions.set(did, [...(reductions.get(did) ?? []), event.id]);
  const revokes = new Map(r.revokes);
  if (event.kind === 'revoke')
    revokes.set(event.target, [...(revokes.get(event.target) ?? []), { event: event.id, root: event.root }]);
  const forks = new Map(r.forks);
  if (event.kind === 'fork' && event.from < (forks.get(event.writer)?.from ?? Infinity))
    forks.set(event.writer, { event: event.id, from: event.from });
  return {
    ...r,
    ...base,
    valid: new Set(r.valid).add(event.id),
    allowedIds: new Set(r.allowedIds).add(event.id),
    lostReaders: lost.length > 0 ? new Map(r.lostReaders).set(event.id, lost) : r.lostReaders,
    power: new Map(r.power).set(event.id, givenIn(view, event)),
    allowedState: after,
    state,
    reductions,
    revokes,
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
  const at = (ids: ReadonlyArray<string>): AccessState => {
    const key = [...new Set(ids)].sort().join(',');
    const cached = r.views.get(key);
    if (cached) return cached;
    const cut = cutOf(ids);
    const view = merge(
      genesis,
      [...cut].filter((id) => r.allowedIds.has(id)).map((id) => r.byId.get(id)!),
      r.saw,
      r.lostReaders,
      r.power,
    );
    r.views.set(key, view);
    return view;
  };
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
    at(ids: ReadonlyArray<string>) {
      return seen(ids) ? at(ids) : null;
    },
    judge(record, needs, within) {
      if (!seen(record.seen) || (within && !seen(within)))
        return { ok: false, reason: 'Access changes it depends on have not arrived yet', later: true };
      // For a cited version, only what the citer had seen can take it away (02 §7.6).
      const known = within ? cutOf(within) : null;
      const counts = (event: string) => !known || known.has(event);
      const covered = (event: string) =>
        record.writer !== undefined &&
        record.collection !== undefined &&
        record.line !== undefined &&
        (r.byId.get(event)!.cutoff.get(record.writer)?.get(record.collection) ?? -1) >= record.line;
      if (record.writer !== undefined) {
        for (const revoke of r.revokes.get(record.writer) ?? [])
          if (revoke.root === record.root && counts(revoke.event) && !covered(revoke.event))
            return { ok: false, reason: 'The key that signed it was revoked', withdrawn: true };
      }
      const fork = record.writer === undefined ? undefined : r.forks.get(record.writer);
      if (fork && (record.at ?? 0) >= fork.from && counts(fork.event))
        return { ok: false, reason: 'Its writer’s log forked at or before it', withdrawn: true };
      const own = at(record.seen);
      if (!needs(roleOf(own, record.root), own))
        return { ok: false, reason: 'Its author was not allowed to, as of what it had seen' };
      const cut = cutOf(record.seen);
      const unseen = (r.reductions.get(record.root) ?? []).filter(
        (event) => !cut.has(event) && counts(event) && !covered(event),
      );
      return { ok: true, unseen };
    },
    revoked: (key: string, root: string) =>
      (r.revokes.get(key) ?? []).filter((revoke) => revoke.root === root).map((revoke) => revoke.event),
    forked: (writer: string) => r.forks.get(writer) ?? null,
    forks: () => [...r.forks].map(([writer, { from }]) => ({ writer, from })),
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
