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
import { contactKeyPair, isContactPublicKey } from '../identity/contact-key.js';
import { openValueFrom, sealValueTo } from '../identity/hpke.js';
import { openValue, sealValue } from '../identity/envelope.js';
import type { Version, CryptoProvider, StorageAdapter } from '../types.js';
import type { Signer } from '../schema/signer.js';
import type { SchemaEngine } from '../schema/schema-engine.js';
import type { SpaceRecord } from '../space/space-manager.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import {
  ACCESS_COMMAND,
  accessRequirement,
  accountSpaceRequirement,
  DEFINE_COMMAND,
  noteGrants,
  writeRequirement,
  writesRecords,
} from '../identity/abilities.js';
import {
  bodyProblem,
  canonicalize,
  createVersion,
  getVersionId,
  isStub,
  signedPart,
  stubOf,
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
import type { Link } from '../types.js';
import { reconcileFolder } from '../storage/folder-reconcile.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createMirror, type Mirror, type Taken } from '../storage/mirror.js';
import type { FolderAdapter } from '../storage/folder-adapter.js';
import { createVersionCheck } from '../validation/check-version.js';
import type { Writers } from './writers.js';
import { breaksLine, checkFork, forkProof } from '../records/fork.js';
import { knownKind, readWarrant, type Warrant, type WarrantKind } from '../records/warrant.js';
import {
  EARLIER_KEYS_LABEL,
  generateSpaceKey,
  isSealedBody,
  MEMBERSHIP_LABEL,
  openBody as openSealedBody,
  sealBody,
  spaceKeyFromRaw,
  type SpaceKey,
} from '../privacy/space-encryption.js';
import { createNetworkManager, type NetworkManager } from '../network/network-manager.js';
import { createMesh, type Mesh } from '../network/mesh.js';
import { createWebSocketTransport } from '../network/ws-transport.js';
import {
  createClientAuth,
  createMeshAuth,
  MAX_EARLIER_READ_KEYS,
  type ReadAccess,
} from '../network/peer-auth.js';
import {
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  SPACE_KEY_RECORD,
  SPACE_RELAYS_RECORD,
  SPACE_KEEPERS_RECORD,
  memberKeyRecordKey,
  BOX_LABEL,
  boxBound,
  boxKey,
  deriveInviteKey,
  deriveReadKey,
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
  refusal,
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
  KEY_CHANGE,
  readDefinition,
  RECORD_DELETE,
  RECORD_WRITE,
  SPACE_RELAYS,
  type FoundingRole,
} from '../space/grants.js';
import { FOUNDER } from '../space/space-manager.js';
import { createSyncEngine, type Holds } from '../sync/sync-engine.js';
import { SYNC_PROTOCOL_VERSION } from '../sync/sync-messages.js';
import { createSpaceFiles, type SealedFile, type SpaceFiles } from '../files/space-files.js';
import { fileRefsIn, MAX_FILES } from '../files/file-id.js';
import type { NetworkMessage, PeerInfo } from '../types.js';
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
import { base32Encode, cidOfDigest, hashedKey, sha256 } from '../utils/hash.js';
import { sameTags, tagsFor, topicKey, topicTag } from '../records/topics.js';
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord, unref } from '../utils/guards.js';
import { serial } from '../utils/serial.js';
import { CLOSE_DID_TAKEN } from '../network/signaling.js';
import type {
  CacheConfig,
  ConnectionState,
  DefineCollection,
  NodeCollection,
  ListOptions,
  NodeEvent,
  NodeNetworkConfig,
  NodeRecord,
  FlaggedAccount,
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
 * Access records a peer without the space key must still be able to judge:
 * who holds which role decides every write. Kept in the clear, even in a
 * private space. Collection definitions stay sealed — a peer that cannot
 * read the records has no use for their rules.
 */
const IN_THE_CLEAR = new Set([
  ROLE_COLLECTION,
  ASSIGN_COLLECTION,
  REMOVE_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  KEY_COLLECTION,
  BOX_COLLECTION,
  MEMBER_KEY_COLLECTION,
  RELAYS_COLLECTION,
  KEEPERS_COLLECTION,
  FORK_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
]);

/** Which collection each access record key belongs to */
const ACCESS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['role:', ROLE_COLLECTION],
  ['assign:', ASSIGN_COLLECTION],
  ['remove:', REMOVE_COLLECTION],
  ['invite:', INVITE_COLLECTION],
  ['revoke:', REVOKE_COLLECTION],
  ['collection:', DEFINITION_COLLECTION],
  ['key:', KEY_COLLECTION],
  ['relays:', RELAYS_COLLECTION],
  ['keepers:', KEEPERS_COLLECTION],
  ['fork:', FORK_COLLECTION],
  ['stepdown:', STEPDOWN_COLLECTION],
  ['succeed:', SUCCEED_COLLECTION],
];

/** How many keys a cutoff may name */
const MAX_CUTOFF = 1024;

/** A change that takes nothing away covers nothing */
const NO_CUTOFF: Cutoff = new Map();

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

/** Freezes a value and everything inside it, in place */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

/** Decrypted bodies kept in memory per space, the oldest let go first */
const MAX_OPENED = 100_000;
/** Line heads whose `once` claims are kept: each set holds its whole chain's, so fewer */
const MAX_ONCE_CLAIMED = 1024;

/**
 * The key of a person's profile record in a space: one per identity, named by
 * a hash of it (record keys are lower case; a did:key is not).
 */
export async function profileKey(did: string): Promise<string> {
  return hashedKey('profile', did);
}

/**
 * The room a space's peers meet in on a relay. A hash of the space's id, so a
 * relay learns which connections belong together but not which space they are
 * — it cannot match the room to an invite, or to the same space elsewhere.
 */
export async function relayRoom(spaceId: string): Promise<string> {
  return base32Encode((await sha256(new TextEncoder().encode(`minca-room/v1|${spaceId}`))).subarray(0, 20));
}

/** The one mesh a node's spaces share, when it has relays to meet on */
export function meshFor(network: NodeNetworkConfig | undefined, did: string): Mesh | undefined {
  if (!network?.relays?.length) return undefined;
  return createMesh({
    did,
    relays: network.relays,
    ...(network.iceServers ? { iceServers: network.iceServers } : {}),
    ...(network.createTransport ? { createTransport: network.createTransport } : {}),
  });
}

/** The relays a node was configured with that a space may name */
export const usableRelays = (network: NodeNetworkConfig | undefined) =>
  (network?.relays ?? []).filter((url) => checkRelays([url]) === null);

/**
 * Whether a proof would let its key do anything in a space beyond writing
 * records: define a collection there, or change who may do what. For what a
 * node offers and shows; a version's own needs are judged on its own.
 */
const grantsBeyondRecords = (proof: unknown, spaceId: string, cmd: string) =>
  noteGrants(proof, { space: spaceId, cmd, args: { space: spaceId } });

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
  /**
   * File stores the space is also kept in (`storage/mirror.ts`): a bucket, an
   * app folder. Read when the space opens, written soon after every change.
   */
  readonly mirrors?: ReadonlyArray<BlobStore>;
  /**
   * Only notes that grant `account/write` count here — for the account's own
   * spaces (its list of spaces, a carrier's passes), where a note for "every
   * space" would otherwise let a key it trusts less join the account to a
   * space or leave one.
   */
  readonly accountOnly?: boolean;
  /** Hold only the collections used, once the space names a keeper (`NodeConfig.cache`). Absent: hold it whole. */
  readonly cache?: CacheConfig;
  /** Told of every version a peer sent that was taken in — what a carrier matches subscriptions against */
  readonly onArrived?: (version: Version) => void;
  /** Fetch every file the space's records name, as a keeper does, rather than only those read (spec 05 §16.6) */
  readonly fetchFiles?: 'all';
}

/** One open space, as `openSpaceRuntime` gives it */
export type SpaceRuntime = Awaited<ReturnType<typeof openSpaceRuntime>>;

/** Which account a connected peer showed it acts for */
interface PeerAccount {
  readonly account: string | null;
  /** Its note grants writing records here and nothing more (`/record`): it can't define collections in this space */
  readonly recordsOnly: boolean;
}
const NO_ACCOUNT: PeerAccount = Object.freeze({ account: null, recordsOnly: false });
/** How long a peer checked here has to become a peer before the check is forgotten: past any handshake's timeout */
const STALE_ADMISSION_MS = 60_000;
/** How long a removed member's socket stays open after nothing more is sent on it, for frames already on their way */
const LET_GO_AFTER_MS = 1000;
/** How long a peer let in on an older key has to show its account before it counts as nobody's */
const WHO_WAIT_MS = 10_000;

/** A peer's note, sent once when it connects (see "Live messages") */
const WHO_MESSAGE = 'who';
/** A live message: `spaces.send` */
const LIVE_MESSAGE = 'live';
const MAX_LIVE_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 16 * 1024;
/** Live messages a peer may send at once, and per second after that */
const LIVE_BURST = 60;
const LIVE_PER_SECOND = 20;

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
      /**
       * A stub whose grant reads the body it doesn't carry, at a node that reads
       * the space: kept, as its record's history, and judged once it is whole.
       */
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
/** How a version fares under its collection's contract, as this node reads them */
import type { RecordContracts } from './types.js';
import { checkComputed, checkComputedTypes, usableComputed, type ComputedFields } from '../query/computed.js';
import { storedComputed, storedContract } from '../records/contract-builder.js';
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
/** Records waiting on a cited version that are read again whenever anything arrives */
const MAX_PENDING_REREAD = 256;
/** Checks this node can't judge yet: what they read can't be opened here. Never cached. */
const UNJUDGED: ChecksVerdict = Object.freeze({
  passes: null,
  unjudged: 'Something it reads is sealed with a key this node doesn’t hold',
});

const storable = (standing: Standing): boolean => standing.ok || !!standing.withdrawn;

/**
 * What the caches of verdicts on a version are keyed by: its id and signature,
 * which a stub shares with the whole version, and which of the two it is. A
 * verdict on a stub, judged without its body, never stands for the whole.
 */
const copyKey = (version: Version) =>
  `${version.id}|${version.signature}|${isStub(version) ? 'stub' : 'whole'}`;

