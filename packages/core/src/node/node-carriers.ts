/**
 * @module node-carriers
 * The account's carriers, and the automations they wake it for.
 *
 * One record per carrier in the registry. Its carry space is derived from
 * the account key and the carrier's key, so every device finds the same one
 * and none is stored. Every device of the account opens it and keeps a pass
 * in it for each of the account's spaces (`space/pass.ts`) — so a space
 * joined in any app is carried, with nothing to do in the home.
 */
import { encodeSpaceInvite, type SpaceRecord } from '../space/space-manager.js';
import { MAX_KEEPERS } from '../space/roles.js';
import { SPACE_KEEPERS } from '../space/grants.js';
import {
  CARRIER_COLLECTION,
  deriveCarrySpace,
  LINK_COLLECTION,
  type Carrier,
  type KeptLink,
  type Membership,
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
import { base32Encode } from '../utils/hash.js';
import { queue, serial } from '../utils/serial.js';
import type { SpaceRuntime } from './space-runtime.js';
import type { NodeAutomations, NodeCarriers, NodeRecord, OwnAutomationView } from './types.js';
import { cached, inBackground, sameJson, within, type NodeContext } from './node-context.js';

/** A carrier record of the account's, with its carry space */
export interface CarrierEntry {
  readonly key: string;
  readonly body: Carrier;
  readonly carry: SpaceRecord;
}

interface CarriersNeeds {
  /** The account's memberships, live and left */
  readonly memberships: () => Promise<ReadonlyArray<NodeRecord<Membership>>>;
  /** The links the account keeps, for carriers to serve */
  readonly keptLinks: () => Promise<ReadonlyArray<{ readonly key: string; readonly body: KeptLink }>>;
  /** Ends and drops again the links the account keeps */
  readonly keepLinks: () => Promise<void>;
}

export function createNodeCarriers(ctx: NodeContext, needs: CarriersNeeds) {
  const { config, provider, registry, account, accountSpaceId } = ctx;

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
    const links = new Map((await needs.keptLinks()).map((link) => [link.key, link.body]));
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
    for (const membership of await needs.memberships()) {
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
      await needs.keepLinks().catch(() => {});
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
  });
}

/** A carrier record whose generation is a count: anything else names no carry space */
function hasCarrierBody(record: NodeRecord<Carrier>): boolean {
  const gen = record.body?.gen;
  return (
    typeof record.body?.did === 'string' && (gen === undefined || (Number.isSafeInteger(gen) && gen >= 0))
  );
}
