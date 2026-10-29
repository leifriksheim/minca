/**
 * @module node
 * A node: one identity, the spaces it holds, and everything needed to read,
 * write and sync them — what a tab, a CLI, a daemon and an agent share.
 *
 * **The root key signs once.** A node signs with a session key the root
 * delegates to for an hour at a time, renewed before it runs out: one
 * signature an hour, never one per write.
 *
 * This file owns the session, the spaces the node holds and the account's
 * memberships; each other part lives in a `node-*.ts` file beside it and is
 * wired together here, sharing one `NodeContext`.
 */
import { createP256Provider } from '../identity/crypto-p256.js';
import type { SpaceRole } from '../types.js';
import { didOf } from '../identity/did.js';
import type { Delegation } from '../identity/ucan.js';
import { actsForAccount, ALL_COMMAND } from '../identity/abilities.js';
import { createSigner } from '../schema/signer.js';
import { createSchemaEngine } from '../schema/schema-engine.js';
import {
  createSpaceManager,
  encodeSpaceInvite,
  parseSpaceInvite,
  previewInvite,
  type InviteLinkOptions,
  type SpaceRecord,
} from '../space/space-manager.js';
import type { Keeper } from '../space/roles.js';
import { ROLE_ASSIGN } from '../space/grants.js';
import { createWriters } from './writers.js';
import { meshFor, openSpaceRuntime, type ActiveSession, type SpaceRuntime } from './space-runtime.js';
import { createServerAuth } from '../network/peer-auth.js';
import { DEFAULT_ICE_SERVERS } from '../network/rtc-transport.js';
import { generateLinkSecret, linkInviteSecret } from '../space/invite-link.js';
import { checkInvitation } from '../space/invitation.js';
import type { LooseSigner } from '../records/loose.js';
import { foundersOf } from '../space/constitution.js';
import { unref } from '../utils/guards.js';
import { createListeners } from '../utils/events.js';
import { serial } from '../utils/serial.js';
import { contactKeyPair, deriveMemberKeyBytes } from '../identity/contact-key.js';
import { createMailboxClient } from '../network/relays.js';
import {
  deriveAccountRegistry,
  deriveContactsSpace,
  MEMBERSHIP_COLLECTION,
  type Membership,
} from '../space/account-registry.js';
import type {
  DefineCollection,
  ListOptions,
  NodeConfig,
  NodeEvent,
  NodeRecord,
  NodeCollections,
  NodeSpaces,
  P2PNode,
  RevokeOptions,
  SpaceSummary,
} from './types.js';
import { inBackground, type NodeContext, type OwnSpaceKind } from './node-context.js';
import { createNodeInvites } from './node-invites.js';
import { createNodeCarriers } from './node-carriers.js';
import { createNodeHosting } from './node-hosting.js';
import { createNodeAccount } from './node-account.js';
import { createNodeContacts } from './node-contacts.js';
import { createNodeInbox } from './node-inbox.js';
import { createNodeDirect } from './node-direct.js';
import { createNodeRecords } from './node-records.js';
import { startAgent } from './node-agent.js';

/** Everything a session key may do: every command, about the whole account */
export const SESSION_COMMAND = ALL_COMMAND;