const looksEncrypted = isSealedBody;

/** The key a sealed body names, as the keyring is looked up by */
function sealedKeyId(body: unknown): string {
  return String(isRecord(body) ? body.keyId : undefined);
}

function isFolderAdapter(adapter: StorageAdapter): adapter is FolderAdapter {
  return 'reload' in adapter && typeof adapter.reload === 'function';
}

const isLinks = (links: unknown): links is ReadonlyArray<Link> => checkLinks(links) === null;
const isLine = (line: unknown): line is Line => checkLine(line) === null;
const areKeepers = (keepers: unknown): keepers is Keeper[] => checkKeepers(keepers) === null;

function isPending(value: unknown): value is Pending {
  return isRecord(value) && typeof value.collection === 'string' && isStringList(value.by);
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

// ─── What a node holding part of a space remembers ──────────────────

/** Where it is kept in the space's store */
const CACHE_KEY = 'cache';
/** One entry per write of this node's still waiting for keepers: `pending/<id>` */
const PENDING_PREFIX = 'pending/';

interface CacheState {
  /**
   * Whether this node has caught up with a node holding the whole space at
   * least once — until then it can't know whether the space names keepers,
   * so it holds only what it uses rather than everything.
   */
  settled: boolean;
  /** Collection → when a query last used it: what this node holds */
  used: Record<string, number>;
  /** Collection → when it was first level with a node holding the whole space */
  level: Record<string, number>;
  /**
   * Collection → versions some writer's line there names as the one before,
   * that this node doesn't hold: until they arrive, it knows it lacks them
   * (02 §4.10). A collection is complete when it has been level with a node
   * holding everything and lacks nothing a line names.
   */
  missing: Record<string, string[]>;
}

/** A write waiting for keepers: its collection, and the keepers that have it */
interface Pending {
  readonly collection: string;
  readonly by: string[];
}

async function loadCacheState(adapter: StorageAdapter): Promise<CacheState> {
  try {
    const bytes = await adapter.get(CACHE_KEY);
    const parsed: unknown = bytes ? JSON.parse(utf8Decode(bytes)) : null;
    const saved = isRecord(parsed) ? parsed : {};
    const numbers = (value: unknown): Record<string, number> =>
      Object.fromEntries(
        Object.entries(typeof value === 'object' && value !== null ? value : {}).filter(
          ([, v]) => typeof v === 'number',
        ),
      );
    const lists = (value: unknown): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(isRecord(value) ? value : {}).flatMap(([name, ids]) =>
          Array.isArray(ids) ? [[name, ids.filter((id): id is string => typeof id === 'string')]] : [],
        ),
      );
    return {
      settled: saved.settled === true,
      used: numbers(saved.used),
      level: numbers(saved.level),
      missing: lists(saved.missing),
    };
  } catch {
    return { settled: false, used: {}, level: {}, missing: {} };
  }
}

