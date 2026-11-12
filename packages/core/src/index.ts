/**
 * @minca/core
 * Self-sovereign, peer-to-peer protocol for the browser.
 *
 * Identity via WebAuthn passkeys, data as signed Versions,
 * sync by range-based set reconciliation (Negentropy),
 * and end-to-end encryption for private Spaces.
 *
 * @module @minca/core
 */

// Core types
export type {
  CryptoProvider,
  CryptoKeyPairResult,
  StandardSchemaV1,
  StandardJSONSchemaV1,
  StandardSchemaResult,
  StandardSchemaIssue,
  Version,
  UnsignedVersion,
  Envelope,
  Link,
  Space,
  SpaceRole,
  SpaceTop,
  SpaceGrant,
  SpaceVisibility,
  CollectionDef,
  PeerInfo,
  StorageAdapter,
  BatchOp,
  NetworkMessage,
  Result,
} from './types.js';
export { ok } from './types.js';

// Identity & Key Management
export { createP256Provider } from './identity/crypto-p256.js';
export {
  registerPasskey,
  authenticatePasskey,
  renamePasskey,
  hasPlatformAuthenticator,
} from './identity/webauthn.js';
export type { PasskeyOptions, PasskeyRegistration, PasskeyAuth, AuthOptions } from './identity/webauthn.js';
export {
  generateSeed,
  seedToRecoveryCode,
  isValidRecoveryCode,
  recoveryCodeToSeed,
} from './identity/recovery-code.js';
export { publicKeyToDid, didOf, P256_MULTICODEC } from './identity/did.js';
export { createIdentityManager, rootFromSeed } from './identity/identity-manager.js';
export {
  createFolderAccountStore,
  createBrowserAccountStore,
  accountDataPath,
  newAccountId,
} from './identity/account-store.js';
export type { AccountStore, AccountSummary } from './identity/account-store.js';
export {
  createVault,
  wrapSeedWithDeviceKey,
  unwrapSeedWithDeviceKey,
  wrapSeedWithPassphrase,
  CLI_PASSPHRASE_LABEL,
  unwrapSeedWithPassphrase,
  deriveLocalKey,
  deriveAccountKey,
  deviceWrapsFor,
  withWrap,
} from './identity/account-vault.js';
export {
  deriveContactKeyBytes,
  deriveMemberKeyBytes,
  deriveInboxKeyBytes,
  deriveInboxSignKeyBytes,
  deriveNameKeyBytes,
  contactPublicKey,
} from './identity/contact-key.js';
export { sealEnvelope, openEnvelope, sealValue, openValue } from './identity/envelope.js';
export type { Bound } from './identity/envelope.js';
export { openFrom } from './identity/hpke.js';

export type { AccountVault, SeedWrap, DeviceWrap, PassphraseWrap } from './identity/account-vault.js';
export type { IdentityManager, Identity } from './identity/identity-manager.js';
export { createDeviceKey, getDeviceKey, deleteDeviceKey } from './identity/device-key.js';
export type { DeviceKey } from './identity/device-key.js';
export { createLocalRootSigner } from './identity/root-signer.js';
export type { RootSigner, NoteRequest } from './identity/root-signer.js';

export type { PairingTicket } from './identity/pairing.js';

export type { Channel } from './identity/channel.js';
export { issueDelegation, commandCovers } from './identity/ucan.js';
export type { Delegation, DelegationPayload, IssueOptions } from './identity/ucan.js';

export type { Policy, Statement } from './identity/policy.js';
export { noteTerms, noteSpaces } from './identity/abilities.js';
export type { NoteTerms } from './identity/abilities.js';

// Schema & Data Structures
export { createSchemaEngine } from './schema/schema-engine.js';
export type { SchemaEngine, ValidationResult } from './schema/schema-engine.js';
export { createSigner } from './schema/signer.js';
export type { Signer } from './schema/signer.js';
export { createVersion, canonicalize } from './schema/version.js';

// Local Storage & State

export { createStorageProvider } from './storage/storage-provider.js';
export type { StorageProvider } from './storage/storage-provider.js';

