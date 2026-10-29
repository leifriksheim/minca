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
 */
import { cached, getOrAdd } from '../utils/map.js';
import { contactKeyPair, isContactPublicKey } from '../identity/contact-key.js';
import type { CryptoProvider, Link, NetworkMessage, PeerInfo, StorageAdapter, Version } from '../types.js';
import type { Signer } from '../schema/signer.js';
import type { SchemaEngine } from '../schema/schema-engine.js';
import type { SpaceRecord } from '../space/space-manager.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import {
  accessRequirement,
  actsForAccount,
  DEFINE_COMMAND,
  noteGrants,
  writeRequirement,
} from '../identity/abilities.js';
import {
  bodyProblem,
  canonicalize,
  createVersion,
  getVersionId,
  isStub,
  signedPart,
} from '../schema/version.js';
import { createStorageProvider, type StorageProvider } from '../storage/storage-provider.js';
import { chainProblem, MAX_SEEN, nextVersion } from '../records/version.js';
import {
  keyKind,
  lineKey,
  newRecordKey,
  onePerForm,
  ownedKey,
  ownsKey,
  RECORD_KEY_PATTERN,
} from '../records/key.js';
import { checkLinks } from '../records/links.js';
import {
  checkContractShape,
  checkContracts,
  checkContractTypes,
  checkLine,
  hasContract,
  onceCitations,
  runContracts,
  type Contract,
  type CitedVersion,
  type Line,
  type Uncited,
} from '../records/contracts.js';
import { changedFixedField, onePerKey, onePerSecret } from '../records/rules.js';
import { storedComputed, storedContract } from '../records/contract-builder.js';
import { checkComputed, checkComputedTypes, usableComputed, type ComputedFields } from '../query/computed.js';
import { reconcileFolder } from '../storage/folder-reconcile.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createMirror, type Mirror, type Taken } from '../storage/mirror.js';
import type { FolderAdapter } from '../storage/folder-adapter.js';
import { createVersionCheck } from '../validation/check-version.js';
import type { Writers } from './writers.js';
import { copyKey, grantsBeyondRecords, idsKey, isStringList, setCapped } from './space-common.js';
import { createSpaceKeys } from './space-keys.js';
import { createSpacePeers } from './space-peers.js';
import { openSpaceHolding } from './space-holding.js';
import { createSpaceWarrants } from './space-warrants.js';
import { breaksLine, checkFork, forkProof } from '../records/fork.js';
import {
  isSealedBody,
  openBody as openSealedBody,
  sealBody,
  type SpaceKey,
} from '../privacy/space-encryption.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import { createMesh, type Mesh } from '../network/mesh.js';
import { createWebSocketTransport } from '../network/ws-transport.js';
import { createClientAuth, createMeshAuth } from '../network/peer-auth.js';
import {
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  SPACE_KEY_RECORD,
  SPACE_RELAYS_RECORD,
  SPACE_KEEPERS_RECORD,
  memberKeyRecordKey,
  deriveInviteKey,
  generateInviteSecret,
  inviteKey as inviteRecordKey,
  assignKey,
  removalKey,
  revokeKey,
  roleKey,
  signInvite,
  verifyInvite,
  forkKey,
  stepDownKey,
  succeedKey,
  WARRANT_COLLECTION,
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
  checkRelays,
  KEEPERS_COLLECTION,
  FORK_COLLECTION,
  checkKeepers,
  type Keeper,
  REMOVE_COLLECTION,
  REVOKE_COLLECTION,
  ROLE_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
  headless,
  isMember,
  holdsRole,
  may,
  readers,
  replayAccess,
  rolesOf,
  type AccessEvent,
  type AccessHistory,
  type AccessState,
  type Cutoff,
  type Needs,
} from '../space/roles.js';
import {
  checkFoundingRole,
  definitionBody,
  readDefinition,
  RECORD_DELETE,
  RECORD_WRITE,
  type FoundingRole,
} from '../space/grants.js';
import { FOUNDER } from '../space/space-manager.js';
import { createSyncEngine } from '../sync/sync-engine.js';
import { SYNC_PROTOCOL_VERSION } from '../sync/sync-messages.js';
import { createSpaceFiles, DEVICE_LIMITS, type SealedFile, type SpaceFiles } from '../files/space-files.js';
import { fileRefsIn, MAX_FILES } from '../files/file-id.js';
import type { StoreFactory } from './stores.js';
import {
  CATALOG_COLLECTION,
  checkStoredCollection,
  isStoredCollection,
  toJsonSchema,
  validateJsonSchema,
  type SchemaIssue,
  type StoredCollection,
} from '../schema/collection-def.js';
import {
  CARRIER_COLLECTION,
  MEMBERSHIP_COLLECTION,
  PROFILE_COLLECTION,
  isAvatarRef,
  type AvatarRef,
} from '../space/account-registry.js';
import { PASS_COLLECTION } from '../space/pass.js';
import { base32Encode, hashedKey, sha256 } from '../utils/hash.js';
import { sameTags, tagsFor, topicKey, topicTag } from '../records/topics.js';
import { base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord, unref } from '../utils/guards.js';
import type {
  CacheConfig,
  ConnectionState,
  DefineCollection,
  NodeCollection,
  ListOptions,
  NodeEvent,
  NodeNetworkConfig,
  NodeRecord,
  RecordContracts,
  SpaceAccess,
  SpaceProfile,
} from './types.js';

/** Collections the node writes itself, through their own calls — never through `put` */
const MANAGED = new Set([
  MEMBERSHIP_COLLECTION,
  WARRANT_COLLECTION,
  PROFILE_COLLECTION,
  CARRIER_COLLECTION,
  PASS_COLLECTION,
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  ...ACCESS_COLLECTIONS,
]);

/**
 * Access records a peer without the space key must still judge: who holds
 * which role decides every write. Kept in the clear even in a private space.
 * Collection definitions stay sealed: a peer that can't read the records has
 * no use for their rules.
 */
const IN_THE_CLEAR = new Set([
  ...Object.values(ACCESS_KINDS)
    .filter(({ clear }) => clear)
    .map(({ collection }) => collection),
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
]);

/**
 * Collections whose every version is kept whole. The access history is
 * replayed whole; a warrant's proof is read back after anything written over it.
 */
const ALWAYS_RETAINED = new Set([
  ...ACCESS_COLLECTIONS,
  WARRANT_COLLECTION,
  PROFILE_COLLECTION,
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
]);

/** How many keys a cutoff may name */
const MAX_CUTOFF = 1024;
/** A change that takes nothing away covers nothing */
const NO_CUTOFF: Cutoff = new Map();
/** Decrypted bodies kept in memory per space, the oldest let go first */
const MAX_OPENED = 100_000;
/** Line heads whose `once` claims are kept: each set holds its whole chain's, so fewer */
const MAX_ONCE_CLAIMED = 1024;
/** Records waiting on a cited version that are read again whenever anything arrives */
const MAX_PENDING_REREAD = 256;

/**
 * The key of a person's profile record in a space: one per identity, named by
 * a hash of it (record keys are lower case; a did:key is not).
 */
export async function profileKey(did: string): Promise<string> {
  return hashedKey('profile', did);
}

/**
 * The room a space's peers meet in on a relay. A hash of the space's id, so a
 * relay learns which connections belong together but not which space they are.
 */
export async function relayRoom(spaceId: string): Promise<string> {
  const digest = await sha256(utf8Encode(`minca-room/v1|${spaceId}`));
  return base32Encode(digest.subarray(0, 20));
}

/** The one mesh a node's spaces share, when it has relays to meet on */
export function meshFor(
  network: NodeNetworkConfig | undefined,
  session: { readonly did: string; readonly key: CryptoKey },
): Mesh | undefined {
  if (!network?.relays?.length) return undefined;
  return createMesh({
    did: session.did,
    key: session.key,
    relays: network.relays,
    ...(network.iceServers ? { iceServers: network.iceServers } : {}),
    ...(network.createTransport ? { createTransport: network.createTransport } : {}),
  });
}

/** The relays a node was configured with that a space may name */
export const usableRelays = (network: NodeNetworkConfig | undefined) =>
  (network?.relays ?? []).filter((url) => checkRelays([url]) === null);

/** Said when a key's note doesn't let it define collections — it can propose them instead */
export const CANNOT_DEFINE =
  "This key's note doesn't let it add or change collections. Propose them instead (collections_propose), and someone who may adds them.";
const CANNOT_CHANGE_ACCESS =
  "This key's note doesn't let it change who may do what in a space. Ask the person.";
const NOT_ACCOUNT = "This key's note doesn't let it change the account itself. Ask the person.";

/** The key that signs, and the delegation that lets it */
export interface ActiveSession {
  readonly did: string;
  readonly key: CryptoKey;
  /** The current note from the account — it is renewed, so always read it fresh. None for a key that signs for itself. */
  readonly proof: () => Delegation | undefined;
}

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

interface Verdict {
  readonly verified: boolean;
  readonly root: string | null;
  readonly reason?: string;
}

type Standing =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly later?: boolean;
      /** Passes every check but one: a later change took its author's access away. Kept, never counted (02 §9.5). */
      readonly withdrawn?: true;
      /** A stub whose grant reads the body it doesn't carry, at a node that reads the space: judged once whole */
      readonly bodyNeeded?: true;
    };
type Refusal = Extract<Standing, { readonly ok: false }>;
const STANDS: Standing = { ok: true };
const ACCESS_LATER: Standing = Object.freeze({
  ok: false,
  reason: 'Access changes it depends on have not arrived yet',
  later: true,
});

/** Whether a version goes in the store: it stands, or stood until a later change withdrew it */
const storable = (standing: Standing): boolean => standing.ok || !!standing.withdrawn;

/** How a version fares under its collection's contract, as this node reads it */
type ChecksVerdict =
  | { readonly passes: true }
  | { readonly passes: false; readonly reason: string }
  /** No contract, or none this node can judge */
  | { readonly passes: null }
  /** Not judged here (spec 09 §2): a line key this library doesn't know, or something sealed. Not counted */
  | { readonly passes: null; readonly unjudged: string }
  /** A version it cites hasn't arrived */
  | { readonly pending: true };
const NO_CHECKS: ChecksVerdict = { passes: null };
/** Checks this node can't judge yet: what they read can't be opened here. Never cached. */
const UNJUDGED: ChecksVerdict = Object.freeze({
  passes: null,
  unjudged: 'Something it reads is sealed with a key this node doesn’t hold',
});

type Opened = { readonly body: unknown; readonly links: ReadonlyArray<Link>; readonly encrypted: boolean };

/** A signature never changes, but the id doesn't cover it: a mangled copy shares the genuine one's id */
const signedKey = (version: Version) => `${version.id}|${version.signature}`;

/** The key a sealed body names, as the keyring is looked up by */
const sealedKeyId = (body: unknown) => String(isRecord(body) ? body.keyId : undefined);

const isFolderAdapter = (adapter: StorageAdapter): adapter is FolderAdapter =>
  'reload' in adapter && typeof adapter.reload === 'function';
const isLinks = (links: unknown): links is ReadonlyArray<Link> => checkLinks(links) === null;
const isLine = (line: unknown): line is Line => checkLine(line) === null;
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

/** A change's body, with its cutoff when that covers anything */
const withCutoff = <T extends object>(body: T, cutoff: Record<string, Record<string, number>>) =>
  Object.keys(cutoff).length ? { ...body, cutoff } : body;

/** Freezes a value and everything inside it, in place */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

/**
 * Whether a version is about the account that signs it: its own place in the
 * space, what others seal to it or see of it, or another of its keys. Only a
 * key acting as the account itself writes one (spec 01 §8), so an app given a
 * space never changes the account's standing there.
 */
function aboutItself(collection: string, body: unknown, root: string, author: string): boolean {
  if (collection === STEPDOWN_COLLECTION || collection === MEMBER_KEY_COLLECTION) return true;
  if (collection === PROFILE_COLLECTION) return true;
  if (!isRecord(body)) return false;
  if (collection === ASSIGN_COLLECTION || collection === REMOVE_COLLECTION) return body.did === root;
  return collection === REVOKE_COLLECTION && body.key !== author;
}

/** A node's address with the space in its query, before any pin in the fragment */
function withSpace(node: string, spaceId: string): string {
  const [base = '', ...pin] = node.split('#');
  const query = `${base.includes('?') ? '&' : '?'}space=${encodeURIComponent(spaceId)}`;
  return `${base}${query}${pin.length ? `#${pin.join('#')}` : ''}`;
}

/** Orders text by code unit, as `<` does */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Why a definition can't be stored, in the library's words; null when it can */
function definitionProblem(
  definition: StoredCollection,
  described: ReadonlyMap<string, { readonly definition: StoredCollection }>,
): string | null {
  const { contract, computed } = definition;
  const shape = contract !== undefined ? checkContractShape(contract) : null;
  const line = contract?.line !== undefined ? checkLine(contract.line) : null;
  // A contract or computed field that misreads the schema is the library's own care, not protocol.
  const checks =
    contract?.check !== undefined
      ? (checkContracts(contract.check, 'contract.check') ??
        checkContractTypes(contract.check, definition.schema, 'contract.check'))
      : null;
  const linked = (name: string) =>
    name === definition.name ? definition : (described.get(name)?.definition ?? null);
  const fields =
    computed !== undefined
      ? (checkComputed(computed) ?? checkComputedTypes(definition.name, computed, definition.schema, linked))
      : null;
  return (
    checkStoredCollection(definition) ??
    (shape === 'unknown' ? 'contract takes only "check" and "line"' : shape) ??
    checks ??
    (line === 'unknown' ? 'contract.line takes only "once"' : line) ??
    fields
  );
}

