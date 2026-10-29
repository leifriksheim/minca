/**
 * @module node-carriers
 * The account's carriers and the automations they wake it for, and the
 * invites and short links (spec 03 §7.7) they serve while every device is away.
 */
import { cached } from '../utils/map.js';
import {
  bareInvite,
  encodeSpaceInvite,
  parseSpaceInvite,
  type InviteLinkOptions,
  type SpaceRecord,
} from '../space/space-manager.js';
import { MAX_KEEPERS, MAX_RELAYS } from '../space/roles.js';
import { SPACE_KEEPERS } from '../space/grants.js';
import { usableRelays, type SpaceRuntime } from './space-runtime.js';
import { deriveInviteKey } from '../space/space-access.js';
import {
  encodeInviteLink,
  inviteLinkKeys,
  isShortInvite,
  linkInviteSecret,
  linkTopic,
  MAX_LINK_PLACES,
  openInvite,
  parseInviteLink,
  pinOf,
  relayOfNode,
  sealInvite,
} from '../space/invite-link.js';
import { readInvitation, writeInvitation } from '../space/invitation.js';
import {
  CARRIER_COLLECTION,
  deriveCarrySpace,
  isKeptLink,
  LINK_COLLECTION,
  type Carrier,
  type KeptLink,
} from '../space/account-registry.js';
import { CARRY_CLOSED_KEY, makePass, PASS_COLLECTION, passKey, type SpacePass } from '../space/pass.js';
import {
  checkOwnAutomation,
  linkedWakes,
  OWN_AUTOMATIONS,
  WAKE_COLLECTION,
  wakeFor,
  type WakeSpace,
} from '../space/own-automations.js';
import type { Automation } from '../schemas/automations.js';
import { base64UrlDecode, bytesToHex, hexToBytes } from '../utils/encoding.js';
import { base32Encode } from '../utils/hash.js';
import { unref } from '../utils/guards.js';
import { queue, serial } from '../utils/serial.js';
import type { NodeAutomations, NodeCarriers, NodeRecord, OwnAutomationView } from './types.js';
import { inBackground, sameJson, sleep, within, type NodeContext } from './node-context.js';

/** The long invite a text names, and when its inviter stops sharing it */
interface Resolved {
  readonly long: string;
  readonly until?: number;
}

/** A carrier record of the account's, with its carry space */
interface CarrierEntry {
  readonly key: string;
  readonly body: Carrier;
  readonly carry: SpaceRecord;
}

