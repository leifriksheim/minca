/**
 * @module node/types
 * The shape of a node. Everything a method returns is JSON-serialisable: the
 * same calls cross a port, and are actions for a CLI, MCP and WebMCP.
 */
import type { MailboxClient } from '../network/relays.js';
import type { BodyOf, CollectionRef, IncludeMap, Query, ResultFor } from '../query/types.js';
import type { CollectionRules } from '../records/rules.js';
import type { CollectionContract, Contract, Line } from '../records/contracts.js';
import type { ComputedFields } from '../query/computed.js';
import type { ComputedResult } from '../records/contract-builder.js';
import type {
  CollectionDef,
  CryptoProvider,
  Version,
  Link,
  SpaceGrant,
  SpaceRole,
  SpaceVisibility,
  StandardJSONSchemaV1,
} from '../types.js';
import type { LinkDeclaration } from '../records/links.js';
import type { RootSigner } from '../identity/root-signer.js';
import type { Delegation } from '../identity/ucan.js';
import type { PeerTransport, SignalledTransport } from '../network/transport.js';
import type { MeshStatus } from '../network/mesh.js';
import type { ServerAuth } from '../network/peer-auth.js';
import type { WriterKeySource } from './writer-keys.js';
import type { StoreFactory } from './stores.js';
import type { JsonSchema, SchemaIssue } from '../schema/collection-def.js';
import type { Keeper } from '../space/roles.js';
import type { Automation } from '../schemas/automations.js';
import type {
  FundOffer,
  FundPayment,
  HostConnectorOffer,
  HostStatus,
  HostedBot,
  OverSpace,
  PayAnswer,
} from '../session/hosting.js';

export interface NodeNetworkConfig {
  /** Relays for WebRTC, browsers only. Each space meets in the room named after its id. */
  readonly relays?: ReadonlyArray<string>;
  /** Always-on nodes to hold a socket to, `wss://host/peer#<DID>` (spec 04 §5.2); the space id is appended */
  readonly nodes?: ReadonlyArray<string>;
  /** Hosts to look for the account registry at, so a new device with only the recovery code finds its spaces */
  readonly hosts?: ReadonlyArray<string>;
  readonly iceServers?: ReadonlyArray<RTCIceServer>;
  /** How WebRTC connections are made; a node in a worker passes `remoteTransport` */
  readonly createTransport?: (iceServers: () => ReadonlyArray<RTCIceServer>) => SignalledTransport;
  /** Extra transports per space, given this node's session DID: for a node serving sockets, or a test */
  readonly transports?: (spaceId: string, sessionDid: string) => ReadonlyArray<PeerTransport>;
}

export interface NodeConfig {
  /** Who this node acts for. The root key only signs session delegations. */
  readonly signer: RootSigner;
  /** The account key (`deriveAccountKey(seed)`): the node then follows the account registry */
  readonly accountKey?: Uint8Array;
  /** The account's contact key (`deriveContactKeyBytes(seed)`), to open contact requests and knocks */
  readonly contactKey?: Uint8Array;
  /** The account's contacts space, for a node given it without the account key */
  readonly contactsSpace?: string;
  /**
   * The account's name as a grant gives it: what knocks and a new inbox say
   * until the account's profile reaches this node from its registry
   */
  readonly accountName?: string;
  /** How the inbox and short links reach mailboxes. Default: `createMailboxClient` */
  readonly mailbox?: MailboxClient;
  /** Where the registry and each space's store live */
  readonly stores: StoreFactory;
  readonly provider?: CryptoProvider;
  /** Collection shapes to use where a space has none: checked on write, flagged (`conforms`) on read, never refused */
  readonly collections?: ReadonlyArray<CollectionDef>;
  /** Omit to stay offline */
  readonly network?: NodeNetworkConfig;
  /** Seconds each session delegation lasts; renewed before it runs out. Default 3600. */
  readonly sessionTtlSeconds?: number;
  /** The key to sign with, when the signer already named it. Default: one claimed from `writerKey`, else a fresh one */
  readonly sessionKey?: CryptoKeyPair;
  /** Where to keep a signing key across runs (`browserWriterKeys`). Without one, each run makes a new key. */
  readonly writerKey?: WriterKeySource;
  /** How often to look for another process's writes to a folder store, ms. 0 disables. Default 2000. */
  readonly watchIntervalMs?: number;
  /**
   * Fetch and keep every file of any size, as a keeper does. Default: others'
   * files up to 5 MiB, dropping the least used past 256 MiB a space (spec 05 §16.6).
   */
  readonly fetchFiles?: 'all';
  /** Hold only the collections this node uses, once a space names a keeper to hold the rest */
  readonly cache?: CacheConfig;
}

/** How a node holds part of a space: its own choice */
export interface CacheConfig {
  /** Collections this app uses: held from the start, and dropped last */
  readonly collections?: ReadonlyArray<string>;
  /** Drop a collection no query touched for this many days, unless it holds unsent writes. Default 30. */
  readonly unusedAfterDays?: number;
  /** How many keepers a write must reach before it can be dropped; only raises the space's `copies` (default 2) */
  readonly copies?: number;
}