export async function openSpaceRuntime(deps: SpaceRuntimeDeps) {
  const { record, provider, signer, schemas, session, emit } = deps;
  const { space } = record;
  let closed = false;
  const statusChanged = () => emit({ type: 'status', space: space.id });

  /** Every key of the space this node holds, by id: a sealed body names its key, the history the current one */
  const keyring = new Map<string, SpaceKey>();
  for (const held of record.keys ?? []) keyring.set(held.id, held);
  if (record.key) keyring.set(record.key.id, record.key);
  /** This account's member key here, which new keys are sealed to */
  const memberPair = deps.memberKey ? await contactKeyPair(deps.memberKey) : null;
  /** An invite waiting to be used — forgotten here once it is, whatever the stored record still says */
  let waitingInvite = record.invite !== null;

  const adapter = await deps.stores(`spaces/${space.id}`);
  const storage: StorageProvider = createStorageProvider(adapter);

  // What this node holds (`node/space-holding.ts`): settled here, since sync asks on every hello.
  const holding = await openSpaceHolding({
    cache: deps.cache ?? null,
    adapter,
    storage,
    spaceId: space.id,
    sessionDid: session.did,
    emit,
    statusChanged,
    isClosed: () => closed,
    access: () => access(),
    sync: () => sync,
    connectedPeers: () => connectedPeers(),
    recordsChanged: () => recordsChanged(),
  });
  const { holds, refreshHolds, use, noteGap, noteArrived, markPending } = holding;

  // The note behind a key must cover this space; whether its account may write is the history's question.
  const checkVersion = createVersionCheck({
    provider,
    required: (version) => writeRequirement(space.id, version.collection),
  });

  /** Signature verdicts. Only passes are kept: failures are what a stranger can mint for free. */
  const verdicts = new Map<string, Verdict>();
  /** Copies checked to be what their id names, envelope and body */
  const copiesChecked = new WeakSet<Version>();

  /**
   * Why a copy isn't what its id names, or null when it is: its id hashes its
   * envelope, and its `bodyHash` names its body. Asked before any verdict
   * cached by id and signature is used.
   */
  async function copyProblem(version: Version): Promise<string | null> {
    if (copiesChecked.has(version)) return null;
    const problem =
      (await bodyProblem(version)) ??
      (version.id === (await getVersionId(signedPart(version)))
        ? null
        : 'Its id is not the hash of what it says');
    if (!problem) copiesChecked.add(version);
    return problem;
  }

  /** Whether a version is signed, and by a key whose note covers this space — and which account that is */
  async function judge(version: Version): Promise<Verdict> {
    const problem = await copyProblem(version);
    if (problem) return { verified: false, root: null, reason: problem };
    const cached = verdicts.get(signedKey(version));
    if (cached) return cached;
    const result = await checkVersion(version);
    if (!result.passed)
      return { verified: false, root: null, ...(result.reason ? { reason: result.reason } : {}) };
    const note =
      version.proof !== undefined ? await verifyNote(version.proof, provider, { untimed: true }) : null;
    const verdict = { verified: true, root: note?.valid ? note.root : version.author };
    verdicts.set(signedKey(version), verdict);
    return verdict;
  }

  /** Bodies already opened, by version id. A failure is not kept: a key that arrives later may open it. */
  const openedBodies = new Map<string, Opened>();

  /** A version's content: its body and its links, sealed together in a private space */
  async function openBody(version: Version): Promise<Opened> {
    // A stub's content is forgotten: read like one this node holds no key for.
    if (isStub(version)) return { body: null, links: version.links ?? [], encrypted: false };
    if (!isSealedBody(version.body))
      return { body: version.body, links: version.links ?? [], encrypted: false };
    const known = openedBodies.get(version.id);
    if (known) return known;
    const sealedWith = keyring.get(sealedKeyId(version.body));
    if (!sealedWith) return { body: null, links: [], encrypted: true };
    try {
      // Bound to this record: a body copied from another record, space or collection does not open.
      const bound = { space: space.id, collection: version.collection, key: version.key };
      const content = await openSealedBody(version.body, sealedWith, bound);
      const opened = isRecord(content) ? content : null;
      const sealedLinks = opened?.links ?? [];
      const links = isLinks(sealedLinks) ? sealedLinks : [];
      const result: Opened = Object.freeze({ body: opened?.body ?? null, links, encrypted: true });
      // An id names its content, so what opened once opens the same way again.
      setCapped(openedBodies, version.id, result, MAX_OPENED);
      return result;
    } catch {
      return { body: null, links: [], encrypted: true };
    }
  }

  /** Whether a version's content is sealed with a key this node doesn't hold */
  const unreadable = (opened: Opened) => opened.body === null && opened.encrypted;

  /**
   * Whether `first` can be the first version of `version`'s record. A later
   * version names its first itself; taking that on trust would let anyone
   * point at a record with no rules, or in another collection.
   */
  const firstOf = (version: Version, first: Version | null): first is Version =>
    !!first && first.seq === 0 && first.key === version.key && first.collection === version.collection;

  /** The first version a version names: itself at seq 0. Not yet checked to be its record's. */
  const namedFirst = async (version: Version): Promise<Version | null> =>
    version.seq === 0 ? version : version.genesis ? storage.getVersion(version.genesis) : null;

  /** A version's first version, checked to be its record's (02 §4.5): never the lowest id at its key, which anyone could grind */
  async function genesisOf(version: Version): Promise<Version | null> {
    const first = await namedFirst(version);
    return firstOf(version, first) ? first : null;
  }

  /** Whether a version is one to show: its first version is held and its record's. Checked on arrival too (02 §4.7). */
  async function consistent(version: Version): Promise<boolean> {
    return version.seq === 0 || (await genesisOf(version)) !== null;
  }

  /** The version before this one in its record's chain, when it names one */
  const previousOf = (version: Version) =>
    version.seq > 0 && version.prev ? storage.getVersion(version.prev) : Promise.resolve(null);

  // ─── Record keys ───────────────────────────────────────────────────
  //
  // Outside sys.*, a first version is at a key its account owns, or at a
  // shared onePer key (02 §4.1, `records/key.ts`), so no member can write a
  // first version at another's key and become its creator.

  let oneSecret: Promise<CryptoKey> | null = null;
  /**
   * What this space's onePer keys are keyed with: its first space key in a
   * private space, its id in a public one (02 §7.3). Null when this node
   * holds no key of a private space.
   */
  function onePerKeying(): Promise<CryptoKey> | null {
    if (oneSecret) return oneSecret;
    if (space.visibility !== 'private') return (oneSecret = onePerSecret({ spaceId: space.id }));
    const first = space.encryptionKeyId ? keyring.get(space.encryptionKeyId) : undefined;
    return first ? (oneSecret = onePerSecret({ spaceKey: first.raw })) : null;
  }

  /** The key `put` writes a body at under a collection's `onePer`, for `root`; null when a part it names is missing */
  async function derivedKey(
    collection: string,
    onePer: ReadonlyArray<string>,
    record: { root: string; links: ReadonlyArray<Link>; body: unknown },
  ): Promise<string | null> {
    const keying = onePerKeying();
    if (!keying) throw new Error('This private space has no key on this node');
    return onePerKey(await keying, collection, onePer, record);
  }

  /** Why a first version's key isn't one its account may write first, from the version alone; null when it may */
  async function keyProblem(version: Version, root: string): Promise<Refusal | null> {
    if (version.seq !== 0) return null;
    const kind = keyKind(version.key);
    // The protocol's own records keep keys of their own, so none can be current at someone's key.
    if (version.collection.startsWith('sys.'))
      return kind === null
        ? null
        : { ok: false, reason: 'A sys.* record is never at an owned or a one: key' };
    if (kind === 'shared') return null;
    if (kind === 'owned' && (await ownsKey(version.key, root))) return null;
    const reason =
      kind === 'owned'
        ? 'Its key belongs to another account'
        : 'A new record needs a key its account owns, or a shared one: key';
    return { ok: false, reason };
  }

  /**
   * Why a first version can't be at a key of a `onePer` key's form, shared
   * `one:<hex>` or owned `<owner>.one:<hex>` (02 §7.3): only a collection
   * whose rules have `onePer` gives one, owned when it names `@author`.
   * Judged from the definition alone, so peers that can't derive the key
   * agree. Null when it can, or when this node can't read the definition.
   */
  async function onePerKeyProblem(version: Version, state: AccessState): Promise<Refusal | null> {
    const form = onePerForm(version.key);
    if (version.seq !== 0 || !form || version.collection.startsWith('sys.')) return null;
    const id = await inForce(state, version.collection);
    const found = id ? await definitionIn(id) : 'missing';
    if (found === 'unreadable') return null;
    const onePer = typeof found === 'string' ? undefined : found.definition.rules?.onePer;
    if (!onePer) return { ok: false, reason: 'A one: key is only for a collection whose rules have onePer' };
    if (form === 'shared' && onePer.includes('@author'))
      return { ok: false, reason: 'A shared one: key is only for a onePer that does not name @author' };
    if (form === 'owned' && !onePer.includes('@author'))
      return { ok: false, reason: 'An owned one: key is only for a onePer that names @author' };
    return null;
  }

  // ─── The access history ────────────────────────────────────────────
  //
  // Every version in the access collections, kept whole (`retain`), turned
  // into plain events and replayed. Everything about who may do what is read
  // from the replay.

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

  interface Access {
    readonly history: AccessHistory;
    readonly events: ReadonlyArray<AccessEvent>;
    /** A version was passed over that a later look might take: then only reading them all again is sure */
    readonly unsettled: boolean;
  }
  let accessCache: Promise<Access> | null = null;
  const access = () => (accessCache ??= loadAccess());
  /** The read key readers must prove now — kept at hand, since a handshake asks for it without waiting */
  let currentReadKey = space.readKey ?? '';

  /**
   * Where the members meet: the relays the space names once it names some,
   * until then the ones the invite named. Handed to the mesh for this room alone.
   */
  let relays: ReadonlyArray<string> = record.relays ?? [];
  let meshRoom: string | null = null;
  function useRelays(named: ReadonlyArray<string>): void {
    const same = named.length === relays.length && named.every((url, i) => url === relays[i]);
    if (named.length === 0 || same) return;
    relays = [...named];
    if (meshRoom) deps.mesh?.useRelays(meshRoom, relays);
    void deps.onRelays?.(relays).catch(() => {});
  }

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
    reportRole(history.current);
    currentReadKey = history.current.keys.at(-1)?.readKey ?? currentReadKey;
    useRelays(history.current.relays);
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

  let reportedRole: string | null | undefined;
  function reportRole(state: AccessState): void {
    const role = placeOf(state, deps.rootDid);
    if (role === reportedRole) return;
    reportedRole = role;
    deps.onRole?.(role);
  }

  /**
   * The command a version invokes, and its arguments (03 §5.2): a delete, or
   * a write with its body. `opaque` when this node can't read the body, so
   * policies on it are left to those who can.
   */
  async function invocationOf(version: Version, first: Version, root: string) {
    const byCreator = version.seq === 0 || (await judge(first)).root === root;
    const collection = version.collection;
    if (version.deleted) return { cmd: RECORD_DELETE, args: { collection, byCreator }, opaque: false };
    const opened = await openBody(version);
    const opaque = isStub(version) || unreadable(opened);
    const args = { collection, byCreator, ...(opaque ? {} : { body: opened.body }) };
    return { cmd: RECORD_WRITE, args, opaque };
  }

  /**
   * What a version asks of its author: in `sys.*`, a place; elsewhere, a grant
   * for what it does. `strict`: a body this node can't read holds no policy on it.
   */
  async function needsOf(
    version: Version,
    first: Version,
    root: string,
    options: { readonly strict?: boolean } = {},
  ): Promise<Needs> {
    if (version.collection.startsWith('sys.')) return (state) => isMember(state, root);
    const { cmd, args, opaque } = await invocationOf(version, first, root);
    return (state) => may(state, root, cmd, args, { opaque: opaque && !options.strict });
  }

  /** Whether this node reads the space's bodies: a public space, or a private one whose key it holds */
  const readsBodies = () => space.visibility !== 'private' || keyring.size > 0;

  // ─── Rules ─────────────────────────────────────────────────────────
  //
  // A version is judged by the definition in force as of the access changes
  // it saw — the same on every peer, since everyone replays the same history.
  // A definition a peer cannot read (a private space, no key) cannot be
  // judged by; members judge instead.

  type Definition = { readonly definition: StoredCollection } | 'missing' | 'unreadable' | 'invalid';
  const definitions = new Map<string, Promise<Definition>>();

  /** The definition held in one version of `sys.collection` */
  function definitionIn(id: string): Promise<Definition> {
    // Something missing may turn up; only settled answers are kept.
    return cached(
      definitions,
      id,
      async (): Promise<Definition> => {
        const version = await storage.getVersion(id);
        if (!version) return 'missing';
        if (version.collection !== CATALOG_COLLECTION || version.deleted) return 'invalid';
        const opened = await openBody(version);
        if (opened.body === null) return 'unreadable';
        const body = opened.body;
        if (!isStoredCollection(body) || version.key !== `collection:${body.name}`) return 'invalid';
        return { definition: body };
      },
      (answer) => answer !== 'missing',
    );
  }

  /**
   * The id of the definition in force for a collection in one state of the
   * history (02 §6.3): the replay's, or, while rival first definitions stand,
   * the lowest of them only when they all say the same, so no ground id picks
   * the rules. One this node can't read when it can't read them all; null
   * when none is in force.
   */
  async function inForce(state: AccessState, collection: string): Promise<string | null> {
    const entry = state.definitions.get(collection);
    if (entry) return entry.event;
    const rivals = state.contested.get(collection);
    if (!rivals?.length) return null;
    const found = await Promise.all(rivals.map((id) => definitionIn(id)));
    const unreadable = rivals.find((_, i) => found[i] === 'unreadable');
    if (unreadable) return unreadable;
    const said = new Set(found.map((one) => (typeof one === 'string' ? one : canonicalize(one.definition))));
    return said.size === 1 && typeof found[0] !== 'string' ? rivals[0]! : null;
  }

  /** The rules and topics in force for a collection in one state of the history — null when there are none to judge by */
  async function rulesAt(
    state: AccessState,
    collection: string,
  ): Promise<{
    rules: NonNullable<StoredCollection['rules']>;
    topics: ReadonlyArray<string>;
    contract: unknown;
  } | null> {
    if (collection.startsWith('sys.')) return null;
    const id = await inForce(state, collection);
    if (!id) return null;
    const found = await definitionIn(id);
    return typeof found === 'string'
      ? null
      : {
          rules: found.definition.rules ?? {},
          topics: found.definition.topics ?? [],
          contract: found.definition.contract,
        };
  }

  // ─── Topic tags ────────────────────────────────────────────────────
  //
  // Keyed from the key a record's body was sealed with, in a private space;
  // from the space id in a public one (`records/topics.ts`).

  const topicKeys = new Map<string, Promise<CryptoKey>>();
  /** The tag key for one of the space's keys, or the public one; null when this node doesn't hold that key */
  function tagKey(keyId: string | null): Promise<CryptoKey> | null {
    const name = keyId ?? 'public';
    let found = topicKeys.get(name);
    if (!found) {
      const held = keyId === null ? null : keyring.get(keyId);
      if (keyId !== null && !held) return null;
      found = topicKey(held ? { spaceKey: held.raw } : { spaceId: space.id });
      topicKeys.set(name, found);
    }
    return found;
  }

  /**
   * Why a version's tags don't match its body under the topics in force, or
   * null when they do — or when this node can't read the body to tell.
   */
  async function tagProblem(version: Version, topics: ReadonlyArray<string>): Promise<Standing | null> {
    if (topics.length === 0 && !version.tags?.length) return null;
    const opened = await openBody(version);
    if (opened.body === null) return null;
    const key = tagKey(opened.encrypted ? sealedKeyId(version.body) : null);
    if (!key) return null;
    const expected = await tagsFor(await key, version.collection, topics, opened.body, opened.links);
    return sameTags(version.tags, expected)
      ? null
      : { ok: false, reason: `Its topic tags don't match what it says` };
  }

  const standings = new Map<string, Promise<Standing>>();
  /** Checks verdicts, by version and the view it was judged in */
  const checkVerdicts = new Map<string, Promise<ChecksVerdict>>();
  /** Records whose newest version waits on a version it cites: read again when anything arrives */
  const pendingKeys = new Set<string>();

  /**
   * Whether a version stands: signed, in this space, consistent with its first
   * version, and — by the access history — written by someone allowed to.
   * The same verdict for a version from a peer, from a folder, or written
   * here, and for one read back later. `within`, for a version another cites:
   * judged as of what the citing version saw, so a change that came after it
   * can't undo a proof that held when it was made (02 §7.6).
   */
  async function standingOf(version: Version, within?: ReadonlyArray<string>): Promise<Standing> {
    const problem = await copyProblem(version);
    if (problem) return { ok: false, reason: problem };
    const cacheKey = within ? `${copyKey(version)}|${idsKey(within)}` : copyKey(version);
    // Only a verdict that stands is kept: one waiting changes when what it waits on arrives (02 §9.5).
    return cached(
      standings,
      cacheKey,
      () => judgeStanding(version, within),
      (standing) => standing.ok,
    );
  }

  /**
   * @param within For a version another cites: what the citing version saw.
   *   Only access changes among those can take it away.
   */
  async function judgeStanding(version: Version, within?: ReadonlyArray<string>): Promise<Standing> {
    // A version may only claim the space it actually sits in.
    if (version.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root)
      return { ok: false, reason: verdict.reason ?? 'Its signature does not check out' };
    const asAccount =
      deps.accountOnly || aboutItself(version.collection, version.body, verdict.root, version.author);
    if (asAccount && !actsForAccount(version.proof))
      return { ok: false, reason: "Its note doesn't let it act as the account itself" };
    const { history } = await access();

    if (ACCESS_COLLECTIONS.has(version.collection)) {
      const event = await toEvent(version);
      if (!event) return { ok: false, reason: 'It is not a well-formed change to who may do what' };
      const status = history.status(event.id);
      if (!status || status.status === 'waiting') return ACCESS_LATER;
      return status.status === 'applied' ? STANDS : { ok: false, reason: status.reason };
    }

    const first = await namedFirst(version);
    if (!first) return { ok: false, reason: 'Its first version has not arrived yet', later: true };
    if (!firstOf(version, first))
      return { ok: false, reason: "The first version it names is not this record's" };
    // Whose key it is depends on nothing that can change: refused, never withdrawn.
    const owned = await keyProblem(version, verdict.root);
    if (owned) return owned;

    const seen = version.seen ?? [];
    // Judged by the changes that stand; refused only by what its writer saw (03 §5.1).
    const state = history.at(seen, within);
    const wrote = history.seenAs(seen);
    if (!state || !wrote) return ACCESS_LATER;
    const form = await onePerKeyProblem(version, state);
    if (form) return form;
    // Rival definitions that differ give no rules, which must not mean anything goes (02 §6.3).
    if (state.contested.has(version.collection) && !(await inForce(state, version.collection)))
      return {
        ok: false,
        reason: `Rival definitions of ${version.collection} stand: nothing is written in it until a manager settles them`,
      };

    const root = verdict.root;
    const found = await rulesAt(state, version.collection);
    const rules = found?.rules;
    const needs = await needsOf(version, first, root);

    // The two refusals worth telling apart: not a member at all, and no grant for what it does.
    if (!isMember(wrote, root))
      return { ok: false, reason: 'Its author was not a member of this space, as of what it had seen' };
    if (!needs(wrote)) {
      return {
        ok: false,
        reason: `Its author holds no grant to ${version.deleted ? 'delete' : 'write'} this ${version.collection} record, as of what it had seen`,
      };
    }
    // A stub's grant may hold only because its body isn't here to read. A node that reads the
    // space waits for the body rather than take it on trust: it judges the whole version afresh.
    if (isStub(version) && readsBodies() && !(await needsOf(version, first, root, { strict: true }))(wrote))
      return {
        ok: false,
        reason: 'Its grant reads its body, which a stub does not carry',
        later: true,
        bodyNeeded: true,
      };
    // Written once: no later version, not even a delete.
    if (rules?.final && version.seq > 0)
      return {
        ok: false,
        reason: `A ${version.collection} record is final: it can't be edited or deleted`,
      };
    const judged = history.judge(
      {
        id: version.id,
        root,
        seen,
        writer: version.author,
        collection: version.collection,
        ...(version.log ? { line: version.log.n } : {}),
      },
      needs,
      within,
    );
    // Withdrawn by a later change: still judged on everything else, since it
    // is kept and others may cite it.
    if (!judged.ok && !judged.withdrawn) return judged;
    const content = await judgeContent(version, first, root, found);
    return judged.ok || !content.ok ? content : judged;
  }

  /** The rest of a version's standing: what its definition's topics and rules ask of what it says */
  async function judgeContent(
    version: Version,
    first: Version,
    root: string,
    found: Awaited<ReturnType<typeof rulesAt>>,
    options: { readonly tags?: boolean } = {},
  ): Promise<Standing> {
    const rules = found?.rules;
    if (found && !version.deleted && options.tags !== false) {
      const problem = await tagProblem(version, found.topics);
      if (problem) return problem;
    }
    if (!rules || version.deleted) return STANDS;
    // Their checks read the first version's body, so every peer must hold it,
    // however late it joins: a first version kept whole, not as a stub.
    if (version.seq === 0 && (rules.onePer || rules.fixed) && !version.retain)
      return {
        ok: false,
        reason: `A new ${version.collection} record must be kept whole: its rules are checked against it`,
      };
    if (version.seq === 0 && rules.onePer) {
      const opened = await openBody(version);
      const keying = onePerKeying();
      // Only a reader can compute a private space's onePer keys; the rest take it on the other checks.
      if (unreadable(opened) || !keying) return STANDS;
      const expected = await onePerKey(await keying, version.collection, rules.onePer, {
        root,
        links: opened.links,
        body: opened.body,
      });
      if (expected !== version.key) {
        return {
          ok: false,
          reason: `${version.collection} allows one per ${rules.onePer.join(' + ')} — its key must be derived from them`,
        };
      }
    }
    // Only against a first version kept whole, so a peer that joined after it
    // was superseded judges the same way as one that saw it.
    if (version.seq > 0 && rules.fixed?.length && first.retain) {
      const [now, then] = await Promise.all([openBody(version), openBody(first)]);
      if (now.body !== null && then.body !== null) {
        const field = changedFixedField(rules.fixed, then.body, now.body);
        if (field)
          return {
            ok: false,
            reason: `"${field}" is fixed once a ${version.collection} record is created`,
          };
      }
    }
    return STANDS;
  }

  // ─── Checks ────────────────────────────────────────────────────────
  //
  // Conditions a collection's versions must meet (`packages/core/src/records/contracts.ts`). They
  // read only what never changes: this version, the one before when it was
  // kept whole, and versions cited by id, kept whole and standing.

  /** A version as a check reads it: its author's account, and its content when it was kept whole */
  async function checkedVersion(
    version: Version,
    whole: boolean,
  ): Promise<CitedVersion | { readonly unreadable: true }> {
    let body: unknown = null;
    // Public links are on the outside, the same for every peer; sealed ones only with the body.
    let links: ReadonlyArray<Link> = version.links ?? [];
    if (whole && !version.deleted) {
      const opened = await openBody(version);
      if (unreadable(opened)) return { unreadable: true };
      body = opened.body;
      links = opened.links;
    }
    return Object.freeze({
      id: version.id,
      key: version.key,
      collection: version.collection,
      seq: version.seq,
      author: (await judge(version)).root ?? version.author,
      createdAt: version.createdAt,
      deleted: !!version.deleted,
      body,
      links,
    });
  }

  /** A version a check cites: here, kept whole, and standing — or why it can't count */
  async function cited(id: string, within: ReadonlyArray<string>): Promise<CitedVersion | Uncited> {
    const version = await storage.getVersion(id);
    if (!version) return { later: true };
    // Whether it was kept is on the version, signed: the same answer on every peer.
    if (!version.retain && !version.deleted) return { refused: `it cites ${id}, which was not kept whole` };
    if (!(await consistent(version))) return { refused: `it cites ${id}, which is not its record's` };
    // As of what the citing version saw: a removal after it doesn't undo it.
    const stands = await standingOf(version, within);
    if (!stands.ok)
      return stands.later ? { later: true } : { refused: `it cites ${id}, which does not stand` };
    // Its own checks too, as of what the citing version saw.
    const passes = await checksOf(version, within);
    if ('pending' in passes) return { later: true };
    if (passes.passes === false) return { refused: `it cites ${id}, which fails its checks` };
    if (passes === UNJUDGED) return { unreadable: true };
    if ('unjudged' in passes) return { unjudged: true };
    return checkedVersion(version, true);
  }

  /**
   * Whether a version passes its collection's checks: the library reads them,
   * peers don’t enforce them (spec/09-contracts.md). `passes: null`
   * when there are none, or this node can't read what they need; `pending`
   * while a version it cites hasn't arrived. Judged as of what it saw, or, for
   * a version another cites, as of what that one saw (`within`).
   */
  async function checksOf(version: Version, within?: ReadonlyArray<string>): Promise<ChecksVerdict> {
    if (ACCESS_COLLECTIONS.has(version.collection) || version.collection.startsWith('sys.')) return NO_CHECKS;
    const cacheKey = `${copyKey(version)}|${within ? idsKey(within) : ''}`;
    // Only what can't change is kept: not a verdict waiting on what it cites, nor one this node couldn't judge.
    const settled = (found: ChecksVerdict) => !('pending' in found) && found !== UNJUDGED;
    return cached(checkVerdicts, cacheKey, () => judgeChecks(version, within), settled);
  }

  async function judgeChecks(version: Version, within?: ReadonlyArray<string>): Promise<ChecksVerdict> {
    const first = await namedFirst(version);
    const root = (await judge(version)).root;
    if (!first || !root) return NO_CHECKS;
    const state = (await access()).history.at(version.seen ?? [], within);
    if (!state) return { pending: true };
    const defined = await rulesAt(state, version.collection);
    const contract = defined?.contract;
    if (contract === undefined) return NO_CHECKS;
    // A contract with a key this library doesn't know: not judged, as a line's below.
    const shape = checkContractShape(contract);
    if (shape === 'unknown')
      return { passes: null, unjudged: `${version.collection} has a contract this library doesn't know` };
    if (shape !== null || !isRecord(contract))
      return { passes: false, reason: `The contract of ${version.collection} can't be read` };
    const listed: unknown = contract.check;
    const checks: unknown = Array.isArray(listed) && listed.length === 0 ? undefined : listed;
    const line: unknown = contract.line;
    if (checks === undefined && line === undefined) return NO_CHECKS;
    // Peers keep any list; one its author's node would have refused can't be read, so nothing passes it.
    if (checks !== undefined && (checkContracts(checks, 'contract.check') !== null || !Array.isArray(checks)))
      return { passes: false, reason: `The contract of ${version.collection} can't be read` };
    // A line declaration with a key this library doesn't know: not judged, as a space with an unknown resolver.
    const lineProblem = line === undefined ? null : checkLine(line);
    if (lineProblem === 'unknown')
      return { passes: null, unjudged: `${version.collection} declares a line this library doesn't know` };
    if (lineProblem !== null)
      return { passes: false, reason: `The line of ${version.collection} can't be read` };
    if (line !== undefined) lineCollections.add(version.collection);
    // What this node can't open, it can't judge: unjudged, so not counted, until it can (spec 09 §2).
    if (!version.deleted) {
      const opened = await openBody(version);
      if (unreadable(opened)) return UNJUDGED;
    }
    // It continues the version before: one that follows a version failing its checks fails too,
    // or a forged step would be laundered by the next.
    let previous = await previousOf(version);
    if (version.seq > 0 && version.prev && !previous) return { pending: true };
    // In a line, a delete is a step that ends it for good: nothing after it counts (spec 09 §7.5).
    if (line !== undefined && previous?.deleted)
      return { passes: false, reason: 'It follows a delete, which ends its line' };
    // A delete in between hides nothing: the chain is judged by the step before it.
    while (previous?.deleted && previous.seq > 0 && previous.prev) {
      const before: Version | null = await storage.getVersion(previous.prev);
      if (!before) return { pending: true };
      previous = before;
    }
    // A step under checks is kept whole by an honest writer (it is signed, so every reader sees the same):
    // one that wasn't can't be judged, and what follows it doesn't count.
    if (previous && !previous.retain && !previous.deleted) {
      const then = (await access()).history.at(previous.seen ?? []);
      const before = then ? await rulesAt(then, previous.collection) : null;
      if (hasContract(before?.contract))
        return { passes: false, reason: 'It follows a version under a contract that was not kept whole' };
    }
    if (previous && !isStub(previous)) {
      if (previous.retain && !previous.deleted) {
        const before = await openBody(previous);
        if (unreadable(before)) return UNJUDGED;
      }
      if (!(await standingOf(previous)).ok)
        return { passes: false, reason: 'It follows a version that does not stand' };
      const before = await checksOf(previous);
      if ('pending' in before) return { pending: true };
      // A step this node couldn't judge leaves what follows unjudged too, so neither is kept as a pass.
      if (before === UNJUDGED) return UNJUDGED;
      if ('unjudged' in before) return before;
      if (before.passes === false)
        return { passes: false, reason: `It follows a version that fails its checks: ${before.reason}` };
    }
    // A delete has no content to check, but it continues the chain like any step: one that follows a
    // failing step fails too, so it can't hide the record from readers or make its key unwritable.
    if (line !== undefined) {
      const broken = await lineBreak(version, root, isLine(line) ? (line.once ?? []) : []);
      if (broken === UNJUDGED) return UNJUDGED;
      if (typeof broken === 'string') return { passes: false, reason: broken };
    }
    if (version.deleted || checks === undefined || !Array.isArray(checks)) return NO_CHECKS;
    const outcome = await checkStanding(version, first, root, state, checks);
    if (outcome === 'unreadable') return UNJUDGED;
    if (outcome === 'unjudged')
      return { passes: null, unjudged: 'It cites a version in a collection this library doesn’t judge' };
    if (outcome.ok) return { passes: true };
    return outcome.later ? { pending: true } : { passes: false, reason: outcome.reason };
  }

  /** Whether a version counts for this node's reader: it stands, and passes its contract */
  async function counts(version: Version): Promise<boolean> {
    if (!(await standingOf(version)).ok) return false;
    const passes = await checksOf(version);
    // Bounded: past it, a waiting record is read again only when the index is rebuilt.
    if ('pending' in passes && pendingKeys.size < MAX_PENDING_REREAD) pendingKeys.add(version.key);
    return !('pending' in passes) && !('unjudged' in passes) && passes.passes !== false;
  }

  /** Collections this node has judged as lines: a version arriving in one can undo a verdict (a double spend) */
  const lineCollections = new Set<string>();
  /**
   * Every version held in a line collection, by key and the version it
   * names before it: deletes and stubs included, whatever `retain` says, so
   * no twin hides from the double-spend check. Dropped when one arrives.
   */
  const lineIndexes = new Map<string, Promise<Map<string, Version[]>>>();
  const twinKey = (version: Version) => `${version.key}\n${version.prev ?? ''}`;
  function lineIndex(collection: string): Promise<Map<string, Version[]>> {
    return cached(lineIndexes, collection, async () => {
      const byPlace = new Map<string, Version[]>();
      for (const version of await storage.keptVersions(collection)) {
        getOrAdd(byPlace, twinKey(version), () => []).push(version);
      }
      return byPlace;
    });
  }

  /**
   * Why a version breaks its line's rule (spec 09 §6), or null. Its key is its
   * author's line key; no other version at that key names the same version
   * before it (a double spend: neither counts, nor anything after either);
   * and no citation in a `once` field appears twice along the counted chain,
   * this version and every one before it.
   */
  async function lineBreak(
    version: Version,
    root: string,
    once: ReadonlyArray<string>,
  ): Promise<string | null | typeof UNJUDGED> {
    if (version.key !== (await lineKey(root, version.collection)))
      return 'It is not at its author’s line key';
    for (const other of (await lineIndex(version.collection)).get(twinKey(version)) ?? []) {
      if (other.id === version.id || other.seq !== version.seq) continue;
      // At an owned key only its owner's versions stand; one that doesn't is no twin.
      if ((await judge(other)).root !== root) continue;
      return 'A double spend: another version of this line follows the same one';
    }
    if (once.length === 0 || version.deleted) return null;
    // Back to the nearest step whose claims are known, then forward: judging a line is linear.
    const fields = JSON.stringify(once);
    const path: Version[] = [];
    let known: ReadonlySet<string> | undefined;
    for (let step: Version | null = version; step;) {
      known = onceClaimed.get(`${step.id}|${fields}`);
      if (known) break;
      path.push(step);
      step = await previousOf(step);
    }
    const claimed = new Set(known);
    // A stub's claims can't be read yet, so a walk through one isn't kept: the whole version may arrive.
    let throughStub = false;
    for (const step of path.reverse()) {
      if (step.deleted) continue;
      if (isStub(step)) throughStub = true;
      const opened = await openBody(step);
      if (unreadable(opened)) return UNJUDGED;
      for (const citation of onceCitations(opened.body, once)) {
        if (claimed.has(citation)) return 'It claims something its line has already claimed';
        claimed.add(citation);
      }
    }
    // An id names its content, and so its whole chain: what it claimed never changes.
    if (throughStub) return null;
    setCapped(onceClaimed, `${version.id}|${fields}`, claimed, MAX_ONCE_CLAIMED);
    return null;
  }
  /** What a line's `once` fields claimed along the chain ending at a version, by its id and the fields */
  const onceClaimed = new Map<string, ReadonlySet<string>>();

  async function checkStanding(
    version: Version,
    first: Version,
    root: string,
    state: AccessState,
    checks: ReadonlyArray<Contract>,
  ): Promise<Standing | 'unjudged' | 'unreadable'> {
    const opened = await openBody(version);
    // Without the key, a peer can't tell: unjudged, as for a cited version it can't open.
    if (unreadable(opened)) return 'unreadable';
    const previous = await previousOf(version);
    const prev = previous ? await checkedVersion(previous, !!previous.retain) : null;
    if (prev && 'unreadable' in prev) return 'unreadable';
    const outcome = await runContracts(checks, {
      values: {
        body: opened.body,
        links: opened.links,
        key: version.key,
        seq: version.seq,
        collection: version.collection,
        author: root,
        creator: (await judge(first)).root ?? first.author,
        createdAt: version.createdAt,
        prev,
      },
      cite: (id) => cited(id, version.seen ?? []),
      member: (did) => isMember(state, did),
    });
    if ('later' in outcome)
      return { ok: false, reason: 'Versions it cites have not arrived yet', later: true };
    if ('unjudged' in outcome) return 'unjudged';
    if ('unreadable' in outcome) return 'unreadable';
    if (outcome.passed) return STANDS;
    return { ok: false, reason: outcome.reason };
  }

  /**
   * Whether a change to the access history may be stored. Not whether it
   * counts — that can change as other changes arrive, so every well-formed one
   * is kept and the replay decides. Only what never changes is asked: that
   * what it saw is here, and that its author is someone the history has heard
   * of, or holds an invite it has.
   */
  async function admissible(version: Version): Promise<Standing> {
    if (version.space !== space.id) return { ok: false, reason: 'It belongs to a different space' };
    if (!version.retain) return { ok: false, reason: 'A change to who may do what must be kept' };
    const event = await toEvent(version);
    if (!event)
      return {
        ok: false,
        reason: (await judge(version)).reason ?? 'It is not a well-formed change to who may do what',
      };
    const { history } = await access();
    if (!history.at(event.seen)) return ACCESS_LATER;
    const known =
      history.named(event.root) ||
      (event.kind === 'assign' && event.viaInvite !== undefined && history.knownInvite(event.viaInvite));
    return known ? STANDS : { ok: false, reason: 'Its author has never been a member of this space' };
  }

  /**
   * Whether a later version follows the version its `prev` names: the same
   * record, one more `seq`, the same first version. Asked on arrival, once
   * that version is held, so a writer can't skip ahead to a `seq` nobody can
   * outrank.
   */
  async function chainStanding(version: Version): Promise<Standing> {
    if (version.seq === 0 || typeof version.prev !== 'string') return STANDS;
    const previous = await storage.getVersion(version.prev);
    if (!previous) return { ok: false, reason: 'The version it follows has not arrived yet', later: true };
    const problem = chainProblem(version, previous);
    return problem ? { ok: false, reason: problem } : STANDS;
  }

  /** Whether a version from outside — a peer, a folder — may be stored */
  async function admit(version: Version): Promise<Standing> {
    const verdict = await admitOnce(version);
    // Refused for good, or a change to who may do what: perhaps proof of a broken rule (docs/warrants.md).
    if ((!verdict.ok && !verdict.later && !verdict.withdrawn) || ACCESS_COLLECTIONS.has(version.collection))
      void warrantIfDue(version).catch(() => {});
    return verdict;
  }

  async function admitOnce(version: Version): Promise<Standing> {
    // Before any cached verdict: a copy with another envelope or body shares the id and signature.
    const problem = await copyProblem(version);
    if (problem) return { ok: false, reason: problem };
    // Whatever its key signed takes a place in that key's log, allowed or not: a second at one place is a fork.
    if ((await judge(version)).verified) await placeInLog(version);
    if (version.retain && isStub(version))
      return { ok: false, reason: 'A version its writer retained travels whole' };
    const chain = await chainStanding(version);
    if (!chain.ok) return chain;
    if (ACCESS_COLLECTIONS.has(version.collection)) return admissible(version);
    const standing = await standingOf(version);
    // Kept as its record's history; it counts only once whole, and its body is judged then.
    return !standing.ok && standing.bodyNeeded ? STANDS : standing;
  }

  /**
   * The version of a record that counts: the current one, unless it no longer
   * stands — then the newest one before it that does, if the store kept one.
   */
  async function currentOf(recordKey: string): Promise<Version | null> {
    const current = await storage.getCurrent(recordKey);
    if (!current || !(await consistent(current))) return null;
    // A stub on top: the body of the version after it is on its way.
    if (!isStub(current) && (await counts(current))) return current;
    for (const version of await storage.history(recordKey)) {
      if (version.id === current.id || isStub(version) || !(await consistent(version))) continue;
      if (await counts(version)) return version;
    }
    return null;
  }

  // ─── What counts now ───────────────────────────────────────────────
  //
  // Every record's counted version, read from the store once and then kept
  // up to date a key at a time: placing a version marks its key stale, and
  // only that key is read again. A change that could alter other verdicts —
  // the space's own records, new keys, a store someone else wrote — throws
  // the whole index away (`recordsChanged`).

  interface Counted {
    readonly version: Version;
    readonly createdAt: string;
    /** Worked out the first time it is read */
    shown?: Promise<NodeRecord<unknown>>;
  }
  let countedIndex: Promise<Map<string, Counted>> | null = null;
  const staleKeys = new Set<string>();
  /** One read of the index at a time, so a key is never brought up to date twice at once */
  let indexing: Promise<unknown> = Promise.resolve();

  const countedEntry = async (version: Version): Promise<Counted> => ({
    version,
    createdAt: await createdAtOf(version),
  });

  async function buildIndex(): Promise<Map<string, Counted>> {
    staleKeys.clear();
    const index = new Map<string, Counted>();
    for (const version of await storage.listCurrent()) {
      const counted =
        !isStub(version) && (await counts(version)) && (await consistent(version))
          ? version
          : await currentOf(version.key);
      if (counted) index.set(counted.key, await countedEntry(counted));
    }
    return index;
  }

  function counted(): Promise<Map<string, Counted>> {
    const run = indexing.then(async () => {
      const index = await (countedIndex ??= buildIndex().catch((error) => {
        countedIndex = null;
        throw error;
      }));
      for (const key of [...staleKeys]) {
        staleKeys.delete(key);
        const version = await currentOf(key);
        if (version) index.set(key, await countedEntry(version));
        else index.delete(key);
      }
      return index;
    });
    indexing = run.catch(() => {});
    return run;
  }

  /** Every record that counts, current version each — deletes included */
  async function everyCurrent(collection?: string): Promise<Version[]> {
    const shown: Version[] = [];
    for (const entry of (await counted()).values())
      if (!collection || entry.version.collection === collection) shown.push(entry.version);
    return shown;
  }

  async function view<T>(version: Version): Promise<NodeRecord<T>> {
    const [{ body, links, encrypted }, verdict, genesis, stands] = await Promise.all([
      openBody(version),
      judge(version),
      genesisOf(version),
      standingOf(version),
    ]);
    const creator = genesis ? await judge(genesis) : null;
    // One record is handed to every reader, so nobody may change it under the others.
    deepFreeze(body);
    deepFreeze(links);
    const issues =
      body === null || version.deleted ? null : await contentIssues(version.collection, body, links);
    const failing = verdict.verified && stands.ok ? await checksOf(version) : NO_CHECKS;
    const reason = !verdict.verified
      ? verdict.reason
      : !stands.ok
        ? stands.reason
        : 'passes' in failing && failing.passes === false
          ? `It fails its checks: ${failing.reason}`
          : undefined;
    return Object.freeze({
      key: version.key,
      version: version.id,
      seq: version.seq,
      space: space.id,
      collection: version.collection,
      author: version.author,
      root: verdict.root,
      createdBy: creator?.verified ? creator.root : null,
      createdAt: genesis?.createdAt ?? version.createdAt,
      updatedAt: version.createdAt,
      // The caller names the body's type; nothing here checks it against one.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the caller's type for the body
      body: body as T | null,
      links,
      encrypted,
      verified: verdict.verified && stands.ok,
      ...(!grantsBeyondRecords(version.proof, space.id, DEFINE_COMMAND)
        ? { recordsOnly: true as const }
        : {}),
      ...(reason ? { reason } : {}),
      ...(version.deleted ? { deleted: true as const } : {}),
      conforms: issues === null ? null : issues.length === 0,
      ...(issues?.length ? { issues } : {}),
    });
  }

  // ─── The catalogue ─────────────────────────────────────────────────
  //
  // Which definition is in force for each collection is the access history's
  // answer: the latest change to `collection:<name>` that counted.

  interface CatalogEntry {
    readonly definition: StoredCollection;
    /** Null when rival first definitions name different accounts */
    readonly definedBy: string | null;
    /** The id of the version that holds this definition */
    readonly version: string;
  }
  let catalogCache: Promise<Map<string, CatalogEntry>> | null = null;
  const catalog = () => (catalogCache ??= loadCatalog());

  async function loadCatalog(): Promise<Map<string, CatalogEntry>> {
    const result = new Map<string, CatalogEntry>();
    const { history } = await access();
    const { definitions, contested } = history.current;
    for (const name of new Set([...definitions.keys(), ...contested.keys()])) {
      const id = await inForce(history.current, name);
      const found = id ? await definitionIn(id) : 'missing';
      if (!id || typeof found === 'string') continue;
      if (found.definition.name !== name) continue;
      result.set(name, {
        definition: found.definition,
        definedBy: definitions.get(name)?.definedBy ?? null,
        version: id,
      });
    }
    return result;
  }

  /** A collection's definition: what the space says. The protocol knows no kinds of record of its own. */
  async function definitionOf(collection: string): Promise<StoredCollection | null> {
    return (await catalog()).get(collection)?.definition ?? null;
  }

  /** Issues with a body against its collection's schema; null when there is no schema to check against. */
  async function shapeIssues(collection: string, body: unknown): Promise<ReadonlyArray<SchemaIssue> | null> {
    // The protocol's own bookkeeping — definitions, profiles, roles — has no user-facing schema.
    if (collection.startsWith('sys.')) return null;
    const described = await definitionOf(collection);
    if (described) {
      // A schema the validator can't build (a bad $id in an annotation, say)
      // checks nothing, like a definition that is invalid (spec 02 §6.1).
      try {
        return validateJsonSchema(described.schema, body);
      } catch {
        return null;
      }
    }
    if (schemas.getCollection(collection)) {
      const checked = await schemas.validate(collection, body);
      return (checked.issues ?? []).map((issue) => ({ path: '/', message: issue.message }));
    }
    return null;
  }

  /**
   * Issues with a record's links against its collection's declaration. Only
   * what can be judged from what is held: a link to a record not here yet is
   * fine — you routinely hold a reaction before its post.
   */
  async function linkIssues(collection: string, links: ReadonlyArray<Link>): Promise<SchemaIssue[]> {
    const malformed = checkLinks(links);
    if (malformed) return [{ path: '/links', message: malformed }];
    if (links.length === 0) return [];
    const declared = (await definitionOf(collection))?.links;
    // An undescribed collection says nothing about its links, so nothing is wrong.
    if (!declared)
      return (await definitionOf(collection))
        ? [{ path: '/links', message: `${collection} declares no links` }]
        : [];

    const issues: SchemaIssue[] = [];
    const perRole = new Map<string, number>();
    for (const [index, link] of links.entries()) {
      const declaration = declared[link.rel];
      if (!declaration) {
        issues.push({
          path: `/links/${index}`,
          message: `${collection} has no "${link.rel}" link (it has: ${Object.keys(declared).join(', ')})`,
        });
        continue;
      }
      perRole.set(link.rel, (perRole.get(link.rel) ?? 0) + 1);
      if (declaration.to === '*') continue;
      const target = await currentOf(link.to);
      if (target && !target.deleted && !declaration.to.includes(target.collection)) {
        issues.push({
          path: `/links/${index}`,
          message: `"${link.rel}" must point at ${declaration.to.join(' or ')}, not ${target.collection}`,
        });
      }
    }
    for (const [rel, count] of perRole) {
      if (declared[rel]?.cardinality === 'one' && count > 1)
        issues.push({ path: '/links', message: `At most one "${rel}" link` });
    }
    return issues;
  }

  /** Shape and link issues together; null when neither has anything to check against. */
  async function contentIssues(
    collection: string,
    body: unknown,
    links: ReadonlyArray<Link>,
  ): Promise<ReadonlyArray<SchemaIssue> | null> {
    const shape = await shapeIssues(collection, body);
    const linked = await linkIssues(collection, links);
    if (shape === null && linked.length === 0 && !(await definitionOf(collection))) return null;
    return [...(shape ?? []), ...linked];
  }

  function describe(name: string, entry: CatalogEntry | null, records: number): NodeCollection {
    const definition = entry?.definition;
    const usable = usableComputed(definition?.computed, definition?.schema);
    return Object.freeze({
      name,
      ...(definition?.title !== undefined ? { title: definition.title } : {}),
      ...(definition?.description !== undefined ? { description: definition.description } : {}),
      schema: definition?.schema ?? null,
      version: definition?.version ?? null,
      history: definition?.history ?? 'latest',
      links: definition?.links ?? {},
      definedBy: entry?.definedBy ?? null,
      rules: definition?.rules ?? {},
      ...(definition?.contract !== undefined ? { contract: definition.contract } : {}),
      // Only what every reader can use: a definition written by hand arrives unchecked.
      ...(usable !== undefined ? { computed: usable } : {}),
      topics: definition?.topics ?? [],
      records,
    });
  }

  // ─── What points where ─────────────────────────────────────────────
  //
  // Derived from the records held, rebuilt when they change, never synced: any
  // node holding the records can build it, and derived data travelling between
  // peers would only be one more thing to disagree about.

  let linkIndexCache: Promise<Map<string, Array<{ rel: string; from: string }>>> | null = null;
  const linkIndex = () => (linkIndexCache ??= buildLinkIndex());

  async function buildLinkIndex(): Promise<Map<string, Array<{ rel: string; from: string }>>> {
    const index = new Map<string, Array<{ rel: string; from: string }>>();
    for (const version of await everyCurrent()) {
      if (version.deleted) continue;
      const { links } = await openBody(version);
      for (const link of links) {
        const list = index.get(link.to) ?? [];
        list.push({ rel: link.rel, from: version.key });
        index.set(link.to, list);
      }
    }
    return index;
  }

  // ─── Profiles ──────────────────────────────────────────────────────
  //
  // Each person says who they are in a space with one record, keyed by their
  // identity (`profileKey`), whose versions are always retained. The fold
  // takes the newest version signed by the identity the key names, so nobody
  // can rename anyone else: a version written by someone else under your key
  // is simply never the answer, and it cannot push yours out, because yours
  // are kept.

  let profilesCache: Promise<Map<string, SpaceProfile>> | null = null;
  const profileMap = () => (profilesCache ??= loadProfiles());

  async function loadProfiles(): Promise<Map<string, SpaceProfile>> {
    const result = new Map<string, SpaceProfile>();
    // By key: the current version may be anyone's.
    for (const [key, versions] of await storage.histories('profile:')) {
      let found: SpaceProfile | null = null;
      for (const version of versions) {
        if (version.collection !== PROFILE_COLLECTION) continue;
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await profileKey(verdict.root)) !== key) continue;
        if (!(await standingOf(version)).ok) continue;
        if (version.deleted) break; // they took it down
        const opened = (await openBody(version)).body;
        const body = isRecord(opened) ? opened : null;
        if (!found) {
          const name = body?.name;
          if (typeof name !== 'string' || !name.trim()) break;
          found = { did: verdict.root, name: name.trim().slice(0, 64), updatedAt: version.createdAt };
        }
        // The picture, from the newest version: one without it shows none (the older stay kept, as retained).
        if (!found.avatar && found.updatedAt === version.createdAt && isAvatarRef(body?.avatar))
          found = { ...found, avatar: body.avatar };
        // The contact key from the newest version that has one: it never changes, and an app
        // without it that wrote a newer version first must not hide it.
        if (isContactPublicKey(body?.contactKey)) {
          found = { ...found, contactKey: body.contactKey };
          break;
        }
      }
      if (found) result.set(found.did, found);
    }
    return result;
  }

  /**
   * Each member's member key, from their own record of it — kept in the
   * clear, so someone who holds only an older key of the space can still say
   * where to seal the new one.
   */
  let memberKeysCache: Promise<Map<string, string>> | null = null;
  const memberKeyMap = () => (memberKeysCache ??= loadMemberKeys());
  /** Every key box, read once until records change */
  let boxCache: ReturnType<typeof storage.histories> | null = null;
  const boxIndex = () => (boxCache ??= storage.histories('box:'));

  async function loadMemberKeys(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    // By key: the current version may be anyone's.
    for (const [key, versions] of await storage.histories('memberkey:')) {
      for (const version of versions) {
        if (version.collection !== MEMBER_KEY_COLLECTION || version.deleted) continue;
        const verdict = await judge(version);
        if (!verdict.verified || !verdict.root || (await memberKeyRecordKey(verdict.root)) !== key) continue;
        if (!(await standingOf(version)).ok) continue;
        const body = isRecord(version.body) ? version.body : null;
        if (isContactPublicKey(body?.key)) {
          found.set(verdict.root, body.key);
          break;
        }
      }
    }
    return found;
  }

  /**
   * Records changed: whatever is derived from them may have too. Given the
   * versions that were placed, and none of them the space's own (`sys.`),
   * only what those records feed is thrown away: who may do what, the
   * definitions and the keys come from `sys.` records alone, so every other
   * verdict still holds. Given nothing — another tab, a folder, new keys —
   * everything is.
   */
  let spaceFiles: SpaceFiles | null = null;
  const missingFiles = (): never => {
    throw new Error('The space is still opening');
  };
  let filesTimer: ReturnType<typeof setTimeout> | null = null;
  /** One pass at a time; a change during one runs another after it */
  let filesPass: Promise<void> | null = null;
  let filesAgain = false;
  /** After a change: which files are named is worked out again, and soon kept, dropped and fetched to match */
  function filesChanged(): void {
    spaceFiles?.changed();
    if (filesPass) {
      filesAgain = true;
      return;
    }
    if (filesTimer || closed) return;
    filesTimer = setTimeout(() => {
      filesTimer = null;
      filesPass = (async () => {
        await spaceFiles?.tidy();
        await spaceFiles?.fetchMissing();
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

  const recordsChanged = (placed?: ReadonlyArray<Version>) => {
    filesChanged();
    if (placed) noteArrived(placed);
    linkIndexCache = null;
    emit({ type: 'records', space: space.id });
    for (const mirror of mirrors) mirror.changed();
    if (placed && placed.every((version) => !version.collection.startsWith('sys.'))) {
      for (const version of placed) staleKeys.add(version.key);
      // A record waiting on a version it cites may count now.
      for (const key of pendingKeys) staleKeys.add(key);
      pendingKeys.clear();
      // A version in a line can make a double spend of one that counted, and undo what cites it.
      if (placed.some((version) => lineCollections.has(version.collection))) {
        checkVerdicts.clear();
        countedIndex = null;
        for (const version of placed) lineIndexes.delete(version.collection);
      }
      return;
    }
    countedIndex = null;
    catalogCache = null;
    profilesCache = null;
    memberKeysCache = null;
    boxCache = null;
    accessCache = placed && accessCache ? extendAccess(accessCache, placed) : null;
    standings.clear();
    checkVerdicts.clear();
    lineIndexes.clear();
    keepUp();
    // The access history may name keepers now, or none.
    void refreshHolds().catch(() => {});
    // Or a new key, which someone connected may not hold.
    void letGoOfOutsiders().catch(() => {});
  };

  // ─── The space's keys (`node/space-keys.ts`) ───────────────────────

  const { currentKey, newestKey, rotateKey, keepUp, keepingUp } = createSpaceKeys({
    space,
    rootDid: deps.rootDid,
    provider,
    proof: session.proof,
    ownRelays: () => usableRelays(deps.network),
    accountOnly: deps.accountOnly,
    keyring,
    heldKey: record.key,
    memberPair,
    storage,
    isClosed: () => closed,
    access,
    judge,
    boxIndex,
    memberKeyMap,
    cannotWrite,
    upsert,
    onKeys: deps.onKeys,
    forgetDefinitions: () => definitions.clear(),
    recordsChanged: () => recordsChanged(),
  });

  // ─── Mirrors ───────────────────────────────────────────────────────
  //
  // Every mirror is one more peer: what it holds goes through the same gates
  // as a peer's records, and what this node holds goes out to it.

  /** What a mirror holds goes through the same gates as a peer's records */
  const fromMirror = async (version: Version): Promise<Taken> => {
    const verdict = await admit(version);
    if (!verdict.ok && !verdict.withdrawn) return verdict.later ? 'later' : 'refused';
    await storage.addVersion(version);
    return 'stored';
  };
  const mirrors: Mirror[] = [];
  for (const [index, store] of (deps.mirrors ?? []).entries()) {
    mirrors.push(
      await createMirror({
        store,
        space: space.id,
        storage,
        state: await deps.stores(`mirrors/${space.id}/${index}`),
        accept: fromMirror,
      }),
    );
  }
  // A data folder is one more: its spaces are segments, like a bucket's, and
  // what this device holds of them is its own (`node/stores.ts`).
  const folderMirror = deps.stores.folder
    ? await createMirror({
        store: deps.stores.folder,
        space: space.id,
        storage,
        state: await deps.stores(`folder/${space.id}`),
        accept: fromMirror,
        // Apps and the CLI on one computer meet through the folder: soon, not in a bucket's time.
        flushMs: 1000,
      })
    : null;
  if (folderMirror) mirrors.push(folderMirror);
  /** Reads every mirror in the background: a space that opens from nothing — a host that lost its disk — fills in as it goes */
  const pullMirrors = () =>
    Promise.all(
      mirrors.map((mirror) =>
        mirror
          .pull()
          .then(({ added }) => {
            if (added === 0) return;
            recordsChanged();
            announceSoon();
          })
          .catch(() => {
            // Out of reach now; what this node holds goes out on the next change.
          }),
      ),
    );

  // ─── Peers ─────────────────────────────────────────────────────────

  /** How the first connect went; after that, what the networks say now (`liveConnection`) */
  let connection: ConnectionState = 'offline';
  let rejected = 0;
  const networks: NetworkManager[] = [];
  const reachable = () => networks.some((network) => network.isConnected());
  /**
   * Connected while some network is: a relay reachable, or a peer. Once up, a
   * space whose relays are all gone and whose peers have left is trying again,
   * not connected; one whose first try failed is connected once a retry works.
   */
  const liveConnection = (): ConnectionState => {
    if (connection === 'offline') return connection;
    if (reachable()) return 'connected';
    return connection === 'connected' ? 'connecting' : connection;
  };
  let shown: ConnectionState | null = null;
  // Relays come and go without a peer doing so; say so when that changes how this space connects.
  const stopWatchingMesh = deps.mesh?.subscribe(() => {
    const now = liveConnection();
    if (now === shown) return;
    shown = now;
    statusChanged();
  });
  /** Which network a peer was met on, so replies go back the same way */
  const routes = new Map<string, NetworkManager>();
  const connectedPeers = () => [
    ...new Set(networks.flatMap((network) => network.getPeers().map((peer) => peer.did))),
  ];

  // ─── Files ─────────────────────────────────────────────────────────
  //
  // Named on the outside of the versions that refer to them, fetched chunk by
  // chunk and checked as they come, kept while a body that names them is
  // (spec 05 §16.6).

  spaceFiles = createSpaceFiles({
    space: space.id,
    adapter,
    storage,
    send: (peer, message) =>
      routes.get(peer)?.send(peer, {
        type: 'sync',
        from: session.did,
        payload: { ...message, v: SYNC_PROTOCOL_VERSION },
      }),
    peers: () => connectedPeers(),
    mirrors: () => mirrors.map((mirror) => ({ store: mirror.store, writer: mirror.writer })),
    stands: async (version) => storable(await standingOf(version)),
    // Files follow records: every file a version kept whole names is fetched, within a device's limits.
    ...(deps.fetchFiles === 'all' ? {} : { limits: DEVICE_LIMITS }),
  });

  const sync = createSyncEngine({
    storageProvider: storage,
    self: session.did,
    holds,
    files: (peer, message) => spaceFiles?.onMessage(peer, message) ?? Promise.resolve(),
    sendToPeer: (peerId, message) => {
      routes.get(peerId)?.send(peerId, { type: 'sync', from: session.did, payload: message });
    },
    validate: async (version) => {
      const verdict = await admit(version);
      return verdict.ok || verdict.withdrawn
        ? { valid: true }
        : { valid: false, reason: verdict.reason, ...(verdict.later ? { later: true } : {}) };
    },
  });

  /**
   * Tells every connected peer this node's root, soon after it took in
   * something new — from a peer or from a folder. Without it, a record passed
   * along waits for the next heartbeat at every hop: a carrier would sit on a
   * friend's write for half a minute before the pod, or your phone, heard of
   * it. A peer already level answers and nothing moves.
   */
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const announceSoon = () => {
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      sync.notifyPeers(connectedPeers());
    }, 100);
  };

  // Once per message from a peer, with everything it brought.
  sync.on('received', (versions: ReadonlyArray<Version>) => {
    recordsChanged(versions);
    announceSoon();
    for (const version of versions) deps.onArrived?.(version);
  });
  sync.on('rejected', (peer: string, _version: Version, reason: string) => {
    rejected += 1;
    emit({ type: 'rejected', space: space.id, peer, reason });
  });

  // ─── Who is at the other end (`node/space-peers.ts`) ───────────────

  const peers = createSpacePeers({
    space,
    rootDid: deps.rootDid,
    session,
    provider,
    keyring,
    readKeyPair: record.read,
    newestKey,
    currentReadKey: () => currentReadKey,
    access,
    formerMembers,
    emit,
    statusChanged,
    networks,
    routes,
    sync,
    connectedPeers,
  });
  /** How this node proves it may read, and checks the peers that connect — against the history at that moment */
  const { readAccess, letGoOfOutsiders } = peers;

  // Both sides of a socket to a node prove who they are; in a private space the client also proves it may read.
  let authenticator: ReturnType<typeof createClientAuth> | null = null;
  /** A socket to an always-on node, for this space */
  function nodeNetwork(node: string): NetworkManager {
    authenticator ??= createClientAuth(space.id, session, readAccess, provider);
    const url = withSpace(node, space.id);
    const auth = authenticator;
    return createNetworkManager({
      did: session.did,
      createTransport: () => createWebSocketTransport({ url, did: session.did, authenticator: auth }),
    });
  }
  /** Sockets to the hosts the account or the space uses, by address: they change while the space is open */
  const hostNetworks = new Map<string, NetworkManager>();

  const net = deps.network;
  if (net) {
    // Who is at the other end is asked of the history at each handshake: the space's key may change while it is open.
    await access();
    if (deps.mesh) {
      meshRoom = await relayRoom(space.id);
      deps.mesh.useRelays(meshRoom, relays);
      // Every peer met through a relay proves who it is, and in a private space that it may read.
      networks.push(deps.mesh.join(meshRoom, createMeshAuth(space.id, session, readAccess, provider)));
    }
    for (const node of net.nodes ?? []) networks.push(nodeNetwork(node));
    for (const transport of net.transports?.(space.id, session.did) ?? []) {
      networks.push(createNetworkManager({ did: session.did, createTransport: () => transport }));
    }
  }

  function listen(network: NetworkManager): void {
    network.on('message', (message: NetworkMessage) => {
      if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
      else peers.onMessage(message);
    });
    network.on('peer-connected', (info: PeerInfo) => {
      if (peers.isCutOff(info.did)) {
        network.drop(info.did);
        return;
      }
      // Said first, so it reaches them before any live message from here.
      peers.introduce(network, info.did);
      routes.set(info.did, network);
      sync.addPeer(info.did);
      // Reconcile at once rather than waiting for the heartbeat.
      sync.notifyPeers([info.did]);
      // It may hold a file nobody else had.
      spaceFiles?.joined(info.did);
      filesChanged();
      statusChanged();
      // The key may have changed between checking it and letting it in.
      void letGoOfOutsiders().catch(() => {});
    });
    network.on('peer-disconnected', (info: PeerInfo) => {
      if (routes.get(info.did) === network) {
        routes.delete(info.did);
        sync.removePeer(info.did);
        peers.forget(info.did);
      }
      peers.disconnected(info.did);
      statusChanged();
    });
    network.on('error', () => {
      if (!networks.some((n) => n.isConnected())) connection = 'error';
      statusChanged();
    });
  }
  for (const network of networks) listen(network);

  // Whether to hold part of the space is settled before the first hello says what this node holds.
  await refreshHolds().catch(() => {});

  if (networks.length > 0) {
    connection = 'connecting';
    // Online as soon as one way in works: a node that is slow to answer, or
    // never does, must not keep the space saying "connecting" meanwhile.
    void Promise.any(networks.map((network) => network.connect())).then(
      () => {
        connection = 'connected';
        statusChanged();
      },
      () => {
        connection = 'error';
        statusChanged();
      },
    );
    sync.start();
  }

  // ─── Writers outside this process ──────────────────────────────────
  //
  // A data folder is written by other apps, and by other devices behind
  // whatever syncs it; a directory store by another process (a command beside
  // a daemon). Nothing announces either, so both are looked for.

  /** Whether another writer changed anything this node holds */
  const look = async (): Promise<boolean> => {
    // The same verdict as for a version from a peer.
    const reconciled = isFolderAdapter(adapter)
      ? (await reconcileFolder(storage, adapter, async (version) => storable(await admit(version)))).changed
      : false;
    const pulled = folderMirror ? (await folderMirror.pull()).added > 0 : false;
    return reconciled || pulled;
  };
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  if (deps.watchIntervalMs > 0 && (folderMirror || isFolderAdapter(adapter))) {
    let running = false;
    watchTimer = setInterval(() => {
      if (running) return;
      running = true;
      look()
        .then((changed) => {
          if (!changed) return;
          recordsChanged();
          announceSoon();
        })
        .catch(() => {
          // A revoked permission or a folder that went away; the next pass will tell.
        })
        .finally(() => {
          running = false;
        });
    }, deps.watchIntervalMs);
  }

  // Tabs of one browser share one IndexedDB but not memory, so a write in one
  // is invisible to the other until it is told. A nudge is enough: the store
  // already holds the data.
  const channel =
    typeof globalThis.BroadcastChannel === 'function'
      ? new globalThis.BroadcastChannel(`minca-node:${deps.rootDid}:${space.id}`)
      : null;
  if (channel) {
    channel.onmessage = () => {
      // The other tab wrote to the store underneath: what sync compares is read again.
      storage.invalidate();
      recordsChanged();
    };
    // In Node a channel holds the process open; it must never be the only thing doing so.
    unref(channel);
  }

  // ─── Holding part of the space (`node/space-holding.ts`) ───────────

  // Here and not earlier: it registers sync handlers and starts timers that need the network connected.
  holding.start();

  // ─── Writing ───────────────────────────────────────────────────────

  interface VersionFields {
    readonly key: string;
    readonly seq: number;
    readonly prev?: string;
    readonly genesis?: string;
  }

  /** Why this account cannot write here at all, or null when it can */
  async function cannotWrite(): Promise<string | null> {
    const { history } = await access();
    if (isMember(history.current, deps.rootDid)) return null;
    return waitingInvite
      ? `You've joined "${space.name}", but its invite hasn't reached this device yet — connect to someone in the space first`
      : `"${space.name}" was shared with you to view — you can't change it`;
  }

  /**
   * The heads a new version names: all of them, or past what a version may
   * name, first those its own standing rests on (its author's place, its
   * role, its collection's definition), then the latest applied. Naming fewer
   * is safe: what it leaves out it is judged as not having seen (03 §3.2).
   */
  async function seenFor(history: AccessHistory, collection: string): Promise<ReadonlyArray<string>> {
    const roles = rolesOf(history.current, deps.rootDid);
    const mine = [
      await removalKey(deps.rootDid),
      await stepDownKey(deps.rootDid),
      ...(await Promise.all(roles.map((role) => assignKey(deps.rootDid, role)))),
      ...roles.map(roleKey),
      `collection:${collection}`,
    ];
    return history.headsFor(mine, MAX_SEEN);
  }

  /** Signs and stores one version. A delete carries no body. */
  async function write<T>(
    collection: string,
    body: T | null,
    version: VersionFields,
    deleted = false,
    links: ReadonlyArray<Link> = [],
    options: { joining?: boolean; as?: ActiveSession } = {},
  ): Promise<Version> {
    const writer = options.as ?? session;
    const asAccount = deps.accountOnly || aboutItself(collection, body, deps.rootDid, writer.did);
    if (asAccount && !actsForAccount(writer.proof())) throw new Error(NOT_ACCOUNT);
    // Every peer would ignore it (see buildEvent); say why here instead.
    if (
      ACCESS_COLLECTIONS.has(collection) &&
      !noteGrants(writer.proof(), accessRequirement(space.id, collection, version.key))
    ) {
      throw new Error(collection === CATALOG_COLLECTION ? CANNOT_DEFINE : CANNOT_CHANGE_ACCESS);
    }
    // Every other copy would refuse it, so refuse it here rather than show a
    // change that exists on this device alone.
    if (!options.joining) {
      const problem = await cannotWrite();
      if (problem) throw new Error(problem);
    }

    let payload: unknown = null;
    let tags: string[] = [];
    // The files the body refers to, named on the outside so keepers fetch and keep them.
    const named = deleted ? [] : fileRefsIn(body);
    if (named.length > MAX_FILES) throw new Error(`A record names at most ${MAX_FILES} files`);
    if (!deleted) {
      // Refused here, where the writer can fix it. On arrival a misfit is kept
      // and flagged instead — see `conforms`.
      const issues = await contentIssues(collection, body, links);
      if (issues?.length) {
        throw new Error(
          `Not a valid ${collection}: ${issues.map((i) => (i.path === '/' ? i.message : `${i.path} ${i.message}`)).join('; ')}`,
        );
      }

      // Encrypt *before* signing: peers without the key still verify the
      // signature and relay the record, they just cannot read it.
      payload = body;
      if (space.visibility === 'private' && !IN_THE_CLEAR.has(collection)) {
        // Always the key the history names now: one someone removed still holds would do nothing.
        const key = currentKey((await access()).history.current);
        if (!key) {
          throw new Error(
            keyring.size
              ? `The key of "${space.name}" changed, and the new one hasn't reached this device yet — connect to someone in the space first`
              : 'This private space has no key on this node',
          );
        }
        // Body and links sealed together: a relay learns neither.
        const content = links.length ? { body, links } : { body };
        payload = await sealBody(content, key, { space: space.id, collection, key: version.key });
      }
      // Worked out from the body, with the key it is sealed with: what every reader will check.
      const topics = collection.startsWith('sys.')
        ? []
        : ((await catalog()).get(collection)?.definition.topics ?? []);
      if (topics.length) {
        const sealedWith = isSealedBody(payload) ? sealedKeyId(payload) : null;
        const key = tagKey(sealedWith);
        if (key) tags = await tagsFor(await key, collection, topics, body, links);
      }
    }

    // Whether superseded versions are kept is the writer's decision, carried
    // on the version — never each reader's, or nodes that had seen different
    // definitions would store different things and never converge. The access
    // history keeps everything: it is replayed whole. A first version under
    // `onePer` or `fixed` is kept whole, because those rules are checked against it.
    const definition = (await catalog()).get(collection)?.definition;
    const retain =
      ALWAYS_RETAINED.has(collection) ||
      definition?.history === 'all' ||
      (version.seq === 0 && !!(definition?.rules?.onePer || definition?.rules?.fixed)) ||
      // Every version under a contract: it reads the one before, and others cite it.
      (!deleted && hasContract(definition?.contract));

    // The next place in this key's line for the collection: given back if the version is refused below.
    const signed = await deps.writers.append(writer.did, space.id, collection, async (log) => {
      const { history, events: held } = await access();
      const seen = await seenFor(history, collection);
      // Checks in force as of the very point it names: a definition arriving meanwhile can't leave it unkept.
      const checkedThen = (() => {
        const then = history.at(seen);
        return then ? rulesAt(then, collection) : null;
      })();
      const then = await checkedThen;
      const keep = retain || (!deleted && hasContract(then?.contract));
      const made = await signer.sign(
        createVersion({
          author: writer.did,
          collection,
          space: space.id,
          body: payload,
          proof: writer.proof(),
          version,
          retain: keep,
          deleted,
          seen,
          // In the clear only where the body is: a private space sealed them above.
          ...(space.visibility === 'public' && !deleted && links.length ? { links } : {}),
          ...(tags.length ? { tags } : {}),
          ...(named.length ? { files: named } : {}),
          log,
        }),
        writer.key,
      );

      // The same verdict every other peer will reach: refused here, with the reason, rather than there.
      const judged = await judge(made);
      if (!judged.verified) throw new Error(judged.reason ?? 'This key may not write here.');
      if (ACCESS_COLLECTIONS.has(collection)) {
        const event = await toEvent(made);
        if (!event) throw new Error('That is not a well-formed change to who may do what');
        const status = (history.extend(event) ?? replayAccess(accessGenesis, [...held, event])).status(
          event.id,
        );
        if (status?.status !== 'applied')
          throw new Error(status?.status === 'dropped' ? status.reason : 'That change could not be made');
      } else {
        const stands = await standingOf(made);
        // Taken away by a change to its rules that came in after it saw the history: try again.
        if (!stands.ok && stands.withdrawn)
          throw Object.assign(new Error(stands.reason), { rulesMoved: true });
        if (!stands.ok) throw new Error(stands.reason);
        // Its checks, here, before anyone else sees it: peers would keep it, but no reader would count it.
        const passes = await checksOf(made);
        if ('pending' in passes) throw new Error('Versions it cites have not arrived yet');
        if ('unjudged' in passes) throw new Error(passes.unjudged);
        if (passes.passes === false) throw new Error(passes.reason);
      }
      return made;
    });
    await storage.addVersion(signed);
    await placeInLog(signed);
    await markPending(signed);
    channel?.postMessage('changed');
    sync.onLocalChange(signed);
    recordsChanged([signed]);
    return signed;
  }

  /**
   * How a record's newest version that stands fares under its checks: kept and
   * synced by every peer either way, counted by a reader only when it passes.
   */
  async function contractsFor(recordKey: string, versionId?: string): Promise<RecordContracts | null> {
    // A version named is judged even when the history leaves it out (a superseded delete, say).
    const named = versionId !== undefined ? await storage.getVersion(versionId) : null;
    const candidates =
      versionId === undefined ? await storage.history(recordKey) : named?.key === recordKey ? [named] : [];
    for (const version of candidates) {
      if (isStub(version)) continue;
      // One named whose first version hasn't arrived waits for it.
      if (!(await consistent(version))) {
        if (versionId !== undefined && version.seq > 0)
          return { version: version.id, passes: null, pending: true };
        continue;
      }
      const stands = await standingOf(version);
      // One named that waits for what it follows is pending, as a contract waiting on what it cites.
      if (!stands.ok && stands.later && versionId !== undefined)
        return { version: version.id, passes: null, pending: true };
      if (!stands.ok) continue;
      const verdict = await checksOf(version);
      if ('pending' in verdict) return { version: version.id, passes: null, pending: true };
      if ('unjudged' in verdict)
        return { version: version.id, passes: null, unjudged: true, reason: verdict.unjudged };
      return { version: version.id, ...verdict };
    }
    return null;
  }

  async function get<T>(recordKey: string): Promise<NodeRecord<T> | null> {
    const current = await currentOf(recordKey);
    return current && !current.deleted ? view<T>(current) : null;
  }

  /** The live current version of a record, or a clear error. */
  async function requireLive(recordKey: string): Promise<Version> {
    const current = await currentOf(recordKey);
    if (!current || current.deleted) throw new Error(`No record ${recordKey} in this space`);
    return current;
  }

  /**
   * The fields for writing a key again: the version after the one that counts.
   * Where the store's newest version fails its checks, after the newest that
   * counts, or afresh as a first version when none does: a version that fails
   * can't make others build on it, or claim a key (a `onePer` key) for good.
   * Otherwise after whatever the store holds, counted or not.
   */
  async function after(recordKey: string): Promise<VersionFields> {
    const held = await storage.getCurrent(recordKey);
    if (!held) return { key: recordKey, seq: 0 };
    const verdict = (await standingOf(held)).ok ? await checksOf(held) : NO_CHECKS;
    // One that fails its checks, or waits for ever on what it cites, can't hold the key.
    if ('passes' in verdict && verdict.passes !== false) return nextVersion(held);
    // Waiting only for its own step before: continue it, rather than fork this record.
    if ('pending' in verdict && held.prev && !(await storage.getVersion(held.prev))) return nextVersion(held);
    const counted = await currentOf(recordKey);
    return counted ? nextVersion(counted) : { key: recordKey, seq: 0 };
  }

  async function writeFirst<T>(
    collection: string,
    body: T,
    recordKey: string,
    links: ReadonlyArray<Link>,
    as?: ActiveSession,
  ): Promise<Version> {
    const current = await currentOf(recordKey);
    if (current && !current.deleted)
      throw new Error(`A record ${recordKey} already exists — update it instead`);
    // Writing a key that was deleted brings it back: the next version after the delete.
    return write(collection, body, await after(recordKey), false, links, as ? { as } : {});
  }

  async function upsert<T>(
    collection: string,
    recordKey: string,
    body: T,
    options: { joining?: boolean } = {},
  ): Promise<NodeRecord<T>> {
    return view<T>(await write(collection, body, await after(recordKey), false, [], options));
  }

  async function removeKey(recordKey: string, as?: ActiveSession): Promise<void> {
    const current = await requireLive(recordKey);
    await write(current.collection, null, await after(current.key), true, [], as ? { as } : {});
  }

  const guard = (collection: string) => {
    if (MANAGED.has(collection)) throw new Error(`${collection} is written by the node itself`);
  };

  // ─── Writers' logs ─────────────────────────────────────────────────
  //
  // A key's writes in each collection here form one line (02 §4.10). Each
  // place a key took is remembered by the version that took it, so a second
  // version at the same place is found the moment it arrives. And each
  // version is checked against the one it names as the place before — when it
  // arrives, or when that one does. Either way the proof goes to everyone else.

  // Named for this format of the log: the `log/`, `next/`, `clog/` and
  // `cnext/` a node kept before it map places to versions no peer holds any
  // more, so they are left unread rather than trusted.
  /** `place/<author>/<collection>/<n>` → the id of the version that took that place */
  const LOG_PREFIX = 'place/';
  /** Key DID → the account it writes for here */
  const KEY_ROOT_PREFIX = 'keyroot/';
  /** `follows/<id>` → the id of a version naming that one as the place before it */
  const NEXT_PREFIX = 'follows/';

  async function placeInLog(version: Version): Promise<void> {
    if (version.space !== space.id || !version.log) return;
    const { log } = version;
    // Which account each key writes for: what a cutoff is worked out from.
    const root = (await judge(version)).root;
    // Only an account a valid note names: a key whose note failed falls back to itself, and isn't anyone's.
    if (
      root &&
      (root !== version.author || !version.proof) &&
      !(await adapter.get(`${KEY_ROOT_PREFIX}${version.author}`))
    )
      await adapter.put(`${KEY_ROOT_PREFIX}${version.author}`, utf8Encode(root));
    // Its place: a second version there is a fork.
    const at = `${LOG_PREFIX}${version.author}/${version.collection}/${log.n}`;
    const held = await adapter.get(at);
    if (!held) await adapter.put(at, utf8Encode(version.id));
    else if (utf8Decode(held) !== version.id) {
      const first = await storage.getVersion(utf8Decode(held));
      if (first) void reportFork(first, version, version.author, version.collection, log.n).catch(() => {});
    }
    // The place before it, if held, must be its key's; and so must it be for whatever names it.
    if (log.prev) {
      await adapter.put(`${NEXT_PREFIX}${log.prev}`, utf8Encode(version.id));
      const previous = await storage.getVersion(log.prev);
      if (previous && breaksLine(version, previous))
        void reportFork(version, previous, version.author, version.collection, log.n).catch(() => {});
    }
    const naming = await adapter.get(`${NEXT_PREFIX}${version.id}`);
    const next = naming ? await storage.getVersion(utf8Decode(naming)) : null;
    if (next?.log && breaksLine(next, version))
      void reportFork(next, version, next.author, next.collection, next.log.n).catch(() => {});
    await noteGap(version);
  }

  /**
   * Hands every peer the proof that a key's line for a collection is not one
   * line — a fork or a break — unless a proof at or before this place stands
   * already. Any member may; one whose note doesn't let it change access
   * leaves it to one whose note does.
   */
  async function reportFork(
    a: Version,
    b: Version,
    writer: string,
    collection: string,
    from: number,
  ): Promise<void> {
    if (closed) return;
    const known = (await access()).history.forked(writer, collection);
    if (known && known.from <= from) return;
    if (
      !noteGrants(session.proof(), accessRequirement(space.id, FORK_COLLECTION, await forkKey(writer))) ||
      (await cannotWrite())
    )
      return;
    await upsert(FORK_COLLECTION, await forkKey(writer), forkProof(a, b));
  }

  /**
   * Runs a write once more when its collection's rules changed while it was
   * being made — it saw the history before the change, so the change takes
   * it away (03 §5.2) — this time under the new rules: a key they derive,
   * what they keep whole, all worked out again.
   */
  async function underCurrentRules<R>(run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (error) {
      if (!(isRecord(error) && error.rulesMoved === true)) throw error;
      return run();
    }
  }

  async function putOnce<T>(
    collection: string,
    body: T,
    options: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession },
  ): Promise<NodeRecord<T>> {
    guard(collection);
    if (options.key !== undefined && !RECORD_KEY_PATTERN.test(options.key)) {
      throw new Error('A record key is 1–128 characters of a–z, 0–9 and : . _ -');
    }
    const links = options.links ?? [];
    // One per something: the key is derived from it, so writing again is the next version of the same record.
    const onePer = (await catalog()).get(collection)?.definition.rules?.onePer;
    if (onePer && options.key === undefined) {
      const derived = await derivedKey(collection, onePer, { root: deps.rootDid, links, body });
      if (!derived)
        throw new Error(`${collection} is one per ${onePer.join(' + ')} — give it every one of those`);
      await keepsCollection(derived, collection);
      return view<T>(
        await write(
          collection,
          body,
          await after(derived),
          false,
          links,
          options.as ? { as: options.as } : {},
        ),
      );
    }
    const recordKey = await keyToWrite(collection, options.key, onePer);
    return view<T>(await writeFirst(collection, body, recordKey, links, options.as));
  }

  /**
   * Where a new record goes: a fresh key of this account's, or the key the
   * caller names. A name is put in this account's namespace (`profile` →
   * `<owner>.profile`); a key this account already owns is taken as it is.
   * Not a `one:` key outside a `onePer` collection, which every peer refuses
   * (02 §7.3), nor a key this node holds a record of another collection at.
   */
  async function keyToWrite(
    collection: string,
    chosen: string | undefined,
    onePer: ReadonlyArray<string> | undefined,
  ): Promise<string> {
    if (chosen === undefined) return newRecordKey(deps.rootDid);
    let recordKey: string;
    if (await ownsKey(chosen, deps.rootDid)) recordKey = chosen;
    else if (keyKind(chosen) === 'owned') throw new Error(`${chosen} belongs to another account`);
    else recordKey = keyKind(chosen) === 'shared' ? chosen : await ownedKey(deps.rootDid, chosen);
    if (onePerForm(recordKey) && !onePer)
      throw new Error(`${recordKey} is a onePer key, and ${collection} has no onePer`);
    await keepsCollection(recordKey, collection);
    return recordKey;
  }

  /**
   * Refuses a write at a key this node holds a record of another collection
   * at. Keys are unique in a space, and a record keeps its collection for
   * life (02 §4.1, §4.2), so the write could only be refused, or continue the
   * other record's chain.
   */
  async function keepsCollection(recordKey: string, collection: string): Promise<void> {
    const held = (await currentOf(recordKey)) ?? (await storage.getCurrent(recordKey));
    if (held && held.collection !== collection)
      throw new Error(
        `${recordKey} already holds a ${held.collection} record, and a key keeps its collection for life: ` +
          `choose a name that includes the collection`,
      );
  }

  // ─── Warrants (`node/space-warrants.ts`) ───────────────────────────

  const { warrantIfDue, flagged } = createSpaceWarrants({
    spaceId: space.id,
    rootDid: deps.rootDid,
    accessGenesis,
    storage,
    isClosed: () => closed,
    access,
    judge,
    standingOf,
    openBody,
    previousOf,
    buildEvent,
    rulesAt,
    needsOf,
    cannotWrite,
    upsert,
  });

  /** Display order: when a record was created, then its key. It decides nothing. */
  const createdAtOf = async (version: Version) => (await genesisOf(version))?.createdAt ?? version.createdAt;

  /**
   * Assigns a role to an account, or with `assigned: false` takes it away:
   * one's own, to leave it. Taking a role leaves what this node has seen
   * them write in it standing.
   */
  async function assign(did: string, role: string, assigned: boolean): Promise<NodeRecord<unknown>> {
    const { history } = await access();
    if (!history.current.roles.has(role)) throw new Error(`There is no role "${role}" in "${space.name}"`);
    const takes = !assigned && rolesOf(history.current, did).includes(role);
    const cutoff = takes ? await cutoffFor(did) : {};
    const body = withCutoff({ did, role, assigned }, cutoff);
    const written = await upsert(ASSIGN_COLLECTION, await assignKey(did, role), body);
    await changeKeyNow();
    return written;
  }

  /** Removes an account from the space, every role it holds with it: one's own, to leave */
  async function removeAccount(did: string): Promise<NodeRecord<unknown>> {
    const { history } = await access();
    if (!isMember(history.current, did)) throw new Error(`They hold no place in "${space.name}"`);
    const cutoff = await cutoffFor(did);
    const written = await upsert(REMOVE_COLLECTION, await removalKey(did), withCutoff({ did }, cutoff));
    await changeKeyNow();
    return written;
  }

  /** What this account is here, for listing: `founder`, a role it holds, or null */
  function placeOf(state: AccessState, did: string): string | null {
    if (state.founders.has(did)) return FOUNDER;
    return rolesOf(state, did)[0] ?? null;
  }

  /**
   * A change that took someone's place makes a new key due. The node that
   * made it changes the key before the call returns, not later in the
   * background: one that closes straight after a removal would otherwise
   * leave the removed member reading everything written since.
   */
  async function changeKeyNow(): Promise<void> {
    if (space.visibility === 'private' && (await access()).history.current.keyDue) await keepingUp();
  }

  /**
   * What a change taking power from an account leaves standing: for each of
   * its keys and each collection, the end of the unbroken line this node
   * holds of that key's versions in that collection, from its first place,
   * each naming the one before. A place held past a gap covers nothing, so
   * one planted far ahead can't cover what its writer signs after; and a node
   * holding some collections keeps their lines whole (05 §9), so it covers
   * all it holds.
   */
  async function cutoffFor(did: string, only?: string): Promise<Record<string, Record<string, number>>> {
    const cutoff: Record<string, Record<string, number>> = {};
    // At most what a change may carry: what is left out is judged with the change.
    for (const end of (await linesOf(did, only)).slice(0, MAX_CUTOFF))
      (cutoff[end.author] ??= {})[end.collection] = end.log!.n;
    return cutoff;
  }

  /**
   * The ends of an account's unbroken lines this node holds: defined
   * collections first, then the rest, each in name order.
   */
  async function linesOf(did: string, only?: string): Promise<Version[]> {
    // What it holds of theirs, whatever way it came: the lines' places are kept only for what arrived by sync.
    const placed = new Map<string, Map<number, Version>>();
    const add = (version: Version) => {
      if (!version.log) return;
      const line = `${version.author} ${version.collection}`;
      const held = placed.get(line) ?? new Map<number, Version>();
      if (!held.has(version.log.n)) held.set(version.log.n, version);
      placed.set(line, held);
    };
    for (const version of await everyCurrent()) {
      if (!version.log || (only && version.author !== only) || version.space !== space.id) continue;
      if ((await judge(version)).root === did) add(version);
    }
    for (const name of await adapter.list(KEY_ROOT_PREFIX)) {
      const key = name.slice(KEY_ROOT_PREFIX.length);
      if ((only && key !== only) || utf8Decode((await adapter.get(name)) ?? new Uint8Array()) !== did)
        continue;
      for (const place of await adapter.list(`${LOG_PREFIX}${key}/`)) {
        const id = await adapter.get(place);
        const version = id ? await storage.getVersion(utf8Decode(id)) : null;
        if (version?.author === key) add(version);
      }
    }
    const ends: Version[] = [];
    for (const held of placed.values()) {
      let end: Version | null = null;
      for (let n = 0; ; n++) {
        const version = held.get(n);
        if (!version || (n > 0 && version.log?.prev !== end?.id)) break;
        end = version;
      }
      if (end) ends.push(end);
    }
    // Defined collections first: writing into many undefined ones costs only whoever did.
    const defined = new Set((await catalog()).keys());
    return ends.sort(
      (a, b) =>
        Number(defined.has(b.collection)) - Number(defined.has(a.collection)) ||
        byCodeUnit(a.collection, b.collection) ||
        byCodeUnit(a.author, b.author),
    );
  }

  /** Whether this account holds a grant, now, to do something to a record */
  async function mayNow(
    collection: string,
    action: 'create' | 'edit' | 'delete',
    first: Version | null,
  ): Promise<boolean> {
    const { history } = await access();
    const state = history.current;
    if (!isMember(state, deps.rootDid)) return false;
    if (collection.startsWith('sys.')) return true;
    const found = await rulesAt(state, collection);
    if (!found && state.contested.has(collection)) return false;
    if (found?.rules.final && action !== 'create') return false;
    const byCreator = action === 'create' || (!!first && (await judge(first)).root === deps.rootDid);
    // The body isn't known yet: a policy on it is decided when the version is written.
    return may(
      state,
      deps.rootDid,
      action === 'delete' ? RECORD_DELETE : RECORD_WRITE,
      { collection, byCreator },
      {
        opaque: action !== 'delete',
      },
    );
  }

  // Once at open, then after every change.
  keepUp();
  const pulling = pullMirrors();
  // What this device holds and the folder lacks (copied in, or written before the folder was) goes out soon.
  folderMirror?.changed();

  return Object.freeze({
    async list<T>(options: ListOptions = {}): Promise<ReadonlyArray<NodeRecord<T>>> {
      if (options.collection) use([options.collection]);
      const shown: Counted[] = [];
      for (const entry of (await counted()).values()) {
        const { collection, deleted } = entry.version;
        if (options.collection ? collection !== options.collection : collection.startsWith('sys.')) continue;
        if (deleted && !options.includeDeleted) continue;
        shown.push(entry);
      }
      shown.sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.version.key.localeCompare(b.version.key),
      );
      if (options.newestFirst) shown.reverse();
      const page = options.limit === undefined ? shown : shown.slice(0, options.limit);
      const shownOf = (entry: Counted) =>
        (entry.shown ??= view(entry.version).catch((error: unknown) => {
          entry.shown = undefined;
          throw error;
        }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the caller's type for the body, as in view
      return Promise.all(page.map((entry) => shownOf(entry) as Promise<NodeRecord<T>>));
    },

    get,
    contracts: contractsFor,

    /** The note a record's current version was signed under; null when its account signed it itself */
    noteOf: async (recordKey: string): Promise<Delegation | null> =>
      (await currentOf(recordKey))?.proof ?? null,

    async put<T>(
      collection: string,
      body: T,
      options: { key?: string; links?: ReadonlyArray<Link>; as?: ActiveSession } = {},
    ): Promise<NodeRecord<T>> {
      return underCurrentRules(() => putOnce(collection, body, options));
    },

    /** The key `name` has in an account's namespace: this account's, unless another is named */
    keyFor: (name: string, account: string = deps.rootDid): Promise<string> => ownedKey(account, name),

    /**
     * The key a record with this body and these links has under its
     * collection's `onePer`, written by `account` (default this one): null
     * when the collection has none, or the body lacks a part it names.
     */
    async onePerKey(
      collection: string,
      body: unknown,
      options: { links?: ReadonlyArray<Link>; account?: string; onePer?: ReadonlyArray<string> } = {},
    ): Promise<string | null> {
      const onePer = options.onePer ?? (await catalog()).get(collection)?.definition.rules?.onePer;
      if (!onePer) return null;
      return derivedKey(collection, onePer, {
        root: options.account ?? deps.rootDid,
        links: options.links ?? [],
        body,
      });
    },

    async can(action: 'create' | 'edit' | 'delete', target: string): Promise<boolean> {
      if (action === 'create') return mayNow(target, 'create', null);
      const current = await currentOf(target);
      if (!current || current.deleted) return false;
      return mayNow(current.collection, action, await genesisOf(current));
    },

    /** Seals a file, keeps it, and gives back the reference a body names it by (spec 05 §16.6) */
    addFile: (bytes: Uint8Array): Promise<SealedFile> => (spaceFiles ?? missingFiles()).add(bytes),
    /** The bytes of a file a body refers to: held here, or fetched from peers or mirrors */
    readFile: (ref: SealedFile): Promise<Uint8Array> => (spaceFiles ?? missingFiles()).open(ref),

    /** For the node itself: writes the next version of a record in a collection `put` refuses, like the profile */
    upsertSystem: <T>(collection: string, recordKey: string, body: T) =>
      upsert<T>(collection, recordKey, body),

    async profiles() {
      return [...(await profileMap()).values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did),
      );
    },

    /** For the node itself: says who this account is here, when that changed and the space takes its writes */
    async publishProfile(profile: { name: string; contactKey?: string; avatar?: AvatarRef }) {
      // Someone following a space without a role in it cannot write there, and says nothing; nor does an app.
      if (!actsForAccount(session.proof()) || (await cannotWrite())) return;
      const name = profile.name.trim().slice(0, 64);
      const mine = (await profileMap()).get(deps.rootDid);
      // An app without the contact key must not take away the one another device published.
      const contactKey = profile.contactKey ?? mine?.contactKey;
      if (
        !name ||
        (mine?.name === name && mine.contactKey === contactKey && mine.avatar?.hash === profile.avatar?.hash)
      )
        return;
      await upsert(PROFILE_COLLECTION, await profileKey(deps.rootDid), {
        name,
        ...(contactKey ? { contactKey } : {}),
        ...(profile.avatar ? { avatar: profile.avatar } : {}),
      });
    },

    rotateKey,

    memberKeys: memberKeyMap,

    ownMemberKey: () => memberPair,

    readAccess: () => readAccess,

    async setRelays(named: ReadonlyArray<string>) {
      const problem = checkRelays(named);
      if (problem) throw new Error(problem);
      await upsert(RELAYS_COLLECTION, SPACE_RELAYS_RECORD, { relays: [...named] });
    },

    async topicTag(collection: string, field: string, value: string | number | boolean) {
      let keyId: string | null = null;
      if (space.visibility === 'private') {
        const key = currentKey((await access()).history.current);
        if (!key) throw new Error(`This device doesn't hold the current key of "${space.name}" yet`);
        keyId = key.id;
      }
      return topicTag(await tagKey(keyId)!, collection, field, value);
    },

    async setKeepers(keepers: ReadonlyArray<Keeper>, copies: number | null = null) {
      const named = keepers.map((k) => ({ did: k.did, name: k.name }));
      const problem = checkKeepers(named, copies);
      if (problem) throw new Error(problem);
      await upsert(KEEPERS_COLLECTION, SPACE_KEEPERS_RECORD, { keepers: named, copies });
    },

    async update<T>(
      recordKey: string,
      body: T,
      options: { links?: ReadonlyArray<Link>; as?: ActiveSession } = {},
    ): Promise<NodeRecord<T>> {
      return underCurrentRules(async () => {
        const current = await requireLive(recordKey);
        guard(current.collection);
        // Links carry over unless replaced: ticking a todo should not unhook it from anything.
        const links = options.links ?? (await openBody(current)).links;
        return view<T>(
          await write(
            current.collection,
            body,
            await after(recordKey),
            false,
            links,
            options.as ? { as: options.as } : {},
          ),
        );
      });
    },

    async linked<T>(
      recordKey: string,
      options: { rel?: string; collection?: string } = {},
    ): Promise<ReadonlyArray<NodeRecord<T>>> {
      if (options.collection) use([options.collection]);
      const pointing = (await linkIndex()).get(recordKey) ?? [];
      const keys = [
        ...new Set(pointing.filter((p) => !options.rel || p.rel === options.rel).map((p) => p.from)),
      ];
      const found: NodeRecord<T>[] = [];
      for (const from of keys) {
        const current = await currentOf(from);
        if (!current || current.deleted) continue;
        if (options.collection && current.collection !== options.collection) continue;
        found.push(await view<T>(current));
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },

    async remove(recordKey: string, options: { as?: ActiveSession } = {}): Promise<void> {
      guard((await requireLive(recordKey)).collection);
      await underCurrentRules(() => removeKey(recordKey, options.as));
    },

    /** For the node itself: deletes a record in a managed collection */
    removeSystem: removeKey,

    async history<T>(recordKey: string): Promise<ReadonlyArray<NodeRecord<T>>> {
      // What a superseded version said is forgotten unless its writer retained it.
      const versions = (await storage.history(recordKey)).filter((version) => !isStub(version));
      return Promise.all(versions.map((version) => view<T>(version)));
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
      const described = await catalog();
      const names = [...new Set([...described.keys(), ...counts.keys()])].sort();
      return names.map((name) => describe(name, described.get(name) ?? null, counts.get(name) ?? 0));
    },

    async define(input: DefineCollection): Promise<NodeCollection> {
      const recordKey = `collection:${input.name}`;
      const current = (await catalog()).get(input.name) ?? null;
      // Peers don't order definitions by version (spec 02 §6.3): a stored one past what can be
      // counted on, written to lock the collection, is simply followed by 1 again.
      const after =
        current && Number.isSafeInteger(current.definition.version + 1) ? current.definition.version : 0;
      const version = input.version ?? after + 1;
      const described = await catalog();
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
      const entry = (await catalog()).get(input.name) ?? null;
      const count = (await everyCurrent(input.name)).filter((e) => !e.deleted).length;
      return describe(input.name, entry, count);
    },

    async undefine(name: string): Promise<void> {
      if (!(await catalog()).has(name)) throw new Error(`${name} is not defined in this space`);
      // Records left behind would lose their shape and their rules, so they go first.
      const left = (await everyCurrent(name)).filter((e) => !e.deleted).length;
      if (left)
        throw new Error(`${name} still has ${left} record${left === 1 ? '' : 's'}; delete them first`);
      await removeKey(`collection:${name}`);
    },

    async access(): Promise<SpaceAccess> {
      const { history } = await access();
      const state = history.current;
      const members = [...readers(state)].sort();
      return Object.freeze({
        roles: [...state.roles]
          .map(([name, definitions]) => ({
            name,
            ...(definitions[0]?.title !== undefined ? { title: definitions[0].title } : {}),
            definitions: definitions.map((definition) => ({
              event: definition.event,
              by: definition.by,
              grants: definition.grants,
              nests: definition.nests,
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        members: members.map((did) => ({
          did,
          founder: state.founders.has(did),
          roles: rolesOf(state, did),
        })),
        invites: [...state.invites].map(([inviteDid, invite]) => ({
          key: inviteDid,
          role: invite.role,
          open: invite.open,
        })),
        founder: state.founders.has(deps.rootDid),
        top: space.top === 'none' ? 'none' : 'founders',
        headless: headless(state),
        successors: [...state.successors].map(([successor, by]) => ({ space: successor, by })),
        mine: rolesOf(state, deps.rootDid),
        heads: history.heads(),
        key: state.keys.length ? { changes: state.keys.length - 1, held: currentKey(state) !== null } : null,
        relays: state.relays.length ? state.relays : relays,
        keepers: state.keepers,
        copies: state.copies,
        forks: history.forks(),
        flagged: await flagged(),
      });
    },

    /** Whether this account, or another, may invoke a command with these arguments, now */
    async may(
      cmd: string,
      args: Readonly<Record<string, unknown>> = {},
      account: string = deps.rootDid,
    ): Promise<boolean> {
      return may((await access()).history.current, account, cmd, args);
    },

    /** Whether this account, or another, holds every grant a role gives, as wide or wider, now */
    async holdsRole(role: string, account: string = deps.rootDid): Promise<boolean> {
      return holdsRole((await access()).history.current, account, role);
    },

    async assign(did: string, role: string) {
      await assign(did, role, true);
    },

    async unassign(did: string, role: string) {
      await assign(did, role, false);
    },

    async removeMember(did: string) {
      await removeAccount(did);
    },

    /** Stops being a founder, keeping the roles held, and `keep` first when given */
    async stepDown(keep?: string) {
      const { history } = await access();
      if (!history.current.founders.has(deps.rootDid))
        throw new Error(`You are not a founder of "${space.name}"`);
      if (keep !== undefined && !rolesOf(history.current, deps.rootDid).includes(keep))
        await assign(deps.rootDid, keep, true);
      if (rolesOf((await access()).history.current, deps.rootDid).length === 0)
        throw new Error(
          `You hold no role in "${space.name}", so stepping down would leave it: keep a role, or leave`,
        );
      const cutoff = await cutoffFor(deps.rootDid);
      const body = withCutoff({ did: deps.rootDid }, cutoff);
      await upsert(STEPDOWN_COLLECTION, await stepDownKey(deps.rootDid), body);
    },

    /** Names a space that succeeds this one. It changes nothing here */
    async succeed(successor: string) {
      if (!isSpaceId(successor) || successor === space.id)
        throw new Error('A successor is named by its space id');
      // Refused here, with the reason, when this account may not: as every peer would.
      await upsert(SUCCEED_COLLECTION, await succeedKey(successor), { space: successor });
    },

    /**
     * Gives up this account's place before it forgets the space: its own
     * member record with no role, so the others stop counting it a reader and
     * a key change becomes due. Nothing sends the removal once the space is
     * closed, so this waits up to `waitMs` for a peer of another account to
     * say it has it. False when it couldn't be written, or nobody took it in
     * time.
     */
    async giveUpPlace(waitMs: number): Promise<boolean> {
      const state = (await access()).history.current;
      // Shared to view, or already gone: there is nothing to remove.
      if (!isMember(state, deps.rootDid)) return true;
      // Nobody else holds a place, so nobody else needs to know.
      if ([...readers(state)].every((did) => did === deps.rootDid)) return true;
      try {
        return await peers.writeUntilStored(async () => (await removeAccount(deps.rootDid)).version, {
          waitMs,
          othersOnly: true,
          reachable: true,
        });
      } catch {
        // A note that may not change access; another of the account's devices can.
        return false;
      }
    },

    /**
     * Waits up to `waitMs` for this node to be level with `peer` here: nothing
     * left in flight either way, so the peer holds everything this node does.
     * False when that long passed first.
     */
    syncedWith(peer: string, waitMs: number): Promise<boolean> {
      if (sync.levelWith(peer)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (level: boolean) => {
          clearTimeout(timer);
          sync.off('synced', onSynced);
          resolve(level);
        };
        const onSynced = (from: string) => {
          if (from === peer) done(true);
        };
        const timer = setTimeout(() => done(false), waitMs);
        sync.on('synced', onSynced);
        // Behind, it would start catching up only at the next heartbeat.
        sync.notifyPeers([peer]);
      });
    },

    /** Writes a role's definition: its grants, issued by this account, and the roles it nests */
    async defineRole(role: FoundingRole) {
      const problem = checkFoundingRole(role);
      if (problem) throw new Error(problem);
      const nonce = () => base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(12)));
      await upsert(
        ROLE_COLLECTION,
        roleKey(role.name),
        definitionBody(role, { root: deps.rootDid, spaceId: space.id }, nonce),
      );
    },

    /** Opens an invite to a role, with its own fresh secret unless a short link's gives it one */
    async openInvite(role: string, secret: Uint8Array = generateInviteSecret()) {
      const pair = await deriveInviteKey(secret, provider);
      await upsert(INVITE_COLLECTION, await inviteRecordKey(pair.did), { key: pair.did, role, open: true });
      return { secret, key: pair.did };
    },

    async closeInvite(inviteDid: string) {
      const { history } = await access();
      const invite = history.current.invites.get(inviteDid);
      if (!invite) throw new Error('There is no such invite in this space');
      // Who joined with it before this node closed it stays: the close names what it saw, and the replay does the rest.
      await upsert(INVITE_COLLECTION, await inviteRecordKey(inviteDid), {
        key: inviteDid,
        role: invite.role,
        open: false,
      });
    },

    /**
     * Revokes a key of this account's. With `waitMs`, it then waits up to that
     * long for a peer to say it has the revoke: a device about to stop sends
     * nothing after, so true means it left. A node with no network configured
     * can't send it anywhere, so false at once. Without, true once written.
     */
    async revoke(key: string, options: { readonly waitMs?: number } = {}): Promise<boolean> {
      const waitMs = options.waitMs ?? 0;
      const write = async () => {
        const cutoff = await cutoffFor(deps.rootDid, key);
        const body = withCutoff({ key }, cutoff);
        return (await upsert(REVOKE_COLLECTION, await revokeKey(key, deps.rootDid), body)).version;
      };
      if (waitMs <= 0) {
        await write();
        return true;
      }
      // With a network configured a peer may still be on its way, through a socket not yet
      // joined or a host not yet reached; with none, nobody can come.
      return peers.writeUntilStored(write, { waitMs, othersOnly: false, reachable: !!net });
    },

    async isRevoked(key: string) {
      return (await access()).history.revoked(key, deps.rootDid).length > 0;
    },

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
      announceSoon();
      return placed.length;
    },

    /** Uses an invite's secret, once its record has arrived. True when this account is a member. */
    async join(secret: Uint8Array) {
      const { history } = await access();
      const pair = await deriveInviteKey(secret, provider);
      const invite = history.current.invites.get(pair.did);
      if (
        isMember(history.current, deps.rootDid) &&
        (!invite || rolesOf(history.current, deps.rootDid).includes(invite.role))
      ) {
        waitingInvite = false;
        deps.onJoined?.();
        return true;
      }
      if (!invite?.open) return false;
      await upsert(
        ASSIGN_COLLECTION,
        await assignKey(deps.rootDid, invite.role),
        {
          did: deps.rootDid,
          role: invite.role,
          assigned: true,
          invite: { key: pair.did, signature: await signInvite(space.id, deps.rootDid, pair, provider) },
        },
        { joining: true },
      );
      waitingInvite = false;
      deps.onJoined?.();
      return true;
    },

    async status() {
      return {
        space: space.id,
        connection: liveConnection(),
        peers: connectedPeers(),
        accounts: peers.accounts(),
        fingerprint: await storage.fingerprint(),
        rejected,
        holds: holding.held(),
        pending: await holding.pending(),
      };
    },

    use,

    send: peers.send,

    /**
     * Always-on nodes to hold a socket to besides those configured: the hosts
     * the account or the space uses. Sockets to any given before and not now
     * are closed.
     */
    useNodes(nodes: ReadonlyArray<string>) {
      if (!net || closed) return;
      const configured = new Set(net.nodes ?? []);
      const wanted = new Set(nodes.filter((node) => !configured.has(node)));
      for (const [node, network] of hostNetworks) {
        if (wanted.has(node)) continue;
        hostNetworks.delete(node);
        networks.splice(networks.indexOf(network), 1);
        network.disconnect();
      }
      for (const node of wanted) {
        if (hostNetworks.has(node)) continue;
        const network = nodeNetwork(node);
        hostNetworks.set(node, network);
        networks.push(network);
        listen(network);
        if (connection === 'offline') connection = 'connecting';
        sync.start();
        void network.connect().then(
          () => {
            connection = 'connected';
            statusChanged();
          },
          () => statusChanged(),
        );
      }
    },

    async close(): Promise<void> {
      closed = true;
      stopWatchingMesh?.();
      await holding.close();
      await keepingUp.done();
      await pulling;
      await Promise.all(mirrors.map((mirror) => mirror.close()));
      if (filesTimer) clearTimeout(filesTimer);
      spaceFiles?.close();
      await filesPass;
      if (watchTimer) clearInterval(watchTimer);
      if (announceTimer) clearTimeout(announceTimer);
      channel?.close();
      sync.stop();
      for (const network of networks) network.disconnect();
      await storage.close();
    },
  });
}