// Storage in a folder the user owns — the one store that is not origin-scoped
export { createFolderAdapter, decodeKey } from './storage/folder-adapter.js';
export type {
  FolderAdapter,
  FolderReload,
  DirectoryHandleLike,
  FileHandleLike,
  WritableFileLike,
} from './storage/folder-adapter.js';

export { reconcileFolder } from './storage/folder-reconcile.js';
export { sqliteStores } from './storage/sqlite-adapter.js';
export type { SqliteDatabase, SqliteStatement, SqliteStores, SqliteValue } from './storage/sqlite-adapter.js';
export type { FolderReconciliation } from './storage/folder-reconcile.js';
export {
  isFolderStorageAvailable,
  pickDataFolder,
  queryFolderPermission,
  ensureFolderPermission,
  rememberDataFolder,
  recallDataFolder,
  forgetDataFolder,
} from './storage/directory-access.js';
export type { FolderAccessMode } from './storage/directory-access.js';

// Spaces
export { parseSpaceInvite } from './space/space-manager.js';
export { openPass } from './space/pass.js';

export {
  checkStoredCollection,
  isStoredCollection,
  schemaProblem,
  toJsonSchema,
  collection,
} from './schema/collection-def.js';
export type {
  StoredCollection,
  JsonSchema,
  SchemaIssue,
  CollectionDefinition,
} from './schema/collection-def.js';
export { titleField, recordTitle, quickAddBody } from './schema/quick-add.js';
export type { Membership } from './space/account-registry.js';
export type { SpaceInvite } from './space/space-manager.js';
export { deriveReadKey, revokeKey } from './space/space-access.js';
export { CONSTITUTION, spaceIdOf } from './space/constitution.js';
export type { Constitution } from './space/constitution.js';
export { replayAccess, may, isMember, rolesOf, readers, checkRelays, MAX_RELAYS } from './space/roles.js';
export type {
  RoleDefinition,
  Needs,
  AccessEvent,
  AccessGenesis,
  AccessHistory,
  AccessState,
  EventStatus,
  RecordVerdict,
} from './space/roles.js';
export { rolePresets, solo, team, community, coop, STAFF_COLLECTIONS } from './space/presets.js';
// Grants: what a role may do (spec 03 §2)
export {
  RECORD_READ,
  RECORD_WRITE,
  RECORD_DELETE,
  COLLECTION_DEFINE,
  MEMBER_REMOVE,
  ROLE_DEFINE,
  ROLE_ASSIGN,
  ROLE_UNASSIGN,
  KEY_CHANGE,
  SPACE_RELAYS,
  SPACE_CARRIERS,
  grantFits,
} from './space/grants.js';
export type { FoundingRole } from './space/grants.js';
export { displayName } from './space/names.js';
export type { RolePreset } from './space/presets.js';
export type { SpaceKeyPair } from './space/space-access.js';

// P2P Networking

export type { RelayState, RelayStatus } from './network/relay-socket.js';

export type { MessagePortLike } from './utils/port.js';

export { createClientAuth, createServerAuth, peerNonce } from './network/peer-auth.js';
export type { ClientAuth, ServerAuth } from './network/peer-auth.js';
export type { PeerTransport, PeerTransportEvents, SignalledTransport } from './network/transport.js';
export { createMesh } from './network/mesh.js';
export type { Mesh, MeshConfig, MeshStatus, PendingConnection } from './network/mesh.js';

export type { NetworkManager, NetworkEvents } from './network/network-manager.js';

// Gossip/Sync Protocol

export type { Item, Round, Sum } from './sync/negentropy.js';

// Validation

// Encryption & Privacy
export { generateSpaceKey } from './privacy/space-encryption.js';

export type { SpaceKey } from './privacy/space-encryption.js';

// Utilities
export {
  base64UrlEncode,
  base64UrlDecode,
  utf8Encode,
  utf8Decode,
  concatBytes,
  bytesToHex,
} from './utils/encoding.js';
export { sha256 } from './utils/hash.js';
export { protocolError, isProtocolError } from './utils/errors.js';
export type { ProtocolError, ProtocolErrorCode } from './utils/errors.js';
export { createEmitter, createListeners } from './utils/events.js';
export type { Emitter } from './utils/events.js';