/** A space, as the node describes it. Never carries the key. */
export interface SpaceSummary {
  readonly id: string;
  readonly name: string;
  readonly visibility: SpaceVisibility;
  /** Its founders, as its constitution names them; some may have stepped down since (`access`) */
  readonly founders: ReadonlyArray<string>;
  /** The space it succeeds, as its constitution says */
  readonly succeeds?: string;
  readonly createdAt: string;
  /** Whether this node can read the space: public, or private with the key */
  readonly readable: boolean;
  /** Whether this account holds a role here, and so may write */
  readonly writable: boolean;
  /** What this account is here: `founder`, a role it holds by name, or null when it holds none */
  readonly role: string | null;
  /** Whether an invite is waiting to be used: its record has not arrived yet */
  readonly joining: boolean;
}

export interface NewSpace {
  readonly name: string;
  /** `private` encrypts every body with the space key */
  readonly visibility: SpaceVisibility;
  /** The roles it is founded with (`rolePresets` has some). Default: none */
  readonly roles?: ReadonlyArray<SpaceRole>;
  /** `founders` (default): you and any `cofounders` hold every command. `none`: you hold only `creatorRoles` */
  readonly top?: 'founders' | 'none';
  /** Under `top: founders`, accounts that found it with you */
  readonly cofounders?: ReadonlyArray<string>;
  /** Roles the constitution gives you. Under `top: none` you need one */
  readonly creatorRoles?: ReadonlyArray<string>;
  /** The space this one succeeds; name it there too, with `spaces.succeed` */
  readonly succeeds?: string;
}

export interface InvitePreview {
  readonly space: Pick<SpaceSummary, 'id' | 'name' | 'visibility' | 'founders' | 'createdAt' | 'succeeds'>;
  readonly invitedBy: string;
  /** Whether the invite carries the key to a private space */
  readonly carriesKey: boolean;
  /** Whether the invite gives a role: false for a view-only one */
  readonly carriesWrite: boolean;
  /** The role it is for, as the link says; the space's invite record is what counts */
  readonly role: string | null;
  /** For a short link: when its inviter stops sharing it, ms */
  readonly until?: number;
}

export interface InviteOptions {
  /** The role it gives. Default: the lowest below yours, or view-only */
  readonly role?: string;
  /** False for a view-only invite: the key, and no role */
  readonly write?: boolean;
  /** A short link, the rest sealed in mailboxes (spec 03 §7.7); the long form when no mailbox takes it */
  readonly short?: boolean;
  /** For a short link: when to stop sharing it, ms. Closing the invite is what ends it. */
  readonly until?: number;
}

/** Who holds what in a space, now */
export interface SpaceAccess {
  /** The space's roles, each with its current definitions (rivals hold what they share) */
  readonly roles: ReadonlyArray<SpaceRoleView>;
  /** Everyone with a place: the founders, and every account assigned a role */
  readonly members: ReadonlyArray<{
    readonly did: string;
    readonly founder: boolean;
    readonly roles: ReadonlyArray<string>;
  }>;
  /** Open and closed invites, by their public key */
  readonly invites: ReadonlyArray<{ readonly key: string; readonly role: string; readonly open: boolean }>;
  /** Whether this account is a founder that has not stepped down */
  readonly founder: boolean;
  /** `founders` or `none`, as the constitution says */
  readonly top: 'founders' | 'none';
  /** No founder is left and no member may change roles: only a successor helps (`spaces.succeed`) */
  readonly headless: boolean;
  /** Spaces named as successors, and who named each. In no order: which to follow is each member's choice. */
  readonly successors: ReadonlyArray<{ readonly space: string; readonly by: ReadonlyArray<string> }>;
  /** The roles assigned to this account, by name */
  readonly mine: ReadonlyArray<string>;
  /** The latest access changes held: what a record written now names as `seen` */
  readonly heads: ReadonlyArray<string>;
  /** A private space's key: how often it changed, and whether this device holds the current one */
  readonly key: { readonly changes: number; readonly held: boolean } | null;
  /** Where members meet: the relays it names, else the ones its invite did */
  readonly relays: ReadonlyArray<string>;
  /** The nodes that keep the space whole: a host, an extension */
  readonly keepers: ReadonlyArray<Keeper>;
  /** How many keepers a write should reach before it may be dropped; null for the default */
  readonly copies: number | null;
  /** Keys proven to have forked their line in a collection; what they signed from `from` on no longer counts (spec 02 §4.10) */
  readonly forks: ReadonlyArray<{
    readonly writer: string;
    readonly collection: string;
    readonly from: number;
  }>;
  /** Accounts a checked warrant proves signed what no honest writer could (spec 03 §6.6), for managers to see */
  readonly flagged: ReadonlyArray<FlaggedAccount>;
}

/** A role as the history has it now */
export interface SpaceRoleView {
  readonly name: string;
  readonly title?: string;
  readonly definitions: ReadonlyArray<{
    /** The definition's id; the space id for the constitution's */
    readonly event: string;
    /** Who wrote it; null for the constitution's */
    readonly by: string | null;
    readonly grants: ReadonlyArray<SpaceGrant>;
    readonly nests: ReadonlyArray<string>;
  }>;
}

/** An account a warrant stands against */
export interface FlaggedAccount {
  readonly account: string;
  /** The key that signed it: one device or app of theirs */
  readonly key: string;
  /** What it broke: `chain`, `standing` or `access` */
  readonly kind: string;
  /** The account that brought the proof */
  readonly by: string;
  /** The id of the offending version */
  readonly offence: string;
}

