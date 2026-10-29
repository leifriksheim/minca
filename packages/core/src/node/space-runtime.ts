/**
 * @module node/space-runtime
 * One open space: its store, its gatekeeper, its peers, its sync.
 *
 * A space is the unit of storage and of sync — its own store, its own
 * rooms and sockets — so two spaces never mix, and a peer you share one space
 * with learns nothing about the others.
 *
 * **A record keeps its key; changes are versions.** Editing a record writes its
 * next version — same key, `seq` one higher, `prev` naming the one replaced —
 * and deleting it writes a version marked deleted. Which version is current is
 * decided by `seq` and id alone (`records/version.ts`), never by a clock, so
 * every node agrees and nothing replayed can roll a record back.
 *
 * **Who may write is the space's access history** (`space/roles.ts`): roles,
 * members, invites, revoked notes and collection definitions, as records every
 * version points into with `seen`. A version stands when its author held what
 * its collection's rules ask, as of what it saw, and nothing it had not seen
 * took that away. A version that stops standing — its author was removed, and
 * the remover never saw it — is passed over when reading, and the version
 * before it counts again, where the store still has one.
 *
 * Each part has a module of its own, opened here in the order they lean on
 * each other: what a version is (`space-versions.ts`), the access history
 * (`space-history.ts`), the rules (`space-rules.ts`), whether a version
 * stands (`space-standing.ts`) and passes its checks (`space-checks.ts`),
 * the catalogue (`space-catalog.ts`), what counts now (`space-index.ts`),
 * profiles (`space-profiles.ts`), the space's keys (`space-keys.ts`),
 * writing (`space-writing.ts`), writers' lines (`space-lines.ts`), warrants
 * (`space-warrants.ts`), mirrors (`space-mirrors.ts`), peers
 * (`space-peers.ts`) and membership (`space-membership.ts`).
 */
import type { CryptoProvider, Version } from '../types.js';
import type { Signer } from '../schema/signer.js';
import type { SchemaEngine } from '../schema/schema-engine.js';
import type { SpaceRecord } from '../space/space-manager.js';
import type { Delegation } from '../identity/ucan.js';
import { actsForAccount } from '../identity/abilities.js';
import { contactKeyPair } from '../identity/contact-key.js';
import { ownedKey } from '../records/key.js';
import { topicTag } from '../records/topics.js';
import { storedComputed, storedContract } from '../records/contract-builder.js';
import { usableComputed, type ComputedFields } from '../query/computed.js';
import { createStorageProvider } from '../storage/storage-provider.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { SpaceKey } from '../privacy/space-encryption.js';
import type { Mesh } from '../network/mesh.js';
import { ACCESS_COLLECTIONS, rolesOf, type AccessState } from '../space/roles.js';
import { FOUNDER } from '../space/space-manager.js';
import { PROFILE_COLLECTION, type AvatarRef } from '../space/account-registry.js';
import { SYNC_PROTOCOL_VERSION } from '../sync/sync-messages.js';
import { createSpaceFiles, DEVICE_LIMITS, type SealedFile } from '../files/space-files.js';
import { CATALOG_COLLECTION, toJsonSchema, type StoredCollection } from '../schema/collection-def.js';
import { unref } from '../utils/guards.js';
import type { StoreFactory } from './stores.js';
import type { Writers } from './writers.js';
import { openSpaceHolding } from './space-holding.js';
import {
  createVersions,
  storable,
  type ActiveSession,
  type SpaceBase,
  type Standing,
} from './space-versions.js';
import { createHistory } from './space-history.js';
import { createRules } from './space-rules.js';
import { createStanding } from './space-standing.js';
import { createChecks } from './space-checks.js';
import { createCatalog, definitionProblem } from './space-catalog.js';
import { createIndex } from './space-index.js';
import { createProfiles, profileKey } from './space-profiles.js';
import { createKeys } from './space-keys.js';
import { createWriting } from './space-writing.js';
import { createLines } from './space-lines.js';
import { createWarrants } from './space-warrants.js';
import { openMirrors } from './space-mirrors.js';
import { createMeeting, openPeers } from './space-peers.js';
import { createMembership } from './space-membership.js';
import type { CacheConfig, DefineCollection, NodeCollection, NodeEvent, NodeNetworkConfig } from './types.js';

