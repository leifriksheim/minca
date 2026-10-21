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
  SyncState,
  StorageAdapter,
  BatchOp,
  NetworkMessage,
  Result,
} from './types.js';
export { ok, err } from './types.js';

// Phase 1: Identity & Key Management
export { createP256Provider } from './identity/crypto-p256.js';
export {
  registerPasskey,
  authenticatePasskey,
  renamePasskey,
  hasPlatformAuthenticator,
} from './identity/webauthn.js';
export type { PasskeyOptions, PasskeyRegistration, PasskeyAuth, AuthOptions } from './identity/webauthn.js';
export {
  generateRecoveryCode,
  generateSeed,
  seedToRecoveryCode,
  normalizeRecoveryCode,
  isValidRecoveryCode,
  recoveryCodeToSeed,
  RECOVERY_SEED_BYTES,
} from './identity/recovery-code.js';
export { publicKeyToDid, didToPublicKey, didOf, P256_MULTICODEC } from './identity/did.js';
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
  PASSPHRASE_ITERATIONS,
} from './identity/account-vault.js';
export {
  deriveContactKeyBytes,
  deriveDoorKeyBytes,
  deriveDoorSignKeyBytes,
  contactKeyPair,
  contactPublicKey,
  isContactPublicKey,
} from './identity/contact-key.js';
export { sealEnvelope, openEnvelope, sealValue, openValue } from './identity/envelope.js';
export type { Bound } from './identity/envelope.js';
export { sealTo, openFrom, sealValueTo, openValueFrom } from './identity/hpke.js';
export type { ContactKeyPair } from './identity/contact-key.js';
export type { AccountVault, SeedWrap, DeviceWrap, PassphraseWrap } from './identity/account-vault.js';
export type { IdentityManager, Identity } from './identity/identity-manager.js';
export { createDeviceKey, getDeviceKey, deleteDeviceKey } from './identity/device-key.js';
export type { DeviceKey } from './identity/device-key.js';
export { createLocalRootSigner } from './identity/root-signer.js';
export type { RootSigner, NoteRequest } from './identity/root-signer.js';
export {
  newPairingSecret,
  pairingCommitment,
  pairingCode,
  encodePairingTicket,
  decodePairingTicket,
} from './identity/pairing.js';
export type { PairingTicket } from './identity/pairing.js';
export {
  channelRoom,
  channelKeyPair,
  deriveChannel,
  PAIRING_CHANNEL,
  CODE_CHANNEL,
} from './identity/channel.js';
export type { Channel, ChannelKind, ChannelSide } from './identity/channel.js';
export {
  DELEGATION_TYPE,
  issueDelegation,
  parseDelegation,
  verifyDelegation,
  verifyNote,
  noteCovers,
  delegationId,
  commandCovers,
  isCommand,
} from './identity/ucan.js';
export type {
  Delegation,
  DelegationPayload,
  Requirement,
  IssueOptions,
  VerifyOptions,
  Verified,
  NoteCheck,
} from './identity/ucan.js';
export { evaluatePolicy, policyProblem } from './identity/policy.js';
export type { Policy, Statement } from './identity/policy.js';
export {
  ALL_COMMAND,
  RECORDS_COMMAND,
  WRITE_COMMAND,
  READ_COMMAND,
  DEFINE_COMMAND,
  ACCESS_COMMAND,
  ACCOUNT_COMMAND,
  noteGrants,
  noteTerms,
  noteSpaces,
  writeRequirement,
  grantsRecordsOnly,
} from './identity/abilities.js';
export type { NoteTerms } from './identity/abilities.js';

// Phase 2: Schema & Data Structures
export { createSchemaEngine } from './schema/schema-engine.js';
export type { SchemaEngine, ValidationResult } from './schema/schema-engine.js';
export { createSigner } from './schema/signer.js';
export type { Signer } from './schema/signer.js';
export { createVersion, canonicalize, getVersionId, signedPart } from './schema/version.js';

// Phase 3: Local Storage & State
export { createIndexedDBAdapter } from './storage/indexeddb-adapter.js';
export { createStorageProvider } from './storage/storage-provider.js';
export type { StorageProvider } from './storage/storage-provider.js';