export function createNodeCarriers(ctx: NodeContext) {
  const { config, provider, registry, mailbox, account, accountSpaceId } = ctx;

  // ─── Invites and short links ───────────────────────────────────────
  //
  // The link holds a secret and the hash of one sealed invite; the invite
  // sits in mailboxes: the account's host's first, which keeps it while every
  // device is away, then the relays where the space's members meet.

  /**
   * An invite to a space, naming where its members meet: the relays the space
   * names, or before it names any, this node's — so the joiner finds the
   * inviter even when their app uses other relays.
   */
  async function inviteTo(spaceId: string, options: InviteLinkOptions = {}): Promise<string> {
    const named = (await ctx.findRecord(spaceId))?.relays ?? [];
    const own = usableRelays(config.network).slice(0, MAX_RELAYS);
    const nodes = await ctx.hosts.nodesOf(spaceId);
    return registry.createInvite(spaceId, ctx.looseSigner(), {
      ...options,
      ...(named.length ? {} : own.length ? { relays: own } : {}),
      ...(nodes.length ? { nodes } : {}),
    });
  }

  /** Where a link's sealed invite is left: its nodes' relays, then the space's or this node's */
  async function linkPlaces(spaceId: string, nodes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    const named = (await ctx.findRecord(spaceId))?.relays ?? [];
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
    const sealed = await sealInvite(secret, {
      invite: invite.signed,
      ...(until !== undefined ? { until } : {}),
    }).catch(() => null);
    if (!sealed) return long;
    const nodes = invite.nodes ?? [];
    const ttl = until !== undefined ? Math.max(60, Math.ceil((until - Date.now()) / 1000)) : undefined;
    const places = await linkPlaces(spaceId, nodes);
    const kept = await dropAt(places, await linkTopic(sealed.pin), sealed.blob, ttl);
    if (kept.length === 0) return long;
    await keepLink(spaceId, sealed, options, until);
    // A host first, which keeps it; then a relay, so one going away leaves the other.
    const hosts = new Set(nodes.map(relayOfNode));
    const named = [kept.find((place) => hosts.has(place)), kept.find((place) => !hosts.has(place))];
    const linked = named.filter((place) => place !== undefined);
    return encodeInviteLink({ secret, pin: sealed.pin, places: linked.slice(0, MAX_LINK_PLACES) });
  }

  /** Leaves a blob at each place; the places that took it */
  async function dropAt(
    places: ReadonlyArray<string>,
    topic: string,
    blob: string,
    ttl: number | undefined,
  ): Promise<string[]> {
    const drop = (place: string) =>
      mailbox.drop(place, topic, blob, ttl).then(
        () => place,
        () => null,
      );
    const taken = await Promise.all(places.map(drop));
    return taken.filter((place) => place !== null);
  }

  /** The links the account keeps, as its registry holds them */
  async function keptLinks(): Promise<ReadonlyArray<{ readonly key: string; readonly body: KeptLink }>> {
    if (ctx.narrowNote) return [];
    const records = await ctx.accountRecords<KeptLink>(
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
    if (!ctx.accountSpaceId || ctx.narrowNote) return;
    const record = await ctx.findRecord(spaceId);
    const body: KeptLink = {
      space: spaceId,
      blob: sealed.blob,
      ...(options.secret ? { invite: (await deriveInviteKey(options.secret, provider)).did } : {}),
      ...(record?.key ? { keyId: record.key.id } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const registryRt = await ctx.runtime(ctx.accountSpaceId);
    await registryRt.upsertSystem(LINK_COLLECTION, `link:${bytesToHex(sealed.pin)}`, body);
    inBackground(passAll());
  }

  /** Stops keeping the links `which` picks */
  async function forgetLinks(which: (link: KeptLink) => boolean): Promise<void> {
    if (!ctx.accountSpaceId || ctx.narrowNote) return;
    const registryRt = await ctx.runtime(ctx.accountSpaceId);
    let forgot = false;
    for (const { key, body } of await keptLinks())
      if (which(body)) {
        await registryRt.removeSystem(key);
        forgot = true;
      }
    if (forgot) inBackground(passAll());
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
      if (ctx.isClosed()) return;
      const record = await registry.get(body.space);
      // Ended only on what this device knows: one not holding the space yet would end a link
      // another device of the account just made.
      if (!record) continue;
      if (linkEnded(body, record)) {
        if (body.invite) await closeIfOpen(body.space, body.invite).catch(() => {});
        await forgetLinks((link) => link.blob === body.blob);
        continue;
      }
      const topic = await linkTopic(hexToBytes(key.slice('link:'.length)));
      const ttl = body.until !== undefined ? Math.ceil((body.until - Date.now()) / 1000) : undefined;
      for (const place of await linkPlaces(body.space, []))
        inBackground(mailbox.drop(place, topic, body.blob, ttl));
    }
  });

  /** Closes an invite unless it is closed already, or this account may not */
  async function closeIfOpen(spaceId: string, inviteDid: string): Promise<void> {
    const rt = await ctx.runtime(spaceId);
    const invite = (await rt.access()).invites.find((held) => held.key === inviteDid);
    if (invite?.open) await rt.closeInvite(inviteDid);
  }

  // Relays forget after two weeks or a restart: every hour, whatever is gone goes back.
  const linkTimer = setInterval(() => void keepLinks().catch(() => {}), 60 * 60 * 1000);
  unref(linkTimer);

  /** A short link's invite, fetched once and kept: a preview and the join that follows ask once */
  const resolved = new Map<string, Promise<Resolved>>();

  /** The long invite a text holds or a short link names, and when its inviter stops sharing it */
  function resolveInvite(text: string): Promise<Resolved> {
    const bare = bareInvite(text);
    if (!isShortInvite(bare)) return Promise.resolve({ long: bare });
    // A few links are remembered, not every one ever read.
    const oldest = resolved.keys().next().value;
    if (!resolved.has(bare) && resolved.size >= 16 && oldest !== undefined) resolved.delete(oldest);
    return cached(resolved, bare, () => fetchInvite(bare));
  }

  /**
   * Asks every place the link names, and this node's relays, for its topic.
   * Of what comes back, only the blob that hashes to the pin is taken — any
   * other, whoever left it, is ignored unopened.
   */
  async function fetchInvite(bare: string): Promise<Resolved> {
    const link = parseInviteLink(bare);
    const { topic, inviteSecret } = await inviteLinkKeys(link.secret, link.pin);
    const places = [...new Set([...link.places, ...usableRelays(config.network)])];
    if (places.length === 0)
      throw new Error('That invite names no place to find it, and this app knows none');
    // A slow place can't hold the join up for long: what has come back by then is all there is.
    const blobs = await fetchBlobs(places, topic, 20_000);
    // Only blobs whose hash is the pin; any other, whoever left it, is never opened.
    const named: string[] = [];
    for (const blob of blobs) if (await hasPin(blob, link.pin)) named.push(blob);
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

  /** What the places hold under a topic, as much as came back within `waitMs` */
  async function fetchBlobs(
    places: ReadonlyArray<string>,
    topic: string,
    waitMs: number,
  ): Promise<Set<string>> {
    const blobs = new Set<string>();
    const fetchAt = async (place: string) => {
      for (const item of await mailbox.fetch(place, topic)) blobs.add(item.blob);
    };
    await Promise.race([sleep(waitMs), Promise.all(places.map((place) => fetchAt(place).catch(() => {})))]);
    return blobs;
  }

  /** The key of the invite a DID, a short link or a long invite names */
  async function inviteKeyOf(keyOrLink: string): Promise<string> {
    if (keyOrLink.startsWith('did:key:')) return keyOrLink;
    // The link itself will do: its secret names the invite.
    if (isShortInvite(bareInvite(keyOrLink))) {
      // A short link's invite secret is derived from its own; a view-only one has no record to close.
      const secret = await linkInviteSecret(parseInviteLink(bareInvite(keyOrLink)).secret);
      return (await deriveInviteKey(secret, provider)).did;
    }
    const secret = parseSpaceInvite(bareInvite(keyOrLink)).invite;
    if (!secret)
      throw new Error(
        'That invite is view-only — there is nothing to close. To stop it working, give the space a new key (changeKey).',
      );
    return (await deriveInviteKey(base64UrlDecode(secret), provider)).did;
  }

  // ─── Carriers ──────────────────────────────────────────────────────
  //
  // One record per carrier in the registry. Its carry space is derived from
  // the account key and the carrier's key, so every device finds the same one
  // and none is stored. Every device of the account opens it and keeps a pass
  // in it for each of the account's spaces (`space/pass.ts`): a space joined
  // in any app is carried, with nothing to do in the home.

  const carrierKey = async (spaceId: string) => (await passKey(spaceId)).replace(/^pass:/, 'carrier:');

  /** Whether a `sys.carrier` record of the account's, live or not, is keyed by this space */
  async function isCarrySpace(spaceId: string): Promise<boolean> {
    if (!accountSpaceId) return false;
    const versions = await (await ctx.runtime(accountSpaceId)).history(await carrierKey(spaceId));
    return versions.some(
      (version) =>
        version.collection === CARRIER_COLLECTION && version.verified && version.root === config.signer.did,
    );
  }

  const derivedCarry = new Map<string, Promise<SpaceRecord>>();
  /** A carrier's carry space: derived, or for one added before they were, the one its invite names */
  async function carrySpaceOf(carrier: Carrier): Promise<SpaceRecord | null> {
    if (carrier.invite && carrier.space)
      return (await registry.get(carrier.space)) ?? ctx.joinRegistry(carrier.invite).catch(() => null);
    const { accountKey } = config;
    if (!accountKey) return null;
    const gen = carrier.gen ?? 0;
    return cached(derivedCarry, `${carrier.did}|${gen}`, () =>
      deriveCarrySpace(accountKey, config.signer.did, carrier.did, gen, provider),
    );
  }

  /** The account's carriers, live and removed, each with its carry space */
  async function carrierRecords(): Promise<ReadonlyArray<CarrierEntry>> {
    const listed = await ctx.accountRecords<Carrier>({ collection: CARRIER_COLLECTION }, hasCarrierBody);
    const found: CarrierEntry[] = [];
    for (const { key, body } of listed) {
      const carry = await carrySpaceOf(body!);
      // Its key names its carry space: that is how every device knows the space is one.
      if (carry && key === (await carrierKey(carry.space.id))) found.push({ key, body: body!, carry });
    }
    return found;
  }

  /** The carriers the account uses now */
  const liveCarriers = async () => (await carrierRecords()).filter(({ body }) => !body.removed);

  /** Makes a carrier's space hold exactly the account's passes, kept links and wakes as they are now */
  async function syncPasses(carrier: CarrierEntry): Promise<void> {
    if (!account || ctx.narrowNote) return;
    const owned = await ownAutomations();
    const { passes, spaces } = await passesFor(account);
    // Removed meanwhile, on this device or another: its passes stay deleted.
    if (!(await liveCarriers()).some((live) => live.key === carrier.key)) return;
    const carry = await ctx.runtime(carrier.carry.space.id);
    await writeExactly(carry, PASS_COLLECTION, passes, (key) => key.startsWith('pass:'));
    // The links the account keeps, for the carrier to serve while every device is away.
    const links = new Map((await keptLinks()).map((link) => [link.key, link.body]));
    await writeExactly(carry, LINK_COLLECTION, links, (key) => key.startsWith('link:'));
    await writeExactly(carry, WAKE_COLLECTION, await wakesOf(owned, spaces), () => true);
  }

  /**
   * A pass for each of the account's spaces, its registry and contacts too so a
   * restore can come through a carrier; and what a wake needs of each space.
   */
  async function passesFor(account: SpaceRecord) {
    const passes = new Map<string, SpacePass>();
    const spaces: WakeSpace[] = [];
    for (const own of ctx.contactsRecord ? [account, ctx.contactsRecord] : [account])
      passes.set(await passKey(own.space.id), await makePass(own));
    for (const membership of await ctx.memberships()) {
      if (membership.deleted || !membership.body || (await ctx.kindOf(membership.body.space))) continue;
      const record = await registry.get(membership.body.space);
      if (!record) continue;
      spaces.push(await wakeSpaceOf(record));
      // Held without its key: nothing to pass on until it arrives.
      const pass = await makePass(record).catch(() => null);
      if (pass) passes.set(await passKey(record.space.id), pass);
    }
    return { passes, spaces };
  }

  /** What a wake needs of a space. Opening it is also how this device learns its key changed. */
  async function wakeSpaceOf(record: SpaceRecord): Promise<WakeSpace> {
    const rt = await ctx.runtime(record.space.id);
    const declared = new Map((await rt.collections()).map((c) => [c.name, c]));
    return {
      id: record.space.id,
      key: record.key,
      visibility: record.space.visibility,
      topics: (collection) => declared.get(collection)?.topics ?? [],
      computed: (collection) => declared.get(collection)?.computed,
    };
  }

  /** A wake for each automation, every value replaced by the space's tag: the carrier matches, never learns */
  async function wakesOf(
    owned: ReadonlyArray<OwnAutomationView>,
    spaces: ReadonlyArray<WakeSpace>,
  ): Promise<Map<string, unknown>> {
    const wakes = new Map<string, unknown>();
    for (const own of owned) {
      const wake = await wakeFor(own, spaces, config.signer.did);
      wakes.set(`wake:${own.id}`, wake);
      // A computed field the automation names reads wakes too: a 👍 can make a todo done.
      for (const also of linkedWakes(own, wake, spaces)) wakes.set(`wake:${own.id}:${also.collection}`, also);
    }
    return wakes;
  }

  /** Makes what this account wrote in a collection, among the keys `mine` takes, say exactly `wanted` */
  async function writeExactly(
    rt: SpaceRuntime,
    collection: string,
    wanted: ReadonlyMap<string, unknown>,
    mine: (key: string) => boolean,
  ): Promise<void> {
    const records = await ctx.ownRecords(rt, { collection, includeDeleted: true }, (record) =>
      mine(record.key),
    );
    const held = new Map(records.map((record) => [record.key, record]));
    for (const [key, body] of wanted) {
      const existing = held.get(key);
      held.delete(key);
      if (!existing || existing.deleted || !sameJson(existing.body, body))
        await rt.upsertSystem(collection, key, body);
    }
    for (const [key, record] of held) if (!record.deleted) await rt.removeSystem(key);
  }

  /** The account's own automations, as it made them */
  async function ownAutomations(): Promise<ReadonlyArray<OwnAutomationView>> {
    const found = await ctx.accountRecords<Automation>(
      { collection: OWN_AUTOMATIONS },
      (record) => record.key.startsWith('automation:') && checkOwnAutomation(record.body) === null,
    );
    return found
      .map((record) => ({ ...record.body!, id: record.key }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  /**
   * Names the account's carriers — its extensions, its hosts — as keepers of
   * a space it manages, and stops naming ones it removed, so apps there hold
   * only what they use. Other keepers the space names stay. Done as each space
   * opens and whenever the carriers change; a space this account doesn't
   * manage is left to whoever does.
   */
  async function nameKeepers(spaceId: string, rt: SpaceRuntime): Promise<void> {
    if (!account || ctx.narrowNote || (await ctx.kindOf(spaceId))) return;
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

  /** Writing in carry spaces, one thing at a time: a removal never lands in the middle of a refill */
  const inCarryTurn = queue();

  /** Every carrier the account uses gets its passes and wakes as they are now, one run at a time */
  const passAll = serial(() =>
    inCarryTurn(async () => {
      // First: a key change that ends a link is seen here, before its record would be copied on.
      await keepLinks().catch(() => {});
      for (const carrier of await liveCarriers()) {
        if (ctx.isClosed()) return;
        // Only a device that may write in the carry space can do this; others leave it to one that can.
        await syncPasses(carrier).catch(() => {});
      }
    }),
  );

  /** Writes one of the account's own automations, checked, and hands every carrier the wakes as they are now */
  async function writeOwn(id: string, body: Automation): Promise<OwnAutomationView> {
    const registryRt = await ctx.requireAccount('Making an automation');
    const problem = checkOwnAutomation(body);
    if (problem) throw new Error(problem);
    // A system collection: nothing defines it, so no other key of the account can make it final.
    await registryRt.upsertSystem<Automation>(OWN_AUTOMATIONS, id, body);
    // Every carrier gets the wakes as they are now, in the background (`carriers.settled`).
    inBackground(passAll());
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
      await ctx.requireAccount('Making an automation');
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
      const registryRt = await ctx.requireAccount('Making an automation');
      if (!(await ownAutomations()).some((view) => view.id === id)) return;
      await registryRt.removeSystem(id);
      inBackground(passAll());
    },

    async versions(ids) {
      if (!accountSpaceId) return [];
      const keys = ids.filter((id) => id.startsWith('automation:'));
      return (await (await ctx.runtime(accountSpaceId)).versionsOf(keys)).filter(
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
      const taken = await (await ctx.runtime(accountSpaceId)).take(mine);
      if (taken > 0) inBackground(passAll());
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
      const registryRt = await ctx.requireAccount('Using a carrier');
      const all = await carrierRecords();
      // The same carrier again keeps its carry space: what it holds stays good, and nothing is closed under it.
      let entry = all.find(({ body }) => body.did === carrier.did && !body.removed);
      if (entry) inBackground(passAll());
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
        invite: await encodeSpaceInvite(entry.carry, ctx.looseSigner(), provider),
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
      if (!(await (await ctx.runtime(spaceId)).syncedWith(did, Math.max(0, deadline - Date.now()))))
        return false;
      return (await ctx.runtime(accountSpaceId)).syncedWith(did, Math.max(0, deadline - Date.now()));
    },

    async remove(spaceId) {
      const registryRt = await ctx.requireAccount('Removing a carrier');
      // In turn with any refill, which would otherwise put the passes back.
      await inCarryTurn(async () => {
        const live = await liveCarriers();
        const did = live.find(({ carry }) => carry.space.id === spaceId)?.body.did;
        // Every carry space it has: one added on two devices at once, before they were derived, has two.
        for (const { key, body, carry } of live.filter((one) => one.body.did === did)) {
          const rt = await ctx.runtime(carry.space.id);
          // Passes gone first, then the word to forget everything, then the carrier's record.
          for (const pass of await ctx.ownRecords(rt, { collection: PASS_COLLECTION }, (r) =>
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

  return Object.freeze({
    carriers,
    automations,
    carrierRecords,
    liveCarriers,
    isCarrySpace,
    nameKeepers,
    passAll,
    inviteTo,
    shortInvite,
    resolveInvite,
    inviteKeyOf,
    forgetLinks,
    stop: () => clearInterval(linkTimer),
  });
}

/** Whether a sealed invite hashes to a link's pin */
async function hasPin(blob: string, pin: Uint8Array): Promise<boolean> {
  return (await pinOf(blob)).every((byte, i) => byte === pin[i]);
}

/** A kept link has ended once its time is up, or the space's key has moved on from the one it carries */
function linkEnded(link: KeptLink, record: SpaceRecord): boolean {
  if (link.until !== undefined && link.until <= Date.now()) return true;
  const { keyId } = link;
  if (keyId === undefined || record.key === null || record.key.id === keyId) return false;
  return (record.keys ?? []).some((held) => held.id === keyId);
}

/** A carrier record whose generation is a count: anything else names no carry space */
function hasCarrierBody(record: NodeRecord<Carrier>): boolean {
  const gen = record.body?.gen;
  return (
    typeof record.body?.did === 'string' && (gen === undefined || (Number.isSafeInteger(gen) && gen >= 0))
  );
}
