/**
 * @module node/space-history
 * The access history of a space: every version in the access collections,
 * kept whole (`retain`), turned into plain events and replayed
 * (`space/roles.ts`). Everything about who may do what is read from the replay.
 */
import { setCapped } from '../utils/map.js';
import type { Version } from '../types.js';
import { accessRequirement, actsForAccount, noteGrants } from '../identity/abilities.js';
import { checkFork } from '../records/fork.js';
import { isSealedBody } from '../privacy/space-encryption.js';
import {
  MEMBER_KEY_COLLECTION,
  SPACE_KEY_RECORD,
  SPACE_RELAYS_RECORD,
  SPACE_KEEPERS_RECORD,
  inviteKey as inviteRecordKey,
  assignKey,
  removalKey,
  revokeKey,
  roleKey,
  verifyInvite,
  forkKey,
  stepDownKey,
  succeedKey,
} from '../space/space-access.js';
import { accessGenesisOf, isSpaceId } from '../space/constitution.js';
import {
  ACCESS_COLLECTIONS,
  ACCESS_KINDS,
  ASSIGN_COLLECTION,
  DEFINITION_COLLECTION,
  INVITE_COLLECTION,
  KEY_COLLECTION,
  MAX_RELAYS,
  RELAYS_COLLECTION,
  KEEPERS_COLLECTION,
  FORK_COLLECTION,
  checkKeepers,
  type Keeper,
  REMOVE_COLLECTION,
  REVOKE_COLLECTION,
  ROLE_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
  readers,
  replayAccess,
  type AccessEvent,
  type AccessHistory,
  type AccessState,
  type Cutoff,
} from '../space/roles.js';
import { readDefinition } from '../space/grants.js';
import { PROFILE_COLLECTION } from '../space/account-registry.js';
import { isRecord, isStringList } from '../utils/guards.js';
import { type Versions, idsKey, signedKey, type SpaceBase } from './space-versions.js';

/** How many keys a cutoff may name */
export const MAX_CUTOFF = 1024;
/** A change that takes nothing away covers nothing */
const NO_CUTOFF: Cutoff = new Map();
/** Access states replayed for warrants */
const MAX_VIEWS = 256;

const areKeepers = (keepers: unknown): keepers is Keeper[] => checkKeepers(keepers) === null;

/** A cutoff from a record's body — key DID → collection → the place covered up to — or null when it isn't one */
function readCutoff(value: unknown): Cutoff | null {
  if (value === undefined) return new Map();
  if (!isRecord(value)) return null;
  const cutoff = new Map<string, Map<string, number>>();
  let entries = 0;
  for (const [key, lines] of Object.entries(value)) {
    if (!key.startsWith('did:key:') || !isRecord(lines)) return null;
    const byCollection = new Map<string, number>();
    for (const [collection, n] of Object.entries(lines)) {
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || ++entries > MAX_CUTOFF) return null;
      byCollection.set(collection, n);
    }
    cutoff.set(key, byCollection);
  }
  return cutoff;
}

/**
 * Whether a version is about the account that signs it: its own place in the
 * space, what others seal to it or see of it, or another of its keys. Only a
 * key acting as the account itself writes one (spec 01 §8), so an app given a
 * space never changes the account's standing there.
 */
export function aboutItself(collection: string, body: unknown, root: string, author: string): boolean {
  if (collection === STEPDOWN_COLLECTION || collection === MEMBER_KEY_COLLECTION) return true;
  if (collection === PROFILE_COLLECTION) return true;
  if (!isRecord(body)) return false;
  if (collection === ASSIGN_COLLECTION || collection === REMOVE_COLLECTION) return body.did === root;
  return collection === REVOKE_COLLECTION && body.key !== author;
}

interface Access {
  readonly history: AccessHistory;
  readonly events: ReadonlyArray<AccessEvent>;
  /** A version was passed over that a later look might take: then only reading them all again is sure */
  readonly unsettled: boolean;
}