// Storage in a folder the user owns — the one store that is not origin-scoped
export { createFolderAdapter, readFolderFile, writeFolderFile } from './storage/folder-adapter.js';
export type {
  FolderAdapter,
  FolderReload,
  DirectoryHandleLike,
  FileHandleLike,
  WritableFileLike,
} from './storage/folder-adapter.js';
export { createEncryptedAdapter, DEFAULT_ENCRYPTED_PREFIXES } from './storage/encrypted-adapter.js';
export type { EncryptedAdapterOptions } from './storage/encrypted-adapter.js';
export { reconcileFolder } from './storage/folder-reconcile.js';
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
export { createSpaceManager, parseSpaceInvite } from './space/space-manager.js';
export {
  deriveAccountRegistry,
  deriveContactsSpace,
  MEMBERSHIP_COLLECTION,
} from './space/account-registry.js';
export {
  CATALOG_COLLECTION,
  checkStoredCollection,
  checkPublishableSchema,
  validateJsonSchema,
  asStandardSchema,
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
export type {
  SpaceManager,
  SpaceRecord,
  SpaceInvite,
  InviteLinkOptions,
  CreateSpaceParams,
} from './space/space-manager.js';
export {
  generateInviteSecret,
  deriveInviteKey,
  deriveReadKey,
  assignKey,
  removalKey,
  stepDownKey,
  succeedKey,
  inviteKey,
  revokeKey,
  roleKey,
  signInvite,
  verifyInvite,
} from './space/space-access.js';
export {
  CONSTITUTION,
  constitutionOf,
  constitutionProblem,
  spaceIdOf,
  checkSpace,
  foundersOf,
  accessGenesisOf,
} from './space/constitution.js';
export type { Constitution } from './space/constitution.js';
export {
  replayAccess,
  may,
  isMember,
  rolesOf,
  readers,
  checkRelays,
  MAX_RELAYS,
  ROLE_COLLECTION,
  ASSIGN_COLLECTION,
  REMOVE_COLLECTION,
  INVITE_COLLECTION,
  REVOKE_COLLECTION,
  STEPDOWN_COLLECTION,
  SUCCEED_COLLECTION,
  STRONG_REMOVE,
  ACCESS_COLLECTIONS,
} from './space/roles.js';
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
  SPACE_KEEPERS,
  SPACE_SUCCEED,
  checkFoundingRoles,
  grantFits,
} from './space/grants.js';
export type { FoundingRole } from './space/grants.js';
export { displayName } from './space/names.js';
export type { RolePreset } from './space/presets.js';
export type { SpaceKeyPair } from './space/space-access.js';

// Phase 4: P2P Networking
export { createSignalingClient, CLOSE_DID_TAKEN } from './network/signaling.js';
export { createMultiSignalingClient } from './network/multi-signaling.js';
export {
  isControlMessage,
  shouldInitiate,
  createSeenSignals,
  signalId,
  MAX_HOPS,
  PEERS_MESSAGE,
  SIGNAL_MESSAGE,
} from './network/introductions.js';
export type { RelayedSignal, SeenSignals } from './network/introductions.js';
export { createRTCTransport } from './network/rtc-transport.js';
export { serveTransport, remoteTransport } from './network/remote-transport.js';
export type { MessagePortLike } from './utils/port.js';
export { createWebSocketTransport } from './network/ws-transport.js';
export type { WebSocketTransportConfig } from './network/ws-transport.js';
export { createClientAuth, createServerAuth, createMeshAuth, peerNonce } from './network/peer-auth.js';
export type { ClientAuth, ServerAuth } from './network/peer-auth.js';
export type {
  PeerTransport,
  PeerTransportEvents,
  SignalledTransport,
  CandidateSink,
} from './network/transport.js';
export { createMesh } from './network/mesh.js';
export type { Mesh, MeshConfig, MeshStatus, PendingConnection } from './network/mesh.js';
export { createNetworkManager } from './network/network-manager.js';
export type { NetworkManager, NetworkManagerConfig, NetworkEvents } from './network/network-manager.js';
export type {
  SignalingClient,
  SignalingMessage,
  SignalKind,
  RelayState,
  RelayStatus,
} from './network/signaling.js';

// Phase 5: Gossip/Sync Protocol
export { parseSyncMessage, SYNC_PROTOCOL_VERSION } from './sync/sync-messages.js';
export type { SyncMessage } from './sync/sync-messages.js';
export { createReconciler, ItemSet, fingerprintOf } from './sync/negentropy.js';
export type { Item, Round, Sum } from './sync/negentropy.js';
export { createSyncEngine } from './sync/sync-engine.js';
export type { SyncEngine, SyncEngineConfig, IncomingValidation } from './sync/sync-engine.js';

// Phase 6: Validation
export { createCryptoGate } from './validation/crypto-gate.js';
export { createCapabilityGate } from './validation/capability-gate.js';
export type { CapabilityGate, CapabilityGateConfig } from './validation/capability-gate.js';
export { createVersionCheck } from './validation/check-version.js';

// Phase 7: Encryption & Privacy
export {
  generateSpaceKey,
  spaceKeyFromRaw,
  sealBody,
  openBody,
  isSealedBody,
} from './privacy/space-encryption.js';
export { sealDirect, openDirect, directBound, directRecipients, MAX_DIRECT_TO } from './privacy/direct.js';
export type { DirectBody, DirectContent } from './privacy/direct.js';
export type { SpaceKey, EncryptedVersionBody, BodyPlace } from './privacy/space-encryption.js';