/** A record, opened and checked: its current version, unless listed as history */
export interface NodeRecord<T = unknown> {
  /** The record's identity, the same across edits; links point here */
  readonly key: string;
  /** This version's id: a content hash */
  readonly version: string;
  /** 0 for the first version, one more for each edit */
  readonly seq: number;
  readonly space: string;
  readonly collection: string;
  /** The key that signed this version, usually a session key */
  readonly author: string;
  /** The identity that key was acting for, when its delegation checks out */
  readonly root: string | null;
  /** The identity that created the record, when its first version is held */
  readonly createdBy: string | null;
  /** When it was created, by its creator's clock: for display only */
  readonly createdAt: string;
  /** When this version was written: for display only */
  readonly updatedAt: string;
  /** The content, or null when it is encrypted and this node has no key */
  readonly body: T | null;
  /** What this record points at; empty when it can't be opened */
  readonly links: ReadonlyArray<Link>;
  readonly encrypted: boolean;
  /** Signature, delegation and shape all check out */
  readonly verified: boolean;
  /** Signed under a note that grants writing records and no more: an app running records as code trusts only versions without it */
  readonly recordsOnly?: true;
  readonly reason?: string;
  /** This version deletes the record (listed only with `includeDeleted`) */
  readonly deleted?: true;
  /** Whether the body fits its collection's schema; null when there is none or it can't be opened. A misfit still syncs. */
  readonly conforms: boolean | null;
  readonly issues?: ReadonlyArray<SchemaIssue>;
}

/** A collection as a space describes it, and how many records it holds */
export interface NodeCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** Null when records exist but the space has no definition for them */
  readonly schema: JsonSchema | null;
  readonly version: number | null;
  /** Whether edits keep old versions: `all`, or `latest` (the default) */
  readonly history: 'latest' | 'all';
  /** The link roles its records carry, and what each may point at */
  readonly links: Readonly<Record<string, LinkDeclaration>>;
  /** The identity that first defined it */
  readonly definedBy: string | null;
  /** What must be unique, which fields are fixed */
  readonly rules: CollectionRules;
  /** What a version must be to count, judged by readers; absent when it has none */
  readonly contract?: CollectionContract;
  /** Values derived from what links to its records; absent when it has none */
  readonly computed?: ComputedFields;
  /** Fields whose values are tagged on each record's outside, so keepers can match them unread */
  readonly topics: ReadonlyArray<string>;
  readonly records: number;
}

export interface DefineCollection {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** JSON Schema in the supported subset, or a Standard JSON Schema validator */
  readonly schema: JsonSchema | StandardJSONSchemaV1;
  /** Default: one past the current version, or 1 */
  readonly version?: number;
  /** Keep every version (`all`), or only the current one (`latest`, the default) */
  readonly history?: 'latest' | 'all';
  /** The link roles its records may carry, and what each may point at */
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  /** What must be unique, which fields are fixed, whether records are written once: every peer checks */
  readonly rules?: CollectionRules;
  /** Fields whose values are topics, like `channel`, so a keeper can match them unread */
  readonly topics?: ReadonlyArray<string>;
  /** What a version must be to count, judged by readers: `check` conditions and a `line` (packages/core/docs/contracts.md) */
  readonly contract?:
    | CollectionContract
    | {
        readonly check?: ReadonlyArray<Contract> | ((scope: never) => Readonly<Record<string, unknown>>);
        readonly line?: Line;
      };
  /** Values derived from what links to its records (packages/core/docs/computed.md) */
  readonly computed?: ComputedFields | ((scope: never) => ComputedResult);
}

export interface NodeCollections {
  /** What a space holds: every defined collection, and every collection with records */
  list(spaceId: string): Promise<ReadonlyArray<NodeCollection>>;
  /** Publishes a definition into the space, as a signed record that syncs like any other */
  define(spaceId: string, definition: DefineCollection): Promise<NodeCollection>;
  /** Takes a definition out of the space; refused while the collection still has records */
  delete(spaceId: string, name: string): Promise<void>;
  /** The topic tag a record with this value carries; keyed in a private space, so only members can work it out */
  tag(spaceId: string, collection: string, field: string, value: string | number | boolean): Promise<string>;
}

/** A version under its collection's contract: `passes` null when it has none, or this node can't judge it */
export interface RecordContracts {
  readonly version: string;
  readonly passes: boolean | null;
  /** Why it fails, or why it is unjudged */
  readonly reason?: string;
  /** A version it cites, or the one before it, hasn't arrived yet */
  readonly pending?: true;
  /** Its collection declares something this library doesn't know, so it is neither counted nor failed */
  readonly unjudged?: true;
}

export interface ListOptions {
  /** Only this collection. Default: every collection except the protocol's own `sys.*` */
  readonly collection?: string;
  /** Newest first when set; oldest first by default */
  readonly newestFirst?: boolean;
  readonly limit?: number;
  /** Also return deleted records, marked `deleted` */
  readonly includeDeleted?: boolean;
}

/** How a space reaches its peers */
export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error';

/** How long a revoke waits for a peer to take it in: for a device about to stop, which sends nothing after */
export interface RevokeOptions {
  readonly waitMs?: number;
}

export interface SpaceStatus {
  readonly space: string;
  readonly connection: ConnectionState;
  /** Peers currently connected in this space */
  readonly peers: ReadonlyArray<string>;
  /** Of `peers`, this account's own other devices and apps */
  readonly own: ReadonlyArray<string>;
  /** Of `peers`, carriers the account uses */
  readonly carriers: ReadonlyArray<string>;
  /** The account each peer showed it acts for, by session DID */
  readonly accounts: Readonly<Record<string, string>>;
  /** A fingerprint of every version kept here: equal on two nodes means identical data */
  readonly fingerprint: string;
  /** Records peers sent that failed validation */
  readonly rejected: number;
  /** What this node holds of the space: `all`, or the collections it uses */
  readonly holds: 'all' | ReadonlyArray<string>;
  /** Writes of this node's that haven't reached enough keepers yet */
  readonly pending: number;
}