const DEFAULT_TTL_SECONDS = 3600;

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

  function scheduleRenewal(inSeconds: number): void {
    renewTimer = setTimeout(() => void renew(), inSeconds * 1000);
    unref(renewTimer);
  }
  async function renew(): Promise<void> {
    try {
      current = await delegate();
      scheduleRenewal(ttl * 0.75);
    } catch {
      // Keep the delegation we have and ask again soon; writes fail once it expires.
      if (!closed) scheduleRenewal(Math.min(60, ttl / 4));
    }
  }
  scheduleRenewal(ttl * 0.75);

  const session: ActiveSession = {
    did: sessionDid,
    key: sessionKeys.privateKey,
    proof: () => current,
  };
  // Where a key keeps its places in each log: a claimed key in its slot, one handed in
  // (an agent's, an app's) in the node's stores, and one made here nowhere.
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
  async function kindOf(spaceId: string): Promise<OwnSpaceKind | null> {
    if (spaceId === accountSpaceId) return 'registry';
    if (spaceId === contactsSpaceId) return 'contacts';
    return (await carrying.isCarrySpace(spaceId)) ? 'carry' : null;
  }

  /** The contact key, for a node allowed to open contact requests */
  const contactKeys = config.contactKey ? await contactKeyPair(config.contactKey) : null;

  async function findRecord(spaceId: string): Promise<SpaceRecord | null> {
    if (spaceId === accountSpaceId) return account;
    const held = await registry.get(spaceId);
    return (
      held ?? (await carrying.carrierRecords()).find(({ carry }) => carry.space.id === spaceId)?.carry ?? null
    );
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
    whenOpen(event.space, checkRevoked);
    inBackground(hosts.keepSpaceHosts(event.space));
    // A space joined with an invite whose record had not arrived: perhaps it has now.
    void finishJoining(event.space);
    if (event.space === accountSpaceId) {
      emit({ type: 'account' });
      void reconcile();
      // A rename on another device reaches the spaces open here too.
      void profile.publishProfileToOpenSpaces();
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

  /** The same, in the account registry; none without one */
  async function accountRecords<T>(
    options: ListOptions,
    check?: (record: NodeRecord<T>) => boolean,
  ): Promise<NodeRecord<T>[]> {
    if (!accountSpaceId) return [];
    return ownRecords<T>(await runtime(accountSpaceId), options, check);
  }

  function runtime(spaceId: string): Promise<SpaceRuntime> {
    if (closed) return Promise.reject(new Error('Node is closed'));
    const known = runtimes.get(spaceId);
    if (known) return known;
    const open = requireRecord(spaceId).then((record) => openRuntime(spaceId, record));
    // A failed open is not kept, or the space would stay broken until restart.
    open.catch(() => runtimes.delete(spaceId));
    runtimes.set(spaceId, open);
    // Its profile, a revoke from an earlier visit, carriers added since, and the hosts to reach.
    for (const step of [profile.publishProfile, checkRevoked, carrying.nameKeepers]) whenOpen(spaceId, step);
    inBackground(open.then(() => hosts.reachHosts(spaceId)));
    return open;
  }

  /** Runs `step` on a space's runtime in the background, if it is open */
  function whenOpen(spaceId: string, step: (spaceId: string, rt: SpaceRuntime) => Promise<void>): void {
    const open = runtimes.get(spaceId);
    if (open) inBackground(open.then((rt) => step(spaceId, rt)));
  }

  async function openRuntime(spaceId: string, record: SpaceRecord): Promise<SpaceRuntime> {
    const kind = await kindOf(spaceId);
    const memberKey = kind === 'registry' ? null : await memberKeyOf(spaceId, record);
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
      ...(config.fetchFiles ? { fetchFiles: config.fetchFiles } : {}),
      emit: fromRuntime,
      onRole: (role) => {
        // Holding a role now, perhaps just joined: the space may hear who this is.
        if (role !== null) {
          whenOpen(spaceId, profile.publishProfile);
          inBackground(hosts.keepSpaceHosts(spaceId));
        }
        if (record.role !== role) void registry.setRole(spaceId, role).then(() => emit({ type: 'spaces' }));
      },
      onJoined: () => {
        if (record.invite) void registry.clearInvite(spaceId).then(() => emit({ type: 'spaces' }));
      },
      memberKey,
      onRelays: (relays) => registry.setRelays(spaceId, relays),
      onKeys: async (keys, currentKey) => {
        if (kind === 'registry') return;
        await registry.addKeys(spaceId, keys, currentKey);
        // The account's other devices and its carriers follow the new key.
        if (!kind) await remember(spaceId, { refresh: true });
        inBackground(carrying.passAll());
      },
    });
  }

  async function memberKeyOf(spaceId: string, record: SpaceRecord): Promise<Uint8Array | null> {
    if (!config.accountKey) return record.memberKey ?? null;
    return deriveMemberKeyBytes(config.accountKey, spaceId);
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
    hosts.forgetReach(spaceId);
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
    return accountRecords<Membership>(
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
    const invite = await invites.inviteTo(spaceId);
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
    inBackground(carrying.passAll());
    // Carriers came or went: the open spaces this account manages say so.
    for (const spaceId of runtimes.keys()) whenOpen(spaceId, carrying.nameKeepers);
    // Not awaited: a host that is slow to answer must not hold up the rest.
    inBackground(hosts.keepHosted());
    // Hosts came or went: every open space holds a socket to those the account uses now.
    for (const spaceId of runtimes.keys()) inBackground(hosts.reachHosts(spaceId));

    if (changed) emit({ type: 'spaces' });
  }

  const reconcile = serial(() =>
    reconcileOnce().catch((error: unknown) => {
      if (!closed) console.error('Could not reconcile the account registry:', error);
    }),
  );

  // ─── The parts ─────────────────────────────────────────────────────

  const ctx: NodeContext = Object.freeze({
    config,
    provider,
    registry,
    account,
    accountSpaceId,
    contactsRecord,
    contactsSpaceId,
    contactKeys,
    narrowNote,
    mailbox: config.mailbox ?? createMailboxClient(),
    emit,
    isClosed: () => closed,
    looseSigner,
    runtime,
    runtimes,
    findRecord,
    kindOf,
    joinRegistry,
    requireAccount,
    ownRecords,
    accountRecords,
  });

  // Invites and carriers each need the other once running: a kept link is handed to carriers, and
  // a refill drops the links again first. Hosting needs the spaces it hands over, made below.
  const invites = createNodeInvites(ctx, {
    nodesOf: (spaceId) => hosts.nodesOf(spaceId),
    passAll: () => carrying.passAll(),
  });
  const carrying = createNodeCarriers(ctx, {
    memberships,
    keptLinks: invites.keptLinks,
    keepLinks: invites.keepLinks,
  });
  const profile = createNodeAccount(ctx);

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
        link ? invites.shortInvite(spaceId, link, opened, options.until) : invites.inviteTo(spaceId, opened);
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
      const { long, until } = await invites.resolveInvite(invite);
      // Who it says invited is shown before joining, so it is checked as joining checks it.
      const parsed = parseSpaceInvite(long);
      const unsigned = await checkInvitation(parsed.signed, provider, parsed.invite);
      if (unsigned) throw new Error(`That invite doesn't check out: ${unsigned}.`);
      return { ...previewInvite(long), ...(until !== undefined ? { until } : {}) };
    },

    async join(invite, options = {}) {
      const record = await joinRegistry((await invites.resolveInvite(invite)).long);
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
      const carrierKeys = new Set((await carrying.liveCarriers()).map(({ body }) => body.did));
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
      const carriers = new Set((await carrying.liveCarriers()).map(({ body }) => body.did));
      const online = (await (await runtime(accountSpaceId)).status()).peers;
      if (!online.some((peer) => carriers.has(peer))) return false;
      const deadline = Date.now() + (options.waitMs ?? CARRIED_WAIT_MS);
      const open = await runtime(spaceId);
      // Named a keeper, and given its pass now rather than whenever the next round comes.
      await carrying.nameKeepers(spaceId, open).catch(() => {});
      inBackground(carrying.passAll());
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
      const key = await invites.inviteKeyOf(keyOrLink);
      await (await runtime(spaceId)).closeInvite(key);
      // Its link, if the account keeps one, is no longer served.
      await invites.forgetLinks((link) => link.space === spaceId && link.invite === key);
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

  const hosts = createNodeHosting(ctx, {
    spaces,
    carriers: carrying.carriers,
    liveCarriers: carrying.liveCarriers,
  });
  const contacts = createNodeContacts(ctx, { spaces, ownName: profile.ownName });
  const inbox = createNodeInbox(ctx, { spaces, contacts, ownName: profile.ownName });
  const direct = createNodeDirect(ctx);
  const recordsNeeds = { runtime, subscribe: events.subscribe };
  const records = createNodeRecords(recordsNeeds);

  const collections = Object.freeze<NodeCollections>({
    list: perSpace((rt) => rt.collections()),
    define: perSpace((rt, definition: DefineCollection) => rt.define(definition)),
    delete: perSpace((rt, name: string) => rt.undefine(name)),
    tag: perSpace((rt, collection: string, field: string, value: string | number | boolean) =>
      rt.topicTag(collection, field, value),
    ),
  });

  // With an account key, start following the registry at once: it is how this
  // node learns which spaces it belongs to.
  if (accountSpaceId) {
    await runtime(accountSpaceId);
    await reconcile();
  }

  async function anyoneOnline(): Promise<boolean> {
    for (const open of runtimes.values()) {
      const rt = await open.catch(() => null);
      if (rt && (await rt.status()).peers.length > 0) return true;
    }
    return false;
  }

  const node: P2PNode = Object.freeze({
    did: config.signer.did,
    sessionDid,
    spaces,
    records,
    collections,
    account: profile.account,
    carriers: carrying.carriers,
    hosting: hosts.hosting,
    automations: carrying.automations,
    contacts: contacts.contacts,
    direct,
    inbox,
    asAgent: (agent: { readonly keys: CryptoKeyPair; readonly note: Delegation }) =>
      startAgent(node, agent, {
        provider,
        contactsSpaceId,
        recordsAs: (as) => createNodeRecords(recordsNeeds, as),
      }),

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
          ...(await carrying.carrierRecords()).map(({ carry }) => carry.space.id),
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
      // Forgotten first: a tab closed while the revokes wait must not leave a revoked key to be claimed.
      await claimed?.forget().catch(() => {});
      // With nobody online, waiting would only show a spinner: the revokes go out with the next sync.
      await node.revokeKey(sessionDid, (await anyoneOnline()) ? options : {});
    },

    async close() {
      if (closed) return;
      closed = true;
      stopWatchingNetwork?.();
      if (renewTimer) clearTimeout(renewTimer);
      invites.stop();
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
