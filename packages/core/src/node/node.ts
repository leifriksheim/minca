/**
 * @module node
 * A node: one identity, the spaces it holds, and everything needed to read,
 * write and sync them — what a tab, a CLI, a daemon and an agent share.
 *
 * **The root key signs once.** A node signs with a session key the root
 * delegates to for an hour at a time, renewed before it runs out: one
 * signature an hour, never one per write.
 */
import { runQuery } from '../query/engine.js';
import {
  nameOf,
  plainQuery,
  type CollectionRef,
  type Include,
  type Query,
  type IncludeMap,
  type ResultFor,
} from '../query/types.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import type { Link, SpaceRole } from '../types.js';
import { didOf } from '../identity/did.js';
import { verifyNote, type Delegation } from '../identity/ucan.js';
import { actsForAccount, ALL_COMMAND, grantsRecordsOnly, noteSpaces } from '../identity/abilities.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import {
  createSpaceManager,
  encodeSpaceInvite,
  parseSpaceInvite,
  bareInvite,
  previewInvite,
  type InviteLinkOptions,
  type SpaceRecord,
} from '../space/space-manager.js';
import { MAX_KEEPERS, MAX_RELAYS, type Keeper } from '../space/roles.js';
import { KEY_CHANGE, MEMBER_REMOVE, ROLE_ASSIGN, SPACE_KEEPERS } from '../space/grants.js';
import { createWriters } from './writers.js';
import {
  meshFor,
  CANNOT_DEFINE,
  usableRelays,
  openSpaceRuntime,
  type ActiveSession,
  type SpaceRuntime,
} from './space-runtime.js';
import { createServerAuth } from '../network/peer-auth.js';
import { DEFAULT_ICE_SERVERS } from '../network/rtc-transport.js';
import { deriveInviteKey } from '../space/space-access.js';
import {
  encodeInviteLink,
  generateLinkSecret,
  inviteLinkKeys,
  isShortInvite,
  linkInviteSecret,
  linkTopic,
  MAX_INVITE_NODES,
  MAX_LINK_PLACES,
  openInvite,
  parseInviteLink,
  pinOf,
  relayOfNode,
  sealInvite,
} from '../space/invite-link.js';
import { checkInvitation, readInvitation, writeInvitation } from '../space/invitation.js';
import type { LooseSigner } from '../records/loose.js';
import { foundersOf } from '../space/constitution.js';
import { base64UrlDecode, base64UrlEncode, bytesToHex, hexToBytes } from '../utils/encoding.js';
import { isRecord, unref } from '../utils/guards.js';
import { createListeners } from '../utils/events.js';
import { serial } from '../utils/serial.js';
import { buildNamespaces, callMethod, givenFor, type Namespace, type OwnMethods } from './api.js';
import {
  contactKeyPair,
  contactPublicKey,
  deriveInboxKeyBytes,
  deriveInboxSignKeyBytes,
  deriveMemberKeyBytes,
} from '../identity/contact-key.js';
import { direct as directSchema } from '../schemas/library/publishing.js';
import { openDirect, sealDirect, type DirectBody } from '../privacy/direct.js';
import {
  contact as contactSchema,
  contactRequest as contactRequestSchema,
  inbox as inboxSchema,
  knock as knockSchema,
  type Contact,
  type ContactRequestRecord,
  type Inbox,
  type Knock,
} from '../schemas/contacts.js';
import {
  clip,
  encodeInbox,
  inboxTopic,
  KNOCK_TTL_SECONDS,
  knockId,
  MAX_INBOX_PLACES,
  openKnock,
  readInbox as readInboxCode,
  sealKnock,
  signPurge,
  type OpenedKnock,
} from '../inbox/inbox.js';
import { createMailboxClient } from '../network/relays.js';
import { team } from '../space/presets.js';
import {
  CARRIER_COLLECTION,
  isKeptLink,
  LINK_COLLECTION,
  type KeptLink,
  deriveAccountRegistry,
  deriveCarrySpace,
  deriveContactsSpace,
  MEMBERSHIP_COLLECTION,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type AvatarRef,
  isAvatarRef,
  type Carrier,
  type Membership,
} from '../space/account-registry.js';
import { CARRY_CLOSED_KEY, makePass, PASS_COLLECTION, passKey, type SpacePass } from '../space/pass.js';
import {
  checkOwnAutomation,
  OWN_AUTOMATIONS,
  WAKE_COLLECTION,
  linkedWakes,
  wakeFor,
  type WakeSpace,
} from '../space/own-automations.js';
import type { Automation } from '../schemas/automations.js';
import {
  createHostClient,
  connectorOffers,
  createSpaceHostClient,
  describeHost,
  hostPeerAddress,
  HOSTING_COLLECTION,
  HostError,
  newSubscriptionSeed,
  readStatus,
  subscriptionKey,
  type HostClient,
  type HostDescription,
  type HostStatus,
  type OverSpace,
  type Hosting,
  type SignedStatus,
} from '../session/hosting.js';
import { base32Encode, hashedKey } from '../utils/hash.js';
import type {
  ContactRequest,
  ContactView,
  InboxView,
  KnockView,
  NodeInbox,
  DefineCollection,
  ListOptions,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeAccount,
  NodeCarriers,
  NodeAutomations,
  OwnAutomationView,
  NodeHosting,
  HostingView,
  SpaceHostingView,
  NodeCollections,
  NodeContacts,
  NodeDirect,
  DirectMessage,
  NodeRecords,
  FileRef,
  AccountProfileView,
  NodeSpaces,
  P2PNode,
  RevokeOptions,
  SpaceSummary,
} from './types.js';

/** Everything a session key may do: every command, about the whole account */
export const SESSION_COMMAND = ALL_COMMAND;

const DEFAULT_TTL_SECONDS = 3600;

/** A carrier record of the account's, with its carry space */
interface CarrierEntry {
  readonly key: string;
  readonly body: Carrier;
  readonly carry: SpaceRecord;
}

/** How long leaving waits for a peer to take the account's removal before forgetting the space anyway */
const LEAVE_WAIT_MS = 5000;
/** How long `spaces.carried` waits, by default: a short loading step, not a promise */
const CARRIED_WAIT_MS = 3000;

function summarize(record: SpaceRecord): SpaceSummary {
  const { space, key } = record;
  return Object.freeze({
    id: space.id,
    name: space.name,
    visibility: space.visibility,
    founders: foundersOf(space),
    ...(space.succeeds !== undefined ? { succeeds: space.succeeds } : {}),
    createdAt: space.createdAt,
    readable: space.visibility === 'public' || key !== null,
    writable: record.role !== null,
    role: record.role,
    joining: record.invite !== null,
  });
}

/** Every collection a query reads: its own, and each `include … from` */
function collectionsOf(query: Query): string[] {
  const plain = plainQuery(query);
  const found = new Set<string>();
  if (typeof plain.collection === 'string') found.add(plain.collection);
  const walk = (includes: Readonly<Record<string, Include>> | undefined) => {
    for (const include of Object.values(includes ?? {})) {
      if (typeof include?.from === 'string') found.add(include.from);
      walk(include?.include);
    }
  };
  walk(plain.include);
  return [...found];
}

/** What a rejection says: its message when it has one */
function reasonText(reason: unknown): string {
  return String((isRecord(reason) ? reason.message : undefined) ?? reason);
}