// Utilities
export {
  base64UrlEncode,
  base64UrlDecode,
  utf8Encode,
  utf8Decode,
  concatBytes,
  bytesToHex,
  hexToBytes,
} from './utils/encoding.js';
export { sha256, cidFromBytes } from './utils/hash.js';
export { protocolError, isProtocolError } from './utils/errors.js';
export type { ProtocolError, ProtocolErrorCode } from './utils/errors.js';
export { createEmitter } from './utils/events.js';
export type { Emitter } from './utils/events.js';

// Node: identity + spaces + sync, behind one API
export {
  createNode,
  serveNode,
  remoteNode,
  serveSigner,
  remoteSigner,
  startNodeInWorker,
  SESSION_COMMAND,
  relayRoom,
  indexedDBStores,
  folderStores,
  directoryStores,
  browserWriterKeys,
  copyAccountData,
  NODE_ACTIONS,
  runAction,
  callAction,
  offeredActions,
  PEER_CONTENT_NOTE,
  PERSON_ONLY,
  checkActionInput,
  createCarrierNode,
  createHostNode,
  spaceSubscription,
  NotAllowedError,
  watchNotifications,
} from './node/index.js';
/** How many automations one proposal to the home may offer */
export { MAX_PROPOSALS } from './space/own-automations.js';
/** Why an app's "worth hearing about" entry can't be offered, or null */
export { checkAppAutomation, checkOwnAutomation, ownQuery } from './space/own-automations.js';
export type {
  StoreFactory,
  WriterKeySource,
  ClaimedWriter,
  HeadStore,
  StoreOptions,
  CopyAccountParams,
  CopyResult,
  NodeAction,
  ActionSchema,
  P2PNode,
  NodeConfig,
  WorkerNodeConfig,
  WorkerStores,
  WorkerLike,
  NodeNetworkConfig,
  NodeSpaces,
  NodeRecords,
  FileRef,
  NodeRecord,
  NodeEvent,
  NodeNetwork,
  SpaceSummary,
  SpaceStatus,
  SpaceAccess,
  CarrierSummary,
  SpaceProfile,
  NewSpace,
  InvitePreview,
  ListOptions,
  InviteOptions,
  ConnectionState,
  NodeCollection,
  NodeCollections,
  DefineCollection,
  NodeAccount,
  AccountProfileView,
  NodeContacts,
  NodeDirect,
  DirectMessage,
  ContactView,
  ContactRequest,
  NodeDoors,
  DoorView,
  KnockView,
  SentKnockView,
  CarrierConfig,
  CarrierNode,
  CarriedSpace,
  CarrierEvent,
  HostConfig,
  HostNode,
  NodeHosting,
  HostingView,
  SpaceHostingView,
  Subscription,
  SubscriptionState,
  Keeper,
  CacheConfig,
  NodeAutomations,
  OwnAutomationView,
  AutomationProposal,
  AppAutomation,
  Wake,
  WakeView,
  NotifyMatch,
  WatchNotificationsOptions,
} from './node/index.js';

// Queries: plain-data filters, sorting, paging and includes over a space
export { runQuery } from './query/engine.js';
export { checkComputed, computedSchemas } from './query/computed.js';
export type { ComputedFields, ComputedValues } from './query/computed.js';
export type {
  ComputedIn,
  FilterOf,
  IncludeMap,
  OperatorsFor,
  ResultFor,
  SortOf,
  TypedFilter,
} from './query/types.js';
export type { QuerySource } from './query/engine.js';
export {
  matches,
  checkQuery,
  checkFilter,
  fieldValue,
  MAX_INCLUDE_DEPTH,
  type FilterSubject,
} from './query/filter.js';
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
  ResultOf,
} from './query/types.js';
export { plainQuery } from './query/types.js';

// Rules: who may create, edit and delete a collection's records, what must be unique,
// and the conditions a version must meet, with the versions it cites
export { checkRules, onePerKey, onePerSecret } from './records/rules.js';
// Keys: whose a record is (spec 02 §4.1)
export { keyKind, lineKey, ownedKey } from './records/key.js';
export { describeCollection } from './records/describe.js';
export type { CollectionRules } from './records/rules.js';
export type { Contract, Condition, CollectionContract, Line } from './records/contracts.js';
export { contractCostHints } from './records/contracts.js';
// Contracts written in TypeScript, typed from the collection's schema, built into CEL
export { contract } from './records/contract-builder.js';
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
  HOSTING_COLLECTION,
  REQUEST_WINDOW_SECONDS,
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
  hostLimits,
  overSpaces,
  HOST_DESCRIPTION_PATH,
  HostError,
} from './session/hosting.js';
export type {
  Hosting,
  SubscriptionKey,
  HostStatus,
  SignedStatus,
  HostDescription,
  HostPlan,
  HostedBot,
  FundOffer,
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
export { createMirror, deleteMirrored } from './storage/mirror.js';
export type { Mirror, MirrorConfig, Taken } from './storage/mirror.js';