// Files: how much of others' files a device fetches ahead and keeps
export { DEVICE_LIMITS } from './files/space-files.js';
export type { FileLimits } from './files/space-files.js';

// Node: identity + spaces + sync, behind one API
export {
  MAX_PROPOSALS,
  checkAppAutomation,
  checkOwnAutomation,
  holdsFor,
  setsOff,
} from './space/own-automations.js';

// Queries: plain-data filters, sorting, paging and includes over a space
export { runQuery } from './query/engine.js';
export { computedSchemas, causeOf, linkedReads, namedComputed } from './query/computed.js';
export { serial } from './utils/serial.js';
export type { ComputedFields, ComputedValues } from './query/computed.js';
export type { ComputedIn, FilterOf, IncludeMap, ResultFor, SortOf, TypedFilter } from './query/types.js';
export type { QuerySource } from './query/engine.js';
export { matches, checkQuery, checkFilter, type FilterSubject } from './query/filter.js';
export type {
  Query,
  Filter,
  Operators,
  Include,
  SortDirection,
  QueryRecord,
  QueryResult,
  CollectionRef,
  Typed,
  BodyOf,
  IncludedOf,
  AnyIncluded,
} from './query/types.js';
export { plainQuery, nameOf } from './query/types.js';

// Rules: who may create, edit and delete a collection's records, what must be unique,
// and the conditions a version must meet, with the versions it cites
export { onePerKey } from './records/rules.js';
// Keys: whose a record is (spec 02 §4.1)
export { keyKind, lineKey, ownedKey } from './records/key.js';
export { describeCollection } from './records/describe.js';
export type { CollectionRules } from './records/rules.js';
export type { Contract, Condition, CollectionContract, Line } from './records/contracts.js';
export type { LinkDeclaration } from './records/links.js';
export { contractCostHints, checkContractShape, runContracts } from './records/contracts.js';
// Contracts written in TypeScript, typed from the collection's schema, built into CEL
export { contract, storedComputed, storedContract } from './records/contract-builder.js';
export type {
  CelExpr,
  CelInt,
  Cited,
  ContractContext,
  ComputedContext,
  ComputedOf,
  ComputedResult,
  BoolLike,
  RolesTo,
  Expr,
  BoolExpr,
  NumExpr,
  IntExpr,
  StrExpr,
  ListExpr,
  ObjExpr,
  VersionExpr,
  DynExpr,
} from './records/contract-builder.js';
/** Conditions over one record: an automation's `where`, and an app's own filters */

// Hosting: a subscription key, signed requests to a host, and a client for one
export {
  newSubscriptionSeed,
  subscriptionKey,
  signRequest,
  verifyRequest,
  createHostClient,
  describeHost,
  signStatus,
  readStatus,
  createSpaceHostClient,
  readPayAnswer,
  HOST_DESCRIPTION_PATH,
  HostError,
} from './session/hosting.js';
export type {
  Hosting,
  SubscriptionKey,
  HostStatus,
  SignedStatus,
  HostDescription,
  HostedBot,
  FundOffer,
  FundLine,
  HostConnectorOffer,
  FundPayment,
  PayAnswer,
  HostClient,
  SpaceHostClient,
  HostLimits,
  OverSpace,
  SpaceUsage,
} from './session/hosting.js';

// Mirrors: a space kept in a dumb file store — a bucket, an app folder — synced like a peer
export type { BlobStore } from './storage/blob-store.js';
export { createMemoryBlobStore } from './storage/blob/memory.js';
export { createS3BlobStore } from './storage/blob/s3.js';
export { createDirectoryBlobStore } from './storage/blob/directory.js';
export type { S3Config } from './storage/blob/s3.js';
export { deleteMirrored } from './storage/mirror.js';
export type { Taken } from './storage/mirror.js';
export * from './node/index.js';