/** Starts a node; call `close()` when done */
export async function createNode(config: NodeConfig): Promise<P2PNode> {
  const provider = config.provider ?? createP256Provider();
  const signer = createSigner(provider);
  const ttl = config.sessionTtlSeconds ?? DEFAULT_TTL_SECONDS;

  const schemas = createSchemaEngine();
  for (const collection of config.collections ?? []) schemas.registerCollection(collection);

  // ─── Session ───────────────────────────────────────────────────────

  // A lasting key no other node signs with now, when the node was given somewhere to keep one.
  const claimed = config.sessionKey ? null : ((await config.writerKey?.claim().catch(() => null)) ?? null);
  const sessionKeys = config.sessionKey ?? claimed?.keys ?? (await provider.generateKeyPair());
  const sessionDid = await didOf(sessionKeys.publicKey, provider);

  const delegate = () =>
    config.signer.delegate({
      audience: sessionDid,
      command: SESSION_COMMAND,
      expiration: Math.floor(Date.now() / 1000) + ttl,
    });

  let current: Delegation = await delegate();
  let closed = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRenewal = (inSeconds: number) => {
    renewTimer = setTimeout(() => {
      delegate()
        .then((token) => {
          current = token;
          scheduleRenewal(ttl * 0.75);
        })
        .catch(() => {
          // The signer said no or was unreachable. Keep the delegation we have
          // and ask again soon; writes fail validation once it expires.
          if (!closed) scheduleRenewal(Math.min(60, ttl / 4));
        });
    }, inSeconds * 1000);
    unref(renewTimer);
  };
  scheduleRenewal(ttl * 0.75);

  const session: ActiveSession = {
    did: sessionDid,
    key: sessionKeys.privateKey,
    proof: () => current,
  };
  // A key made here dies with the node, and its places in each log with it. A
  // claimed key keeps them in its slot; one handed in (an agent's, an app's) in the
  // node's stores (`node/writers.ts`).
  const handedIn = await config.stores('writers');
  const writers = createWriters((did) =>
    did !== sessionDid ? handedIn : (claimed?.heads ?? (config.sessionKey ? handedIn : null)),
  );
  const mesh = meshFor(config.network, session);
  /**
   * A node whose note doesn't let it act as the account itself — an app, or
   * an agent on someone's computer running a node of its own. It may follow
   * the account, but never writes for it: no list of spaces, no passes, no
   * name, no inbox. Every peer would ignore those (spec 01 §8).
   */
  const narrowNote = !actsForAccount(current);
  /** What signs this node's loose versions — invitations, knocks: the session key, under the note as it is now */
  const looseSigner = (): LooseSigner => ({ did: session.did, key: session.key, proof: current });

  // ─── Events ────────────────────────────────────────────────────────

  const events = createListeners<NodeEvent>('node event');
  const { emit } = events;

  const stopWatchingNetwork = mesh?.subscribe(() => emit({ type: 'network' }));

  // ─── Spaces ────────────────────────────────────────────────────────

  const registryStore = await config.stores('registry', { seal: true });
  const registry = createSpaceManager(registryStore, provider);
  const runtimes = new Map<string, Promise<SpaceRuntime>>();
  /** Spaces with no invite waiting: every change to them would otherwise read the registry to find that out */
  const noInviteWaiting = new Set<string>();
  /**
   * Who is holding each space open. One object per stretch of being held:
   * when the space closes for another reason (leaving it), the object goes,
   * and a release from before does nothing to whoever holds it next.
   */
  const holds = new Map<string, { count: number }>();

  // The account's own space list, kept in a space every device of the account
  // derives for itself. Hidden from `list`; everything else treats it as a space.
  const account = config.accountKey
    ? await deriveAccountRegistry(config.accountKey, config.signer.did, provider)
    : null;
  const accountSpaceId = account?.space.id ?? null;

  // The account's contacts, in a space derived the same way — or, for an app
  // given it by its account home, named in the config. Hidden from `list` too.
  const contactsRecord = config.accountKey
    ? await deriveContactsSpace(config.accountKey, config.signer.did, provider)
    : null;
  const contactsSpaceId = contactsRecord?.space.id ?? config.contactsSpace ?? null;
  // Kept in the node's own list like a joined space, so it can be shared with an app like one.
  if (contactsRecord && !(await registry.get(contactsRecord.space.id))) {
    await joinRegistry(await encodeSpaceInvite(contactsRecord, looseSigner(), provider));
  }
  /** Which of the account's own spaces this is, or null for one it uses */
  async function kindOf(spaceId: string): Promise<'registry' | 'contacts' | 'carry' | null> {
    if (spaceId === accountSpaceId) return 'registry';
    if (spaceId === contactsSpaceId) return 'contacts';
    return (await isCarrySpace(spaceId)) ? 'carry' : null;
  }

  /** The contact key, for a node allowed to open contact requests */
  const contactKeys = config.contactKey ? await contactKeyPair(config.contactKey) : null;

  /**
   * An invite to a space, naming where its members meet: the relays the space
   * names, or before it names any, this node's — so the joiner finds the
   * inviter even when their app uses other relays.
   */
  async function inviteTo(spaceId: string, options: InviteLinkOptions = {}): Promise<string> {
    const named = (await findRecord(spaceId))?.relays ?? [];
    const own = usableRelays(config.network).slice(0, MAX_RELAYS);
    const nodes = await nodesOf(spaceId);
    return registry.createInvite(spaceId, looseSigner(), {
      ...options,
      ...(named.length ? {} : own.length ? { relays: own } : {}),
      ...(nodes.length ? { nodes } : {}),
    });
  }

  /**
   * The always-on nodes an invite names, so a joiner reaches one with nobody
   * else online: the account's hosts, the space's own, and those the invite
   * that brought this node here named. A host that can't be described in a
   * few seconds is left out rather than holding the invite up.
   */
  async function nodesOf(spaceId: string): Promise<ReadonlyArray<string>> {
    if (!config.network) return [];
    const hosts = [
      ...(await hostingRecords()),
      ...((await kindOf(spaceId)) ? [] : await namedHosts(spaceId).catch(() => [])),
    ];
    const inTime = (peer: Promise<string | null>) =>
      Promise.race([peer, new Promise<null>((resolve) => unref(setTimeout(() => resolve(null), 3000)))]);
    // Not the nodes an invite gave this node: nothing vouches for them, so they are used here and never passed on.
    const peers = await Promise.all(hosts.map((host) => inTime(peerOf(host).catch(() => null))));
    const pinned = [
      ...new Set(peers.filter((peer): peer is string => peer !== null && peer.includes('#did:key:'))),
    ];
    return pinned.slice(0, MAX_INVITE_NODES);
  }

  async function findRecord(spaceId: string): Promise<SpaceRecord | null> {
    if (spaceId === accountSpaceId) return account;
    const held = await registry.get(spaceId);
    return held ?? (await carrierRecords()).find(({ carry }) => carry.space.id === spaceId)?.carry ?? null;
  }

  async function requireRecord(spaceId: string): Promise<SpaceRecord> {
    const record = await findRecord(spaceId);
    if (!record) throw new Error(`Unknown space: ${spaceId}`);
    return record;
  }

  // Said once per space: the note this node writes under was revoked there.
  const revokedIn = new Set<string>();
  async function checkRevoked(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (revokedIn.has(spaceId) || !(await open.isRevoked(session.did))) return;
    revokedIn.add(spaceId);
    emit({ type: 'revoked', space: spaceId });
  }

  /** Runtime events pass through; a change to the account registry is also acted on. */
  const fromRuntime = (event: NodeEvent) => {
    emit(event);
    // Which peers are the account's own is read off the registry's peers, so
    // a device coming or going there changes every open space's status too.
    if (event.type === 'status' && event.space === accountSpaceId) {
      for (const spaceId of runtimes.keys())
        if (spaceId !== accountSpaceId) emit({ type: 'status', space: spaceId });
    }
    if (event.type !== 'records') return;
    void runtimes
      .get(event.space)
      ?.then((rt) => checkRevoked(event.space, rt))
      .catch(() => {});
    void keepSpaceHosts(event.space).catch(() => {});
    // A space joined with an invite whose record had not arrived: perhaps it has now.
    void finishJoining(event.space);
    if (event.space === accountSpaceId) {
      emit({ type: 'account' });
      void reconcile();
      // A rename on another device reaches the spaces open here too.
      void publishProfileToOpenSpaces();
    }
  };

  /** The account registry, or why `what` can't be done without it */
  function requireAccount(what: string): Promise<SpaceRuntime> {
    if (!accountSpaceId) return Promise.reject(new Error(`${what} needs the account key`));
    return runtime(accountSpaceId);
  }

  /** What this account wrote in a collection that `check` takes: only it writes its own lists */
  async function ownRecords<T>(
    rt: SpaceRuntime,
    options: ListOptions,
    check: (record: NodeRecord<T>) => boolean = () => true,
  ): Promise<NodeRecord<T>[]> {
    return (await rt.list<T>(options)).filter(
      (record) => record.verified && record.root === config.signer.did && check(record),
    );
  }

  /**
   * The account's profile, from its registry — null without an account key,
   * or before one is set. One record: its current version is the name, by the
   * ordering rule, the same on every device whatever their clocks say.
   */
  async function ownProfile(): Promise<AccountProfileView | null> {
    if (!accountSpaceId) return null;
    const profile = await (await runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
    if (!profile?.verified || profile.root !== config.signer.did || typeof profile.body?.name !== 'string')
      return null;
    const avatar = profile.body.avatar;
    return {
      name: profile.body.name,
      updatedAt: profile.updatedAt,
      ...(isAvatarRef(avatar) ? { avatar } : {}),
    };
  }
  const ownName = async () => (await ownProfile())?.name ?? null;

  /**
   * Tells a space who this account is. Done when the space opens and when the
   * name changes — not by opening every space, which would start syncing them
   * all; a space not open now hears on its next open.
   */
  async function publishProfile(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (narrowNote || (await kindOf(spaceId))) return;
    const own = await ownProfile();
    if (!own) return;
    const base = { name: own.name, ...(contactKeys ? { contactKey: contactKeys.publicKey } : {}) };
    const held = (await open.profiles()).find((profile) => profile.did === config.signer.did)?.avatar;
    const current = isAvatarRef(held) && held.source === own.avatar?.hash ? held : undefined;
    // The name and contact key go out now, with the picture the space already has; a new picture
    // follows once it is copied, which may wait on its bytes reaching this device.
    const shown = own.avatar ? (current ?? (isAvatarRef(held) ? held : undefined)) : undefined;
    await open.publishProfile({ ...base, ...(shown ? { avatar: shown } : {}) });
    if (own.avatar && !current)
      void avatarIn(spaceId, open, own.avatar)
        .then((avatar) => open.publishProfile({ ...base, avatar }))
        .catch(() => {
          // Its bytes are on a device that is away: copied next time the profile is published.
        });
  }

  /**
   * The account's picture as a file of this space: a space's members can't
   * read the registry, so each space holds its own copy, made once and named
   * by the registry file it copies.
   */
  function avatarIn(spaceId: string, open: SpaceRuntime, avatar: AvatarRef): Promise<AvatarRef> {
    // One copy per space and picture, however many publishes ask at once (a space opening, a change).
    const at = `${spaceId}:${avatar.hash}`;
    let copying = avatarCopies.get(at);
    if (!copying) {
      copying = (async () => {
        const held = (await open.profiles()).find((profile) => profile.did === config.signer.did)?.avatar;
        if (isAvatarRef(held) && held.source === avatar.hash) return held;
        const registryRt = await runtime(accountSpaceId!);
        const copy = await open.addFile(await registryRt.readFile(avatar));
        return { ...copy, mime: avatar.mime, source: avatar.hash };
      })();
      copying.catch(() => avatarCopies.delete(at));
      avatarCopies.set(at, copying);
    }
    return copying;
  }
  const avatarCopies = new Map<string, Promise<AvatarRef>>();

  async function publishProfileToOpenSpaces(): Promise<void> {
    for (const [spaceId, open] of runtimes) {
      await open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
    }
  }

  function runtime(spaceId: string): Promise<SpaceRuntime> {
    if (closed) return Promise.reject(new Error('Node is closed'));
    let open = runtimes.get(spaceId);
    if (!open) {
      open = requireRecord(spaceId).then(async (record) => {
        const kind = await kindOf(spaceId);
        return openSpaceRuntime({
          record,
          writers,
          stores: config.stores,
          provider,
          signer,
          schemas,
          session,
          rootDid: config.signer.did,
          ...(config.network ? { network: config.network } : {}),
          ...(mesh ? { mesh } : {}),
          accountOnly: kind !== null,
          // The account's own spaces are always held whole: every device needs all of them.
          ...(config.cache && !kind ? { cache: config.cache } : {}),
          watchIntervalMs: config.watchIntervalMs ?? 2000,
          emit: fromRuntime,
          onRole: (role) => {
            // Holding a role now — perhaps just joined — means the space may hear who this is.
            if (role !== null)
              void runtimes
                .get(spaceId)
                ?.then((rt) => publishProfile(spaceId, rt))
                .catch(() => {});
            if (role !== null) void keepSpaceHosts(spaceId).catch(() => {});
            if (record.role === role) return;
            void registry.setRole(spaceId, role).then(() => emit({ type: 'spaces' }));
          },
          onJoined: () => {
            if (!record.invite) return;
            void registry.clearInvite(spaceId).then(() => emit({ type: 'spaces' }));
          },
          memberKey:
            kind === 'registry'
              ? null
              : config.accountKey
                ? await deriveMemberKeyBytes(config.accountKey, spaceId)
                : (record.memberKey ?? null),
          // Kept only for a space in the list: the registry is not in it.
          onRelays: (relays) => registry.setRelays(spaceId, relays),
          onKeys: async (keys, current) => {
            if (kind === 'registry') return;
            await registry.addKeys(spaceId, keys, current);
            // The account's other devices follow the new key, and its carriers: passes and wakes, not a whole reconcile.
            if (!kind) await remember(spaceId, { refresh: true });
            void passAll().catch(() => {});
          },
        });
      });
      // A failed open must not be cached, or the space stays broken until restart.
      open.catch(() => runtimes.delete(spaceId));
      void open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
      // A revoke that arrived on an earlier visit.
      void open.then((rt) => checkRevoked(spaceId, rt)).catch(() => {});
      // Carriers added since this space was last open.
      void open.then((rt) => nameKeepers(spaceId, rt)).catch(() => {});
      runtimes.set(spaceId, open);
      // The hosts the account or the space uses, reached over their sockets.
      void open.then(() => reachHosts(spaceId)).catch(() => {});
    }
    return open;
  }

  /** A method that opens the space its first argument names, and asks its runtime */
  const perSpace =
    <A extends unknown[], R>(call: (rt: SpaceRuntime, ...args: A) => R | Promise<R>) =>
    async (spaceId: string, ...args: A): Promise<R> =>
      call(await runtime(spaceId), ...args);

  /**
   * Uses a waiting invite, once its record has reached this device. Asked
   * again while it is still working, it runs once more afterwards — the
   * record that makes the difference may be the one that arrived meanwhile.
   */
  const joining = new Map<string, () => Promise<void>>();
  /** Takes in an invite; the space it is for may now have one waiting */
  async function joinRegistry(invite: string): Promise<SpaceRecord> {
    const record = await registry.join(invite);
    noInviteWaiting.delete(record.space.id);
    return record;
  }
  function finishJoining(spaceId: string): Promise<void> {
    if (noInviteWaiting.has(spaceId)) return Promise.resolve();
    let run = joining.get(spaceId);
    if (!run) joining.set(spaceId, (run = serial(() => joinOnce(spaceId))));
    return run();
  }
  async function joinOnce(spaceId: string): Promise<void> {
    if (closed) return;
    const record = await registry.get(spaceId);
    if (!record?.invite) return void noInviteWaiting.add(spaceId);
    const { invite } = record;
    // Not yet, perhaps; the next change to the space tries again.
    await runtime(spaceId)
      .then((rt) => rt.join(invite))
      .catch(() => {});
  }

  async function closeRuntime(spaceId: string): Promise<void> {
    holds.delete(spaceId);
    reaching.delete(spaceId);
    const open = runtimes.get(spaceId);
    if (!open) return;
    runtimes.delete(spaceId);
    // One still opening when the node closes fails to open ("Node is closed"): there is nothing to close.
    const rt = await open.catch(() => null);
    await rt?.close();
  }

  // ─── Memberships ───────────────────────────────────────────────────
  //
  // One record per space in the registry, key `space:<id>`, holding its
  // invite. Current and live: the account belongs to the space. Current and
  // deleted: it left — and rejoining is simply the next version. Every device
  // converges on the same answer, because it is the same record.

  const membershipKey = (spaceId: string) => `space:${spaceId}`;

  /** The space key an invite carries, if it can be read */
  const inviteKeyOf = (invite: unknown) => {
    try {
      return typeof invite === 'string' ? parseSpaceInvite(invite).key : undefined;
    } catch {
      return undefined;
    }
  };

  async function memberships(): Promise<ReadonlyArray<NodeRecord<Membership>>> {
    if (!accountSpaceId) return [];
    return ownRecords<Membership>(
      await runtime(accountSpaceId),
      { collection: MEMBERSHIP_COLLECTION, includeDeleted: true },
      (record) =>
        record.deleted ||
        (typeof record.body?.space === 'string' && record.key === membershipKey(record.body.space)),
    );
  }

  /**
   * Records in the registry that the account belongs to a space. With
   * `refresh`, rewrites the record if the space's key changed since, so a
   * new device joins with the key in use now.
   */
  async function remember(spaceId: string, options: { refresh?: boolean } = {}): Promise<void> {
    if (!accountSpaceId || narrowNote) return;
    const open = await runtime(accountSpaceId);
    const known = await open.get<Membership>(membershipKey(spaceId));
    if (known && (!options.refresh || known.deleted)) return;
    // A view-only invite: what lets the account write is its role in the
    // space, which every device reads there. Invite secrets are never kept.
    const invite = await inviteTo(spaceId);
    if (known && inviteKeyOf(known.body?.invite) === inviteKeyOf(invite)) return;
    await open.upsertSystem<Membership>(MEMBERSHIP_COLLECTION, membershipKey(spaceId), {
      space: spaceId,
      invite,
    });
  }

  /**
   * Writes the account's own removal from a space it is leaving, so the
   * space stops counting it and changes its key. Best effort: a space that
   * won't open, or a note that may not write there, still lets it leave.
   */
  async function giveUpPlace(spaceId: string): Promise<void> {
    await runtime(spaceId)
      .then((open) => open.giveUpPlace(LEAVE_WAIT_MS))
      .catch(() => false);
  }

  async function forget(spaceId: string): Promise<void> {
    if (!accountSpaceId) return;
    const open = await runtime(accountSpaceId);
    if (await open.get(membershipKey(spaceId))) await open.removeSystem(membershipKey(spaceId));
  }

  // ─── Carriers ──────────────────────────────────────────────────────
  //
  // One record per carrier in the registry. Its carry space is derived from
  // the account key and the carrier's key, so every device finds the same one
  // and none is stored. Every device of the account opens it and keeps a pass
  // in it for each of the account's spaces (`space/pass.ts`) — so a space
  // joined in any app is carried, with nothing to do in the home.

  const carrierKey = async (spaceId: string) => (await passKey(spaceId)).replace(/^pass:/, 'carrier:');

  /** Whether a `sys.carrier` record of the account's, live or not, is keyed by this space */
  async function isCarrySpace(spaceId: string): Promise<boolean> {
    if (!accountSpaceId) return false;
    const versions = await (await runtime(accountSpaceId)).history(await carrierKey(spaceId));
    return versions.some(
      (version) =>
        version.collection === CARRIER_COLLECTION && version.verified && version.root === config.signer.did,
    );
  }

  const derivedCarry = new Map<string, Promise<SpaceRecord>>();
  /** A carrier's carry space: derived, or for one added before they were, the one its invite names */
  async function carrySpaceOf(carrier: Carrier): Promise<SpaceRecord | null> {
    if (carrier.invite && carrier.space)
      return (await registry.get(carrier.space)) ?? joinRegistry(carrier.invite).catch(() => null);
    if (!config.accountKey) return null;
    const at = `${carrier.did}|${carrier.gen ?? 0}`;
    const known = derivedCarry.get(at);
    if (known) return known;
    const derived = deriveCarrySpace(
      config.accountKey,
      config.signer.did,
      carrier.did,
      carrier.gen ?? 0,
      provider,
    );
    derivedCarry.set(at, derived);
    return derived;
  }

  /** The account's carriers, live and removed, each with its carry space */
  async function carrierRecords(): Promise<ReadonlyArray<CarrierEntry>> {
    if (!accountSpaceId) return [];
    const found: CarrierEntry[] = [];
    for (const record of await ownRecords<Carrier>(
      await runtime(accountSpaceId),
      { collection: CARRIER_COLLECTION },
      // A generation is a count: anything else names no carry space.
      (one) =>
        typeof one.body?.did === 'string' &&
        (one.body.gen === undefined || (Number.isSafeInteger(one.body.gen) && one.body.gen >= 0)),
    )) {
      const carry = await carrySpaceOf(record.body!);
      // Its key names its carry space: that is how every device knows the space is one.
      if (carry && record.key === (await carrierKey(carry.space.id)))
        found.push({ key: record.key, body: record.body!, carry });
    }
    return found;
  }

  /**
   * Puts a pass in a carrier's space for each of the account's spaces, and
   * takes away the rest; and a wake for each of its own automations, each value replaced by
   * the space's tag: the carrier matches, never learns.
   */
  async function syncPasses(carrier: CarrierEntry): Promise<void> {
    if (!account || narrowNote) return;
    const passes = new Map<string, SpacePass>();
    const spaces: WakeSpace[] = [];
    const owned = await ownAutomations();
    // The registry and the contacts too, so a restore can come through the carrier.
    passes.set(await passKey(account.space.id), await makePass(account));
    if (contactsRecord) passes.set(await passKey(contactsRecord.space.id), await makePass(contactsRecord));
    for (const membership of await memberships()) {
      if (membership.deleted || !membership.body || (await kindOf(membership.body.space))) continue;
      const record = await registry.get(membership.body.space);
      if (!record) continue;
      // Opened even with no wakes to make: opening is also how this device learns the space's key changed.
      const declared = new Map(
        (await (await runtime(record.space.id)).collections()).map((c) => [c.name, c]),
      );
      spaces.push({
        id: record.space.id,
        key: record.key,
        visibility: record.space.visibility,
        topics: (collection) => declared.get(collection)?.topics ?? [],
        computed: (collection) => declared.get(collection)?.computed,
      });
      try {
        passes.set(await passKey(record.space.id), await makePass(record));
      } catch {
        // Held without its key — nothing to pass on until it arrives.
      }
    }
    // Removed meanwhile, on this device or another: its passes stay deleted.
    if (!(await liveCarriers()).some((live) => live.key === carrier.key)) return;
    const carry = await runtime(carrier.carry.space.id);
    await writeExactly(carry, PASS_COLLECTION, passes, (key) => key.startsWith('pass:'));
    // The links the account keeps, for the carrier to serve while every device is away.
    const links = new Map<string, unknown>();
    for (const link of await keptLinks()) links.set(link.key, link.body);
    await writeExactly(carry, LINK_COLLECTION, links, (key) => key.startsWith('link:'));
    const wakes = new Map<string, unknown>();
    for (const own of owned) {
      const wake = await wakeFor(own, spaces, config.signer.did);
      wakes.set(`wake:${own.id}`, wake);
      // A 👍 can make a todo done: what a computed field the automation names reads wakes too.
      for (const also of linkedWakes(own, wake, spaces)) wakes.set(`wake:${own.id}:${also.collection}`, also);
    }
    await writeExactly(carry, WAKE_COLLECTION, wakes, () => true);
  }

  /** Makes what this account wrote in a collection, among the keys `mine` takes, say exactly `wanted` */
  async function writeExactly(
    rt: SpaceRuntime,
    collection: string,
    wanted: ReadonlyMap<string, unknown>,
    mine: (key: string) => boolean,
  ): Promise<void> {
    const held = new Map(
      (await ownRecords(rt, { collection, includeDeleted: true }, (record) => mine(record.key))).map(
        (record) => [record.key, record],
      ),
    );
    for (const [key, body] of wanted) {
      const current = held.get(key);
      if (!current || current.deleted || JSON.stringify(current.body) !== JSON.stringify(body))
        await rt.upsertSystem(collection, key, body);
      held.delete(key);
    }
    for (const [key, record] of held) if (!record.deleted) await rt.removeSystem(key);
  }

  /** The account's own automations, as it made them */
  async function ownAutomations(): Promise<ReadonlyArray<OwnAutomationView>> {
    if (!accountSpaceId) return [];
    const found = await ownRecords<Automation>(
      await runtime(accountSpaceId),
      { collection: OWN_AUTOMATIONS },
      (record) => record.key.startsWith('automation:') && checkOwnAutomation(record.body) === null,
    );
    return found
      .map((record) => ({ ...record.body!, id: record.key }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  /** The carriers the account uses now */
  const liveCarriers = async () => (await carrierRecords()).filter(({ body }) => !body.removed);

  /**
   * Names the account's carriers — its extensions, its hosts — as keepers of
   * a space it manages, and stops naming ones it removed, so apps there hold
   * only what they use. Other keepers the space names stay. Done as each space
   * opens and whenever the carriers change; a space this account doesn't
   * manage is left to whoever does.
   */
  async function nameKeepers(spaceId: string, rt: SpaceRuntime): Promise<void> {
    if (!account || narrowNote || (await kindOf(spaceId))) return;
    if (!(await rt.may(SPACE_KEEPERS))) return;
    const access = await rt.access();
    const carriers = await carrierRecords();
    const active = carriers.filter(({ body }) => !body.removed).map(({ body }) => body);
    const gone = new Set(carriers.filter(({ body }) => body.removed).map(({ body }) => body.did));
    for (const carrier of active) gone.delete(carrier.did);
    const kept = access.keepers.filter((keeper) => !gone.has(keeper.did));
    const added = active
      .filter((carrier) => !kept.some((keeper) => keeper.did === carrier.did))
      .map((c) => ({ did: c.did, name: c.name.slice(0, 80) }));
    if (added.length === 0 && kept.length === access.keepers.length) return;
    await rt.setKeepers([...kept, ...added].slice(0, MAX_KEEPERS), access.copies);
  }

  /**
   * Makes this node's spaces match the account's: join what the account
   * belongs to, leave what it left, and record anything held here that the
   * registry has never heard of.
   */
  async function reconcileOnce(): Promise<void> {
    if (!accountSpaceId || closed) return;
    const held = new Set((await registry.list()).map((record) => record.space.id));
    const known = new Set<string>();
    let changed = false;

    for (const membership of await memberships()) {
      const spaceId = membership.key.slice('space:'.length);
      known.add(spaceId);
      if (!membership.deleted && !held.has(spaceId)) {
        try {
          await joinRegistry(membership.body!.invite);
          changed = true;
        } catch {
          // An unreadable invite; the next version written for it will do.
        }
      } else if (membership.deleted && held.has(spaceId)) {
        // The account left it, on some device. If that one couldn't give up its place, this one does.
        await giveUpPlace(spaceId);
        await closeRuntime(spaceId);
        await registry.remove(spaceId);
        changed = true;
      }
    }

    // Held here but never recorded — joined before the registry existed, or on
    // a node without the account key. Recorded now, so other devices follow.
    // Held still: one left while this ran stays left.
    const stillHeld = new Set((await registry.list()).map((record) => record.space.id));
    for (const spaceId of held) {
      if (!known.has(spaceId) && stillHeld.has(spaceId) && !(await kindOf(spaceId))) await remember(spaceId);
    }

    // Not awaited: it opens every space the account holds, which from a data
    // folder takes long, and nothing here needs it done. Signing in waits on this.
    void passAll().catch(() => {});
    // Carriers came or went: the open spaces this account manages say so.
    for (const [spaceId, open] of runtimes) void open.then((rt) => nameKeepers(spaceId, rt)).catch(() => {});
    // Not awaited: a host that is slow to answer must not hold up the rest.
    void keepHosted().catch(() => {});
    // Hosts came or went: every open space holds a socket to those the account uses now.
    for (const spaceId of runtimes.keys()) void reachHosts(spaceId).catch(() => {});

    if (changed) emit({ type: 'spaces' });
  }

  /** Whether `work` settled within `waitMs` */
  const within = (work: Promise<unknown>, waitMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      void work.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });

  /** Writing in carry spaces, one thing at a time: a removal never lands in the middle of a refill */
  let carryTurn: Promise<unknown> = Promise.resolve();
  const inCarryTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const run = carryTurn.catch(() => {}).then(work);
    carryTurn = run;
    return run;
  };

  const mailbox = config.mailbox ?? createMailboxClient();

  // ── Short invite links (spec 03 §7.7) ──
  //
  // The link holds a secret and the hash of one sealed invite; the invite
  // sits in mailboxes: the account's host's first, which keeps it while every
  // device is away, then the relays where the space's members meet.

  /** Where a link's sealed invite is left: its nodes' relays, then the space's or this node's */
  async function linkPlaces(spaceId: string, nodes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const named = (await findRecord(spaceId))?.relays ?? [];
    const relays = named.length ? named : usableRelays(config.network).slice(0, MAX_RELAYS);
    return [...new Set([...nodes.map(relayOfNode), ...relays])];
  }

  /**
   * A short link to a space: the invite `inviteTo` would give, sealed under a
   * fresh secret and left in mailboxes. Where none takes it, or it is too large
   * for one, the long invite is given instead: it works the same.
   */
  async function shortInvite(
    spaceId: string,
    secret: Uint8Array,
    options: InviteLinkOptions,
    until: number | undefined,
  ): Promise<string> {
    const long = await inviteTo(spaceId, options);
    // The invitation as signed: its secret is the link's to give.
    const invite = parseSpaceInvite(long);
    let sealed: { readonly blob: string; readonly pin: Uint8Array };
    try {
      sealed = await sealInvite(secret, { invite: invite.signed, ...(until !== undefined ? { until } : {}) });
    } catch {
      return long;
    }
    const topic = await linkTopic(sealed.pin);
    const ttl = until !== undefined ? Math.max(60, Math.ceil((until - Date.now()) / 1000)) : undefined;
    const hosts = new Set((invite.nodes ?? []).map(relayOfNode));
    const places = await linkPlaces(spaceId, invite.nodes ?? []);
    const kept = (
      await Promise.all(
        places.map((place) =>
          mailbox.drop(place, topic, sealed.blob, ttl).then(
            () => place,
            () => null,
          ),
        ),
      )
    ).filter((place): place is string => place !== null);
    if (kept.length === 0) return long;
    await keepLink(spaceId, sealed, options, until);
    // A host first, which keeps it; then a relay, so one going away leaves the other.
    const host = kept.find((place) => hosts.has(place));
    const relay = kept.find((place) => !hosts.has(place));
    const named = [host, relay].filter((place): place is string => place !== undefined);
    return encodeInviteLink({ secret, pin: sealed.pin, places: named.slice(0, MAX_LINK_PLACES) });
  }

  /** The links the account keeps, as its registry holds them */
  async function keptLinks(): Promise<ReadonlyArray<{ readonly key: string; readonly body: KeptLink }>> {
    if (!accountSpaceId || narrowNote) return [];
    const records = await ownRecords<KeptLink>(
      await runtime(accountSpaceId),
      { collection: LINK_COLLECTION },
      (record) => record.key.startsWith('link:') && isKeptLink(record.body),
    );
    return records.map((record) => ({ key: record.key, body: record.body! }));
  }

  /**
   * Keeps a short link's sealed invite in the account registry: what it is
   * for, never its secret. Every device then drops it again while it lasts,
   * and closes its invite when it ends; carriers serve it meanwhile.
   */
  async function keepLink(
    spaceId: string,
    sealed: { readonly blob: string; readonly pin: Uint8Array },
    options: InviteLinkOptions,
    until: number | undefined,
  ): Promise<void> {
    if (!accountSpaceId || narrowNote) return;
    const record = await findRecord(spaceId);
    const body: KeptLink = {
      space: spaceId,
      blob: sealed.blob,
      ...(options.secret ? { invite: (await deriveInviteKey(options.secret, provider)).did } : {}),
      ...(record?.key ? { keyId: record.key.id } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    await (
      await runtime(accountSpaceId)
    ).upsertSystem(LINK_COLLECTION, `link:${bytesToHex(sealed.pin)}`, body);
    void passAll().catch(() => {});
  }

  /** Stops keeping the links `which` picks */
  async function forgetLinks(which: (link: KeptLink) => boolean): Promise<void> {
    if (!accountSpaceId || narrowNote) return;
    const registryRt = await runtime(accountSpaceId);
    let forgot = false;
    for (const { key, body } of await keptLinks())
      if (which(body)) {
        await registryRt.removeSystem(key);
        forgot = true;
      }
    if (forgot) void passAll().catch(() => {});
  }

  /**
   * Looks after every link the account keeps. One past its `until`, for a
   * space this device no longer holds, or carrying a key the space has moved
   * on from, has ended: its role invite is closed, so nobody holding the
   * space's current key can still join with it, and it is forgotten. The
   * rest are dropped again where the space's members meet; a relay already
   * holding one stores nothing new.
   */
  const keepLinks = serial(async () => {
    for (const { key, body } of await keptLinks()) {
      if (closed) return;
      const record = await registry.get(body.space);
      // Ended only on what this device knows: one behind on a key change, or not holding the space yet,
      // would otherwise end a link another device of the account just made.
      if (!record) continue;
      const moved =
        body.keyId !== undefined &&
        record.key !== null &&
        record.key.id !== body.keyId &&
        (record.keys ?? []).some((held) => held.id === body.keyId);
      if (moved || (body.until !== undefined && body.until <= Date.now())) {
        if (body.invite) await closeIfOpen(body.space, body.invite).catch(() => {});
        await forgetLinks((link) => link.blob === body.blob);
        continue;
      }
      const topic = await linkTopic(hexToBytes(key.slice('link:'.length)));
      const ttl = body.until !== undefined ? Math.ceil((body.until - Date.now()) / 1000) : undefined;
      for (const place of await linkPlaces(body.space, []))
        void mailbox.drop(place, topic, body.blob, ttl).catch(() => {});
    }
  });

  /** Closes an invite unless it is closed already, or this account may not */
  async function closeIfOpen(spaceId: string, inviteDid: string): Promise<void> {
    const rt = await runtime(spaceId);
    const invite = (await rt.access()).invites.find((held) => held.key === inviteDid);
    if (invite?.open) await rt.closeInvite(inviteDid);
  }

  // Relays forget after two weeks or a restart: every hour, whatever is gone goes back.
  const linkTimer = setInterval(() => void keepLinks().catch(() => {}), 60 * 60 * 1000);
  unref(linkTimer);

  /** Pages of a topic read for a short link: a relay holds 64 blobs, at least four a page */
  const INVITE_PAGES = 16;

  /** A short link's invite, fetched once and kept: a preview and the join that follows ask once */
  const resolved = new Map<string, Promise<{ readonly long: string; readonly until?: number }>>();

  /** The long invite a text holds or a short link names, and when its inviter stops sharing it */
  function resolveInvite(text: string): Promise<{ readonly long: string; readonly until?: number }> {
    const bare = bareInvite(text);
    if (!isShortInvite(bare)) return Promise.resolve({ long: bare });
    let found = resolved.get(bare);
    if (!found) {
      found = fetchInvite(bare);
      // A preview and the join after it ask once; a few links are remembered, not every one ever read.
      const oldest = resolved.keys().next();
      if (resolved.size >= 16 && !oldest.done) resolved.delete(oldest.value);
      resolved.set(bare, found);
      found.catch(() => resolved.delete(bare));
    }
    return found;
  }

  /**
   * Asks every place the link names, and this node's relays, for its topic.
   * Of what comes back, only the blob that hashes to the pin is taken — any
   * other, whoever left it, is ignored unopened.
   */
  async function fetchInvite(bare: string): Promise<{ readonly long: string; readonly until?: number }> {
    const link = parseInviteLink(bare);
    const { topic, inviteSecret } = await inviteLinkKeys(link.secret, link.pin);
    const places = [...new Set([...link.places, ...usableRelays(config.network)])];
    if (places.length === 0)
      throw new Error('That invite names no place to find it, and this app knows none');
    const blobs = new Set<string>();
    // A slow place can't hold the join up for long: what has come back by then is all there is.
    await Promise.race([
      new Promise<void>((resolve) => unref(setTimeout(resolve, 20_000))),
      Promise.all(
        places.map((place) =>
          mailbox.fetch(place, topic, 0, INVITE_PAGES).then(
            (items) => items.forEach((item) => blobs.add(item.blob)),
            () => {},
          ),
        ),
      ),
    ]);
    // Only blobs whose hash is the pin; any other, whoever left it, is never opened.
    const named: string[] = [];
    for (const blob of blobs)
      if ((await pinOf(blob)).every((byte, i) => byte === link.pin[i])) named.push(blob);
    // Only the inviter could make two blobs share a pin, and then neither is trusted.
    if (named.length > 1) throw new Error('That invite link names more than one invite, so it is not used');
    const opened = named[0] ? await openInvite(link, named[0]) : null;
    if (!opened)
      throw new Error('That invite was not found. It may have expired, or the places it names may be down.');
    const { invite, until } = opened;
    // The invitation as its inviter signed it, and beside it the secret the link's own gives a role link.
    const signed = readInvitation(writeInvitation(invite)).version;
    const long = writeInvitation(signed, typeof signed.body.role === 'string' ? inviteSecret : undefined);
    return { long, ...(until !== undefined ? { until } : {}) };
  }

  /** Every carrier the account uses gets its passes and wakes as they are now, one run at a time */
  const passAll = serial(() =>
    inCarryTurn(async () => {
      // First: a key change that ends a link is seen here, before its record would be copied on.
      await keepLinks().catch(() => {});
      for (const carrier of await liveCarriers()) {
        if (closed) return;
        // Only a device that may write in the carry space can do this; others leave it to one that can.
        await syncPasses(carrier).catch(() => {});
      }
    }),
  );

  const reconcile = serial(() =>
    reconcileOnce().catch((error: unknown) => {
      if (!closed) console.error('Could not reconcile the account registry:', error);
    }),
  );

  const spaces = Object.freeze<NodeSpaces>({
    async list() {
      const used: SpaceRecord[] = [];
      for (const record of await registry.list()) if (!(await kindOf(record.space.id))) used.push(record);
      return used.map(summarize);
    },

    async get(spaceId) {
      const record = await findRecord(spaceId);
      return record ? summarize(record) : null;
    },

    async create(params) {
      const me = config.signer.did;
      const record = await registry.create({
        name: params.name,
        visibility: params.visibility,
        creator: me,
        ...(params.roles ? { roles: params.roles } : {}),
        ...(params.top ? { top: params.top } : {}),
        ...(params.cofounders ? { cofounders: params.cofounders } : {}),
        ...(params.creatorRoles?.length ? { assigned: { [me]: params.creatorRoles } } : {}),
        ...(params.succeeds !== undefined ? { succeeds: params.succeeds } : {}),
      });
      await remember(record.space.id);
      emit({ type: 'spaces' });
      return summarize(record);
    },

    async invite(spaceId, options = {}) {
      // A short link's secret comes first: a role invite's own secret is derived from it.
      const link = options.short ? generateLinkSecret() : null;
      const share = (opened: InviteLinkOptions = {}) =>
        link ? shortInvite(spaceId, link, opened, options.until) : inviteTo(spaceId, opened);
      if (options.write === false) return share();
      const open = await runtime(spaceId);
      const { roles, founder, mine } = await open.access();
      const member = founder || mine.length > 0;
      // By default `member` when you may give it, else the first role you may give; with none, a view-only invite.
      const assignable: string[] = [];
      for (const { name } of roles)
        if (await open.may(ROLE_ASSIGN, { role: name, self: false, roles: [] })) assignable.push(name);
      const role = options.role ?? (assignable.includes('member') ? 'member' : assignable[0]);
      if (!role) {
        if (options.role !== undefined || !member)
          throw new Error(
            member
              ? `There is no role "${options.role}"`
              : 'You hold no role here, so you can only share it to view',
          );
        return share();
      }
      const { secret } = await open.openInvite(role, link ? await linkInviteSecret(link) : undefined);
      return share({ secret, role });
    },

    async preview(invite) {
      const { long, until } = await resolveInvite(invite);
      // Who it says invited is shown before joining, so it is checked as joining checks it.
      const parsed = parseSpaceInvite(long);
      const unsigned = await checkInvitation(parsed.signed, provider, parsed.invite);
      if (unsigned) throw new Error(`That invite doesn't check out: ${unsigned}.`);
      return { ...previewInvite(long), ...(until !== undefined ? { until } : {}) };
    },

    async join(invite, options = {}) {
      const record = await joinRegistry((await resolveInvite(invite)).long);
      if (options.memberKey) await registry.setMemberKey(record.space.id, options.memberKey);
      // A runtime opened before the key arrived would still be unable to read.
      await closeRuntime(record.space.id);
      await remember(record.space.id);
      // Uses the invite now if its record is here already — otherwise when it arrives.
      await finishJoining(record.space.id);
      emit({ type: 'spaces' });
      return summarize((await registry.get(record.space.id)) ?? record);
    },

    async leave(spaceId) {
      const kind = await kindOf(spaceId);
      if (kind)
        throw new Error(`The ${kind === 'registry' ? 'account registry' : `${kind} space`} cannot be left`);
      await giveUpPlace(spaceId);
      await forget(spaceId);
      await closeRuntime(spaceId);
      await registry.remove(spaceId);
      emit({ type: 'spaces' });
    },

    async hold(spaceId) {
      const held = holds.get(spaceId) ?? holds.set(spaceId, { count: 0 }).get(spaceId)!;
      held.count += 1;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        if (holds.get(spaceId) !== held) return;
        held.count -= 1;
        if (held.count === 0) await closeRuntime(spaceId);
      };
      try {
        await runtime(spaceId);
      } catch (error) {
        await release();
        throw error;
      }
      return release;
    },

    send: perSpace((rt, message: unknown, to?: string) => rt.send(message, to)),

    async status(spaceId) {
      const status = await (await runtime(spaceId)).status();
      if (!accountSpaceId) return { ...status, own: [], carriers: [] };
      // A peer's key does not say whose it is. But only this account's devices
      // and apps can read the account registry, so a peer there is one of ours
      // — except a carrier, which the registry names by its key.
      const carrierKeys = new Set((await liveCarriers()).map(({ body }) => body.did));
      const inRegistry = new Set((await (await runtime(accountSpaceId)).status()).peers);
      return {
        ...status,
        own: status.peers.filter((peer) => inRegistry.has(peer) && !carrierKeys.has(peer)),
        carriers: status.peers.filter((peer) => carrierKeys.has(peer)),
      };
    },

    async carried(spaceId, options = {}) {
      if (!accountSpaceId || narrowNote || !config.network) return false;
      // Only with a carrier connected now, as the account registry shows it: else nothing is coming.
      const carriers = new Set((await liveCarriers()).map(({ body }) => body.did));
      const online = (await (await runtime(accountSpaceId)).status()).peers;
      if (!online.some((peer) => carriers.has(peer))) return false;
      const deadline = Date.now() + (options.waitMs ?? CARRIED_WAIT_MS);
      const open = await runtime(spaceId);
      // Named a keeper, and given its pass now rather than whenever the next round comes.
      await nameKeepers(spaceId, open).catch(() => {});
      void passAll().catch(() => {});
      while (!closed && Date.now() < deadline) {
        // Level with a carrier: it holds the genesis, and any invite opened since.
        for (const peer of (await spaces.status(spaceId)).carriers)
          if (await open.syncedWith(peer, Math.max(0, Math.min(2000, deadline - Date.now())))) return true;
        await new Promise((resolve) => unref(setTimeout(resolve, 250)));
      }
      return false;
    },

    profiles: perSpace((rt) => rt.profiles()),
    access: perSpace((rt) => rt.access()),
    may: perSpace((rt, cmd: string, args?: Readonly<Record<string, unknown>>, account?: string) =>
      rt.may(cmd, args, account),
    ),
    holdsRole: perSpace((rt, role: string, account?: string) => rt.holdsRole(role, account)),
    defineRole: perSpace((rt, role: SpaceRole) => rt.defineRole(role)),
    assign: perSpace((rt, did: string, role: string) => rt.assign(did, role)),
    unassign: perSpace((rt, did: string, role: string) => rt.unassign(did, role)),
    removeMember: perSpace((rt, did: string) => rt.removeMember(did)),
    stepDown: perSpace((rt, options?: { readonly keep?: string }) => rt.stepDown(options?.keep)),

    async succeed(spaceId, successor) {
      // Where this node holds the successor, its constitution must name this space: else it is a copy.
      const held = await registry.get(successor);
      if (held && held.space.succeeds !== spaceId)
        throw new Error(`"${held.space.name}" does not say it succeeds this space`);
      await (await runtime(spaceId)).succeed(successor);
    },

    async closeInvite(spaceId, keyOrLink) {
      let key = keyOrLink;
      // The link itself will do: its secret names the invite.
      if (!keyOrLink.startsWith('did:key:') && isShortInvite(bareInvite(keyOrLink))) {
        // A short link's invite secret is derived from its own; a view-only one has no record to close.
        const secret = await linkInviteSecret(parseInviteLink(bareInvite(keyOrLink)).secret);
        key = (await deriveInviteKey(secret, provider)).did;
      } else if (!keyOrLink.startsWith('did:key:')) {
        const secret = parseSpaceInvite(bareInvite(keyOrLink)).invite;
        if (!secret)
          throw new Error(
            'That invite is view-only — there is nothing to close. To stop it working, give the space a new key (changeKey).',
          );
        key = (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
      }
      await (await runtime(spaceId)).closeInvite(key);
      // Its link, if the account keeps one, is no longer served.
      await forgetLinks((link) => link.space === spaceId && link.invite === key);
    },

    revoke: perSpace((rt, key: string, options?: RevokeOptions) => rt.revoke(key, options)),
    changeKey: perSpace((rt) => rt.rotateKey()),
    setRelays: perSpace((rt, relays: ReadonlyArray<string>) => rt.setRelays(relays)),
    setKeepers: perSpace((rt, keepers: ReadonlyArray<Keeper>, copies?: number | null) =>
      rt.setKeepers(keepers, copies ?? null),
    ),

    async authenticator(spaceId) {
      const record = await findRecord(spaceId);
      if (!record) return null;
      // Every peer proves its own DID; in a private space, readers are also
      // checked against the read key the space's history names now. The
      // welcome is signed by the key this node introduces itself with.
      const read = record.space.visibility === 'private' ? (await runtime(spaceId)).readAccess() : null;
      return createServerAuth(spaceId, read, sessionKeys.privateKey, provider, () => current);
    },
  });

  // With an account key, start following the registry at once: it is how this
  // node learns which spaces it belongs to.
  if (accountSpaceId) {
    await runtime(accountSpaceId);
    await reconcile();
  }

  /** Writes one of the account's own automations, checked, and hands every carrier the wakes as they are now */
  async function writeOwn(id: string, body: Automation): Promise<OwnAutomationView> {
    const registryRt = await requireAccount('Making an automation');
    const problem = checkOwnAutomation(body);
    if (problem) throw new Error(problem);
    // A system collection: nothing defines it, so no other key of the account can make it final.
    await registryRt.upsertSystem<Automation>(OWN_AUTOMATIONS, id, body);
    // Every carrier gets the wakes as they are now, in the background (`carriers.settled`).
    void passAll().catch(() => {});
    return { ...body, id };
  }

  const automations = Object.freeze<NodeAutomations>({
    list: ownAutomations,

    add: (own) =>
      writeOwn(`automation:${base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(10)))}`, {
        ...own,
        name: own.name.trim(),
        since: own.since ?? new Date().toISOString(),
      }),

    async update(id, changes) {
      await requireAccount('Making an automation');
      const current = (await ownAutomations()).find((view) => view.id === id);
      if (!current) throw new Error('There is no such automation');
      const { id: _id, ...was } = current;
      return writeOwn(id, {
        ...was,
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.paused !== undefined ? { paused: changes.paused } : {}),
      });
    },

    async remove(id) {
      const registryRt = await requireAccount('Making an automation');
      if (!(await ownAutomations()).some((view) => view.id === id)) return;
      await registryRt.removeSystem(id);
      void passAll().catch(() => {});
    },

    async versions(ids) {
      if (!accountSpaceId) return [];
      const keys = ids.filter((id) => id.startsWith('automation:'));
      return (await (await runtime(accountSpaceId)).versionsOf(keys)).filter(
        (version) => version.collection === OWN_AUTOMATIONS,
      );
    },

    async take(versions) {
      if (!accountSpaceId) return 0;
      // The account's own automations only: whatever else rides along waits for sync.
      const mine = versions.filter(
        (version) =>
          typeof version === 'object' &&
          version !== null &&
          version.collection === OWN_AUTOMATIONS &&
          version.space === accountSpaceId,
      );
      if (mine.length === 0) return 0;
      const taken = await (await runtime(accountSpaceId)).take(mine);
      if (taken > 0) void passAll().catch(() => {});
      return taken;
    },
  });

  const carriers = Object.freeze<NodeCarriers>({
    list: async () =>
      (await liveCarriers()).map(({ body: { did, name, since }, carry }) => ({
        space: carry.space.id,
        did,
        name,
        since,
      })),

    async add(carrier) {
      const registryRt = await requireAccount('Using a carrier');
      const all = await carrierRecords();
      // The same carrier again keeps its carry space: what it holds stays good, and nothing is closed under it.
      let entry = all.find(({ body }) => body.did === carrier.did && !body.removed);
      if (entry) void passAll().catch(() => {});
      else {
        // Added again after a removal, a new carry space: the last one tells it to forget. One past the
        // highest seen, not a count: a device that hasn't synced every earlier one must not land on a closed space.
        const gens = all.filter(({ body }) => body.did === carrier.did).map(({ body }) => body.gen ?? 0);
        const gen = gens.length ? Math.max(...gens) + 1 : 0;
        const body: Carrier = {
          did: carrier.did,
          name: carrier.name.trim().slice(0, 80) || 'Carrier',
          since: new Date().toISOString(),
          ...(gen ? { gen } : {}),
        };
        const carry = (await carrySpaceOf(body))!;
        // Two devices adding it at once write the one record, for the one space.
        entry = { key: await carrierKey(carry.space.id), body, carry };
        await registryRt.upsertSystem<Carrier>(CARRIER_COLLECTION, entry.key, body);
        // Its passes before its invite, as one batch: a carrier joining an empty carry space takes spaces as they trickle in.
        // Not in turn behind a refill: nothing removes a carrier that is only now being added.
        await syncPasses(entry);
      }
      return {
        space: entry.carry.space.id,
        invite: await encodeSpaceInvite(entry.carry, looseSigner(), provider),
      };
    },

    settled: (waitMs) => within(passAll.done(), waitMs),

    async reached(spaceId, waitMs) {
      const did = (await liveCarriers()).find(({ carry }) => carry.space.id === spaceId)?.body.did;
      if (!did || !accountSpaceId) return false;
      const deadline = Date.now() + waitMs;
      // Level with the passes and wakes as they are now: a refill under way first, within the same time.
      await within(passAll.done(), waitMs);
      // Its passes first: only through them does it come to the registry, and hold its own record there.
      if (!(await (await runtime(spaceId)).syncedWith(did, Math.max(0, deadline - Date.now())))) return false;
      return (await runtime(accountSpaceId)).syncedWith(did, Math.max(0, deadline - Date.now()));
    },

    async remove(spaceId) {
      const registryRt = await requireAccount('Removing a carrier');
      // In turn with any refill, which would otherwise put the passes back.
      await inCarryTurn(async () => {
        const live = await liveCarriers();
        const did = live.find(({ carry }) => carry.space.id === spaceId)?.body.did;
        // Every carry space it has: one added on two devices at once, before they were derived, has two.
        for (const { key, body, carry } of live.filter((one) => one.body.did === did)) {
          const rt = await runtime(carry.space.id);
          // Passes gone first, then the word to forget everything, then the carrier's record.
          for (const pass of await ownRecords(rt, { collection: PASS_COLLECTION }, (r) =>
            r.key.startsWith('pass:'),
          ))
            await rt.removeSystem(pass.key);
          await rt.upsertSystem(PASS_COLLECTION, CARRY_CLOSED_KEY, { v: 1, closed: true });
          // Kept, so adding it again counts this one and takes a new carry space.
          await registryRt.upsertSystem<Carrier>(CARRIER_COLLECTION, key, {
            ...body,
            removed: new Date().toISOString(),
          });
        }
      });
    },
  });

  // ─── Hosting ───────────────────────────────────────────────────────
  //
  // A host is a carrier the account pays for. The subscription key lives in
  // the registry (`sys.hosting`), so every device signs as the same
  // subscription, and any of them hands the host the carry space once it is
  // paid — the one that paid, or the next one to notice.

  const hostingKey = (url: string) => hashedKey('hosting', url);

  /** The hosting records the account wrote, live */
  async function hostingRecords(): Promise<ReadonlyArray<Hosting>> {
    if (!accountSpaceId) return [];
    const records = await ownRecords<Hosting>(
      await runtime(accountSpaceId),
      { collection: HOSTING_COLLECTION },
      (record) => typeof record.body?.url === 'string' && typeof record.body.seed === 'string',
    );
    return records.map((record) => record.body!);
  }

  async function hostClient(hosting: Hosting): Promise<{ client: HostClient; subscription: string }> {
    const key = await subscriptionKey(base64UrlDecode(hosting.seed), provider);
    return { client: createHostClient(hosting.url, hosting.host, key, provider), subscription: key.did };
  }

  /** What the host at a known address says about itself — refused when it's another host now */
  async function describeKnown(hosting: Hosting): Promise<HostDescription> {
    const description = await describeHost(hosting.url);
    if (description.did !== hosting.host)
      throw new Error("The host at this address has another key now, so it's another host");
    return description;
  }

  /** Last time each host was handed the spaces, or refused them — so asking again waits a while */
  const handedAt = new Map<string, number>();
  const HAND_AGAIN_MS = 60_000;
  /** Handovers under way, so a second look waits for the first instead of reporting the spaces not carried */
  const handing = new Map<string, Promise<{ status: HostStatus; receipt: SignedStatus }>>();

  /**
   * Keeps what the host signed in the registry, so every device shows it and
   * the person holds the host's word — written only when what it says changed.
   */
  async function keepReceipt(
    hosting: Hosting,
    kept: HostStatus | null,
    status: HostStatus,
    receipt: SignedStatus,
    description: HostDescription,
  ): Promise<void> {
    if (narrowNote || !accountSpaceId) return;
    const { name } = description;
    const peer = hostPeerAddress(hosting.url, description) ?? undefined;
    const same =
      kept &&
      kept.state === status.state &&
      kept.paidUntil === status.paidUntil &&
      kept.renews === status.renews &&
      kept.plan === status.plan &&
      JSON.stringify(kept.over ?? []) === JSON.stringify(status.over ?? []) &&
      hosting.name === name &&
      hosting.peer === peer;
    if (same) return;
    const { peer: _before, ...rest } = hosting;
    const record: Hosting = { ...rest, name, receipt, ...(peer ? { peer } : {}) };
    await (
      await runtime(accountSpaceId)
    ).upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(hosting.url), record);
  }

  /** Asks a host how it stands, and hands it the spaces if it is paid for but not carrying them */
  async function viewHosting(hosting: Hosting, force = false): Promise<HostingView> {
    const { client, subscription } = await hostClient(hosting);
    const kept = hosting.receipt ? await readStatus(hosting.receipt, hosting.host, provider) : null;
    const base = { url: hosting.url, host: hosting.host, subscription, since: hosting.since };
    try {
      const description = await describeKnown(hosting);
      let { status, receipt } = await client.status();
      const due = force || Date.now() - (handedAt.get(hosting.url) ?? 0) > HAND_AGAIN_MS;
      // A host with limits keeps an account's spaces with nothing paid: its free plan.
      const paid =
        status.state === 'active' ||
        status.state === 'grace' ||
        ((description.free || description.limits !== undefined) && status.state !== 'lapsed');
      const inFlight = handing.get(hosting.url);
      if (!status.carrying && inFlight) {
        // Another look is handing the spaces over right now: wait for it,
        // rather than answer "not carrying" while they're on their way.
        const handed = await inFlight.catch(() => null);
        if (handed) ({ status, receipt } = handed);
      } else if (!status.carrying && paid && due && !narrowNote) {
        handedAt.set(hosting.url, Date.now());
        const attaching = carriers
          .add({ did: hosting.host, name: new URL(hosting.url).host })
          .then(({ invite }) => client.attach(config.signer.did, invite));
        handing.set(hosting.url, attaching);
        try {
          ({ status, receipt } = await attaching);
        } catch (error) {
          // Not paid after all (it lapsed in between): the status says so.
          if (!(error instanceof HostError && error.status === 402)) throw error;
        } finally {
          handing.delete(hosting.url);
        }
      }
      await keepReceipt(hosting, kept, status, receipt, description);
      return {
        ...base,
        name: description.name,
        status,
        live: true,
        fund: description.free ? null : (description.fund ?? null),
        reminds: description.remind === true,
      };
    } catch (error) {
      return {
        ...base,
        name: hosting.name ?? new URL(hosting.url).host,
        status: kept,
        live: false,
        fund: null,
        reminds: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Every device keeps its hosts carrying: after the registry changes, ask each once more */
  async function keepHosted(): Promise<void> {
    if (narrowNote) return;
    for (const hosting of await hostingRecords()) await viewHosting(hosting).catch(() => {});
  }

  async function requireHosting(url: string): Promise<Hosting> {
    const found = (await hostingRecords()).find((hosting) => hosting.url === url);
    if (!found) throw new Error(`This account doesn't use the host at ${url}`);
    return found;
  }

  /** An address a device may reach: https://, or http:// on this machine */
  function checkAddress(address: string, what: string): URL {
    const url = new URL(address);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      throw new Error(`${what} is reached over https://`);
    return url;
  }

  // ─── A space paying for itself ─────────────────────────────────────
  //
  // A space names the hosts it pays in `std.host` records, which only those
  // who may manage it write. Any member's device holding the space key hands
  // such a host the space's pass once someone has paid there, and again when
  // the space's key changes, so the host carries it without reading it.

  /** When each space last asked its hosts, and what it named then: asked again after a while, or when that changed */
  const spaceHostsAsked = new Map<string, { at: number; named: string }>();
  const SPACE_HOSTS_EVERY_MS = 10 * 60_000;

  async function namedHosts(
    spaceId: string,
  ): Promise<ReadonlyArray<{ url: string; did?: string; name?: string }>> {
    const rt = await runtime(spaceId);
    // Only where the space keeps hosts: listing a collection makes a space held in part hold it.
    if (!(await rt.collections()).some((c) => c.name === 'std.host' && c.version !== null)) return [];
    const records = await rt.list<unknown>({ collection: 'std.host' });
    return records.flatMap((record) => {
      const body = record.body;
      if (!record.verified || record.deleted || !isRecord(body) || typeof body.url !== 'string') return [];
      let url: string;
      try {
        url = checkAddress(body.url, 'A host').origin;
      } catch {
        return [];
      }
      return [
        {
          url,
          ...(typeof body.did === 'string' ? { did: body.did } : {}),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
        },
      ];
    });
  }

  /** The read key a space is carried with now, as a DID: what a host should hold */
  const currentReadKey = (pass: SpacePass): string | undefined => pass.readKey ?? pass.space.readKey;

  async function askSpaceHost(
    spaceId: string,
    named: { url: string; did?: string; name?: string },
    hand: boolean,
  ): Promise<SpaceHostingView> {
    try {
      const description = await describeHost(named.url);
      // A host whose key changed since the space chose it is not the host it chose.
      if (named.did && named.did !== description.did) throw new Error('The host’s key changed');
      const client = createSpaceHostClient(named.url, description.did, provider);
      let { status } = await client.status(spaceId);
      // Paid, or a free host that hasn't let it lapse, as for an account's subscription.
      const paid =
        status.state === 'active' ||
        status.state === 'grace' ||
        (description.free && status.state !== 'lapsed');
      const record = hand && paid ? await findRecord(spaceId) : null;
      if (record && (record.space.visibility === 'public' || record.key)) {
        const pass = await makePass(record);
        if (!status.carrying || (pass.read && status.readKey !== currentReadKey(pass)))
          ({ status } = await client.hand(spaceId, pass));
      }
      return {
        url: named.url,
        name: named.name ?? description.name,
        host: description.did,
        status,
        free: description.free === true,
        fund: description.free ? null : (description.fund ?? null),
        reminds: description.remind === true,
        runsBots: description.bots === true,
        bots: status.bots ?? [],
        connectors: description.bots === true ? connectorOffers(description.connectors) : [],
      };
    } catch (error) {
      return {
        url: named.url,
        name: named.name ?? new URL(named.url).hostname,
        host: null,
        status: null,
        free: false,
        fund: null,
        reminds: false,
        runsBots: false,
        bots: [],
        connectors: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A client for a host a space names, checked to be the host it chose */
  async function spaceHostClient(spaceId: string, url: string) {
    const named = (await namedHosts(spaceId)).find((known) => known.url === url);
    if (!named) throw new Error('This space doesn’t use the host at that address');
    const description = await describeHost(named.url);
    if (named.did && named.did !== description.did) throw new Error('The host’s key changed');
    return createSpaceHostClient(named.url, description.did, provider);
  }

  /** Hands the hosts a space names its pass, when they were paid and don't carry it with its key yet */
  async function keepSpaceHosts(spaceId: string): Promise<void> {
    // Only while it is open: a change heard as it closed must not open it again.
    if ((await kindOf(spaceId)) || !runtimes.has(spaceId)) return;
    const hosts = await namedHosts(spaceId);
    await reachHosts(spaceId, hosts);
    if (narrowNote) return;
    const named = hosts.map((h) => h.url).join(' ');
    const asked = spaceHostsAsked.get(spaceId);
    if (!hosts.length || (asked?.named === named && Date.now() - asked.at < SPACE_HOSTS_EVERY_MS)) return;
    spaceHostsAsked.set(spaceId, { at: Date.now(), named });
    for (const known of hosts) await askSpaceHost(spaceId, known, true);
  }

  // ─── Reaching hosts ────────────────────────────────────────────────
  //
  // A host is reached over its socket, at the address its description names
  // (`peer`). Every space holds one to each host the account uses, as the
  // account's carry space names them all; a space also holds one to each host
  // it pays itself (`std.host`). The account registry also tries the hosts
  // the node was built with (`network.hosts`), so a new device with only the
  // recovery code finds its registry there, and every space from it.

  /** Each host's socket address, as its description said: asked once, and again after a failure */
  /** A node address pinned to a key (spec 04 §5.2); one without a key to pin stays as it is */
  const pinnedTo = (address: string | null, did: string | undefined): string | null =>
    address && did?.startsWith('did:key:') ? `${address.split('#')[0]}#${did}` : address;
  const describedPeers = new Map<string, Promise<string | null>>();
  function describedPeer(url: string): Promise<string | null> {
    let found = describedPeers.get(url);
    if (!found) {
      found = describeHost(url).then(
        (description) => pinnedTo(hostPeerAddress(url, description), description.did),
        () => {
          describedPeers.delete(url);
          return null;
        },
      );
      describedPeers.set(url, found);
    }
    return found;
  }
  /**
   * A host's socket address: the one written down with it, or its
   * description's. Pinned to the key written down with it when there is one,
   * else the key it described itself with, so another node answering there is refused.
   */
  const peerOf = async (host: {
    url: string;
    peer?: string;
    host?: string;
    did?: string;
  }): Promise<string | null> => {
    const address =
      (host.peer ? hostPeerAddress(host.url, { peer: host.peer }) : null) ?? (await describedPeer(host.url));
    return pinnedTo(address, host.host ?? host.did);
  };

  /** What each space was last told to reach, so nothing reconnects when nothing changed */
  const reaching = new Map<string, string>();

  /** Gives a space's runtime the hosts to hold sockets to: the account's, and those it pays itself */
  async function reachHosts(
    spaceId: string,
    spaceHosts?: ReadonlyArray<{ url: string; peer?: string; did?: string }>,
  ): Promise<void> {
    if (!config.network) return;
    const open = runtimes.get(spaceId);
    if (!open) return;
    const hosts: Array<{ url: string; peer?: string; host?: string; did?: string }> = [
      ...(await hostingRecords()),
    ];
    if (spaceId === accountSpaceId) hosts.push(...(config.network.hosts ?? []).map((url) => ({ url })));
    // Asked only while it is still open: asking would open it again.
    if (!(await kindOf(spaceId)) && runtimes.get(spaceId) === open)
      hosts.push(...(spaceHosts ?? (await namedHosts(spaceId))));
    // The nodes the invite that brought it here named: the inviter's hosts, reached before the space's own
    // records are. Once the space names its keepers, only those of them it names: an invite is unauthenticated.
    const named = (await registry.get(spaceId))?.nodes ?? [];
    const keepers = new Set(
      named.length > 0
        ? ((await (await open).access().catch(() => null))?.keepers ?? []).map((keeper) => keeper.did)
        : [],
    );
    const invited = named.filter(
      (node) => keepers.size === 0 || keepers.has(decodeURIComponent(node.split('#')[1] ?? '')),
    );
    const peers = [
      ...new Set(
        [...(await Promise.all(hosts.map(peerOf))), ...invited].filter(
          (peer): peer is string => peer !== null,
        ),
      ),
    ].sort();
    const said = peers.join(' ');
    if (reaching.get(spaceId) === said || runtimes.get(spaceId) !== open) return;
    reaching.set(spaceId, said);
    (await open).useNodes(peers);
  }

  const hosting = Object.freeze<NodeHosting>({
    async space(spaceId) {
      const hand = !narrowNote;
      const views = await Promise.all(
        (await namedHosts(spaceId)).map((known) => askSpaceHost(spaceId, known, hand)),
      );
      if (hand) spaceHostsAsked.set(spaceId, { at: Date.now(), named: views.map((v) => v.url).join(' ') });
      return views;
    },

    async list() {
      return Promise.all((await hostingRecords()).map((known) => viewHosting(known)));
    },

    async over(spaceId) {
      const found: Array<{ url: string; name: string; over: OverSpace }> = [];
      for (const hosting of await hostingRecords()) {
        const status = hosting.receipt ? await readStatus(hosting.receipt, hosting.host, provider) : null;
        const over = status?.over?.find((one) => one.space === spaceId);
        if (over) found.push({ url: hosting.url, name: hosting.name ?? new URL(hosting.url).host, over });
      }
      return found;
    },

    async use(address) {
      const registryRt = await requireAccount('Using a host');
      const base = checkAddress(address, 'A host').origin;
      const known = (await hostingRecords()).find((existing) => existing.url === base);
      if (known) return viewHosting(known, true);
      const description = await describeHost(base);
      const peer = hostPeerAddress(base, description);
      const record: Hosting = {
        url: base,
        host: description.did,
        name: description.name,
        ...(peer ? { peer } : {}),
        seed: base64UrlEncode(newSubscriptionSeed()),
        since: new Date().toISOString(),
      };
      await registryRt.upsertSystem<Hosting>(HOSTING_COLLECTION, await hostingKey(base), record);
      return viewHosting(record, true);
    },

    async pay(url, payment) {
      return (await hostClient(await requireHosting(url))).client.pay(payment);
    },

    async remind(url, email) {
      await (await hostClient(await requireHosting(url))).client.remind(email);
    },

    async payForSpace(spaceId, url, payment) {
      return (await spaceHostClient(spaceId, url)).pay(spaceId, payment);
    },

    async remindForSpace(spaceId, url, email) {
      await (await spaceHostClient(spaceId, url)).remind(spaceId, email);
    },

    async stopForSpace(spaceId, url) {
      const named = (await namedHosts(spaceId)).find((known) => known.url === url);
      if (!named) throw new Error('This space doesn’t use the host at that address');
      // Which bots are the host's is its own word, signed: asked before it is let go.
      const view = await askSpaceHost(spaceId, named, false);
      // Un-named first, so no device hands it the key that follows.
      const rt = await runtime(spaceId);
      for (const record of await rt.list<unknown>({ collection: 'std.host' })) {
        const body = record.body;
        if (record.deleted || !isRecord(body) || typeof body.url !== 'string') continue;
        let origin: string;
        try {
          origin = new URL(body.url).origin;
        } catch {
          continue;
        }
        if (origin === url) await rt.remove(record.key);
      }
      const access = await spaces.access(spaceId);
      const members = new Map(access.members.map((member) => [member.did, member.roles]));
      const bots: string[] = [];
      for (const bot of view.bots.map((one) => one.bot)) {
        const roles = members.get(bot);
        if (roles && (await spaces.may(spaceId, MEMBER_REMOVE, { self: false, roles }))) bots.push(bot);
      }
      if (bots.length === 0 && !(await spaces.may(spaceId, KEY_CHANGE))) return { bots: [], newKey: false };
      for (const bot of bots) await spaces.removeMember(spaceId, bot);
      // A host that can't say whether it holds a pass is taken to hold one.
      const handed = view.status ? view.status.carrying : true;
      const newKey = access.key !== null && (bots.length > 0 || handed);
      // Removing a member changes the key by itself; with none removed it is changed here.
      if (newKey && bots.length === 0) await spaces.changeKey(spaceId);
      return { bots, newKey };
    },

    async startBot(spaceId, url, bot) {
      const client = await spaceHostClient(spaceId, url);
      const invite = await spaces.invite(spaceId, bot.role ? { role: bot.role } : {});
      const { bot: did, status } = await client.startBot(spaceId, bot.name, invite);
      return { bot: did, status };
    },

    async stop(url) {
      const registryRt = await requireAccount('Stopping a host');
      const known = await requireHosting(url);
      const { client } = await hostClient(known);
      await client.detach().catch(() => {});
      const carrier = (await liveCarriers()).find(({ body }) => body.did === known.host);
      if (carrier) await carriers.remove(carrier.carry.space.id);
      await registryRt.removeSystem(await hostingKey(known.url));
    },
  });

  // ─── Contacts ──────────────────────────────────────────────────────
  //
  // One `std.contact` per person in the contacts space, keyed by their DID, so
  // there is one per person on every device. Asking someone is a knock left
  // as a `std.contact-request` in a space you share: the signed invite to a new space for
  // two, sealed to their contact key, so it opens only for them, and only as
  // coming from the account that left it.

  // The key `onePer: ['did']` derives, so the record for someone is the same one on every device.
  const contactRecordKey = async (did: string) =>
    (await contactsRuntime()).onePerKey(contactSchema.name, { did }, { onePer: contactSchema.rules.onePer });

  async function contactsRuntime(): Promise<SpaceRuntime> {
    if (!contactsSpaceId)
      throw new Error(
        'This app was not given your contacts. Connect to your account home again, and allow contacts.',
      );
    return runtime(contactsSpaceId);
  }

  /** Making and joining spaces for two needs a note good for every space — whole-account access. */
  function requireEverywhere(what: string): void {
    // As a knock needs: `/account/write` for the whole account (spec 01 §8, 07).
    if (narrowNote) {
      throw new Error(
        `${what} makes or joins a space, which needs access to your whole account. Connect to your account home again, and ask for it.`,
      );
    }
  }

  /** Defines a collection in a space that has none by that name yet */
  async function ensureDefined(open: SpaceRuntime, definition: DefineCollection): Promise<void> {
    if (
      (await open.collections()).some(
        (collection) => collection.name === definition.name && collection.version !== null,
      )
    )
      return;
    try {
      await open.define(definition);
    } catch {
      throw new Error(
        `This space has no ${definition.title ?? definition.name} collection yet, and you can't add one here. Ask someone who manages it.`,
      );
    }
  }

  async function contactRecords(): Promise<ReadonlyArray<NodeRecord<Contact>>> {
    if (!contactsSpaceId) return [];
    const found: NodeRecord<Contact>[] = [];
    const listed = await ownRecords<Contact>(
      await contactsRuntime(),
      { collection: contactSchema.name },
      (record) => typeof record.body?.did === 'string' && typeof record.body.name === 'string',
    );
    // One record per person, under the key their DID gives.
    for (const record of listed)
      if (record.key === (await contactRecordKey(record.body!.did))) found.push(record);
    return found;
  }

  /** Whoever the account blocked */
  const blockedDids = async () =>
    new Set((await contactRecords()).flatMap(({ body }) => (body!.blocked === true ? [body!.did] : [])));

  function requireContactKeys(): void {
    if (!contactKeys)
      throw new Error(
        "This app can't read contact requests. Connect to your account home again, and allow contacts.",
      );
  }

  function contactView(record: NodeRecord<Contact>): ContactView {
    const body = record.body!;
    return Object.freeze({
      did: body.did,
      name: body.name,
      space: typeof body.space === 'string' ? body.space : null,
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
      blocked: body.blocked === true,
      updatedAt: record.updatedAt,
    });
  }

  async function writeContact(body: Contact): Promise<ContactView> {
    const open = await contactsRuntime();
    await ensureDefined(open, contactSchema);
    // One per person: writing again is the next version of their record.
    return contactView(await open.put<Contact>(contactSchema.name, body));
  }

  /** Leaves a space for two, unless another contact still names it */
  async function leavePairSpace(spaceId: string | null, did: string): Promise<void> {
    if (!spaceId || !(await registry.get(spaceId))) return;
    if ((await contactRecords()).some((record) => record.body!.did !== did && record.body!.space === spaceId))
      return;
    await spaces.leave(spaceId);
  }

  /**
   * A knock left in a space as a contact request, opened — or null when it
   * isn't one sealed to this account's contact key, by the account that wrote it.
   */
  async function openMail(record: NodeRecord<unknown> | null): Promise<OpenedKnock | null> {
    if (
      !config.contactKey ||
      !contactKeys ||
      !record?.verified ||
      record.collection !== contactRequestSchema.name
    )
      return null;
    const body = record.body;
    if (!isRecord(body) || body.to !== contactKeys.publicKey || typeof body.sealed !== 'string') return null;
    const opened = await openKnock([config.contactKey], body.sealed, provider);
    if (!opened || opened.from !== record.root || opened.from === config.signer.did) return null;
    return opened;
  }

  /**
   * A space for two and a knock that invites someone to it, sealed to `to`:
   * their inbox key or their contact key. The space waits for a carrier to
   * hold it before the knock is made, so they can join with every device of
   * this account away (`spaces.carried`).
   */
  async function makePair(
    to: string,
    names: { readonly mine: string; readonly theirs: string },
    note: string | undefined,
  ): Promise<{
    readonly space: string;
    readonly invite: string;
    readonly sealed: string;
    readonly carried: boolean;
  }> {
    const pair = await spaces.create({
      name: `${clip(names.mine, 64)} & ${clip(names.theirs, 64)}`,
      visibility: 'private',
      ...team,
    });
    try {
      const invite = await spaces.invite(pair.id, { role: 'editor' });
      const { signed, invite: secret } = parseSpaceInvite(invite);
      if (!secret) throw new Error('The invite to the space for two opens no role');
      const carried = await spaces.carried(pair.id);
      const sealed = await sealKnock(
        to,
        { invite: signed, secret: base64UrlDecode(secret), name: names.mine, ...(note ? { note } : {}) },
        looseSigner(),
        provider,
      );
      return { space: pair.id, invite, sealed, carried };
    } catch (error) {
      await spaces.leave(pair.id).catch(() => {});
      throw error;
    }
  }

  const contacts: NodeContacts = Object.freeze<NodeContacts>({
    async space() {
      return contactsSpaceId;
    },

    async list() {
      return (await contactRecords())
        .map(contactView)
        .sort((a, b) => a.name.localeCompare(b.name) || a.did.localeCompare(b.did));
    },

    async get(did) {
      const record = (await contactRecords()).find((found) => found.body!.did === did);
      return record ? contactView(record) : null;
    },

    async put(contact: {
      readonly did: string;
      readonly name: string;
      readonly space?: string | null;
      readonly note?: string;
    }) {
      if (!contact.did.startsWith('did:')) throw new Error('A contact needs their account DID');
      const name = contact.name.trim().slice(0, 200);
      if (!name) throw new Error('A contact needs a name');
      return writeContact({
        did: contact.did,
        name,
        ...(contact.space ? { space: contact.space } : {}),
        ...(contact.note ? { note: contact.note.slice(0, 2000) } : {}),
      });
    },

    async remove(did) {
      const found = await contacts.get(did);
      if (!found) return;
      await leavePairSpace(found.space, did);
      const key = await contactRecordKey(did);
      if (key) await (await contactsRuntime()).remove(key);
    },

    async block(did) {
      const found = await contacts.get(did);
      await leavePairSpace(found?.space ?? null, did);
      await writeContact({
        did,
        name: found?.name ?? did,
        blocked: true,
        ...(found?.note ? { note: found.note } : {}),
      });
    },

    async ask(spaceId, did, options = {}) {
      requireEverywhere('Adding a contact');
      if (did === config.signer.did) throw new Error('That is you');
      if (!contactsSpaceId) await contactsRuntime();
      const shared = await runtime(spaceId);
      const profiles = await shared.profiles();
      const theirs = profiles.find((profile) => profile.did === did);
      if (!theirs?.contactKey) {
        throw new Error(
          "They can't be asked here yet: their profile in this space has no contact key. It appears once they open the space in an up-to-date app.",
        );
      }
      const mine =
        (await ownName()) ?? profiles.find((profile) => profile.did === config.signer.did)?.name ?? 'Me';
      const note = options.note?.trim().slice(0, 2000);
      const made = await makePair(theirs.contactKey, { mine, theirs: theirs.name }, note);
      await ensureDefined(shared, contactRequestSchema);
      await writeContact({ did, name: theirs.name, space: made.space });
      const request = await shared.put<ContactRequestRecord>(contactRequestSchema.name, {
        to: theirs.contactKey,
        sealed: made.sealed,
      });
      return { space: made.space, request: request.key, carried: made.carried };
    },

    async requests(spaceId) {
      requireContactKeys();
      const shared = await runtime(spaceId);
      const blocked = await blockedDids();
      const names = new Map((await shared.profiles()).map((profile) => [profile.did, profile.name]));
      const found: ContactRequest[] = [];
      for (const record of await shared.list<unknown>({ collection: contactRequestSchema.name })) {
        const opened = await openMail(record);
        if (!opened || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push({
          space: spaceId,
          key: record.key,
          from: opened.from,
          name: names.get(opened.from) ?? null,
          ...(opened.note ? { note: opened.note } : {}),
          pairSpace: opened.pairSpace,
          createdAt: record.createdAt,
        });
      }
      return found;
    },

    async accept(spaceId, requestKey) {
      requireEverywhere('Accepting a contact request');
      requireContactKeys();
      const shared = await runtime(spaceId);
      const opened = await openMail(await shared.get<unknown>(requestKey));
      if (!opened) throw new Error('That contact request is gone, or is not for you.');
      await spaces.join(opened.invite);
      const name =
        (await shared.profiles()).find((profile) => profile.did === opened.from)?.name ??
        (await contacts.get(opened.from))?.name ??
        opened.name;
      return writeContact({ did: opened.from, name, space: opened.pairSpace });
    },

    async others(did) {
      const found = await contacts.get(did);
      if (!found?.space || !(await registry.get(found.space))) return [];
      const open = await runtime(found.space);
      const [{ members }, profiles, status] = await Promise.all([
        open.access(),
        open.profiles(),
        open.status(),
      ]);
      const seen = new Set([
        ...members.map((member) => member.did),
        ...profiles.map((profile) => profile.did),
        ...Object.values(status.accounts),
      ]);
      return [...seen].filter((account) => account !== config.signer.did && account !== did).sort();
    },
  });

  // ─── The inbox ─────────────────────────────────────────────────────
  //
  // The inbox's settings are a `std.inbox` in the contacts space; its keys
  // are derived from the contact key and its `gen`, so every device with the
  // contact key opens the same inbox. Knocks wait in the mailboxes it names.
  //
  // A knock you left is a `std.knock` until someone other than you joins
  // the space for two: only the holder of the inbox key could open the
  // invite, so whoever joins is them. Then it becomes a contact, and the
  // invite is closed. See `packages/core/src/inbox/inbox.ts`.

  /** Knocks seen in this node's inbox, by id: opened (null when they didn't check out), and until when to keep them */
  const knockCache = new Map<string, { readonly opened: OpenedKnock | null; readonly until: number }>();
  /** Knocks that didn't check out, by id, and until when they are not opened again: one dated a little ahead may pass later */
  const failed = new Map<string, number>();
  const DAY_MS = 24 * 3600 * 1000;

  /** The inbox is the account's own, in its contacts space: only a key acting as the account opens one, as every peer checks */
  const inboxAllowed = () => contactsSpaceId !== null && !narrowNote;

  function requireContactKey(what: string): Uint8Array {
    // The inbox is the account's: a key whose note doesn't grant `/account/write` never opens one or knocks.
    if (!inboxAllowed())
      throw new Error(`This key's note doesn't let it use your inbox. ${what} is the person's to do.`);
    if (!config.contactKey)
      throw new Error(
        `${what} needs your contact key. Connect to your account home again, and allow contacts.`,
      );
    return config.contactKey;
  }

  /** An inbox's keys, from the contact key and its gen */
  async function inboxKeys(gen: number) {
    const contactKey = requireContactKey('Your inbox');
    const key = await deriveInboxKeyBytes(contactKey, gen);
    const sign = await deriveInboxSignKeyBytes(contactKey, gen);
    const signPublic = contactPublicKey(sign);
    return { key, sign, publicKey: contactPublicKey(key), signPublic, topic: await inboxTopic(signPublic) };
  }

  /** The account's inbox: the newest `std.inbox` of the highest gen */
  async function inboxRecord(): Promise<NodeRecord<Inbox> | null> {
    if (!contactsSpaceId) return null;
    const records = await ownRecords<Inbox>(
      await contactsRuntime(),
      { collection: inboxSchema.name },
      (record) =>
        Number.isSafeInteger(record.body?.gen) && record.body!.gen >= 0 && Array.isArray(record.body!.places),
    );
    return (
      records.sort((a, b) => b.body!.gen - a.body!.gen || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    );
  }

  async function inboxView(record: NodeRecord<Inbox>): Promise<InboxView> {
    const body = record.body!;
    const keys = await inboxKeys(body.gen);
    return Object.freeze({
      gen: body.gen,
      ...(body.name ? { name: body.name } : {}),
      key: keys.publicKey,
      sign: keys.signPublic,
      places: Object.freeze([...body.places]),
      code: await encodeInbox(
        keys.sign,
        {
          key: keys.publicKey,
          sign: keys.signPublic,
          gen: body.gen,
          places: body.places,
          ...(body.name ? { name: body.name } : {}),
        },
        provider,
      ),
      updatedAt: record.updatedAt,
    });
  }

  /** Writes the inbox's settings, checked the way a knocker will read its code */
  async function writeInbox(body: Inbox, current: NodeRecord<Inbox> | null): Promise<InboxView> {
    const keys = await inboxKeys(body.gen);
    await encodeInbox(keys.sign, { ...body, key: keys.publicKey, sign: keys.signPublic }, provider);
    const open = await contactsRuntime();
    await ensureDefined(open, inboxSchema);
    return inboxView(
      current ? await open.update<Inbox>(current.key, body) : await open.put<Inbox>(inboxSchema.name, body),
    );
  }

  /** Clears knocks from every mailbox an inbox names, as its owner; how many did */
  async function purgeInbox(body: Inbox, ids: ReadonlyArray<string> | null): Promise<number> {
    const keys = await inboxKeys(body.gen);
    const done = await Promise.allSettled(
      body.places.map((place) =>
        mailbox.purge(place, keys.topic, keys.signPublic, ids, (nonce) =>
          signPurge(keys.sign, keys.topic, nonce, ids),
        ),
      ),
    );
    return done.filter((result) => result.status === 'fulfilled').length;
  }

  async function sentRecords(): Promise<ReadonlyArray<NodeRecord<Knock>>> {
    if (!contactsSpaceId) return [];
    return ownRecords<Knock>(
      await contactsRuntime(),
      { collection: knockSchema.name },
      (record) => typeof record.body?.space === 'string' && typeof record.body.invite === 'string',
    );
  }

  /**
   * Knocks of yours: one someone joined becomes a contact, and its invite is
   * closed; one nobody joined within the knock's life is let go, space and all.
   */
  async function settleSent(): Promise<void> {
    for (const record of await sentRecords()) {
      const { space, name, invite } = record.body!;
      if (!(await registry.get(space))) {
        await (await contactsRuntime()).remove(record.key);
        continue;
      }
      const open = await runtime(space);
      // Only the holder of the inbox key could open the invite: whoever joined first is them.
      const joiner = (await open.access()).members.find((member) => member.did !== config.signer.did)?.did;
      if (joiner) {
        // Whoever else the invite reached, nobody more joins with it.
        await spaces.closeInvite(space, invite).catch(() => {});
        const given = (await open.profiles()).find((profile) => profile.did === joiner)?.name;
        await writeContact({ did: joiner, name: given ?? name, space });
        await (await contactsRuntime()).remove(record.key);
      } else if (Date.now() - Date.parse(record.createdAt) > KNOCK_TTL_SECONDS * 1000 + DAY_MS) {
        await spaces.leave(space).catch(() => {});
        await (await contactsRuntime()).remove(record.key);
      }
    }
  }

  /** What the mailboxes of this node's inbox hold now, opened and cached */
  async function readKnocks(): Promise<ReadonlyArray<{ readonly id: string; readonly opened: OpenedKnock }>> {
    const now = Date.now();
    for (const [id, cached] of knockCache) if (cached.until <= now) knockCache.delete(id);
    const record = await inboxRecord();
    if (!record) return [];
    const { gen, places } = record.body!;
    const keys = await inboxKeys(gen);
    // Every mailbox, in full: an inbox holds 64 knocks at most, and a knock
    // cleared from another device should go from here too. What was opened
    // once is not opened again, nor what failed to.
    const held = new Map<string, string>();
    const fetched = await Promise.allSettled(places.map((place) => mailbox.fetch(place, keys.topic)));
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      // A relay's id is only its word: file the knock under the hash of what it is.
      for (const item of result.value) held.set(await knockId(item.blob), item.blob);
    }
    const found: { id: string; opened: OpenedKnock }[] = [];
    for (const [id, blob] of held) {
      let opened = knockCache.get(id)?.opened ?? null;
      if (!opened && (failed.get(id) ?? 0) <= now) {
        opened = await openKnock([keys.key], blob, provider);
        if (opened) knockCache.set(id, { opened, until: opened.at + KNOCK_TTL_SECONDS * 1000 });
        else failed.set(id, now + 15 * 60_000);
      }
      if (opened) found.push({ id, opened });
    }
    return found;
  }

  /** A direct message as this account reads it — null when it is neither by nor for this account */
  async function directView(
    spaceId: string,
    open: SpaceRuntime,
    record: NodeRecord<DirectBody>,
  ): Promise<DirectMessage | null> {
    // Who wrote it is whoever created it: the context binds that account, so a copy posted by anyone else opens nothing.
    const from = record.createdBy;
    if (!record.verified || record.collection !== directSchema.name || !from || record.root !== from)
      return null;
    const to = Array.isArray(record.body?.to) ? record.body.to.filter((did) => typeof did === 'string') : [];
    const me = config.signer.did;
    if (from !== me && !to.includes(me)) return null;
    const pair = open.ownMemberKey();
    const opened = pair ? await openDirect(spaceId, from, record.body, me, pair) : null;
    return Object.freeze({
      key: record.key,
      from,
      to: [...to].sort(),
      text: opened?.text ?? null,
      createdAt: record.createdAt,
      ...(record.recordsOnly ? { recordsOnly: true as const } : {}),
    });
  }

  const direct = Object.freeze<NodeDirect>({
    async reachable(spaceId) {
      const open = await runtime(spaceId);
      const { members } = await open.access();
      const keys = await open.memberKeys();
      return members
        .map((member) => member.did)
        .filter((did) => did !== config.signer.did && keys.has(did))
        .sort();
    },

    async send(spaceId, to, text) {
      const open = await runtime(spaceId);
      const pair = open.ownMemberKey();
      if (!pair)
        throw new Error(
          "This node can't seal direct messages here: it wasn't given your member key for this space.",
        );
      const trimmed = text.trim();
      if (!trimmed) throw new Error('A direct message needs some text');
      // Your own key as this node holds it, so your other devices read what you sent even before it is published.
      const keys = new Map(await open.memberKeys());
      keys.set(config.signer.did, pair.publicKey);
      const body = await sealDirect(spaceId, config.signer.did, to, { text: trimmed }, keys);
      await ensureDefined(open, directSchema);
      const record = await open.put<DirectBody>(directSchema.name, body);
      const view = await directView(spaceId, open, record);
      if (!view) throw new Error('The direct message was written, but could not be read back');
      return view;
    },

    async list(spaceId) {
      const open = await runtime(spaceId);
      const found: DirectMessage[] = [];
      for (const record of await open.list<DirectBody>({ collection: directSchema.name })) {
        const view = await directView(spaceId, open, record);
        if (view) found.push(view);
      }
      return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    },
  });

  const inbox: NodeInbox = Object.freeze<NodeInbox>({
    async get() {
      if (!config.contactKey || !inboxAllowed()) return null;
      const record = await inboxRecord();
      return record ? inboxView(record) : null;
    },

    async open(options = {}) {
      requireContactKey('Opening your inbox');
      if (!contactsSpaceId) await contactsRuntime();
      const current = await inboxRecord();
      const places = [...(options.places ?? current?.body?.places ?? usableRelays(config.network))].slice(
        0,
        MAX_INBOX_PLACES,
      );
      if (places.length === 0)
        throw new Error('An inbox needs a mailbox to hold its knocks, and this node has none.');
      const name = clip((options.name ?? current?.body?.name ?? (await ownName()) ?? '').trim(), 64);
      return writeInbox({ gen: current?.body?.gen ?? 0, places, ...(name ? { name } : {}) }, current);
    },

    async rotate() {
      requireContactKey('Replacing your inbox');
      const current = await inboxRecord();
      if (!current) return inbox.open();
      // What waits in the old one goes with it.
      await purgeInbox(current.body!, null).catch(() => 0);
      knockCache.clear();
      failed.clear();
      return writeInbox({ ...current.body!, gen: current.body!.gen + 1 }, current);
    },

    async clear() {
      requireContactKey('Clearing your inbox');
      const current = await inboxRecord();
      if (!current) throw new Error('Your inbox is not open');
      if ((await purgeInbox(current.body!, null)) === 0)
        throw new Error("None of your inbox's mailboxes could be reached to clear it.");
      knockCache.clear();
      failed.clear();
    },

    async knock(code, options = {}) {
      requireContactKey('Knocking');
      requireEverywhere('Knocking');
      const theirs = await readInboxCode(code, provider);
      if ((await inbox.get())?.key === theirs.key) throw new Error('That is your own inbox');
      if (!contactsSpaceId) await contactsRuntime();
      const mine = (await ownName()) ?? 'Someone';
      const name = theirs.name ?? 'Contact';
      const made = await makePair(theirs.key, { mine, theirs: name }, options.note);
      const topic = await inboxTopic(theirs.sign);
      const left = await Promise.allSettled(
        theirs.places.map((place) => mailbox.drop(place, topic, made.sealed, KNOCK_TTL_SECONDS)),
      );
      if (!left.some((result) => result.status === 'fulfilled')) {
        await spaces.leave(made.space).catch(() => {});
        const reasons = left
          .map((result) => (result.status === 'rejected' ? reasonText(result.reason) : ''))
          .filter(Boolean);
        throw new Error(`None of their inbox's mailboxes took the knock. ${reasons.join('; ')}`);
      }
      const open = await contactsRuntime();
      await ensureDefined(open, knockSchema);
      await open.put<Knock>(knockSchema.name, { space: made.space, name, invite: made.invite });
      return { space: made.space, carried: made.carried };
    },

    async knocks() {
      requireContactKey('Reading knocks');
      await settleSent().catch(() => {});
      const blocked = await blockedDids();
      const found: KnockView[] = [];
      for (const { id, opened } of await readKnocks()) {
        if (opened.from === config.signer.did || blocked.has(opened.from)) continue;
        // Already accepted, here or on another device.
        if (await registry.get(opened.pairSpace)) continue;
        found.push(
          Object.freeze({
            id,
            from: opened.from,
            name: opened.name,
            ...(opened.note ? { note: opened.note } : {}),
            pairSpace: opened.pairSpace,
            at: new Date(opened.at).toISOString(),
          }),
        );
      }
      return found.sort((a, b) => b.at.localeCompare(a.at));
    },

    async sent() {
      await settleSent().catch(() => {});
      return (await sentRecords()).map((record) =>
        Object.freeze({ space: record.body!.space, name: record.body!.name, at: record.createdAt }),
      );
    },

    async accept(id) {
      requireContactKey('Accepting a knock');
      requireEverywhere('Accepting a knock');
      if (!knockCache.get(id)?.opened) await readKnocks();
      const knocked = knockCache.get(id)?.opened;
      if (!knocked) throw new Error('That knock is gone: it expired, or your inbox was cleared or replaced.');
      await spaces.join(knocked.invite);
      const known = await contacts.get(knocked.from);
      const contact = await writeContact({
        did: knocked.from,
        name: known?.name ?? knocked.name,
        space: knocked.pairSpace,
      });
      // Done with: nobody needs it in the mailboxes any more.
      const current = await inboxRecord();
      if (current) await purgeInbox(current.body!, [id]).catch(() => 0);
      knockCache.delete(id);
      return contact;
    },

    async dismiss(id) {
      requireContactKey('Dismissing a knock');
      const current = await inboxRecord();
      if (current) await purgeInbox(current.body!, [id]);
      knockCache.delete(id);
    },
  });

  const collections = Object.freeze<NodeCollections>({
    list: perSpace((rt) => rt.collections()),
    define: perSpace((rt, definition: DefineCollection) => rt.define(definition)),
    delete: perSpace((rt, name: string) => rt.undefine(name)),
    tag: perSpace((rt, collection: string, field: string, value: string | number | boolean) =>
      rt.topicTag(collection, field, value),
    ),
  });

  const accountApi = Object.freeze<NodeAccount>({
    profile: ownProfile,
    async setName(name) {
      const registryRt = await requireAccount('Renaming across devices');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A name cannot be empty');
      const avatar = (await ownProfile())?.avatar;
      const written = await registryRt.upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, {
        name: trimmed,
        ...(avatar ? { avatar } : {}),
      });
      emit({ type: 'account' });
      await publishProfileToOpenSpaces();
      return { name: trimmed, updatedAt: written.updatedAt, ...(avatar ? { avatar } : {}) };
    },
    async setAvatar(image, options = {}) {
      const registryRt = await requireAccount('Changing the picture across devices');
      const name = (await ownName()) ?? options.name?.trim();
      if (!name) throw new Error('Give the account a name first');
      if (image && !image.mime.startsWith('image/')) throw new Error('A picture is an image');
      const avatar = image ? { ...(await registryRt.addFile(image.bytes)), mime: image.mime } : null;
      const written = await registryRt.upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, {
        name,
        ...(avatar ? { avatar } : {}),
      });
      emit({ type: 'account' });
      await publishProfileToOpenSpaces();
      return { name, updatedAt: written.updatedAt, ...(avatar ? { avatar } : {}) };
    },
    async picture() {
      const avatar = (await ownProfile())?.avatar;
      if (!avatar || !accountSpaceId) return null;
      return { bytes: await (await runtime(accountSpaceId)).readFile(avatar), mime: avatar.mime };
    },
    revoke: async (key, options) =>
      (await requireAccount('Revoking in the account registry')).revoke(key, options),
  });

  /** The records namespace, writing as `as` when given: an agent's key and note */
  function makeRecords(as?: ActiveSession): NodeRecords {
    const self: NodeRecords = Object.freeze({
      list: async <T>(spaceId: string, options?: ListOptions) => (await runtime(spaceId)).list<T>(options),
      get: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).get<T>(key),
      contracts: async (spaceId: string, key: string, version?: string) =>
        (await runtime(spaceId)).contracts(key, version),
      keyFor: async (spaceId: string, name: string, account?: string) =>
        (await runtime(spaceId)).keyFor(name, account),
      onePerKey: async (
        spaceId: string,
        collection: string,
        body: unknown,
        options?: { links?: ReadonlyArray<Link>; account?: string },
      ) => (await runtime(spaceId)).onePerKey(collection, body, options),
      put: async <T>(
        spaceId: string,
        collection: CollectionRef,
        body: T,
        options?: { key?: string; links?: ReadonlyArray<Link> },
      ) => (await runtime(spaceId)).put<T>(nameOf(collection), body, as ? { ...options, as } : options),
      update: async <T>(spaceId: string, key: string, body: T, options?: { links?: ReadonlyArray<Link> }) =>
        (await runtime(spaceId)).update<T>(key, body, as ? { ...options, as } : options),
      linked: async <T>(spaceId: string, key: string, options?: { rel?: string; collection?: string }) =>
        (await runtime(spaceId)).linked<T>(key, options),
      delete: async (spaceId: string, key: string) =>
        (await runtime(spaceId)).remove(key, as ? { as } : undefined),
      history: async <T>(spaceId: string, key: string) => (await runtime(spaceId)).history<T>(key),
      addFile: async (spaceId: string, bytes: Uint8Array, about: { mime: string; name?: string }) => ({
        ...(await (await runtime(spaceId)).addFile(bytes)),
        mime: about.mime,
        ...(about.name !== undefined ? { name: about.name } : {}),
      }),
      readFile: async (spaceId: string, ref: FileRef) => (await runtime(spaceId)).readFile(ref),
      can: perSpace((rt, action: 'create' | 'edit' | 'delete', target: string) => rt.can(action, target)),
      async query<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
        spaceId: string,
        query: Query<C, I>,
      ): Promise<ResultFor<C, I>> {
        const space = await runtime(spaceId);
        // Asked before running, so a node holding part of the space starts fetching what it lacks.
        const complete = space.use(collectionsOf(plainQuery(query)));
        const result = await runQuery(
          {
            list: (collection) => space.list({ collection }),
            get: (key) => space.get(key),
            linked: (key, options) => space.linked(key, options),
            computed: (collection) => space.computed(collection),
          },
          query,
        );
        // The query's type says what it finds; running it can't prove that.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed from the query
        return { ...result, complete } as ResultFor<C, I>;
      },
      watch<const C extends CollectionRef, const I extends IncludeMap | undefined = undefined>(
        spaceId: string,
        query: Query<C, I>,
        onResult: (result: ResultFor<C, I>) => void,
        onError?: (error: Error) => void,
      ) {
        let stopped = false;
        // Changes arrive in bursts during sync: one run at a time, never a queue of stale runs.
        const run = serial(async () => {
          if (stopped) return;
          try {
            const result = await self.query(spaceId, query);
            if (!stopped) onResult(result);
          } catch (error) {
            if (!stopped) onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
        const unsubscribe = events.subscribe((event) => {
          if (event.type === 'records' && event.space === spaceId) void run();
        });
        void run();
        return () => {
          stopped = true;
          unsubscribe();
        };
      },
    });
    return self;
  }
  const records = makeRecords();

  // ─── Agents ────────────────────────────────────────────────────────

  async function asAgent(agent: {
    readonly keys: CryptoKeyPair;
    readonly note: Delegation;
  }): Promise<P2PNode> {
    const agentDid = await didOf(agent.keys.publicKey, provider);
    const checked = await verifyNote(agent.note, provider);
    if (!checked.valid) throw new Error(`The agent's note does not check out: ${checked.reason}`);
    const { note } = checked;
    if (!grantsRecordsOnly(note))
      throw new Error(
        'That note grants more than records — ask the account home for one with `recordsOnly: true`.',
      );
    if (note.payload.aud !== agentDid) throw new Error('That note was made out to a different key.');
    if (note.payload.iss !== config.signer.did) throw new Error('That note is from a different account.');

    // The spaces its note names; all of them for an agent granted the whole account.
    // What it may do there is its note's to say; this node also refuses, by the label, what needs a person.
    const reach = noteSpaces(note);
    const named = new Set(reach === 'all' ? [] : reach);
    const allowed = (spaceId: unknown) =>
      reach === 'all' || (typeof spaceId === 'string' && named.has(spaceId));
    const contactsGiven = () => contactsSpaceId !== null && allowed(contactsSpaceId);
    // Written with the agent's key, under its note.
    const writes = makeRecords({ did: agentDid, key: agent.keys.privateKey, proof: () => note });

    // What the table in `node/api.ts` marks `own`; the rest it decides there.
    const own: { readonly [N in Namespace as keyof OwnMethods<N> extends never ? never : N]: OwnMethods<N> } =
      {
        spaces: {
          list: async () => (await spaces.list()).filter((space) => allowed(space.id)),
          get: async (spaceId) => (allowed(spaceId) ? spaces.get(spaceId) : null),
          authenticator: async () => null,
        },
        records: {
          can: async (spaceId, action, target) => allowed(spaceId) && records.can(spaceId, action, target),
          watch: (spaceId, query, onResult, onError) => {
            if (allowed(spaceId)) return records.watch(spaceId, query, onResult, onError);
            onError?.(new Error('The agent was not given this space.'));
            return () => {};
          },
        },
        // The runtime refuses this too, and every peer ignores it — said early, with what to do instead.
        collections: {
          define: async () => {
            throw new Error(CANNOT_DEFINE);
          },
        },
        hosting: {
          space: async (spaceId) => {
            if (!allowed(spaceId)) throw new Error('That space was not given to this agent');
            return hosting.space(spaceId);
          },
          over: async (spaceId) => (allowed(spaceId) ? hosting.over(spaceId) : []),
        },
        contacts: {
          space: async () => (contactsGiven() ? contactsSpaceId : null),
          list: async () => (contactsGiven() ? contacts.list() : []),
          get: async (did) => (contactsGiven() ? contacts.get(did) : null),
        },
        direct: { reachable: async (spaceId) => (allowed(spaceId) ? direct.reachable(spaceId) : []) },
        inbox: { get: async () => null },
      };
    const person = (what: string) => async (): Promise<never> => {
      throw new Error(`An agent can't ${what}. Ask the person to do it.`);
    };

    return Object.freeze({
      did: config.signer.did,
      sessionDid: agentDid,
      ...buildNamespaces((namespace, name, policy) => {
        if (policy === 'own') return givenFor(own, namespace, name);
        const source: unknown = namespace === 'records' ? writes : Reflect.get(node, namespace);
        if (!isRecord(source)) throw new Error(`A node has no ${namespace}`);
        if (policy === 'pass') return (...args: unknown[]) => callMethod(source, name, args);
        if (policy !== 'scoped') return person(policy);
        return async (...args: unknown[]) => {
          if (!allowed(args[0]))
            throw new Error(
              'The agent was not given this space. The person can give it more in their account home.',
            );
          return callMethod(source, name, args);
        };
      }),
      delegation: () => note,
      iceServers: () => node.iceServers(),
      asAgent: person('start another agent'),
      revokeKey: person('revoke a key'),
      revokeSelf: person('sign the account out'),
      subscribe: (listener: (event: NodeEvent) => void) =>
        node.subscribe((event) => {
          if (!('space' in event) || allowed(event.space)) listener(event);
        }),
      // The agent stops; the node it acts through keeps running.
      close: async () => {},
    }) satisfies P2PNode;
  }

  const node: P2PNode = Object.freeze({
    did: config.signer.did,
    sessionDid,
    spaces,
    records,
    collections,
    account: accountApi,
    carriers,
    hosting,
    automations,
    contacts,
    direct,
    inbox,
    asAgent,

    delegation: () => current,

    iceServers: async () => (mesh ? mesh.iceServers() : (config.network?.iceServers ?? DEFAULT_ICE_SERVERS)),

    network: Object.freeze({
      status: () => mesh?.status() ?? { relays: [], links: [], connecting: [], turn: false },
      reconnect: () => mesh?.reconnect(),
    }),

    subscribe: events.subscribe,

    async revokeKey(key: string, options: RevokeOptions & { readonly spaces?: ReadonlyArray<string> } = {}) {
      // Everywhere the account writes, unless told where: the listed spaces, its carry spaces and contacts space.
      const ids = options.spaces ?? [
        ...new Set([
          ...(await spaces.list()).filter((space) => space.writable).map((space) => space.id),
          ...(await carrierRecords()).map(({ carry }) => carry.space.id),
          ...(contactsSpaceId ? [contactsSpaceId] : []),
        ]),
      ];
      const wait = options.waitMs === undefined ? {} : { waitMs: options.waitMs };
      // Each its own store: one that can't be written (a space gone, or no longer the account's
      // to write in) has nothing to send, and must not keep the rest from happening.
      const taken = await Promise.all([
        ...ids.map((spaceId) => spaces.revoke(spaceId, key, wait).catch(() => true)),
        ...(options.spaces ? [] : [node.account.revoke(key, wait).catch(() => true)]),
      ]);
      return taken.every(Boolean);
    },

    async revokeSelf(options: RevokeOptions = {}) {
      // Forgotten first: a tab closed while the revokes wait must not leave a
      // revoked key behind, to be claimed and refused on every write after.
      await claimed?.forget().catch(() => {});
      // With anyone online, every revoke waits for a peer to take it in, closed
      // spaces too, which open for it. With nobody, waiting would only keep a
      // person signing out looking at a spinner: they go out with the next sync.
      let anyone = false;
      for (const open of runtimes.values()) {
        const rt = await open.catch(() => null);
        if (rt && (await rt.status()).peers.length > 0) anyone = true;
      }
      await node.revokeKey(sessionDid, anyone ? options : {});
    },

    async close() {
      if (closed) return;
      closed = true;
      stopWatchingNetwork?.();
      if (renewTimer) clearTimeout(renewTimer);
      clearInterval(linkTimer);
      const open = [...runtimes.keys()];
      await Promise.all(open.map((spaceId) => closeRuntime(spaceId)));
      // Let go of the registry too: an open database connection blocks the
      // browser from ever deleting it.
      await registryStore.close();
      // Only now: until every space is closed, the key could still sign.
      await claimed?.release();
      events.clear();
    },
  });

  // A lasting key the account revoked on an earlier visit, which was never
  // forgotten here: every write it signs would be refused. Forgotten now, and
  // this run starts again on a key of its own; the next claims a new lasting one.
  if (claimed && accountSpaceId && (await (await runtime(accountSpaceId)).isRevoked(sessionDid))) {
    await claimed.forget().catch(() => {});
    await node.close();
    const { writerKey: _revoked, ...rest } = config;
    return createNode(rest);
  }
  return node;
}