export interface SpaceRuntimeDeps {
  readonly record: SpaceRecord;
  /** The logs of the keys this node signs with: one line per key, space and collection (`node/writers.ts`) */
  readonly writers: Writers;
  readonly stores: StoreFactory;
  readonly provider: CryptoProvider;
  readonly signer: Signer;
  readonly schemas: SchemaEngine;
  readonly session: ActiveSession;
  /** The identity the node acts for — names the cross-tab channel */
  readonly rootDid: string;
  readonly network?: NodeNetworkConfig;
  /** The node's connections through relays, which this space joins by its room */
  readonly mesh?: Mesh;
  readonly watchIntervalMs: number;
  readonly emit: (event: NodeEvent) => void;
  /** Told the role this account holds whenever the access history says something new */
  readonly onRole?: (role: string | null) => void;
  /** Told once an invite's secret has been used, and can be forgotten */
  readonly onJoined?: () => void;
  /**
   * This account's member key for the space (`deriveMemberKeyBytes`): what a
   * new key is sealed to when the space's key changes. Without it, this node
   * waits for another of the account's to learn the new key.
   */
  readonly memberKey?: Uint8Array | null;
  /** Told every key of the space this node holds whenever it learns one, and which it now writes with */
  readonly onKeys?: (keys: ReadonlyArray<SpaceKey>, current: string) => Promise<void>;
  /** Told the relays the space names, when they differ from the ones the record came with */
  readonly onRelays?: (relays: ReadonlyArray<string>) => Promise<void>;
  /** File stores the space is also kept in (`storage/mirror.ts`): read when it opens, written soon after every change */
  readonly mirrors?: ReadonlyArray<BlobStore>;
  /**
   * Only notes that grant `account/write` count here — for the account's own
   * spaces, where a note for "every space" would otherwise let a key it
   * trusts less join the account to a space or leave one.
   */
  readonly accountOnly?: boolean;
  /** Hold only the collections used, once the space names a keeper (`NodeConfig.cache`). Absent: hold it whole. */
  readonly cache?: CacheConfig;
  /** Told of every version a peer sent that was taken in — what a carrier matches subscriptions against */
  readonly onArrived?: (version: Version) => void;
  /** Fetch and keep every file the space's records name, as a keeper does, rather than within a device's limits (spec 05 §16.6) */
  readonly fetchFiles?: 'all';
}

/** One open space, as `openSpaceRuntime` gives it */
export type SpaceRuntime = Awaited<ReturnType<typeof openSpaceRuntime>>;

/** What this account is here, for listing: `founder`, a role it holds, or null */
function placeOf(state: AccessState, did: string): string | null {
  if (state.founders.has(did)) return FOUNDER;
  return rolesOf(state, did)[0] ?? null;
}