/** A live message as it arrives: what was sent, and who sent it */
export interface LiveMessage {
  /** The sender's account, proven by its note; null for a peer that showed none */
  readonly from: string | null;
  /** The sending device's session DID, where a reply to it goes */
  readonly peer: string;
  /** Whether the sender's note writes records but can't define collections here (false for a read-only note) */
  readonly recordsOnly: boolean;
  readonly message: unknown;
}

export type NodeEvent =
  /** Records were added, changed or deleted, locally or by sync */
  | { readonly type: 'records'; readonly space: string }
  /** Connection or peers changed */
  | { readonly type: 'status'; readonly space: string }
  /** The registry changed: a space was created, joined or left */
  | { readonly type: 'spaces' }
  /** The account's profile may have changed, here or on another device */
  | { readonly type: 'account' }
  | { readonly type: 'rejected'; readonly space: string; readonly peer: string; readonly reason: string }
  /** A live message from a peer in a space (`spaces.send`) */
  | ({ readonly type: 'message'; readonly space: string } & LiveMessage)
  /** The note this node writes under was revoked in a space */
  | { readonly type: 'revoked'; readonly space: string }
  /** A relay or a connection changed (`network.status()`) */
  | { readonly type: 'network' };

/** The node's own connections, across every space: its relays, and the peers it reaches or is reaching */
export interface NodeNetwork {
  /** Where each relay and connection stands. No relays when none are configured. */
  status(): MeshStatus;
  /** Tries every relay waiting to reconnect, now */
  reconnect(): void;
}

/** Who someone is in a space: the name they gave there, by their identity */
export interface SpaceProfile {
  /** Their identity, as `root` and `createdBy` on a record name it */
  readonly did: string;
  readonly name: string;
  readonly updatedAt: string;
  /** Their contact key's public half, which a contact request is sealed to */
  readonly contactKey?: string;
  /** Their picture, a file in this space: read it with `records.readFile` */
  readonly avatar?: FileRef;
}

export interface NodeSpaces {
  list(): Promise<ReadonlyArray<SpaceSummary>>;
  get(spaceId: string): Promise<SpaceSummary | null>;
  create(params: NewSpace): Promise<SpaceSummary>;
  /** An invite string. For a private space it carries the key: treat it as a secret */
  invite(spaceId: string, options?: InviteOptions): Promise<string>;
  /** What an invite or link is for; a short link is fetched from its mailboxes first */
  preview(invite: string): Promise<InvitePreview>;
  /** Joins a space from an invite. `memberKey` lets a node without the account key receive new space keys */
  join(invite: string, options?: { readonly memberKey?: Uint8Array }): Promise<SpaceSummary>;
  /** Gives up the account's place in a space, then forgets it and its key here */
  leave(spaceId: string): Promise<void>;
  /** Roles, members and invites, as the space's access history says now */
  access(spaceId: string): Promise<SpaceAccess>;
  /** Whether this account, or `account`, may invoke a command with these arguments in a space now (spec 03 §2) */
  may(
    spaceId: string,
    cmd: string,
    args?: Readonly<Record<string, unknown>>,
    account?: string,
  ): Promise<boolean>;
  /** Whether this account, or `account`, holds every grant of a role at least as wide; may say no wrongly, never yes */
  holdsRole(spaceId: string, role: string, account?: string): Promise<boolean>;
  /** Writes a role's definition, replacing the ones held. Needs `/role/define` */
  defineRole(spaceId: string, role: SpaceRole): Promise<void>;
  /** Assigns a role to an account. Needs `/role/assign` */
  assign(spaceId: string, did: string, role: string): Promise<void>;
  /** Takes a role from an account. Needs `/role/unassign`, unless it is your own */
  unassign(spaceId: string, did: string, role: string): Promise<void>;
  /** Removes an account and its roles. Needs `/member/remove`, unless it is you */
  removeMember(spaceId: string, did: string): Promise<void>;
  /** Stops being a founder but stays, taking role `keep` first when given */
  stepDown(spaceId: string, options?: { readonly keep?: string }): Promise<void>;
  /** Names a space that succeeds this one. Needs `/space/succeed`, or a place here when no one holds it */
  succeed(spaceId: string, successor: string): Promise<void>;
  /** Closes an invite, by link or by its key from `access().invites`. Who joined with it stays. */
  closeInvite(spaceId: string, keyOrLink: string): Promise<void>;
  /** Gives a private space a new key, for a lost device. Needs `/key/change` */
  changeKey(spaceId: string): Promise<void>;
  /** Names the relays (wss://, at most 8) the space's members meet on. Needs `/space/relays` */
  setRelays(spaceId: string, relays: ReadonlyArray<string>): Promise<void>;
  /** Names the nodes that keep the space whole (at most 16), and how many a write should reach. Needs `/space/keepers` */
  setKeepers(spaceId: string, keepers: ReadonlyArray<Keeper>, copies?: number | null): Promise<void>;
  /**
   * Revokes one of this account's keys, by DID: nothing it writes counts from then on.
   * With `waitMs`, waits that long for a peer to take it in: true when one did, or with no wait.
   */
  revoke(spaceId: string, key: string, options?: RevokeOptions): Promise<boolean>;
  /** Keeps a space syncing until the function it returns is called; it stops once nothing holds it */
  hold(spaceId: string): Promise<() => Promise<void>>;
  /** A live message (at most 64 KB) to peers connected now, `to` an account or a session DID; kept nowhere */
  send(spaceId: string, message: unknown, to?: string): Promise<void>;
  status(spaceId: string): Promise<SpaceStatus>;
  /** Waits up to `waitMs` (default 3 s) for a connected carrier to hold all this node does of a space */
  carried(spaceId: string, options?: { readonly waitMs?: number }): Promise<boolean>;
  /** Waits up to `waitMs` for one peer, by its key, to hold all this node does of a space; for a node about to close */
  reached(spaceId: string, peer: string, waitMs: number): Promise<boolean>;
  /** How a node serving this space checks connecting peers and signs its welcome; null for a space it does not hold */
  authenticator(spaceId: string): Promise<ServerAuth | null>;
  /** The name each person gave in this space; yours is published from the account's name */
  profiles(spaceId: string): Promise<ReadonlyArray<SpaceProfile>>;
}