export function createHistory({
  space,
  storage,
  provider,
  versions,
  onRead,
}: SpaceBase & {
  readonly versions: Versions;
  /** Told the state the history is in now, whenever it is read anew */
  readonly onRead: (state: AccessState) => void;
}) {
  const { copyProblem, judge } = versions;

  const accessGenesis = accessGenesisOf(space);

  /** Events, by version: building one checks signatures and invites */
  const events = new Map<string, AccessEvent | null>();

  async function toEvent(version: Version): Promise<AccessEvent | null> {
    if (await copyProblem(version)) return null;
    const key = signedKey(version);
    if (events.has(key)) return events.get(key) ?? null;
    const event = await buildEvent(version);
    // Only settled answers from a valid signature are kept.
    if (event || (await judge(version)).verified) events.set(key, event);
    return event;
  }

  async function buildEvent(version: Version): Promise<AccessEvent | null> {
    if (!ACCESS_COLLECTIONS.has(version.collection) || !version.retain) return null;
    // Only a note that grants it changes the space's collections, or who may do what.
    if (!noteGrants(version.proof, accessRequirement(space.id, version.collection, version.key))) return null;
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root) return null;
    const root = verdict.root;
    if (!actsForAccount(version.proof) && aboutItself(version.collection, version.body, root, version.author))
      return null;
    const base = {
      id: version.id,
      key: version.key,
      root,
      author: version.author,
      seen: version.seen ?? [],
      cutoff: NO_CUTOFF,
      ...(version.log ? { line: version.log.n } : {}),
    };

    if (version.collection === DEFINITION_COLLECTION) {
      if (!version.key.startsWith('collection:')) return null;
      const name = version.key.slice('collection:'.length);
      return { ...base, kind: 'definition', name, deleted: !!version.deleted };
    }
    // Everything else is taken away by a change, never deleted: a delete has no body to carry a cutoff.
    if (version.deleted || isSealedBody(version.body)) return null;
    const body = version.body;
    if (!isRecord(body)) return null;
    const cutoff = readCutoff(body.cutoff);
    if (!cutoff) return null;
    // Definitions, invites and successors take nothing from anyone, so carry no cutoff.
    const noCutoff = body.cutoff === undefined;

    switch (version.collection) {
      case ROLE_COLLECTION: {
        const defined = noCutoff ? readDefinition(body, { root, spaceId: space.id }) : null;
        if (!defined || version.key !== roleKey(defined.name)) return null;
        return {
          ...base,
          kind: 'role',
          name: defined.name,
          ...(defined.title !== undefined ? { title: defined.title } : {}),
          grants: defined.grants,
          nests: defined.nests,
        };
      }
      case ASSIGN_COLLECTION: {
        const { did, role, assigned, invite } = body;
        // Roles go to accounts, never to roles: an assignee is a did:key.
        if (typeof did !== 'string' || !did.startsWith('did:key:') || typeof role !== 'string') return null;
        if (typeof assigned !== 'boolean' || version.key !== (await assignKey(did, role))) return null;
        if (invite === undefined) return { ...base, cutoff, kind: 'assign', did, role, assigned };
        if (!isRecord(invite) || typeof invite.key !== 'string' || typeof invite.signature !== 'string')
          return null;
        if (!(await verifyInvite(space.id, did, invite.key, invite.signature, provider))) return null;
        return { ...base, cutoff, kind: 'assign', did, role, assigned, viaInvite: invite.key };
      }
      case REMOVE_COLLECTION: {
        const { did } = body;
        if (typeof did !== 'string' || version.key !== (await removalKey(did))) return null;
        return { ...base, cutoff, kind: 'remove', did };
      }
      case STEPDOWN_COLLECTION: {
        const { did } = body;
        if (typeof did !== 'string' || version.key !== (await stepDownKey(did))) return null;
        return { ...base, cutoff, kind: 'stepdown', did };
      }
      case SUCCEED_COLLECTION: {
        // It names another space: the successor's constitution names this one, so can't be it.
        if (!noCutoff || !isSpaceId(body.space) || body.space === space.id) return null;
        if (version.key !== (await succeedKey(body.space))) return null;
        return { ...base, kind: 'succeed', space: body.space };
      }
      case INVITE_COLLECTION: {
        const { key, role, open } = body;
        if (!noCutoff || typeof key !== 'string' || typeof role !== 'string' || typeof open !== 'boolean')
          return null;
        if (version.key !== (await inviteRecordKey(key))) return null;
        return { ...base, kind: 'invite', inviteKey: key, role, open };
      }
      case KEY_COLLECTION: {
        const { keyId, readKey } = body;
        if (version.key !== SPACE_KEY_RECORD || typeof keyId !== 'string' || keyId.length > 64) return null;
        if (typeof readKey !== 'string' || !readKey.startsWith('did:key:')) return null;
        return { ...base, kind: 'key', keyId, readKey };
      }
      case RELAYS_COLLECTION: {
        const { relays } = body;
        if (version.key !== SPACE_RELAYS_RECORD || !isStringList(relays) || relays.length > MAX_RELAYS)
          return null;
        return { ...base, kind: 'relays', relays };
      }
      case FORK_COLLECTION: {
        // The proof stands on its own: every peer checks both signatures itself.
        const fork = await checkFork(body.a, body.b, space.id, provider);
        if (typeof fork === 'string' || version.key !== (await forkKey(fork.writer))) return null;
        return { ...base, kind: 'fork', writer: fork.writer, collection: fork.collection, from: fork.from };
      }
      case KEEPERS_COLLECTION: {
        const { keepers } = body;
        const copies = body.copies ?? null;
        if (version.key !== SPACE_KEEPERS_RECORD || checkKeepers(keepers, copies) !== null) return null;
        if (!areKeepers(keepers) || !(copies === null || typeof copies === 'number')) return null;
        return { ...base, kind: 'keepers', keepers, copies };
      }
      case REVOKE_COLLECTION: {
        // At a key naming both the key and its account, so no one else's revoke can take its place.
        const { key } = body;
        if (typeof key !== 'string' || !key.startsWith('did:key:')) return null;
        if (version.key !== (await revokeKey(key, root))) return null;
        return { ...base, cutoff, kind: 'revoke', target: key };
      }
    }
    return null;
  }

  let accessCache: Promise<Access> | null = null;
  const access = () => (accessCache ??= loadAccess());

  /**
   * Accounts that held a place in this private space and hold none now. No
   * live message goes to them, and while a new key is due (`untilNewKey`)
   * nothing else does either. Empty in a public space, which anyone may read.
   */
  async function formerMembers(options: { untilNewKey?: boolean } = {}): Promise<ReadonlySet<string>> {
    if (space.visibility !== 'private') return new Set();
    const { history, events } = await access();
    // A key made since does the work, and someone invited back holds it.
    if (options.untilNewKey && !history.current.keyDue) return new Set();
    const allowed = readers(history.current);
    const gone = new Set<string>();
    for (const event of events) {
      if ((event.kind !== 'assign' && event.kind !== 'remove') || allowed.has(event.did)) continue;
      if (history.status(event.id)?.status === 'applied') gone.add(event.did);
    }
    return gone;
  }

  /** Whether a version sits where the history reads: an access kind's key, in its collection */
  const inAccessHistory = (version: Version) =>
    Object.values(ACCESS_KINDS).some(
      ({ prefix, collection }) => version.key.startsWith(prefix) && version.collection === collection,
    );

  async function loadAccess(): Promise<Access> {
    const found: AccessEvent[] = [];
    let unsettled = false;
    // By key, not by the current version's collection: whatever sits on top may be anyone's.
    for (const { prefix, collection } of Object.values(ACCESS_KINDS)) {
      for (const versions of (await storage.histories(prefix)).values()) {
        for (const held of versions.filter((version) => version.collection === collection)) {
          const event = await toEvent(held);
          if (event) found.push(event);
          else unsettled ||= !events.has(signedKey(held));
        }
      }
    }
    return accessFrom(replayAccess(accessGenesis, found), found, unsettled);
  }

  function accessFrom(history: AccessHistory, found: ReadonlyArray<AccessEvent>, unsettled: boolean): Access {
    onRead(history.current);
    return { history, events: found, unsettled };
  }

  /**
   * The history with versions just stored, each added the way a whole replay
   * would place it (`AccessHistory.extend`), or read and replayed again when
   * one can't be. Adding a member costs as much as the members, not the history.
   */
  async function extendAccess(before: Promise<Access>, placed: ReadonlyArray<Version>): Promise<Access> {
    const previous = await before.catch(() => null);
    if (!previous || previous.unsettled) return loadAccess();
    let pending: AccessEvent[] = [];
    for (const version of placed.filter(inAccessHistory)) {
      const event = await toEvent(version);
      if (event) pending.push(event);
      else if (!events.has(signedKey(version))) return loadAccess();
    }
    if (pending.length === 0) return previous;
    let history = previous.history;
    const found = [...previous.events];
    // A batch from a peer may hold a change before the one it saw: whichever follows on goes first.
    while (pending.length > 0) {
      const left: AccessEvent[] = [];
      for (const event of pending) {
        const next = history.extend(event);
        if (!next) left.push(event);
        else if (next !== history) {
          found.push(event);
          history = next;
        }
      }
      if (left.length === pending.length) return loadAccess();
      pending = left;
    }
    return accessFrom(history, found, false);
  }

  /** Views already replayed, by the changes they hold: a set of ids always replays to the same state */
  const views = new Map<string, AccessState>();

  /**
   * The access state a writer had when it signed: the changes it names as
   * seen and everything they saw, replayed alone. Unlike `history.at`, no
   * change outside them — a rival that arrives late, or a change made later —
   * can alter it, so a verdict on misconduct judged by it is final. Null
   * while one of them hasn't arrived.
   */
  async function ownView(seen: ReadonlyArray<string>): Promise<AccessState | null> {
    const cacheKey = idsKey(seen);
    const known = views.get(cacheKey);
    if (known) return known;
    const { events } = await access();
    const byId = new Map(events.map((event) => [event.id, event]));
    const cut: AccessEvent[] = [];
    const visited = new Set<string>([accessGenesis.id]);
    const waiting = [...seen];
    while (waiting.length > 0) {
      const id = waiting.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const event = byId.get(id);
      if (!event) return null;
      cut.push(event);
      waiting.push(...event.seen);
    }
    const state = replayAccess(accessGenesis, cut).current;
    setCapped(views, cacheKey, state, MAX_VIEWS);
    return state;
  }

  return {
    accessGenesis,
    access,
    toEvent,
    buildEvent,
    formerMembers,
    ownView,
    /** The space's own records changed: the history takes in the versions placed, or is read again */
    changed(placed?: ReadonlyArray<Version>): void {
      accessCache = placed && accessCache ? extendAccess(accessCache, placed) : null;
    },
  };
}

export type History = ReturnType<typeof createHistory>;