export async function openSpaceRuntime(deps: SpaceRuntimeDeps) {
  const { record, provider, signer, schemas, session, emit, rootDid } = deps;
  const { space } = record;
  let closed = false;
  const isClosed = () => closed;
  const statusChanged = () => emit({ type: 'status', space: space.id });

  /** Every key of the space this node holds, by id: a sealed body names its key, the history the current one */
  const keyring = new Map<string, SpaceKey>();
  for (const held of record.keys ?? []) keyring.set(held.id, held);
  if (record.key) keyring.set(record.key.id, record.key);
  /** This account's member key here, which new keys are sealed to */
  const memberPair = deps.memberKey ? await contactKeyPair(deps.memberKey) : null;

  const adapter = await deps.stores(`spaces/${space.id}`);
  const storage = createStorageProvider(adapter);

  // What this node holds (`node/space-holding.ts`): settled here, since sync asks on every hello.
  const holding = await openSpaceHolding({
    cache: deps.cache ?? null,
    adapter,
    storage,
    spaceId: space.id,
    sessionDid: session.did,
    emit,
    statusChanged,
    isClosed,
    access: () => history.access(),
    sync: () => peers.sync,
    connectedPeers: () => peers.connectedPeers(),
    recordsChanged: () => recordsChanged(),
  });

  const base: SpaceBase = {
    record,
    space,
    storage,
    provider,
    keyring,
    session,
    rootDid,
    accountOnly: !!deps.accountOnly,
    isClosed,
  };

  // ─── Judging ───────────────────────────────────────────────────────

  const meeting = createMeeting(record, deps.mesh, deps.onRelays);
  let reportedRole: string | null | undefined;
  const versions = createVersions(base);
  const history = createHistory({
    ...base,
    versions,
    onRead(state) {
      meeting.heard(state);
      const role = placeOf(state, rootDid);
      if (role === reportedRole) return;
      reportedRole = role;
      deps.onRole?.(role);
    },
  });
  const rules = createRules({ ...base, versions });
  const standing = createStanding({ ...base, versions, history, rules });
  const checks = createChecks({ ...base, versions, history, rules, standing });
  const catalog = createCatalog({ schemas, history, rules, currentOf: (key) => index.currentOf(key) });
  const index = createIndex({ ...base, versions, standing, checks, catalog, use: holding.use });
  const profiles = createProfiles({ ...base, versions, standing });

  // ─── Writing ───────────────────────────────────────────────────────

  const upsert = (collection: string, recordKey: string, body: unknown) =>
    writing.upsert(collection, recordKey, body);
  const cannotWrite = () => writing.cannotWrite();
  const keys = createKeys({
    ...base,
    memberPair,
    network: deps.network,
    versions,
    history,
    rules,
    profiles,
    upsert,
    cannotWrite,
    recordsChanged: () => recordsChanged(),
    onKeys: deps.onKeys,
  });
  const writing = createWriting({
    ...base,
    signer,
    writers: deps.writers,
    versions,
    history,
    rules,
    standing,
    checks,
    catalog,
    index,
    keys,
    stored,
  });
  const lines = createLines({
    ...base,
    adapter,
    versions,
    history,
    catalog,
    everyCurrent: () => index.everyCurrent(),
    noteGap: holding.noteGap,
    upsert,
    cannotWrite,
  });
  const warrants = createWarrants({ ...base, versions, history, rules, standing, upsert, cannotWrite });

  /** A version this node signed is in the store: its key's line, the other tabs and the peers hear of it */
  async function stored(version: Version): Promise<void> {
    await lines.placeInLog(version);
    await holding.markPending(version);
    mirrors.tellTabs();
    peers.sync.onLocalChange(version);
    recordsChanged([version]);
  }

  /** Whether a version from outside — a peer, a folder — may be stored */
  async function admit(version: Version): Promise<Standing> {
    const verdict = await admitOnce(version);
    // Refused for good, or a change to who may do what: perhaps proof of a broken rule (docs/warrants.md).
    if ((!verdict.ok && !verdict.later && !verdict.withdrawn) || ACCESS_COLLECTIONS.has(version.collection))
      void warrants.warrantIfDue(version).catch(() => {});
    return verdict;
  }

  async function admitOnce(version: Version): Promise<Standing> {
    // Before any cached verdict: a copy with another envelope or body shares the id and signature.
    const problem = await versions.copyProblem(version);
    if (problem) return { ok: false, reason: problem };
    // Whatever its key signed takes a place in that key's log, allowed or not: a second at one place is a fork.
    if ((await versions.judge(version)).verified) await lines.placeInLog(version);
    return standing.admission(version);
  }

  // ─── Mirrors and files ─────────────────────────────────────────────

  const mirrors = await openMirrors({
    ...base,
    stores: deps.stores,
    adapter,
    mirrors: deps.mirrors,
    watchIntervalMs: deps.watchIntervalMs,
    admit,
    recordsChanged: () => recordsChanged(),
    announceSoon: () => peers.announceSoon(),
  });

  // Named on the outside of the versions that refer to them, fetched chunk by
  // chunk and checked as they come, kept while a body that names them is
  // (spec 05 §16.6).
  const files = createSpaceFiles({
    space: space.id,
    adapter,
    storage,
    send: (peer, message) =>
      peers.toPeer(peer, {
        type: 'sync',
        from: session.did,
        payload: { ...message, v: SYNC_PROTOCOL_VERSION },
      }),
    peers: () => peers.connectedPeers(),
    mirrors: mirrors.all,
    stands: async (version) => storable(await standing.standingOf(version)),
    // Files follow records: every file a version kept whole names is fetched, within a device's limits.
    ...(deps.fetchFiles === 'all' ? {} : { limits: DEVICE_LIMITS }),
  });

  let filesTimer: ReturnType<typeof setTimeout> | null = null;
  /** One pass at a time; a change during one runs another after it */
  let filesPass: Promise<void> | null = null;
  let filesAgain = false;
  /** After a change: which files are named is worked out again, and soon kept, dropped and fetched to match */
  function filesChanged(): void {
    files.changed();
    if (filesPass) {
      filesAgain = true;
      return;
    }
    if (filesTimer || closed) return;
    filesTimer = setTimeout(() => {
      filesTimer = null;
      filesPass = (async () => {
        await files.tidy();
        await files.fetchMissing();
      })()
        .catch(() => {
          // A peer or mirror out of reach; the next change tries again.
        })
        .finally(() => {
          filesPass = null;
          if (filesAgain && !closed) {
            filesAgain = false;
            filesChanged();
          }
        });
    }, 2000);
    unref(filesTimer);
  }

  /**
   * Records changed: whatever is derived from them may have too. Given the
   * versions that were placed, and none of them the space's own (`sys.`),
   * only what those records feed is thrown away: who may do what, the
   * definitions and the keys come from `sys.` records alone, so every other
   * verdict still holds. Given nothing — another tab, a folder, new keys —
   * everything is.
   */
  function recordsChanged(placed?: ReadonlyArray<Version>): void {
    filesChanged();
    if (placed) holding.noteArrived(placed);
    index.linksChanged();
    emit({ type: 'records', space: space.id });
    mirrors.changed();
    if (placed && placed.every((version) => !version.collection.startsWith('sys.'))) {
      index.stale(placed.map((version) => version.key));
      // A record waiting on a version it cites may count now.
      index.stale(checks.takeWaiting());
      if (checks.arrived(placed)) index.forget();
      return;
    }
    history.changed(placed);
    for (const derived of [index, catalog, profiles, keys, standing, checks]) derived.forget();
    keys.keepUp();
    // The access history may name keepers now, or none.
    void holding.refreshHolds().catch(() => {});
    // Or a new key, which someone connected may not hold.
    void peers.letGoOfOutsiders().catch(() => {});
  }

  // ─── Peers ─────────────────────────────────────────────────────────

  const peers = await openPeers({
    ...base,
    network: deps.network,
    mesh: deps.mesh,
    meeting,
    history,
    keys,
    holds: holding.holds,
    files,
    emit,
    statusChanged,
    admit,
    recordsChanged,
    filesChanged,
    onArrived: deps.onArrived,
  });
  // Whether to hold part of the space is settled before the first hello says what this node holds.
  await holding.refreshHolds().catch(() => {});
  peers.connect();
  mirrors.watch();
  // Here and not earlier: it registers sync handlers and starts timers that need the network connected.
  holding.start();

  const membership = createMembership({
    ...base,
    networked: !!deps.network,
    history,
    keys,
    lines,
    writing,
    peers,
    meeting,
    flagged: warrants.flagged,
    onJoined: deps.onJoined,
  });

  // Once at open, then after every change.
  keys.keepUp();
  const pulling = mirrors.pull();
  mirrors.fillFolder();

  const { catalog: definitions, definitionOf, describe } = catalog;
  const { everyCurrent } = index;

  return Object.freeze({
    list: index.list,
    get: index.get,
    linked: index.linked,
    history: index.history,
    contracts: writing.contractsFor,
    put: writing.put,
    update: writing.update,
    remove: writing.remove,
    onePerKey: writing.onePerKey,
    can: writing.can,
    ...membership,

    /** The note a record's current version was signed under; null when its account signed it itself */
    noteOf: async (recordKey: string): Promise<Delegation | null> =>
      (await index.currentOf(recordKey))?.proof ?? null,

    /** The key `name` has in an account's namespace: this account's, unless another is named */
    keyFor: (name: string, account: string = rootDid): Promise<string> => ownedKey(account, name),

    /** Seals a file, keeps it, and gives back the reference a body names it by (spec 05 §16.6) */
    addFile: (bytes: Uint8Array): Promise<SealedFile> => files.add(bytes),
    /** The bytes of a file a body refers to: held here, or fetched from peers or mirrors */
    readFile: (ref: SealedFile): Promise<Uint8Array> => files.open(ref),

    /** For the node itself: writes the next version of a record in a collection `put` refuses, like the profile */
    upsertSystem: writing.upsert,
    /** For the node itself: deletes a record in a managed collection */
    removeSystem: writing.removeKey,

    async profiles() {
      return [...(await profiles.profiles()).values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did),
      );
    },

    /** For the node itself: says who this account is here, when that changed and the space takes its writes */
    async publishProfile(profile: { name: string; contactKey?: string; avatar?: AvatarRef }) {
      // Someone following a space without a role in it cannot write there, and says nothing; nor does an app.
      if (!actsForAccount(session.proof()) || (await cannotWrite())) return;
      const name = profile.name.trim().slice(0, 64);
      const mine = (await profiles.profiles()).get(rootDid);
      // An app without the contact key must not take away the one another device published.
      const contactKey = profile.contactKey ?? mine?.contactKey;
      if (
        !name ||
        (mine?.name === name && mine.contactKey === contactKey && mine.avatar?.hash === profile.avatar?.hash)
      )
        return;
      await upsert(PROFILE_COLLECTION, await profileKey(rootDid), {
        name,
        ...(contactKey ? { contactKey } : {}),
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
      });
    },

    rotateKey: keys.rotateKey,
    memberKeys: profiles.memberKeys,
    ownMemberKey: () => memberPair,
    readAccess: () => peers.readAccess,

    async topicTag(collection: string, field: string, value: string | number | boolean) {
      let keyId: string | null = null;
      if (space.visibility === 'private') {
        const key = keys.currentKey((await history.access()).history.current);
        if (!key) throw new Error(`This device doesn't hold the current key of "${space.name}" yet`);
        keyId = key.id;
      }
      return topicTag(await rules.tagKey(keyId)!, collection, field, value);
    },

    /** A collection's computed fields, as its definition says now; a malformed member reads as none */
    async computed(collection: string): Promise<ComputedFields | undefined> {
      const definition = await definitionOf(collection);
      return usableComputed(definition?.computed, definition?.schema);
    },

    async collections(): Promise<ReadonlyArray<NodeCollection>> {
      const counts = new Map<string, number>();
      for (const version of await everyCurrent()) {
        if (version.deleted) continue;
        // The protocol's own bookkeeping is not one of the space's kinds of thing.
        if (version.collection.startsWith('sys.')) continue;
        counts.set(version.collection, (counts.get(version.collection) ?? 0) + 1);
      }
      const described = await definitions();
      const names = [...new Set([...described.keys(), ...counts.keys()])].sort();
      return names.map((name) => describe(name, described.get(name) ?? null, counts.get(name) ?? 0));
    },

    async define(input: DefineCollection): Promise<NodeCollection> {
      const recordKey = `collection:${input.name}`;
      const current = (await definitions()).get(input.name) ?? null;
      // Peers don't order definitions by version (spec 02 §6.3): a stored one past what can be
      // counted on, written to lock the collection, is simply followed by 1 again.
      const after =
        current && Number.isSafeInteger(current.definition.version + 1) ? current.definition.version : 0;
      const version = input.version ?? after + 1;
      const described = await definitions();
      const definition: StoredCollection = {
        name: input.name,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        schema: toJsonSchema(input.schema),
        version,
        ...(input.history !== undefined ? { history: input.history } : {}),
        ...(input.links !== undefined ? { links: input.links } : {}),
        ...(input.rules !== undefined ? { rules: input.rules } : {}),
        ...(input.topics !== undefined ? { topics: input.topics } : {}),
        ...(input.contract !== undefined ? { contract: storedContract(input) } : {}),
        ...(input.computed !== undefined ? { computed: storedComputed(input) } : {}),
      };
      const problem = definitionProblem(definition, described);
      if (problem) throw new Error(problem);
      if (!Number.isSafeInteger(version)) throw new Error(`version must be a whole number below 2^53`);
      if (current && version <= after) {
        throw new Error(
          `${input.name} is at version ${current.definition.version}; a new definition needs a higher one`,
        );
      }
      // Not retroactive: a change to the rules binds what saw it, and what a change to its author's standing that saw it reaches (03 §5).
      await upsert(CATALOG_COLLECTION, recordKey, definition);
      const entry = (await definitions()).get(input.name) ?? null;
      const count = (await everyCurrent(input.name)).filter((e) => !e.deleted).length;
      return describe(input.name, entry, count);
    },

    async undefine(name: string): Promise<void> {
      if (!(await definitions()).has(name)) throw new Error(`${name} is not defined in this space`);
      // Records left behind would lose their shape and their rules, so they go first.
      const left = (await everyCurrent(name)).filter((e) => !e.deleted).length;
      if (left)
        throw new Error(`${name} still has ${left} record${left === 1 ? '' : 's'}; delete them first`);
      await writing.removeKey(`collection:${name}`);
    },

    syncedWith: peers.syncedWith,

    async versionsOf(keys: ReadonlyArray<string>) {
      return (await Promise.all(keys.map((key) => storage.history(key)))).flat();
    },

    /** Takes in versions handed over outside sync, through the same checks as a peer's. How many were new. */
    async take(versions: ReadonlyArray<Version>) {
      const placed: Version[] = [];
      // First versions before the ones that follow them.
      for (const version of [...versions].sort((a, b) => a.seq - b.seq)) {
        if (await storage.getVersion(version.id)) continue;
        const verdict = await admit(version).catch(() => null);
        if (!verdict || !storable(verdict)) continue;
        await storage.addVersion(version);
        placed.push(version);
      }
      if (placed.length === 0) return 0;
      recordsChanged(placed);
      peers.announceSoon();
      return placed.length;
    },

    async status() {
      const { connection, peers: connected, accounts, rejected } = peers.status();
      return {
        space: space.id,
        connection,
        peers: connected,
        accounts,
        fingerprint: await storage.fingerprint(),
        rejected,
        holds: holding.held(),
        pending: await holding.pending(),
      };
    },

    use: holding.use,
    send: peers.send,
    useNodes: peers.useNodes,

    async close(): Promise<void> {
      closed = true;
      peers.quiet();
      await holding.close();
      await keys.keepingUp.done();
      await pulling;
      await mirrors.close();
      if (filesTimer) clearTimeout(filesTimer);
      files.close();
      await filesPass;
      peers.close();
      await storage.close();
    },
  });
}