/** A file a body refers to, as `records.addFile` gives it */
export interface FileRef {
  readonly hash: string;
  readonly size: number;
  readonly key: string;
  readonly salt: string;
  readonly mime: string;
  readonly name?: string;
}

export interface NodeRecords {
  /** Current versions, oldest record first; deleted records only with `includeDeleted` */
  list<T = unknown>(spaceId: string, options?: ListOptions): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** A record's current version, or null when there is none or it was deleted */
  get<T = unknown>(spaceId: string, key: string): Promise<NodeRecord<T> | null>;
  /** How a record's newest standing version, or the one named, fares under its collection's contract */
  contracts(spaceId: string, key: string, version?: string): Promise<RecordContracts | null>;
  /** The key `name` has in an account's namespace (this one's by default): where `put(…, { key: name })` writes */
  keyFor(spaceId: string, name: string, account?: string): Promise<string>;
  /** The key a record with this body has under its collection's `onePer`; null when there is none */
  onePerKey(
    spaceId: string,
    collection: string,
    body: unknown,
    options?: { links?: ReadonlyArray<Link>; account?: string },
  ): Promise<string | null>;
  /** Creates a record under a fresh key, or `key` in this account's namespace. Writing a deleted key brings it back. */
  put<T = unknown>(
    spaceId: string,
    collection: string,
    body: T,
    options?: { key?: string; links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<T>>;
  /** The same, typed by the collection's definition */
  put<C extends { readonly name: string }>(
    spaceId: string,
    collection: C,
    body: BodyOf<C>,
    options?: { key?: string; links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<BodyOf<C>>>;
  /** Writes the record's next version; links carry over unless given */
  update<T = unknown>(
    spaceId: string,
    key: string,
    body: T,
    options?: { links?: ReadonlyArray<Link> },
  ): Promise<NodeRecord<T>>;
  /** The records whose current version points at this one, optionally by role or collection */
  linked<T = unknown>(
    spaceId: string,
    key: string,
    options?: { rel?: string; collection?: string },
  ): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** Deletes a record everywhere, by writing a version marked deleted */
  delete(spaceId: string, key: string): Promise<void>;
  /** The versions of a record kept here, newest first */
  history<T = unknown>(spaceId: string, key: string): Promise<ReadonlyArray<NodeRecord<T>>>;
  /** Whether this account may `create` in a collection, or `edit` / `delete` a record; `target` names it */
  can(spaceId: string, action: 'create' | 'edit' | 'delete', target: string): Promise<boolean>;
  /** Seals and keeps a file, giving the reference to put in a body (spec 05 §16.6) */
  addFile(spaceId: string, bytes: Uint8Array, about: { mime: string; name?: string }): Promise<FileRef>;
  /** The bytes of a file a body refers to: held here, or fetched from peers or mirrors */
  readFile(spaceId: string, ref: FileRef): Promise<Uint8Array>;
  /**
   * Records matching a query, typed when it names a collection by its definition.
   * @throws When the query is malformed, saying what to fix
   */
  query<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
    spaceId: string,
    query: Query<C, I>,
  ): Promise<ResultFor<C, I>>;
  /** Runs a query now and whenever the space's records change; returns a function that stops it */
  watch<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
    spaceId: string,
    query: Query<C, I>,
    onResult: (result: ResultFor<C, I>) => void,
    onError?: (error: Error) => void,
  ): () => void;
}

export interface AccountProfileView {
  readonly name: string;
  /** The account's picture, a file in its registry */
  readonly avatar?: FileRef;
  /** When it was set, on whichever device set it */
  readonly updatedAt: string;
}

/** A carrier the account uses, as the account registry lists it */
export interface CarrierSummary {
  /** The carry space shared with it */
  readonly space: string;
  /** Its key, as peers see it */
  readonly did: string;
  readonly name: string;
  readonly since: string;
}

/** Nodes that keep the account's spaces online without reading them (`space/pass.ts`). Needs the account key */
export interface NodeCarriers {
  list(): Promise<ReadonlyArray<CarrierSummary>>;
  /** Starts using a carrier: a carry space with a pass for every space, and the invite to give it */
  add(carrier: {
    readonly did: string;
    readonly name: string;
  }): Promise<{ readonly space: string; readonly invite: string }>;
  /** Waits up to `waitMs` for the carrier to hold what this node wrote for it; for a node about to close */
  reached(space: string, waitMs: number): Promise<boolean>;
  /** Waits up to `waitMs` for the passes and wakes written in the background to be done; for a node about to close */
  settled(waitMs: number): Promise<boolean>;
  /** Stops using a carrier: its passes go, and it is told to forget what it held */
  remove(space: string): Promise<void>;
}

/** One of the account's own automations, kept in its registry (`space/own-automations.ts`) */
export interface OwnAutomationView extends Automation {
  /** Its record key in the registry */
  readonly id: string;
}

/** "Let me know when…": the account's own automations, noticed by its carriers. Needs the account key. */
export interface NodeAutomations {
  list(): Promise<ReadonlyArray<OwnAutomationView>>;
  /** Starts one: `when.query` is a collection and a `where` over each new record, `$me` the account */
  add(own: Omit<Automation, 'since'> & { readonly since?: string }): Promise<OwnAutomationView>;
  /** Renames it, pauses or resumes it */
  update(
    id: string,
    changes: { readonly name?: string; readonly paused?: boolean },
  ): Promise<OwnAutomationView>;
  remove(id: string): Promise<void>;
  /** Every version of these, signed, for another device of the account to `take` */
  versions(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Version>>;
  /** Takes in automations handed over outside sync, checked as a peer's. How many were new */
  take(versions: ReadonlyArray<Version>): Promise<number>;
}

/** A host the account uses, and what it says now */
export interface HostingView {
  /** The host's address */
  readonly url: string;
  /** The host's own key, as it appears to peers */
  readonly host: string;
  /** Its name, as it describes itself; its address's host name when it doesn't */
  readonly name: string;
  /** The subscription — the key the account made for this host */
  readonly subscription: string;
  readonly since: string;
  /** How the subscription stands, as the host signed it: now when `live`, else last heard */
  readonly status: HostStatus | null;
  /** Whether `status` is what the host said just now */
  readonly live: boolean;
  /** Why it could not be reached */
  readonly error?: string;
  /** How the account's balance there is added to; null when it takes no payments or can't be reached */
  readonly fund: FundOffer | null;
  /** Whether it sends reminders by email (`remind`) */
  readonly reminds: boolean;
}

/** Hosts: carriers the account pays for (spec/06-nodes-and-sessions.md, Hosts) */
export interface NodeHosting {
  /** The hosts the account uses, each asked how it stands; a host paid since gets the spaces */
  list(): Promise<ReadonlyArray<HostingView>>;
  /** Starts using a host: a subscription key every device signs as, and the spaces once it is paid */
  use(url: string): Promise<HostingView>;
  /** Adds to the account's balance at a host: a `checkout` page to open, or a `request` for a wallet */
  pay(url: string, payment: FundPayment): Promise<PayAnswer>;
  /** Asks a host for reminders by email before paid time runs out */
  remind(url: string, email: string): Promise<void>;
  /** Stops using a host: it forgets the spaces. Cancel a renewing card first (`manage`). */
  stop(url: string): Promise<void>;
  /** The hosts a space pays (`std.host`), each asked how it stands; one paid gets the pass */
  space(spaceId: string): Promise<ReadonlyArray<SpaceHostingView>>;
  /** The account's hosts that last said a space is over their free line (spec 08 §1.1). Asks no host. */
  over(spaceId: string): Promise<
    ReadonlyArray<{
      readonly url: string;
      readonly name: string;
      readonly over: OverSpace;
    }>
  >;
  /** Adds to a space's fund at a host it names, once or monthly. Anyone in it may. */
  payForSpace(spaceId: string, url: string, payment: FundPayment): Promise<PayAnswer>;
  /** Asks a host a space names for reminders by email before the space's paid time runs out */
  remindForSpace(spaceId: string, url: string, email: string): Promise<void>;
  /** Stops a space using a host: its `std.host` record goes, and with `manage` its bots and key */
  stopForSpace(
    spaceId: string,
    url: string,
  ): Promise<{
    /** The bots removed from the space, by DID */
    readonly bots: ReadonlyArray<string>;
    /** Whether the space's key changes because of it */
    readonly newKey: boolean;
  }>;
  /** Asks a host the space names to run a bot there with `role`; removing the bot stops it */
  startBot(
    spaceId: string,
    url: string,
    bot: { readonly name: string; readonly role?: string },
  ): Promise<{ readonly bot: string; readonly status: HostStatus }>;
}

/** A host a space pays for itself, as `hosting.space` sees it */
export interface SpaceHostingView {
  readonly url: string;
  /** Its name, as the space or the host gives it */
  readonly name: string;
  /** The host's key; null when it could not be reached */
  readonly host: string | null;
  /** How the space's subscription stands there, signed by the host; null when it could not be asked */
  readonly status: HostStatus | null;
  /** Whether it keeps spaces for nothing: every subscription counts as paid there */
  readonly free: boolean;
  /** How the space's fund is added to there; null on a free host, or one that takes no communities */
  readonly fund: FundOffer | null;
  /** Whether it sends reminders by email (`remindForSpace`) */
  readonly reminds: boolean;
  /** Whether it runs bots for the spaces it carries (`startBot`) */
  readonly runsBots: boolean;
  /** The bots it runs in this space, as its signed status says */
  readonly bots: ReadonlyArray<HostedBot>;
  /** The services its bots can be connected to (spec 08 §3.1) */
  readonly connectors: ReadonlyArray<HostConnectorOffer>;
  /** Why it could not be asked, when it couldn't */
  readonly error?: string;
}

export interface NodeAccount {
  /** The account's profile; null without an account key, or before one is set */
  profile(): Promise<AccountProfileView | null>;
  /** Renames the account everywhere. Needs an account key. */
  setName(name: string): Promise<AccountProfileView>;
  /**
   * Sets the account's picture everywhere, already resized; `null` removes it.
   * `name` is kept with it when the registry has no name yet. Needs an account key.
   */
  setAvatar(
    image: { bytes: Uint8Array; mime: string } | null,
    options?: { name?: string },
  ): Promise<AccountProfileView>;
  /** The account's picture, read from its registry; null without one, or without an account key */
  picture(): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Revokes one of this account's keys in the account registry. Needs an account key. */
  revoke(key: string, options?: RevokeOptions): Promise<boolean>;
}

/** Someone in the account's contact list */
export interface ContactView {
  /** Their account */
  readonly did: string;
  /** What you call them; they never see it */
  readonly name: string;
  /** Your space for two with them, or null */
  readonly space: string | null;
  readonly note?: string;
  /** Their knocks are hidden, in every space and in your inbox */
  readonly blocked: boolean;
  /** Their username, when you found them by it */
  readonly username?: string;
  readonly updatedAt: string;
}

/** An invite to a space a contact left for you in your space for two */
export interface SpaceInviteView {
  /** Who left it */
  readonly from: string;
  /** The space it invites you to, and what it is called */
  readonly space: string;
  readonly name: string;
  /** What `spaces.join` takes */
  readonly invite: string;
  /** The space for two it was left in, and its record there: what `join` takes */
  readonly pairSpace: string;
  readonly key: string;
  readonly createdAt: string;
}

/** A knock left for this account in a space both belong to, opened */
export interface ContactRequest {
  /** The space it was left in */
  readonly space: string;
  /** Its record there: what `accept` takes */
  readonly key: string;
  /** The account asking */
  readonly from: string;
  /** The name they go by in that space, when they gave one */
  readonly name: string | null;
  readonly note?: string;
  /** The space for two it invites you to */
  readonly pairSpace: string;
  readonly createdAt: string;
}

/** The account's contacts: each a private space for two, listed in the contacts space */
export interface NodeContacts {
  /** The contacts space's id, or null for a node not given it */
  space(): Promise<string | null>;
  /** Everyone in the list, blocked people too, by name */
  list(): Promise<ReadonlyArray<ContactView>>;
  get(did: string): Promise<ContactView | null>;
  /** Adds someone, or changes what the list says about them */
  put(contact: {
    readonly did: string;
    readonly name: string;
    readonly space?: string | null;
    readonly note?: string;
  }): Promise<ContactView>;
  /** Takes them off the list and leaves your space for two. Nobody else's space is touched. */
  remove(did: string): Promise<void>;
  /** Leaves your space for two, and hides their knocks from now on */
  block(did: string): Promise<void>;
  /**
   * Asks someone in a shared space to add you: a space for two, its invite sealed
   * to them as a `std.contact-request`. `carried`: whether a carrier held it first.
   */
  ask(
    spaceId: string,
    did: string,
    options?: { readonly note?: string },
  ): Promise<{ readonly space: string; readonly request: string; readonly carried: boolean }>;
  /** Knocks left for this account in a space, except blocked and accepted ones */
  requests(spaceId: string): Promise<ReadonlyArray<ContactRequest>>;
  /** Joins the space for two a knock invites you to, and puts whoever asked on your list */
  accept(spaceId: string, requestKey: string): Promise<ContactView>;
  /** Accounts in your space for two besides the two of you */
  others(did: string): Promise<ReadonlyArray<string>>;
  /**
   * Invites a contact into one of your spaces: an invite for `role` (as
   * `spaces.invite` makes one), left in your space for two with them. Only a
   * contact who has joined that space can be invited.
   */
  invite(did: string, spaceId: string, options?: { readonly role?: string }): Promise<void>;
  /**
   * Invites your contacts left for you, to spaces you don't hold yet, newest
   * first. Also closes invites of yours a contact has used, and deletes them.
   */
  invites(): Promise<ReadonlyArray<SpaceInviteView>>;
  /** Joins the space an invite from a contact is for; its maker closes the invite once they see you there */
  join(pairSpace: string, key: string): Promise<SpaceSummary>;
}

/** A direct message, opened (`node.direct`) */
export interface DirectMessage {
  /** The record's key: delete it to take the message back */
  readonly key: string;
  /** Who wrote it */
  readonly from: string;
  /** Who it is for, sorted, not counting `from` */
  readonly to: ReadonlyArray<string>;
  /** Null when this node can't open it */
  readonly text: string | null;
  readonly createdAt: string;
  /** Written under a note that grants records only here, as `NodeRecord.recordsOnly` */
  readonly recordsOnly?: true;
}

/** Direct messages: text sealed to some members' member keys, in a private space (`docs/direct-messages.md`) */
export interface NodeDirect {
  /** Members who published a member key, besides you */
  reachable(spaceId: string): Promise<ReadonlyArray<string>>;
  /** Seals text for these members and you, and writes it, defining `std.direct` when needed */
  send(spaceId: string, to: ReadonlyArray<string>, text: string): Promise<DirectMessage>;
  /** Every direct message in the space written by or to this account, oldest first */
  list(spaceId: string): Promise<ReadonlyArray<DirectMessage>>;
}

/** The account's inbox, as `node.inbox` shows it */
export interface InboxView {
  /** Which inbox of the account's this is: `rotate` makes the next */
  readonly gen: number;
  /** The name its code gives whoever knocks */
  readonly name?: string;
  /** The inbox key's public half: knocks are sealed to it */
  readonly key: string;
  /** Its signing key's public half, which signs the code */
  readonly sign: string;
  /** Mailboxes that hold its knocks */
  readonly places: ReadonlyArray<string>;
  /** The inbox code to hand out, in a link (`#inbox=…`) or a QR code */
  readonly code: string;
  /** The username that leads to it, and when it lapses unless claimed again (ms) */
  readonly username?: string;
  readonly usernameUntil?: number;
  readonly updatedAt: string;
}

/** Someone knocking on your inbox, checked and opened */
export interface KnockView {
  /** The knock's id, the same on every relay: what `accept` takes */
  readonly id: string;
  /** Their account, proven by signature and note */
  readonly from: string;
  /** The name they give; nothing vouches for it */
  readonly name: string;
  readonly note?: string;
  /** The space for two it invites you to */
  readonly pairSpace: string;
  /** When they knocked, ISO */
  readonly at: string;
}

/** A knock you left, waiting for them to join */
export interface SentKnockView {
  /** The space for two you made */
  readonly space: string;
  /** The name their inbox code gave */
  readonly name: string;
  /** The username you knocked on, when it was one */
  readonly username?: string;
  readonly at: string;
}

/** The inbox: how people you share no space with ask to become your contact (`spec/07-inbox.md`) */
export interface NodeInbox {
  /** Your inbox, or null until it is opened */
  get(): Promise<InboxView | null>;
  /** Opens your inbox, or changes its mailboxes (1–3) and the name its code gives */
  open(options?: { readonly places?: ReadonlyArray<string>; readonly name?: string }): Promise<InboxView>;
  /** Replaces your inbox: codes for the old one lead nowhere */
  rotate(): Promise<InboxView>;
  /** Clears every knock waiting in your inbox, and keeps it open */
  clear(): Promise<void>;
  /**
   * Claims a username (`leif@minca.social`) for your inbox on its domain's
   * name service, opening the inbox first if need be. The name follows the
   * inbox: replacing it, or changing its name or mailboxes, points the name at
   * the new code, and it is renewed before it lapses.
   */
  claim(username: string): Promise<InboxView>;
  /** Gives your username up: it leads nowhere, and anyone may claim it */
  release(): Promise<InboxView>;
  /**
   * Knocks on someone's inbox, by its code, a link, or a username, with a
   * space for two; `carried` as for `contacts.ask`
   */
  knock(
    code: string,
    options?: { readonly note?: string },
  ): Promise<{ readonly space: string; readonly carried: boolean }>;
  /** Knocks waiting in your inbox; also turns your knocks someone joined into contacts */
  knocks(): Promise<ReadonlyArray<KnockView>>;
  /** Knocks you left that nobody has joined yet */
  sent(): Promise<ReadonlyArray<SentKnockView>>;
  /** Joins the space for two a knock invites you to, and puts whoever knocked on your list */
  accept(id: string): Promise<ContactView>;
  /** Lets a knock go without blocking whoever knocked */
  dismiss(id: string): Promise<void>;
}

export interface P2PNode {
  /** The identity this node acts for */
  readonly did: string;
  /** The session key that signs and connects; stable for the node's lifetime */
  readonly sessionDid: string;
  readonly spaces: NodeSpaces;
  readonly records: NodeRecords;
  readonly collections: NodeCollections;
  /** The account itself — its name, synced through the account registry */
  readonly account: NodeAccount;
  /** Nodes that keep the account's spaces online without reading them */
  readonly carriers: NodeCarriers;
  /** Hosts the account pays to keep its spaces online */
  readonly hosting: NodeHosting;
  /** The account's own automations, kept in its registry */
  readonly automations: NodeAutomations;
  /** People: the account's contact list, and asking to be added */
  readonly contacts: NodeContacts;
  /** Direct messages: text only some members of a space can read */
  readonly direct: NodeDirect;
  /** The inbox: how people you share no space with can ask to become your contact */
  readonly inbox: NodeInbox;
  /** The delegation the session key currently writes under (root → session) */
  delegation(): Delegation;
  /** ICE servers for the app's own WebRTC: the configured ones, and a relay's TURN servers */
  iceServers(): Promise<ReadonlyArray<RTCIceServer>>;
  /** Relays and connections, for showing why a peer is or is not there */
  readonly network: NodeNetwork;
  /**
   * The same node acting as an agent, only in the spaces its note names (`node/api.ts`).
   * @throws When the note is not an agent's, has run out, or is not made out to `keys`
   */
  asAgent(agent: { readonly keys: CryptoKeyPair; readonly note: Delegation }): Promise<P2PNode>;
  subscribe(listener: (event: NodeEvent) => void): () => void;
  /**
   * Revokes a key of this account in `spaces`, or everywhere the account writes.
   * True once a peer took each in, or at once without `waitMs`.
   */
  revokeKey(
    key: string,
    options?: RevokeOptions & { readonly spaces?: ReadonlyArray<string> },
  ): Promise<boolean>;
  /** Revokes this node's own key everywhere and forgets a lasting one: for signing out */
  revokeSelf(options?: RevokeOptions): Promise<void>;
  close(): Promise<void>;
}