export async function openSpaceRuntime(deps: SpaceRuntimeDeps) {
  const { record, provider, signer, schemas, session, emit } = deps;
  const { space } = record;
  let closed = false;

  /**
   * Every key of the space this node holds, by id. Encrypted bodies name the
   * key they were sealed with; the history names which one is current.
   */
  const keyring = new Map<string, SpaceKey>();
  for (const held of record.keys ?? []) keyring.set(held.id, held);
  if (record.key) keyring.set(record.key.id, record.key);
  /** This account's member key here, which new keys are sealed to */
  const memberPair = deps.memberKey ? await contactKeyPair(deps.memberKey) : null;
  /** An invite waiting to be used — forgotten here once it is, whatever the stored record still says */
  let waitingInvite = record.invite !== null;

  const adapter = await deps.stores(`spaces/${space.id}`);
  const storage: StorageProvider = createStorageProvider(adapter);

  // What this node holds of the space (see "Holding part of the space" below).
  // Here, before anything can ask: sync asks on every hello.
  const cache = deps.cache ?? null;
  const cacheState = await loadCacheState(adapter);
  // The collections the app declared are held from the start.
  for (const collection of cache?.collections ?? [])
    if (!collection.startsWith('sys.')) cacheState.used[collection] ??= Date.now();
  // A node that may hold part of the space starts by holding only what it
  // uses: whether the space names keepers is only known once it has caught up.
  let partial = cache !== null;
  const holds = (): Holds => (partial ? new Set(Object.keys(cacheState.used)) : 'all');

  // Body shape is checked when a record is written here, and reported as
  // `conforms` when it is read. The note behind a key must cover this space;
  // whether its account may write here is the access history's question, asked below.
  // Judged for this space, whatever space a version claims: standing refuses a claim of another.
  const checkVersion = createVersionCheck({
    provider,
    required: (version) => writeRequirement(space.id, version.collection),
  });

  // A signature never changes, so a verdict on one holds forever. Keyed on the
  // id *and* the signature: the id does not cover it, so a copy with a broken
  // signature shares the genuine one's id. Only passes are kept — a failure
  // remembered by id would let anyone who sends a mangled copy first get the
  // real record refused; and failures are what a stranger can mint for free.
  const verdicts = new Map<string, Verdict>();
  const verdictKey = (e: Version) => `${e.id}|${e.signature}`;

  /** Copies checked to be what their id names, envelope and body: the caches are keyed by id and signature alone */
  const copiesChecked = new WeakSet<Version>();

  /**
   * Why a copy isn't what its id names, or null when it is: its id must be the
   * hash of its own envelope, and its body the one its `bodyHash` names. Asked
   * before any verdict cached by id and signature is used, so a copy with the
   * real id and signature but another envelope or body never passes on the
   * real one's.
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
    const cached = verdicts.get(verdictKey(version));
    if (cached) return cached;

    const result = await checkVersion(version);
    let verdict: Verdict;
    if (!result.passed) {
      verdict = { verified: false, root: null, ...(result.reason ? { reason: result.reason } : {}) };
    } else {
      const checked =
        version.proof !== undefined ? await verifyNote(version.proof, provider, { untimed: true }) : null;
      verdict = { verified: true, root: checked?.valid ? checked.root : version.author };
      verdicts.set(verdictKey(version), verdict);
    }
    return verdict;
  }

  type Opened = { readonly body: unknown; readonly links: ReadonlyArray<Link>; readonly encrypted: boolean };
  /**
   * Bodies already decrypted, by version id. Only a version whose signature
   * checked out is ever opened, and a failure is not kept: a key that arrives
   * later may open it.
   */
  const openedBodies = new Map<string, Opened>();

  /**
   * A version's content: its body and its links. In a private space both are
   * sealed together, so a relay learns neither what a record says nor what it
   * points at.
   */
  async function openBody(version: Version): Promise<Opened> {
    // A stub's content is forgotten: read like one this node holds no key for.
    if (isStub(version)) return { body: null, links: version.links ?? [], encrypted: false };
    if (!looksEncrypted(version.body))
      return { body: version.body, links: version.links ?? [], encrypted: false };
    const known = openedBodies.get(version.id);
    if (known) return known;
    const sealedWith = keyring.get(sealedKeyId(version.body));
    if (!sealedWith) return { body: null, links: [], encrypted: true };
    try {
      // Bound to this record: a body copied from another record, space or collection does not open.
      const content = await openSealedBody(version.body, sealedWith, {
        space: space.id,
        collection: version.collection,
        key: version.key,
      });
      const opened = isRecord(content) ? content : null;
      const sealedLinks = opened?.links ?? [];
      const links = isLinks(sealedLinks) ? sealedLinks : [];
      const result: Opened = Object.freeze({ body: opened?.body ?? null, links, encrypted: true });
      // An id names its content, so what opened once opens the same way again.
      openedBodies.set(version.id, result);
      if (openedBodies.size > MAX_OPENED) openedBodies.delete(openedBodies.keys().next().value!);
      return result;
    } catch {
      return { body: null, links: [], encrypted: true };
    }
  }

  /**
   * Whether `first` can be the first version of the record `version` belongs
   * to. A later version names its first version itself, and a check that took
   * that on trust would let anyone point at a record with no rules — or in
   * another collection — and be judged by that instead.
   */
  const firstOf = (version: Version, first: Version | null): first is Version =>
    !!first && first.seq === 0 && first.key === version.key && first.collection === version.collection;

  /**
   * A version's first version: itself at seq 0, else the one its chain names
   * (02 §4.5). Never the lowest id held at its key, which anyone who may
   * create there could grind.
   */
  async function genesisOf(version: Version): Promise<Version | null> {
    if (version.seq === 0) return version;
    const first = version.genesis ? await storage.getVersion(version.genesis) : null;
    return firstOf(version, first) ? first : null;
  }

  /**
   * Whether a version is one this node should show: a later version whose
   * first version is held and is its record's. Every version stored passed
   * that check on arrival (02 §4.7); this keeps a read from trusting it.
   */
  async function consistent(version: Version): Promise<boolean> {
    return version.seq === 0 || (await genesisOf(version)) !== null;
  }

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
    return {
      ok: false,
      reason:
        kind === 'owned'
          ? 'Its key belongs to another account'
          : 'A new record needs a key its account owns, or a shared one: key',
    };
  }

  /**
   * Why a first version at a key of a `onePer` key's form, shared `one:<hex>`
   * or owned `<owner>.one:<hex>`, can't be there, as of one state of the
   * history (02 §7.3): only a collection whose rules have `onePer` gives one,
   * owned when it names `@author` and shared when it doesn't. Judged from the
   * definition alone, so peers that can't derive the key agree. Null when it
   * can, or when this node can't read the definition to tell.
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
  // into plain events and replayed. Rebuilt when records change; everything
  // about who may do what is read from the replay.

  const accessGenesis = accessGenesisOf(space);

  /** Events, by version id — building one checks signatures and invites, so they are kept */
  const events = new Map<string, AccessEvent | null>();

  const eventKey = (version: Version) => `${version.id}|${version.signature}`;

  async function toEvent(version: Version): Promise<AccessEvent | null> {
    if (await copyProblem(version)) return null;
    const cacheKey = eventKey(version);
    if (events.has(cacheKey)) return events.get(cacheKey)!;
    const event = await buildEvent(version);
    // A failed signature is what a stranger can mint for free; only settled answers from a valid one are kept.
    if (event || (await judge(version)).verified) events.set(cacheKey, event);
    return event;
  }

  async function buildEvent(version: Version): Promise<AccessEvent | null> {
    if (!ACCESS_COLLECTIONS.has(version.collection) || !version.retain) return null;
    // Only a note that grants it changes the space's collections, or who may do what.
    if (!noteGrants(version.proof, accessRequirement(space.id, version.collection, version.key))) return null;
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root) return null;
    const seen = version.seen ?? [];
    const base = {
      id: version.id,
      key: version.key,
      root: verdict.root,
      author: version.author,
      seen,
      cutoff: NO_CUTOFF,
      ...(version.log ? { line: version.log.n } : {}),
    };

    if (version.collection === DEFINITION_COLLECTION) {
      if (!version.key.startsWith('collection:')) return null;
      return {
        ...base,
        kind: 'definition',
        name: version.key.slice('collection:'.length),
        deleted: !!version.deleted,
      };
    }
    // Everything else in the history is taken away by a change, never deleted: a delete has no body to carry a cutoff.
    if (version.deleted || looksEncrypted(version.body)) return null;
    const body = version.body;
    if (!isRecord(body)) return null;
    const cutoff = readCutoff(body.cutoff);
    if (!cutoff) return null;

    switch (version.collection) {
      case ROLE_COLLECTION: {
        // A definition carries no cutoff: it takes nothing from anyone, and binds what saw it.
        if (body.cutoff !== undefined) return null;
        const defined = readDefinition(body, { root: verdict.root, spaceId: space.id });
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
        const { did, role, assigned } = body;
        // Roles go to accounts, never to roles: an assignee is a did:key.
        if (typeof did !== 'string' || !did.startsWith('did:key:') || typeof role !== 'string') return null;
        if (typeof assigned !== 'boolean') return null;
        if (version.key !== (await assignKey(did, role))) return null;
        const invite = body.invite;
        let viaInvite: string | undefined;
        if (invite !== undefined) {
          if (!isRecord(invite) || typeof invite.key !== 'string' || typeof invite.signature !== 'string')
            return null;
          if (!(await verifyInvite(space.id, did, invite.key, invite.signature, provider))) return null;
          viaInvite = invite.key;
        }
        return {
          ...base,
          cutoff,
          kind: 'assign',
          did,
          role,
          assigned,
          ...(viaInvite !== undefined ? { viaInvite } : {}),
        };
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
        // It names a space by id, never this one: the successor's constitution names this one, so can't be it.
        if (body.cutoff !== undefined || !isSpaceId(body.space) || body.space === space.id) return null;
        if (version.key !== (await succeedKey(body.space))) return null;
        return { ...base, kind: 'succeed', space: body.space };
      }
      case INVITE_COLLECTION: {
        const inviteDid = body.key;
        if (typeof inviteDid !== 'string' || typeof body.role !== 'string' || typeof body.open !== 'boolean')
          return null;
        if (version.key !== (await inviteRecordKey(inviteDid))) return null;
        return { ...base, cutoff, kind: 'invite', inviteKey: inviteDid, role: body.role, open: body.open };
      }
      case KEY_COLLECTION: {
        if (version.key !== SPACE_KEY_RECORD || typeof body.keyId !== 'string' || body.keyId.length > 64)
          return null;
        if (typeof body.readKey !== 'string' || !body.readKey.startsWith('did:key:')) return null;
        return { ...base, kind: 'key', keyId: body.keyId, readKey: body.readKey };
      }
      case RELAYS_COLLECTION: {
        if (
          version.key !== SPACE_RELAYS_RECORD ||
          !isStringList(body.relays) ||
          body.relays.length > MAX_RELAYS
        )
          return null;
        return { ...base, kind: 'relays', relays: body.relays };
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
        if (
          version.key !== SPACE_KEEPERS_RECORD ||
          checkKeepers(keepers, copies) !== null ||
          !areKeepers(keepers) ||
          !(copies === null || typeof copies === 'number')
        )
          return null;
        return { ...base, kind: 'keepers', keepers, copies };
      }
      case REVOKE_COLLECTION: {
        // An account's revoke of one of its keys sits at a key naming both, so no one else's can take its place.
        if (typeof body.key !== 'string' || !body.key.startsWith('did:key:')) return null;
        if (version.key !== (await revokeKey(body.key, verdict.root))) return null;
        return { ...base, cutoff, kind: 'revoke', target: body.key };
      }
    }
    return null;
  }

  interface Access {
    readonly history: AccessHistory;
    readonly events: ReadonlyArray<AccessEvent>;
    /** Whether a version was passed over that a later look might take: then only reading them all again is sure */
    readonly unsettled: boolean;
  }
  let accessCache: Promise<Access> | null = null;
  /** The read key readers must prove now — kept at hand, since a handshake asks for it without waiting */
  let currentReadKey = space.readKey ?? '';

  /**
   * Where the members meet: the relays the space names once it names some,
   * and until then the ones the invite that brought it here named. Handed to
   * the mesh for this space's room alone.
   */
  let relays: ReadonlyArray<string> = record.relays ?? [];
  let meshRoom: string | null = null;
  function useRelays(named: ReadonlyArray<string>): void {
    if (named.length === 0 || (named.length === relays.length && named.every((url, i) => url === relays[i])))
      return;
    relays = [...named];
    if (meshRoom) deps.mesh?.useRelays(meshRoom, relays);
    void deps.onRelays?.(relays).catch(() => {});
  }
  const access = () => (accessCache ??= loadAccess());

  /**
   * Accounts that held a place in this private space and hold none now:
   * removed, or left. No live message goes to them, and while a new key is
   * due (`untilNewKey`) — they may hold the current one — nothing else does
   * either. Empty in a public space, which anyone may read.
   */
  async function formerMembers(options: { untilNewKey?: boolean } = {}): Promise<ReadonlySet<string>> {
    if (space.visibility !== 'private') return new Set();
    const { history, events } = await access();
    // A key made since: it does the work, and someone invited back holds it.
    if (options.untilNewKey && !history.current.keyDue) return new Set();
    const allowed = readers(history.current);
    const gone = new Set<string>();
    for (const event of events) {
      if ((event.kind !== 'assign' && event.kind !== 'remove') || allowed.has(event.did)) continue;
      if (history.status(event.id)?.status === 'applied') gone.add(event.did);
    }
    return gone;
  }

  async function loadAccess(): Promise<Access> {
    const found: AccessEvent[] = [];
    let unsettled = false;
    // By key, not by the current version's collection: whatever sits on top
    // may be anyone's, and every version of the history counts.
    for (const [prefix, collection] of ACCESS_KEYS) {
      for (const versions of (await storage.histories(prefix)).values()) {
        for (const held of versions) {
          if (held.collection !== collection) continue;
          const event = await toEvent(held);
          if (event) found.push(event);
          else unsettled ||= !events.has(eventKey(held));
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
   * The history with versions just stored: each change added to the one
   * there was, the way a whole replay would place it, and the whole history
   * read and replayed again when one can't be (`AccessHistory.extend`).
   * Adding a member or changing a role costs as much as the members, not
   * the history twice over.
   */
  async function extendAccess(before: Promise<Access>, placed: ReadonlyArray<Version>): Promise<Access> {
    const previous = await before.catch(() => null);
    if (!previous || previous.unsettled) return loadAccess();
    let pending: AccessEvent[] = [];
    for (const version of placed) {
      if (
        !ACCESS_KEYS.some(
          ([prefix, collection]) => version.key.startsWith(prefix) && version.collection === collection,
        )
      )
        continue;
      const event = await toEvent(version);
      if (event) pending.push(event);
      else if (!events.has(eventKey(version))) return loadAccess();
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

  /** The note a version was written under, when it was delegated */

  /**
   * The command a version invokes, and its arguments (03 §5.2): a delete, or
   * a write with its body. `opaque` when this node can't read the body, so
   * policies on it are left to those who can.
   */
  async function invocationOf(
    version: Version,
    first: Version,
    root: string,
  ): Promise<{ readonly cmd: string; readonly args: Record<string, unknown>; readonly opaque: boolean }> {
    const byCreator = version.seq === 0 || (await judge(first)).root === root;
    const collection = version.collection;
    if (version.deleted) return { cmd: RECORD_DELETE, args: { collection, byCreator }, opaque: false };
    const opened = await openBody(version);
    const opaque = isStub(version) || (opened.encrypted && opened.body === null);
    return {
      cmd: RECORD_WRITE,
      args: { collection, byCreator, ...(opaque ? {} : { body: opened.body }) },
      opaque,
    };
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
    let found = definitions.get(id);
    if (!found) {
      found = (async (): Promise<Definition> => {
        const version = await storage.getVersion(id);
        if (!version) return 'missing';
        if (version.collection !== CATALOG_COLLECTION || version.deleted) return 'invalid';
        const opened = await openBody(version);
        if (opened.body === null) return 'unreadable';
        const body = opened.body;
        if (!isStoredCollection(body) || version.key !== `collection:${body.name}`) return 'invalid';
        return { definition: body };
      })();
      definitions.set(id, found);
      // Something missing may turn up; only settled answers are worth keeping.
      void found.then((answer) => answer === 'missing' && definitions.delete(id));
    }
    return found;
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
    const cacheKey = within
      ? `${copyKey(version)}|${[...new Set(within)].sort().join(',')}`
      : copyKey(version);
    let found = standings.get(cacheKey);
    if (!found) {
      found = judgeStanding(version, within);
      standings.set(cacheKey, found);
      // Only a verdict that stands is kept: one waiting on something not here
      // yet changes when it arrives, and a failing verdict is never cached (02 §9.5).
      found.then(
        (standing) => !standing.ok && standings.delete(cacheKey),
        () => standings.delete(cacheKey),
      );
    }
    return found;
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
    if (deps.accountOnly && !noteGrants(version.proof, accountSpaceRequirement(space.id, version.collection)))
      return { ok: false, reason: "Its note doesn't let it write in the account's own spaces" };
    const { history } = await access();

    if (ACCESS_COLLECTIONS.has(version.collection)) {
      const event = await toEvent(version);
      if (!event) return { ok: false, reason: 'It is not a well-formed change to who may do what' };
      const status = history.status(event.id);
      if (!status || status.status === 'waiting') return ACCESS_LATER;
      return status.status === 'applied' ? STANDS : { ok: false, reason: status.reason };
    }

    const first =
      version.seq === 0 ? version : version.genesis ? await storage.getVersion(version.genesis) : null;
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
      if ((opened.body === null && opened.encrypted) || !keying) return STANDS;
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
      if (opened.body === null && opened.encrypted) return { unreadable: true };
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
    const cacheKey = `${copyKey(version)}|${within ? [...new Set(within)].sort().join(',') : ''}`;
    const cached = checkVerdicts.get(cacheKey);
    if (cached) return cached;
    const verdict = (async (): Promise<ChecksVerdict> => {
      const first =
        version.seq === 0 ? version : version.genesis ? await storage.getVersion(version.genesis) : null;
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
      if (
        checks !== undefined &&
        (checkContracts(checks, 'contract.check') !== null || !Array.isArray(checks))
      )
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
        if (opened.body === null && opened.encrypted) return UNJUDGED;
      }
      // It continues the version before: one that follows a version failing its checks fails too,
      // or a forged step would be laundered by the next.
      let previous = version.seq > 0 && version.prev ? await storage.getVersion(version.prev) : null;
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
          if (before.body === null && before.encrypted) return UNJUDGED;
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
    })();
    checkVerdicts.set(cacheKey, verdict);
    // Only what can't change is kept: a pending verdict changes when what it cites arrives,
    // and one this node couldn't judge may change once it can open what it needs.
    void verdict.then(
      (found) => ('pending' in found || found === UNJUDGED) && checkVerdicts.delete(cacheKey),
    );
    return verdict;
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
    let index = lineIndexes.get(collection);
    if (!index) {
      index = storage.keptVersions(collection).then((held) => {
        const byPlace = new Map<string, Version[]>();
        for (const version of held) {
          const at = byPlace.get(twinKey(version));
          if (at) at.push(version);
          else byPlace.set(twinKey(version), [version]);
        }
        return byPlace;
      });
      lineIndexes.set(collection, index);
    }
    return index;
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
      step = step.seq > 0 && step.prev ? await storage.getVersion(step.prev) : null;
    }
    const claimed = new Set(known);
    // A stub's claims can't be read yet, so a walk through one isn't kept: the whole version may arrive.
    let throughStub = false;
    for (const step of path.reverse()) {
      if (step.deleted) continue;
      if (isStub(step)) throughStub = true;
      const opened = await openBody(step);
      if (opened.body === null && opened.encrypted) return UNJUDGED;
      for (const citation of onceCitations(opened.body, once)) {
        if (claimed.has(citation)) return 'It claims something its line has already claimed';
        claimed.add(citation);
      }
    }
    // An id names its content, and so its whole chain: what it claimed never changes.
    if (throughStub) return null;
    onceClaimed.set(`${version.id}|${fields}`, claimed);
    if (onceClaimed.size > MAX_ONCE_CLAIMED) onceClaimed.delete(onceClaimed.keys().next().value!);
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
    if (opened.body === null && opened.encrypted) return 'unreadable';
    const previous = version.seq > 0 && version.prev ? await storage.getVersion(version.prev) : null;
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
    if (described) return validateJsonSchema(described.schema, body);
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
        // The picture, from the newest version: taken away is gone.
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
        if (deps.fetchFiles === 'all') await spaceFiles?.fetchAll();
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

  // ─── The space's keys ──────────────────────────────────────────────
  //
  // A private space's key changes when someone loses their place in it
  // (`sys.key`, part of the access history): whoever manages the space makes
  // a new one, and seals a copy to each member's member key (`sys.box`). The
  // key record carries every earlier key sealed under the new one, so holding
  // the current key opens everything written before it — which is how
  // someone who joins later reads the old records, and someone removed reads
  // nothing new. This is how Keybase changes a team's key.

  /** The key the history names now, if this node holds it */
  function currentKey(state: AccessState): SpaceKey | null {
    const epoch = state.keys.at(-1);
    return epoch ? (keyring.get(epoch.keyId) ?? null) : null;
  }

  /** The newest key this node holds that the history names — what it proves it may read with while behind */
  function newestKey(state: AccessState): SpaceKey | null {
    for (const epoch of [...state.keys].reverse()) {
      const held = keyring.get(epoch.keyId);
      if (held) return held;
    }
    return record.key;
  }

  /** Box and key record versions already opened, so each is tried once */
  const opened = new Set<string>();
  /**
   * Key records already opened, for the keys the history named then. Which
   * key event counts, and which keys it names, can change as changes arrive,
   * so they are opened again when that does.
   */
  const openedKeyRecords = new Set<string>();
  let openedFor = '';
  /**
   * Keys whose key change is malformed: its earlier keys don't open, or leave
   * out the space's first key, which every reader needs for onePer keys
   * (03 §9.3). Nothing is taken from them, and a manager replaces them.
   */
  const malformedKeys = new Set<string>();

  /** Takes in what this node can open: boxes sealed to its member key, and the earlier keys each key record carries */
  async function learnKeys(): Promise<void> {
    const { history } = await access();
    const epochs = history.current.keys;
    const learned: SpaceKey[] = [];
    const take = (found: SpaceKey) => {
      if (keyring.has(found.id)) return false;
      keyring.set(found.id, found);
      learned.push(found);
      return true;
    };

    if (memberPair && epochs.some((epoch) => !keyring.has(epoch.keyId))) {
      for (const versions of (await storage.histories('box:')).values()) {
        for (const version of versions) {
          if (version.collection !== BOX_COLLECTION || version.deleted || opened.has(version.id)) continue;
          const body = isRecord(version.body) ? version.body : null;
          if (body?.to !== deps.rootDid || typeof body.keyId !== 'string' || typeof body.sealed !== 'string')
            continue;
          const epoch = epochs.find((known) => known.keyId === body.keyId);
          if (!epoch || keyring.has(epoch.keyId)) continue;
          opened.add(version.id);
          const content = await openValueFrom(
            memberPair,
            BOX_LABEL,
            boxBound(space.id, epoch.keyId, deps.rootDid),
            body.sealed,
          );
          if (!isRecord(content) || typeof content.key !== 'string') continue;
          // Whoever sealed it, it is the key the history names or it is nothing.
          const found = await spaceKeyFromRaw(base64UrlDecode(content.key)).catch(() => null);
          if (found?.id === epoch.keyId && (await deriveReadKey(found, provider)).did === epoch.readKey)
            take(found);
        }
      }
    }

    const named = epochs.map((epoch) => `${epoch.keyId}/${epoch.readKey}/${epoch.event}`).join('|');
    if (named !== openedFor) {
      openedFor = named;
      openedKeyRecords.clear();
      malformedKeys.clear();
    }
    // Each newer key opens the ones before it — which may open more.
    let more = true;
    while (more) {
      more = false;
      for (const versions of (await storage.histories('key:')).values()) {
        for (const version of versions) {
          const body = isRecord(version.body) ? version.body : null;
          if (
            version.collection !== KEY_COLLECTION ||
            openedKeyRecords.has(version.id) ||
            typeof body?.keyId !== 'string'
          )
            continue;
          // Only the key change that counted for that key: anyone may store a version at `key:space`.
          const epoch = epochs.find((known) => known.keyId === body.keyId);
          if (!epoch || epoch.event !== version.id) continue;
          const holder = keyring.get(body.keyId);
          if (!holder) continue;
          openedKeyRecords.add(version.id);
          const earlier = await openValue(
            holder.seal,
            EARLIER_KEYS_LABEL,
            { space: space.id, keyId: holder.id },
            body.earlier,
          );
          const found: SpaceKey[] = [];
          for (const raw of isStringList(earlier) ? earlier.slice(0, 1000) : []) {
            const key = await spaceKeyFromRaw(base64UrlDecode(raw)).catch(() => null);
            if (key) found.push(key);
          }
          // Without the first key, a reader holding only this one couldn't derive onePer keys (02 §7.3).
          if (!isStringList(earlier) || !found.some((key) => key.id === space.encryptionKeyId)) {
            malformedKeys.add(body.keyId);
            continue;
          }
          // And only keys the history names, each with the read key it names.
          for (const key of found) {
            const named = epochs.find((known) => known.keyId === key.id);
            if (named && (await deriveReadKey(key, provider)).did === named.readKey && take(key)) more = true;
          }
        }
      }
    }

    if (learned.length === 0) return;
    // A definition this node couldn't read may open now.
    definitions.clear();
    const writeWith = newestKey((await access()).history.current);
    if (writeWith) await deps.onKeys?.([...keyring.values()], writeWith.id);
    recordsChanged();
  }

  /** Makes a new key current, with every key before it sealed inside, and seals it to each member */
  async function rotateKey(): Promise<void> {
    if (space.visibility !== 'private') throw new Error('A public space has no key to change');
    const { history } = await access();
    if (!may(history.current, deps.rootDid, KEY_CHANGE, {}))
      throw new Error(`Only someone granted ${KEY_CHANGE} in "${space.name}" can change its key`);
    if (!currentKey(history.current))
      throw new Error(`This device doesn't hold the current key of "${space.name}" yet`);
    // Every key change carries the first key, so every reader holds it (03 §9.3).
    if (!space.encryptionKeyId || !keyring.has(space.encryptionKeyId))
      throw new Error(`This device doesn't hold the first key of "${space.name}"`);
    const next = await generateSpaceKey();
    const earlier = [...keyring.values()].map((held) => base64UrlEncode(held.raw));
    const body = {
      keyId: next.id,
      readKey: (await deriveReadKey(next, provider)).did,
      earlier: await sealValue(next.seal, EARLIER_KEYS_LABEL, { space: space.id, keyId: next.id }, earlier),
    };
    keyring.set(next.id, next);
    try {
      await upsert(KEY_COLLECTION, SPACE_KEY_RECORD, body);
    } catch (error) {
      keyring.delete(next.id);
      throw error;
    }
    await deps.onKeys?.([...keyring.values()], next.id);
    await boxForMembers();
  }

  /**
   * Seals the current key to each member who has no copy from someone who
   * manages the space. Members show their member key on their profile; one
   * who hasn't yet gets their copy once they do.
   */
  async function boxForMembers(): Promise<void> {
    const { history } = await access();
    const state = history.current;
    const epoch = state.keys.at(-1);
    const key = currentKey(state);
    if (!epoch || !key) return;

    const boxed = new Set<string>();
    for (const versions of (await storage.histories('box:')).values()) {
      for (const version of versions) {
        const body = isRecord(version.body) ? version.body : null;
        if (
          version.collection !== BOX_COLLECTION ||
          body?.keyId !== epoch.keyId ||
          typeof body.to !== 'string'
        )
          continue;
        const { root } = await judge(version);
        if (root && (root === deps.rootDid || may(state, root, KEY_CHANGE, {}))) boxed.add(body.to);
      }
    }
    const memberKeys = await memberKeyMap();
    const raw = base64UrlEncode(key.raw);
    for (const did of [...readers(state)].sort()) {
      const publicKey = memberKeys.get(did);
      if (boxed.has(did) || !publicKey) continue;
      const sealed = await sealValueTo(publicKey, BOX_LABEL, boxBound(space.id, epoch.keyId, did), {
        key: raw,
      });
      await upsert(BOX_COLLECTION, await boxKey(epoch.keyId, did, deps.rootDid), {
        keyId: epoch.keyId,
        to: did,
        sealed,
      });
    }
  }

  /**
   * Keeps the keys in step with the history: says where to seal this
   * account's copy, learns what it can, and — managing the space — changes
   * the key when due and seals it to whoever lacks it.
   */
  async function upkeep(): Promise<void> {
    // A note that can't change access keeps no keys for others: it only reads.
    if (!grantsBeyondRecords(session.proof(), space.id, ACCESS_COMMAND)) {
      if (space.visibility === 'private') await learnKeys();
      return;
    }
    await nameRelays();
    if (space.visibility !== 'private') return;
    if (deps.accountOnly) {
      await learnKeys();
      return;
    }
    const mine = await memberKeyMap();
    if (memberPair && mine.get(deps.rootDid) !== memberPair.publicKey && !(await cannotWrite())) {
      await upsert(MEMBER_KEY_COLLECTION, await memberKeyRecordKey(deps.rootDid), {
        key: memberPair.publicKey,
      });
    }
    await learnKeys();
    const { history } = await access();
    const state = history.current;
    if (!currentKey(state)) return;
    if (!may(state, deps.rootDid, KEY_CHANGE, {})) return;
    // A current key whose change left out the first key is replaced, as one that is due.
    const malformed = malformedKeys.has(state.keys.at(-1)?.keyId ?? '');
    if (state.keyDue || (malformed && space.encryptionKeyId && keyring.has(space.encryptionKeyId)))
      await rotateKey();
    else await boxForMembers();
  }

  /**
   * A space nobody has said where to meet yet: whoever manages it names the
   * relays this node uses, so the invites and devices that follow meet there.
   */
  async function nameRelays(): Promise<void> {
    const own = usableRelays(deps.network).slice(0, MAX_RELAYS);
    if (own.length === 0) return;
    const { history } = await access();
    if (history.current.relays.length > 0 || !may(history.current, deps.rootDid, SPACE_RELAYS, {})) return;
    await upsert(RELAYS_COLLECTION, SPACE_RELAYS_RECORD, { relays: own });
  }

  /** Runs the upkeep once more after whatever changed — one run at a time */
  const keepingUp = serial(async () => {
    if (closed) return;
    await upkeep().catch(() => {
      // A write refused, a peer's junk: the next change tries again.
    });
  });
  function keepUp(): void {
    if (!closed) void keepingUp();
  }

  /** The read key each peer checked here was let in on, by session DID, and when */
  const admittedOn = new Map<string, { readonly readKey: string; readonly at: number }>();

  /** How this node proves it may read, and checks the peers that connect — against the history at that moment */
  const readAccess: ReadAccess | null =
    space.visibility !== 'private'
      ? null
      : {
          async key() {
            const held = newestKey((await access()).history.current);
            // A carrier holds the read key pair without the key it comes from: it may be served the space, and cannot open it.
            return held ? deriveReadKey(held, provider) : (record.read ?? null);
          },
          current: () => currentReadKey,
          async earlier() {
            const { current } = (await access()).history;
            const newest = newestKey(current);
            const older = [...current.keys]
              .reverse()
              .map((epoch) => keyring.get(epoch.keyId))
              .filter((held): held is SpaceKey => held !== undefined && held !== newest);
            return Promise.all(
              older.slice(0, MAX_EARLIER_READ_KEYS).map((held) => deriveReadKey(held, provider)),
            );
          },
          async membership() {
            const held = newestKey((await access()).history.current);
            return held ? sealValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, session.proof()) : null;
          },
          async admits(peerDid: string, readKey: string, membership: unknown) {
            const { history } = await access();
            const epoch = history.current.keys.find((known) => known.readKey === readKey);
            const held = epoch ? keyring.get(epoch.keyId) : undefined;
            if (!held) return false;
            const { account } = await accountOf(
              peerDid,
              await openValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, membership),
            );
            return account !== null && readers(history.current).has(account);
          },
          async removed(peerDid: string, readKey: string, membership: unknown) {
            const { history } = await access();
            const epoch = history.current.keys.find((known) => known.readKey === readKey);
            const held = epoch ? keyring.get(epoch.keyId) : undefined;
            if (!held) return false;
            const note = await openValue(held.seal, MEMBERSHIP_LABEL, { space: space.id }, membership);
            const { account } = await accountOf(peerDid, note);
            return account !== null && (await formerMembers({ untilNewKey: true })).has(account);
          },
          admitted(peerDid: string, readKey: string) {
            admittedOn.set(peerDid, { readKey, at: Date.now() });
          },
        };

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
    const relays = deps.mesh?.status().relays ?? [];
    if (relays.length > 0 && relays.every((relay) => relay.closeCode === CLOSE_DID_TAKEN)) return 'refused';
    return connection === 'connected' ? 'connecting' : connection;
  };
  let shown: ConnectionState | null = null;
  // Relays come and go without a peer doing so; say so when that changes how this space connects.
  const stopWatchingMesh = deps.mesh?.subscribe(() => {
    const now = liveConnection();
    if (now === shown) return;
    shown = now;
    emit({ type: 'status', space: space.id });
  });
  /** Which network a peer was met on, so replies go back the same way */
  const routes = new Map<string, NetworkManager>();

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
    stands: async (version) => {
      const standing = await standingOf(version);
      return standing.ok || !!standing.withdrawn;
    },
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

  // Both sides of a socket to a node prove who they are; in a private space the client also proves it may read.
  let authenticator: ReturnType<typeof createClientAuth> | null = null;
  /** A socket to an always-on node, for this space */
  function nodeNetwork(node: string): NetworkManager {
    authenticator ??= createClientAuth(space.id, session, readAccess, provider);
    // The space goes in the query, before any pin in the fragment.
    const [base = '', ...pin] = node.split('#');
    const url = `${base}${base.includes('?') ? '&' : '?'}space=${encodeURIComponent(space.id)}${pin.length ? `#${pin.join('#')}` : ''}`;
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

  const connectedPeers = () => [
    ...new Set(networks.flatMap((network) => network.getPeers().map((peer) => peer.did))),
  ];

  // ─── Live messages ─────────────────────────────────────────────────
  //
  // A connection proves which session key is at the other end — not whose it
  // is. So the first thing each side sends is its note, the delegation from
  // its account to that key: the same note its records carry. It names the
  // key it was made out to, and that must be the key the connection proved,
  // so a note copied off someone's record is no use to anyone else.

  const peerAccounts = new Map<string, Promise<PeerAccount>>();
  /** Peers let go of because their account was removed, by session DID: turned away again when they redial */
  const cutOff = new Map<string, string>();
  const knownAccounts = new Map<string, PeerAccount>();
  const liveAllowance = new Map<string, { tokens: number; at: number }>();

  async function accountOf(peer: string, note: unknown): Promise<PeerAccount> {
    if (!isRecord(note) || canonicalize(note).length > MAX_NOTE_LENGTH) return NO_ACCOUNT;
    const checked = await verifyNote(note, provider).catch(() => null);
    if (!checked?.valid || checked.audience !== peer) return NO_ACCOUNT;
    return {
      account: checked.root,
      // A key that writes records somewhere but can't define here. Judged on the
      // whole note, so a key for another space doesn't pass as the account here.
      // A note that only reads is not one: it writes nothing. The note is the
      // account's own, one link, so its key can't sign itself a wider one.
      recordsOnly:
        writesRecords(checked.note) && !grantsBeyondRecords(checked.note, space.id, DEFINE_COMMAND),
    };
  }

  /** A peer's share of live messages: a burst, then a steady rate — as the relay limits them */
  function withinAllowance(peer: string): boolean {
    const now = Date.now();
    const held = liveAllowance.get(peer) ?? { tokens: LIVE_BURST, at: now };
    const tokens = Math.min(LIVE_BURST, held.tokens + ((now - held.at) / 1000) * LIVE_PER_SECOND);
    liveAllowance.set(peer, { tokens: Math.max(0, tokens - 1), at: now });
    return tokens >= 1;
  }

  async function onLive(peer: string, payload: unknown): Promise<void> {
    if (!withinAllowance(peer)) return;
    if ((JSON.stringify(payload ?? null)?.length ?? 0) > MAX_LIVE_BYTES) return;
    const { account, recordsOnly } = (await peerAccounts.get(peer)) ?? NO_ACCOUNT;
    // Gone while its note was being checked.
    if (!routes.has(peer)) return;
    if (account !== null && (await formerMembers()).has(account)) return;
    emit({ type: 'message', space: space.id, from: account, peer, recordsOnly, message: payload });
  }

  /**
   * Lets go of the peers a handshake would refuse now. A handshake checks a
   * reader once, but the space's key changes when someone is removed: a peer
   * let in on a key that is no longer current stays only while it acts for
   * someone who may still read, as it would get in again (`checkRead`).
   * Anyone else — someone removed, a view-only link from before — stops
   * getting anything the moment this node knows the new key.
   */
  async function letGoOfOutsiders(): Promise<void> {
    const connected = new Set(connectedPeers());
    // Someone removed is let go of as soon as this node knows, on any key:
    // the key may not have changed yet, if nobody who manages the space is here.
    const gone = await formerMembers({ untilNewKey: true });
    for (const [peer, account] of cutOff) if (!gone.has(account)) cutOff.delete(peer);
    for (const peer of connected) {
      const account = knownAccounts.get(peer)?.account ?? null;
      if (account === null || !gone.has(account) || cutOff.has(peer)) continue;
      cutOff.set(peer, account);
      admittedOn.delete(peer);
      // Nothing more goes to them from now; the socket closes a moment later,
      // so what was already sent — the "stored" for their own leaving — arrives.
      sync.removePeer(peer);
      routes.delete(peer);
      setTimeout(() => {
        peerAccounts.delete(peer);
        knownAccounts.delete(peer);
        liveAllowance.delete(peer);
        for (const network of networks) network.drop(peer);
      }, LET_GO_AFTER_MS);
    }
    if (admittedOn.size === 0) return;
    for (const [peer, { at }] of admittedOn) {
      // Checked, and never let in: a handshake the other side refused.
      if (!connected.has(peer) && Date.now() - at > STALE_ADMISSION_MS) admittedOn.delete(peer);
    }
    const allowed = readers((await access()).history.current);
    for (const peer of connected) {
      const admission = admittedOn.get(peer);
      if (!admission || admission.readKey === currentReadKey) continue;
      // Its note is said first, but may still be on its way; this runs again when it lands.
      if (!peerAccounts.has(peer) && Date.now() - admission.at < WHO_WAIT_MS) continue;
      const { account } = (await peerAccounts.get(peer)) ?? NO_ACCOUNT;
      if (account !== null && allowed.has(account)) continue;
      // Let in again meanwhile, on the key it holds now.
      if (admittedOn.get(peer) !== admission) continue;
      admittedOn.delete(peer);
      for (const network of networks) network.drop(peer);
    }
  }

  function listen(network: NetworkManager): void {
    network.on('message', (message: NetworkMessage) => {
      if (message.type === 'sync') void sync.handleMessage(message.from, message.payload);
      else if (message.type === WHO_MESSAGE) {
        const note = isRecord(message.payload) ? message.payload.note : undefined;
        const checked = accountOf(message.from, note);
        peerAccounts.set(message.from, checked);
        void checked.then((known) => {
          if (peerAccounts.get(message.from) !== checked) return;
          knownAccounts.set(message.from, known);
          emit({ type: 'status', space: space.id });
          void letGoOfOutsiders().catch(() => {});
        });
      } else if (message.type === LIVE_MESSAGE) void onLive(message.from, message.payload);
    });
    network.on('peer-connected', (info: PeerInfo) => {
      if (cutOff.has(info.did)) {
        network.drop(info.did);
        return;
      }
      // Said first, so it reaches them before any live message from here.
      network.send(info.did, { type: WHO_MESSAGE, from: session.did, payload: { note: session.proof() } });
      routes.set(info.did, network);
      sync.addPeer(info.did);
      // Reconcile at once rather than waiting for the heartbeat.
      sync.notifyPeers([info.did]);
      emit({ type: 'status', space: space.id });
      // The key may have changed between checking it and letting it in.
      void letGoOfOutsiders().catch(() => {});
    });
    network.on('peer-disconnected', (info: PeerInfo) => {
      if (routes.get(info.did) === network) {
        routes.delete(info.did);
        sync.removePeer(info.did);
        peerAccounts.delete(info.did);
        knownAccounts.delete(info.did);
        liveAllowance.delete(info.did);
      }
      if (!connectedPeers().includes(info.did)) admittedOn.delete(info.did);
      emit({ type: 'status', space: space.id });
    });
    network.on('error', () => {
      if (!networks.some((n) => n.isConnected())) connection = 'error';
      emit({ type: 'status', space: space.id });
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
        emit({ type: 'status', space: space.id });
      },
      () => {
        connection = 'error';
        emit({ type: 'status', space: space.id });
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

  // ─── Holding part of the space ─────────────────────────────────────
  //
  // With `cache` set, and once the space names a keeper, this node holds only
  // the collections it uses, besides the space's own. Sync takes in nothing
  // else. Its own writes are pending until enough keepers have them, and a
  // collection holding a pending write is never dropped. Without a keeper the
  // space is held whole: then this node may be one of its copies.

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const declared = new Set((cache?.collections ?? []).filter((c) => !c.startsWith('sys.')));
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  const saveCache = () => {
    if (cacheTimer || !cache) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      void adapter.put(CACHE_KEY, utf8Encode(JSON.stringify(cacheState))).catch(() => {});
    }, 500);
    unref(cacheTimer);
  };
  const flushCache = async () => {
    if (!cacheTimer) return;
    clearTimeout(cacheTimer);
    cacheTimer = null;
    await adapter.put(CACHE_KEY, utf8Encode(JSON.stringify(cacheState))).catch(() => {});
  };
  saveCache();

  /**
   * Holds part of the space from the moment it names a keeper, and all of it
   * again if it stops — once this node has caught up enough to know.
   */
  async function refreshHolds(): Promise<void> {
    if (!cache || closed) return;
    const next = (await access()).history.current.keepers.length > 0 || !cacheState.settled;
    if (next === partial) return;
    partial = next;
    // Peers learn what this node holds now; anything newly held comes across.
    sync.notifyPeers(connectedPeers());
    emit({ type: 'status', space: space.id });
  }

  /** Collections a query or a screen uses: held from now on. Whether all of them are here yet. */
  function use(collections: ReadonlyArray<string>): boolean {
    if (!cache) return true;
    const now = Date.now();
    let added = false;
    for (const collection of collections) {
      if (typeof collection !== 'string' || collection.startsWith('sys.')) continue;
      const was = cacheState.used[collection];
      if (was === undefined) added = true;
      if (was === undefined || now - was > HOUR) {
        cacheState.used[collection] = now;
        saveCache();
      }
    }
    if (added && partial) sync.notifyPeers(connectedPeers());
    return !partial || collections.every((c) => c.startsWith('sys.') || completeHere(c));
  }

  /** Level with a node holding everything once, and lacking nothing a writer's line in it names */
  function completeHere(collection: string): boolean {
    return cacheState.level[collection] !== undefined && !(cacheState.missing[collection]?.length ?? 0);
  }

  /**
   * Keeps track of what each writer's line in a held collection names that
   * this node lacks: a version that names one not here adds it, and asks
   * every peer for it; one that arrives takes itself off.
   */
  async function noteGap(version: Version): Promise<void> {
    if (!cache || !version.log || version.collection.startsWith('sys.')) return;
    const { collection } = version;
    const missing = cacheState.missing[collection] ?? [];
    const before = version.log.prev;
    if (!before || missing.includes(before) || (await storage.getVersion(before))) return;
    cacheState.missing[collection] = [...missing, before];
    sync.ask(collection, [before]);
    saveCache();
    // A query that said "complete" says so no longer.
    if (partial) emit({ type: 'records', space: space.id });
  }

  /**
   * Takes versions just stored off what was missing — only once they are in
   * the store, so a query never says "complete" for what it can't read yet.
   */
  function noteArrived(placed: ReadonlyArray<Version>): void {
    if (!cache) return;
    let changed = false;
    for (const version of placed) {
      const missing = cacheState.missing[version.collection];
      if (!missing?.includes(version.id)) continue;
      const left = missing.filter((id) => id !== version.id);
      if (left.length) cacheState.missing[version.collection] = left;
      else delete cacheState.missing[version.collection];
      changed = true;
    }
    if (changed) saveCache();
  }

  /** A write of this node's, waiting for keepers — only on a node that may hold part of a space */
  async function markPending(version: Version): Promise<void> {
    if (!cache || version.author !== session.did || version.collection.startsWith('sys.')) return;
    const pending: Pending = { collection: version.collection, by: [] };
    await adapter.put(`${PENDING_PREFIX}${version.id}`, utf8Encode(JSON.stringify(pending)));
  }

  /**
   * A keeper has some of this node's pending writes: those it named, or every
   * one in a collection it is level on. Once enough keepers have one, it
   * stops being pending. Only keepers the space names count.
   */
  async function confirm(
    peer: string,
    which: { ids?: ReadonlySet<string>; collection?: string },
  ): Promise<void> {
    if (!cache) return;
    const state = (await access()).history.current;
    if (!state.keepers.some((keeper) => keeper.did === peer)) return;
    const target = Math.min(state.keepers.length, Math.max(state.copies ?? 2, cache.copies ?? 0));
    for (const name of await adapter.list(PENDING_PREFIX)) {
      const id = name.slice(PENDING_PREFIX.length);
      if (which.ids && !which.ids.has(id)) continue;
      const bytes = await adapter.get(name);
      if (!bytes) continue;
      const pending: unknown = JSON.parse(utf8Decode(bytes));
      if (!isPending(pending)) continue;
      if (which.collection !== undefined && pending.collection !== which.collection) continue;
      if (!pending.by.includes(peer)) pending.by.push(peer);
      if (pending.by.length >= target) await adapter.delete(name);
      else await adapter.put(name, utf8Encode(JSON.stringify(pending)));
    }
  }

  sync.on('synced', (_peer: string, full: boolean) => {
    if (!cache || !full || cacheState.settled) return;
    // Caught up with a node holding everything: the access history here is the space's now.
    cacheState.settled = true;
    saveCache();
    void refreshHolds().catch(() => {});
  });
  sync.on('stored', (peer: string, ids: ReadonlyArray<string>) => {
    void confirm(peer, { ids: new Set(ids) }).catch(() => {});
  });
  sync.on('level', (peer: string, collection: string, full: boolean) => {
    // What a line names and is not here yet: asked again, of whoever holds it now.
    const missing = cacheState.missing[collection];
    if (cache && missing?.length) sync.ask(collection, missing);
    if (cache && full && cacheState.level[collection] === undefined) {
      cacheState.level[collection] = Date.now();
      saveCache();
      // A query that said "not complete" says so no longer.
      if (partial) emit({ type: 'records', space: space.id });
    }
    void confirm(peer, { collection }).catch(() => {});
  });

  /**
   * Drops collections no query has touched for a while: their records go,
   * and they are no longer held. Never one the app declared, nor one holding
   * a write still waiting for keepers.
   */
  async function dropUnused(): Promise<void> {
    if (!cache || !partial || closed) return;
    const cutoff = Date.now() - (cache.unusedAfterDays ?? 30) * DAY;
    const waiting = new Set<string>();
    for (const name of await adapter.list(PENDING_PREFIX)) {
      const bytes = await adapter.get(name);
      const pending: unknown = bytes ? JSON.parse(utf8Decode(bytes)) : null;
      if (isPending(pending)) waiting.add(pending.collection);
    }
    let dropped = false;
    for (const [collection, at] of Object.entries(cacheState.used)) {
      if (at > cutoff || declared.has(collection) || waiting.has(collection)) continue;
      // No longer held first, so nothing syncs it back while it goes.
      delete cacheState.used[collection];
      delete cacheState.level[collection];
      delete cacheState.missing[collection];
      for (const item of (await storage.items(collection)).items)
        await storage.removeVersion(cidOfDigest(item.id));
      dropped = true;
    }
    if (!dropped) return;
    saveCache();
    recordsChanged();
    sync.notifyPeers(connectedPeers());
  }
  // When the app opens the space, then every few hours while it stays open.
  const dropTimer = cache ? setInterval(() => void dropUnused().catch(() => {}), 6 * HOUR) : null;
  const tidying = cache ? dropUnused().catch(() => {}) : Promise.resolve();
  unref(dropTimer);

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
    if (deps.accountOnly && !noteGrants(writer.proof(), accountSpaceRequirement(space.id, collection)))
      throw new Error(NOT_ACCOUNT);
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
        const sealedWith = looksEncrypted(payload) ? sealedKeyId(payload) : null;
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
      ACCESS_COLLECTIONS.has(collection) ||
      // Proof read back whole after anything written over it (\`flagged\`).
      collection === WARRANT_COLLECTION ||
      collection === PROFILE_COLLECTION ||
      collection === BOX_COLLECTION ||
      collection === MEMBER_KEY_COLLECTION ||
      // What a removed carrier was is read back after the delete (`nameKeepers`).
      collection === CARRIER_COLLECTION ||
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

  // ─── Warrants ──────────────────────────────────────────────────────
  //
  // A version the protocol refuses, that no honest writer could have signed —
  // judged as of what it says it had seen — is proof against the account
  // behind its key. A peer that refuses one writes it down for every member,
  // once per account; every peer checks the proof itself (docs/warrants.md).

  type WarrantVerdict = 'holds' | 'false' | 'later' | 'unjudgeable';

  /** Whether a version's account is one the space has known: only those can be warranted, so a stranger minting keys costs nobody a write */
  async function accountable(version: Version): Promise<string | null> {
    const verdict = await judge(version);
    if (!verdict.verified || !verdict.root || version.space !== space.id) return null;
    return (await access()).history.named(verdict.root) ? verdict.root : null;
  }

  /** Views already replayed, by the changes they hold: a set of ids always replays to the same state */
  const views = new Map<string, AccessState>();
  const MAX_VIEWS = 256;

  /**
   * The access state a writer had when it signed: the changes it names as
   * seen and everything they saw, replayed alone. Unlike `history.at`, no
   * change outside them — a rival that arrives late, or a change made later —
   * can alter it, so a verdict on misconduct judged by it is final. Null
   * while one of them hasn't arrived.
   */
  async function ownView(seen: ReadonlyArray<string>): Promise<AccessState | null> {
    const cacheKey = [...new Set(seen)].sort().join(',');
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
    if (views.size >= MAX_VIEWS) views.delete(views.keys().next().value!);
    views.set(cacheKey, state);
    return state;
  }

  /** Whether a version broke a rule of its standing, as of what it had seen: no place, or `who` or `final` against it */
  async function standingBroken(version: Version, root: string): Promise<WarrantVerdict> {
    const state = await ownView(version.seen ?? []);
    if (!state) return 'later';
    return standingBrokenIn(state, version, root);
  }

  /** The same check, in a given state */
  async function standingBrokenIn(
    state: AccessState,
    version: Version,
    root: string,
  ): Promise<WarrantVerdict> {
    if (!isMember(state, root)) return 'holds';
    if (version.collection.startsWith('sys.')) return 'false';
    const found = await rulesAt(state, version.collection);
    if (found?.rules.final && version.seq > 0) return 'holds';
    // An edit's grant may rest on whose record it is; only a first version is judged here.
    if (version.seq !== 0) return 'false';
    const needs = await needsOf(version, version, root);
    return needs(state) ? 'false' : 'holds';
  }

  /** Whether proof of one kind holds: the offending version first, then what checking it needs */
  async function evidenceHolds(kind: string, evidence: ReadonlyArray<Version>): Promise<WarrantVerdict> {
    // A kind this peer doesn't know flags nobody.
    if (!knownKind(kind)) return 'false';
    const [offending, context] = evidence;
    if (!offending || !(await accountable(offending))) return 'false';
    const root = (await judge(offending)).root!;
    switch (kind) {
      case 'chain': {
        if (!context || 'body' in offending || 'body' in context) return 'false';
        if (!(await judge(context)).verified || context.id !== offending.prev) return 'false';
        return chainProblem(offending, context) ? 'holds' : 'false';
      }
      case 'standing':
        if (
          context ||
          'body' in offending ||
          ACCESS_COLLECTIONS.has(offending.collection) ||
          offending.collection === WARRANT_COLLECTION
        )
          return 'false';
        return standingBroken(offending, root);
      case 'access': {
        if (context || !ACCESS_COLLECTIONS.has(offending.collection) || !('body' in offending))
          return 'false';
        const event = await buildEvent(offending);
        if (!event) return 'false';
        const state = await ownView(event.seen);
        if (!state) return 'later';
        return refusal(event, state) ? 'holds' : 'false';
      }
    }
  }

  /** Whether a warrant record proves what it says, against the account its key names, and is its writer's own */
  async function warrantVerdict(version: Version): Promise<WarrantVerdict> {
    const cacheKey = copyKey(version);
    const known = judgedWarrants.get(cacheKey);
    if (known) return known;
    const warrant = await warrantShape(version);
    if (warrant === 'unnamed') return 'false';
    const verdict = warrant ? await evidenceHolds(warrant.kind, warrant.evidence) : 'false';
    // Judged in the offending version's own view, a proof that holds, or fails, always will.
    if (verdict === 'holds' || verdict === 'false') judgedWarrants.set(cacheKey, verdict);
    return verdict;
  }

  /** Warrants already judged: each checked once, not on every look at who is flagged */
  const judgedWarrants = new Map<string, WarrantVerdict>();

  /**
   * A warrant's body, if the version has a warrant's shape: a first version
   * of `std.warrant`, not a delete, and not against its writer. Anything else
   * flags nobody.
   */
  async function warrantShape(version: Version): Promise<Warrant | 'unnamed' | null> {
    if (version.deleted || version.seq !== 0 || version.collection !== WARRANT_COLLECTION) return null;
    const warrant = readWarrant((await openBody(version)).body);
    const offending = warrant?.evidence[0];
    if (!warrant || !offending || !(await judge(offending)).verified) return null;
    // The one answer that can change: the account may be named once more of the history arrives.
    const against = await accountable(offending);
    if (!against) return 'unnamed';
    const by = (await judge(version)).root;
    return by && against !== by ? warrant : null;
  }

  /** The proof a version gives against its account, or null when it gives none */
  async function violationIn(version: Version): Promise<{ kind: WarrantKind; evidence: Version[] } | null> {
    const root = await accountable(version);
    if (!root) return null;
    if (version.seq > 0 && version.prev) {
      const previous = await storage.getVersion(version.prev);
      if (previous && chainProblem(version, previous))
        return { kind: 'chain', evidence: [stubOf(version), stubOf(previous)] };
    }
    if (ACCESS_COLLECTIONS.has(version.collection)) {
      const event = await buildEvent(version);
      const quick = event && (await access()).history.at(event.seen);
      if (!event || (quick && !refusal(event, quick))) return null;
      return (await evidenceHolds('access', [version])) === 'holds'
        ? { kind: 'access', evidence: [version] }
        : null;
    }
    // A warrant is a record like any other: a false one flags nobody, and proves nothing against its writer.
    if (version.collection === WARRANT_COLLECTION) return null;
    // The global view first, which is cheap; the own view, a replay, only for what it finds broken.
    // Proof only the own view would show goes unwritten: a flag missed, never a false one.
    const quick = (await access()).history.at(version.seen ?? []);
    if (quick && (await standingBrokenIn(quick, version, root)) !== 'holds') return null;
    return (await standingBroken(version, root)) === 'holds'
      ? { kind: 'standing', evidence: [stubOf(version)] }
      : null;
  }

  /**
   * Writes down, as this account's own record, the proof a version gives
   * against its account — unless a warrant of its own against that account
   * stands already, so one account's misconduct costs each member one record
   * at a time. It doesn't lean on anyone else's warrant, which would go if
   * its writer were removed. One that can't write leaves it to one that can.
   */
  async function warrantIfDue(version: Version): Promise<void> {
    if (closed || (await cannotWrite())) return;
    // Only an account the history names can be warranted: anything else stops here, for free.
    const root = await accountable(version);
    if (!root || root === deps.rootDid) return;
    // With a warrant of its own against that account standing, its next offences cost nothing to look at.
    if ((await flagged()).some((flag) => flag.account === root && flag.by === deps.rootDid)) return;
    const violation = await violationIn(version);
    // Taken only once there is something to write, so a decoy can't hide an offence behind it.
    if (!violation || warranting.has(root)) return;
    warranting.add(root);
    try {
      if (!(await flagged()).some((flag) => flag.account === root && flag.by === deps.rootDid))
        await warrantOnce(violation);
    } finally {
      warranting.delete(root);
    }
  }

  /** Accounts this node is writing a warrant against now: offences that arrive meanwhile wait for the next */
  const warranting = new Set<string>();

  async function warrantOnce(violation: { kind: WarrantKind; evidence: Version[] }): Promise<void> {
    // Checked again: the space may have closed while the proof was being worked out.
    if (closed) return;
    await upsert(WARRANT_COLLECTION, await newRecordKey(deps.rootDid), violation);
  }

  /** The accounts proven to have broken the protocol's rules here, by the warrants that stand */
  async function flagged(): Promise<ReadonlyArray<FlaggedAccount>> {
    const found: FlaggedAccount[] = [];
    // Each warrant's first version, kept whole, whatever came after it: like any record, anyone
    // may write a later version or a delete, and neither takes the proof back.
    const firsts: Version[] = [];
    for (const current of await storage.queryVersions(WARRANT_COLLECTION))
      for (const version of await storage.history(current.key))
        if (version.seq === 0 && version.collection === WARRANT_COLLECTION) firsts.push(version);
    for (const version of firsts) {
      if (version.deleted || isStub(version) || !(await standingOf(version)).ok) continue;
      // Only proof this peer checked: one that stands unjudged, for want of rules it can't read, flags nobody.
      if ((await warrantVerdict(version)) !== 'holds') continue;
      const warrant = readWarrant((await openBody(version)).body);
      const offending = warrant?.evidence[0];
      const account = offending && (await accountable(offending));
      if (!warrant || !offending || !account || !knownKind(warrant.kind)) continue;
      const by = (await judge(version)).root ?? version.author;
      // One flag per offence and writer, however many records say it.
      if (found.some((flag) => flag.offence === offending.id && flag.by === by)) continue;
      found.push({ account, key: offending.author, kind: warrant.kind, by, offence: offending.id });
    }
    return found;
  }

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
    const written = await upsert(ASSIGN_COLLECTION, await assignKey(did, role), {
      did,
      role,
      assigned,
      ...(Object.keys(cutoff).length ? { cutoff } : {}),
    });
    await changeKeyNow();
    return written;
  }

  /** Removes an account from the space, every role it holds with it: one's own, to leave */
  async function removeAccount(did: string): Promise<NodeRecord<unknown>> {
    const { history } = await access();
    if (!isMember(history.current, did)) throw new Error(`They hold no place in "${space.name}"`);
    const cutoff = await cutoffFor(did);
    const written = await upsert(REMOVE_COLLECTION, await removalKey(did), {
      did,
      ...(Object.keys(cutoff).length ? { cutoff } : {}),
    });
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
    return packCutoff([(await linesOf(new Set([did]), only)).get(did) ?? []]);
  }

  /**
   * At most what a change may carry, shared among the accounts it reaches: one
   * line from each in turn, so no one's writing can use up anyone else's
   * share. What is left out is judged with the change.
   */
  function packCutoff(
    accounts: ReadonlyArray<ReadonlyArray<Version>>,
  ): Record<string, Record<string, number>> {
    const cutoff: Record<string, Record<string, number>> = {};
    let named = 0;
    for (let round = 0; named < MAX_CUTOFF && accounts.some((lines) => round < lines.length); round++)
      for (const lines of accounts) {
        const end = lines[round];
        if (!end || named >= MAX_CUTOFF) continue;
        (cutoff[end.author] ??= {})[end.collection] = end.log!.n;
        named++;
      }
    return cutoff;
  }

  /**
   * The ends of each account's unbroken lines this node holds: defined
   * collections first, then the rest, each in name order. One pass over what
   * it holds, however many accounts.
   */
  async function linesOf(dids: ReadonlySet<string>, only?: string): Promise<Map<string, Version[]>> {
    // What it holds of theirs, whatever way it came: the lines' places are kept only for what arrived by sync.
    const placed = new Map<string, { readonly did: string; readonly held: Map<number, Version> }>();
    const add = (did: string, version: Version) => {
      if (!version.log) return;
      const line = `${version.author} ${version.collection}`;
      const entry = placed.get(line) ?? { did, held: new Map<number, Version>() };
      if (!entry.held.has(version.log.n)) entry.held.set(version.log.n, version);
      placed.set(line, entry);
    };
    for (const version of await everyCurrent()) {
      if (!version.log || (only && version.author !== only) || version.space !== space.id) continue;
      const root = (await judge(version)).root;
      if (root && dids.has(root)) add(root, version);
    }
    for (const name of await adapter.list(KEY_ROOT_PREFIX)) {
      const key = name.slice(KEY_ROOT_PREFIX.length);
      const did = utf8Decode((await adapter.get(name)) ?? new Uint8Array());
      if ((only && key !== only) || !dids.has(did)) continue;
      for (const place of await adapter.list(`${LOG_PREFIX}${key}/`)) {
        const id = await adapter.get(place);
        const version = id ? await storage.getVersion(utf8Decode(id)) : null;
        if (version?.author === key) add(did, version);
      }
    }
    const byAccount = new Map<string, Version[]>();
    for (const { did, held } of placed.values()) {
      let end: Version | null = null;
      for (let n = 0; ; n++) {
        const version = held.get(n);
        if (!version || (n > 0 && version.log?.prev !== end?.id)) break;
        end = version;
      }
      if (end) byAccount.set(did, [...(byAccount.get(did) ?? []), end]);
    }
    // Defined collections first: writing into many undefined ones costs only whoever did.
    const defined = new Set((await catalog()).keys());
    for (const ends of byAccount.values())
      ends.sort(
        (a, b) =>
          Number(defined.has(b.collection)) - Number(defined.has(a.collection)) ||
          (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : a.author < b.author ? -1 : 1),
      );
    return byAccount;
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
      // Someone following a space without a role in it cannot write there, and says nothing.
      if (await cannotWrite()) return;
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
      const contract = definition.contract;
      const shapeProblem = contract !== undefined ? checkContractShape(contract) : null;
      const lineProblem = contract?.line !== undefined ? checkLine(contract.line) : null;
      const problem =
        checkStoredCollection(definition) ??
        (shapeProblem === 'unknown' ? 'contract takes only "check" and "line"' : shapeProblem) ??
        (contract?.check !== undefined
          ? (checkContracts(contract.check, 'contract.check') ??
            // The library's own care, not protocol: a contract that misreads the schema is refused here.
            checkContractTypes(contract.check, definition.schema, 'contract.check'))
          : null) ??
        (lineProblem === 'unknown' ? 'contract.line takes only "once"' : lineProblem) ??
        (definition.computed !== undefined
          ? (checkComputed(definition.computed) ??
            // The library's care, as for contracts: read against the schemas of what it links to.
            checkComputedTypes(definition.name, definition.computed, definition.schema, (name) =>
              name === definition.name ? definition : (described.get(name)?.definition ?? null),
            ))
          : null);
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
      await upsert(STEPDOWN_COLLECTION, await stepDownKey(deps.rootDid), {
        did: deps.rootDid,
        ...(Object.keys(cutoff).length ? { cutoff } : {}),
      });
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
      const taken = new Set<string>();
      let wanted: string | null = null;
      let found: () => void = () => {};
      const onStored = (peer: string, ids: ReadonlyArray<string>) => {
        void peerAccounts.get(peer)?.then(({ account }) => {
          if (account === deps.rootDid) return;
          for (const id of ids) taken.add(id);
          if (wanted !== null && taken.has(wanted)) found();
        });
      };
      // Listening before writing: a peer can answer before the write returns.
      sync.on('stored', onStored);
      try {
        wanted = (await removeAccount(deps.rootDid)).version;
        if (taken.has(wanted)) return true;
        if (waitMs <= 0) return false;
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), waitMs);
          found = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
      } catch {
        // A note that may not change access; another of the account's devices can.
        return false;
      } finally {
        sync.off('stored', onStored);
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

    async openInvite(role: string) {
      const secret = generateInviteSecret();
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
      const taken = new Set<string>();
      let wanted: string | null = null;
      let found: () => void = () => {};
      const onStored = (_peer: string, ids: ReadonlyArray<string>) => {
        for (const id of ids) taken.add(id);
        if (wanted !== null && taken.has(wanted)) found();
      };
      // Listening before writing: a peer can answer before the write returns.
      if (waitMs > 0) sync.on('stored', onStored);
      try {
        const cutoff = await cutoffFor(deps.rootDid, key);
        wanted = (
          await upsert(REVOKE_COLLECTION, await revokeKey(key, deps.rootDid), {
            key,
            ...(Object.keys(cutoff).length ? { cutoff } : {}),
          })
        ).version;
        if (waitMs <= 0 || taken.has(wanted)) return true;
        // With a network configured a peer may still be on its way, through a socket not yet
        // joined or a host not yet reached; with none, nobody can come.
        if (!net) return false;
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), waitMs);
          found = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
      } finally {
        if (waitMs > 0) sync.off('stored', onStored);
      }
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
        accounts: Object.fromEntries(
          [...knownAccounts].flatMap(([peer, known]) =>
            known.account && routes.has(peer) ? [[peer, known.account]] : [],
          ),
        ),
        fingerprint: await storage.fingerprint(),
        rejected,
        holds: partial ? Object.keys(cacheState.used).sort() : ('all' as const),
        pending: (await adapter.list(PENDING_PREFIX)).length,
      };
    },

    use,

    async send(message: unknown, to?: string) {
      const encoded = JSON.stringify(message ?? null);
      if (encoded.length > MAX_LIVE_BYTES) throw new Error('A live message can be at most 64 KB');
      const gone = await formerMembers();
      for (const peer of connectedPeers()) {
        const account = (await peerAccounts.get(peer))?.account ?? null;
        if (to && to !== peer && account !== to) continue;
        // Removed, or left: live messages stop with everything else.
        if (account !== null && gone.has(account)) continue;
        routes.get(peer)?.send(peer, { type: LIVE_MESSAGE, from: session.did, payload: message ?? null });
      }
    },

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
            emit({ type: 'status', space: space.id });
          },
          () => emit({ type: 'status', space: space.id }),
        );
      }
    },

    async close(): Promise<void> {
      closed = true;
      stopWatchingMesh?.();
      if (dropTimer) clearInterval(dropTimer);
      await tidying;
      await flushCache();
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
