/**
 * @module node/host
 * A carrier that never sleeps, for many accounts: what a hosting service runs.
 *
 * It is the extension's carrier (`node/carrier.ts`) with more than one carry
 * space. Each **subscription** — someone paying for hosting — is a key the
 * account made, a date it is paid until, and once a device hands it over,
 * the account's carry space. The spaces every carry space's passes name are
 * held once, whoever asks for them, so a space shared by two paying members
 * is one space here, online for all its members.
 *
 * Blind, like any carrier: it holds no seed, no space key and no note, signs
 * nothing, and takes in only what passes the same gates as at any member's
 * node. What it learns: which spaces exist, their size, when they change, and
 * — through the carry spaces — which account asked for which.
 *
 * A space can also pay for itself: a subscription named `space:<id>` carries
 * that one space, from its pass alone, handed over by any member's device.
 * Anyone may pay into it; what it carries is still only ciphertext.
 *
 * Subscriptions live in the host's own store, next to the carried spaces. The
 * payment side (`packages/cli/src/host/…`) only ever moves a subscription's date.
 *
 * With `limits`, an account's subscription needs no payment: it is on the
 * free plan, and paying buys room. A space several accounts write in is free
 * up to a line — how many accounts wrote there lately, and its size — and past
 * it, after a grace period, only its own subscription carries it (spec 08 §1.1).
 */
import type { CryptoProvider, StorageAdapter, Version } from '../types.js';
import type { HostLimits, OverSpace, SpaceUsage } from '../session/hosting.js';
import { createUsageMeter } from './usage.js';
import { createP256Provider } from '../identity/crypto-p256.js';
import { createServerAuth } from '../network/peer-auth.js';
import { utf8Decode, utf8Encode } from '../utils/encoding.js';
import { isRecord } from '../utils/guards.js';
import { createCarryCore, type CarrierEvent } from './carrier.js';
import type { StoreFactory } from './stores.js';
import type { NodeNetworkConfig } from './types.js';
import type { BlobStore } from '../storage/blob-store.js';
import { deleteMirrored } from '../storage/mirror.js';
import { openPass } from '../space/pass.js';
import { createListeners } from '../utils/events.js';

/** What names a space's own subscription at a host */
const SPACE_SUBSCRIPTION_PREFIX = 'space:';

/** A space's own subscription id: `space:<space id>` */
export const spaceSubscription = (spaceId: string) => `${SPACE_SUBSCRIPTION_PREFIX}${spaceId}`;

/** Someone paying for hosting, as the host knows them */
export interface Subscription {
  /**
   * The subscription key's DID, what every call about it is signed with; or
   * for a space paying for itself, `space:<space id>`
   */
  readonly id: string;
  /** Unix seconds. Past it, the grace period; past that, it is dropped. */
  readonly paidUntil: number;
  /** When it was made, unix seconds */
  readonly since: number;
  /** The account and its carry space, once a device has handed them over */
  readonly carry?: { readonly account: string; readonly space: string; readonly invite: string };
  /** For a space's own subscription: the pass a member's device handed over, once one has */
  readonly pass?: unknown;
  /** The payment provider's reference for whoever pays — nothing else about them is kept */
  readonly customer?: string;
  /** A wallet payment asked for and not yet seen (`packages/cli/src/wallet.ts`) */
  readonly invoice?: Invoice;
  /** When one of its devices last made a signed call, unix seconds, to the day: a free one idle long enough is dropped */
  readonly seen?: number;
}

/** A payment a host asked a wallet for: an exact amount, so the transfer that arrives says whose it is */
export interface Invoice {
  readonly plan: string;
  /** In the token's smallest unit, as a decimal string */
  readonly amount: string;
  /** When it was asked for, unix seconds — a transfer made before it pays nothing */
  readonly at: number;
}

export type SubscriptionState = 'active' | 'grace' | 'lapsed';

/** Which limits a space is over */
type Reason = OverSpace['reasons'][number];

/**
 * Where a space stands against the free line. `since` is when it went over;
 * `from` is when its grace began, moved on while its own subscription pays;
 * `under` is since when it has been well under; `stopped` is when members'
 * subscriptions stopped carrying it.
 */
interface Line {
  readonly since: number;
  readonly from: number;
  readonly reasons: ReadonlyArray<Reason>;
  readonly under?: number;
  readonly stopped?: number;
}
export interface HostConfig {
  /** The host's own key — who it is to peers */
  readonly key: CryptoKeyPair;
  readonly stores: StoreFactory;
  readonly network?: NodeNetworkConfig;
  readonly provider?: CryptoProvider;
  /** Days a lapsed subscription is kept, carried, before it is dropped. Default 30. */
  readonly graceDays?: number;
  /** Every subscription counts as paid — for someone hosting only themselves, and for trying it out */
  readonly free?: boolean;
  /**
   * The accounts this host carries for, and no others — someone hosting only
   * themselves and their family. Absent: any account whose subscription is paid.
   */
  readonly allow?: ReadonlyArray<string>;
  /** Unix seconds now; for tests */
  readonly now?: () => number;
  /**
   * The host's bucket (`storage/blob/s3.ts`): every carried space is kept
   * there too, in the mirror layout, and so is the list of subscriptions. The
   * host's disk is then only a cache — lose it, and everything comes back.
   * A space nobody pays for any more is deleted from it.
   */
  readonly mirror?: BlobStore;
  readonly watchIntervalMs?: number;
  /**
   * Whether the subscription an account's carry space belongs to may take no
   * more spaces: what it carries stays, and a space its account adds later
   * waits until this says no. The host's storage limit, its own policy.
   */
  readonly full?: (carrySpace: string) => boolean;
  /**
   * Free hosting within limits: an account's subscription needs no payment,
   * and a community past the free line pays for itself (spec 08 §1.1).
   * Ignored with `free`.
   */
  readonly limits?: HostLimits;
  /** How many bytes a carried space takes: what the free line's `bytes` reads */
  readonly measure?: (spaceId: string) => Promise<number>;
  /** Accounts whose writes are not counted: the host's own bots */
  readonly ignore?: (account: string) => boolean | Promise<boolean>;
}

/** A host, as `createHostNode` starts it */
export type HostNode = Awaited<ReturnType<typeof createHostNode>>;

const SUBSCRIPTION_PREFIX = 'subscription:';

/** The space a subscription is a space's own for, or null for an account's */
const spaceIdOf = (id: string): string | null =>
  id.startsWith(SPACE_SUBSCRIPTION_PREFIX) && id.length > SPACE_SUBSCRIPTION_PREFIX.length && id.length <= 200
    ? id.slice(SPACE_SUBSCRIPTION_PREFIX.length)
    : null;

/** An account this host was not told to carry for */
export class NotAllowedError extends Error {
  constructor() {
    super('This host only carries spaces for the accounts its owner named');
  }
}
/** Where the subscriptions are kept in the bucket */
const BUCKET_PREFIX = 'host/subscriptions/';
/** Where each space's standing against the free line is kept, there and in the bucket */
const LINE_PREFIX = 'line:';
const LINE_BUCKET_PREFIX = 'host/lines/';
const DAY = 24 * 3600;
/** How far under every limit a space must stay, for its window, to be free again */
const UNDER = 0.8;
/** How long after the host first sees a space what arrives may be its history, rather than people writing now */
const CATCH_UP_SECONDS = 600;
/** Where the host keeps which spaces it once stopped carrying for members, there and in the bucket */
const STRUCK_PREFIX = 'struck:';
const STRUCK_BUCKET_PREFIX = 'host/struck/';

/** Starts a host */
export async function createHostNode(config: HostConfig) {
  const provider = config.provider ?? createP256Provider();
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const graceSeconds = (config.graceDays ?? 30) * DAY;
  const allowed = (account: string) => !config.allow || config.allow.includes(account);
  const store: StorageAdapter = await config.stores('host');

  const events = createListeners<CarrierEvent>('host');

  const read = async (id: string): Promise<Subscription | null> => {
    const bytes = await store.get(`${SUBSCRIPTION_PREFIX}${id}`);
    // Only `write` below puts anything here; a check would turn a damaged record into a missing one.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- this host's own writes
    return bytes ? (JSON.parse(utf8Decode(bytes)) as Subscription) : null;
  };
  const bucketKey = (id: string) => `${BUCKET_PREFIX}${encodeURIComponent(id)}.json`;
  const write = async (subscription: Subscription): Promise<Subscription> => {
    const bytes = utf8Encode(JSON.stringify(subscription));
    await store.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, bytes);
    // The bucket's copy is what a host with a new disk starts from.
    await config.mirror?.put(bucketKey(subscription.id), bytes);
    return subscription;
  };
  const forget = async (id: string) => {
    await store.delete(`${SUBSCRIPTION_PREFIX}${id}`);
    await config.mirror?.delete(bucketKey(id));
  };
  const list = async (): Promise<Subscription[]> => {
    const keys = await store.list(SUBSCRIPTION_PREFIX);
    return (await Promise.all(keys.map((key) => read(key.slice(SUBSCRIPTION_PREFIX.length))))).filter(
      (s): s is Subscription => s !== null,
    );
  };

  const limits = config.free ? null : (config.limits ?? null);

  const state = (subscription: Subscription): SubscriptionState => {
    if (config.free || subscription.paidUntil >= now()) return 'active';
    // With limits an account needs no payment: not paying is the free plan.
    if (limits && !spaceIdOf(subscription.id)) return 'active';
    return subscription.paidUntil + graceSeconds >= now() ? 'grace' : 'lapsed';
  };

  /** Which room an account's subscription has, at a host with limits; null otherwise */
  const plan = (subscription: Subscription): 'free' | 'paid' | null =>
    limits && !spaceIdOf(subscription.id) ? (subscription.paidUntil >= now() ? 'paid' : 'free') : null;

  // ─── The free line ─────────────────────────────────────────────────

  const meter = limits
    ? await createUsageMeter({
        store: await config.stores('host-usage'),
        windowDays: limits.space.windowDays,
        now,
      })
    : null;
  const lines = new Map<string, Line>();
  const lineBucketKey = (spaceId: string) => `${LINE_BUCKET_PREFIX}${spaceId}.json`;
  const writeLine = async (spaceId: string, line: Line | null) => {
    if (line) lines.set(spaceId, line);
    else lines.delete(spaceId);
    if (line) {
      const bytes = utf8Encode(JSON.stringify(line));
      await store.put(`${LINE_PREFIX}${spaceId}`, bytes);
      // A restart, or a new disk, keeps the grace clock where it was.
      await config.mirror?.put(lineBucketKey(spaceId), bytes);
    } else {
      await store.delete(`${LINE_PREFIX}${spaceId}`);
      await config.mirror?.delete(lineBucketKey(spaceId));
    }
  };
  if (limits) {
    if (config.mirror && (await store.list(LINE_PREFIX)).length === 0)
      for (const key of await config.mirror.list(LINE_BUCKET_PREFIX)) {
        const bytes = await config.mirror.get(key);
        const spaceId = key.slice(LINE_BUCKET_PREFIX.length, -'.json'.length);
        if (bytes && spaceId) await store.put(`${LINE_PREFIX}${spaceId}`, bytes);
      }
    for (const key of await store.list(LINE_PREFIX)) {
      const bytes = await store.get(key);
      const line: unknown = bytes ? JSON.parse(utf8Decode(bytes)) : null;
      if (
        isRecord(line) &&
        typeof line.since === 'number' &&
        typeof line.from === 'number' &&
        Array.isArray(line.reasons)
      )
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- this host's own writes, shape checked
        lines.set(key.slice(LINE_PREFIX.length), line as unknown as Line);
    }
  }
  const lineGrace = (limits?.graceDays ?? 0) * DAY;
  /** Spaces members' subscriptions no longer carry, being over the line with nobody paying */
  const skipped = new Set(
    [...lines].flatMap(([spaceId, line]) => (line.stopped !== undefined ? [spaceId] : [])),
  );

  /**
   * Spaces members' subscriptions once stopped carrying, and when: one that
   * comes back over the line after the host forgot it gets no new grace.
   */
  const struck = new Map<string, number>();
  const strike = async (spaceId: string, at: number) => {
    struck.set(spaceId, at);
    const bytes = utf8Encode(String(at));
    await store.put(`${STRUCK_PREFIX}${spaceId}`, bytes);
    await config.mirror?.put(`${STRUCK_BUCKET_PREFIX}${spaceId}`, bytes);
  };
  if (limits) {
    if (config.mirror && (await store.list(STRUCK_PREFIX)).length === 0)
      for (const key of await config.mirror.list(STRUCK_BUCKET_PREFIX)) {
        const bytes = await config.mirror.get(key);
        if (bytes) await store.put(`${STRUCK_PREFIX}${key.slice(STRUCK_BUCKET_PREFIX.length)}`, bytes);
      }
    for (const key of await store.list(STRUCK_PREFIX)) {
      const bytes = await store.get(key);
      const at = bytes ? Number(utf8Decode(bytes)) : NaN;
      if (Number.isFinite(at)) struck.set(key.slice(STRUCK_PREFIX.length), at);
    }
  }

  /**
   * A version reached a carried space: its account wrote there, unless it is
   * the host's own. Counted by when it arrived, whatever its writer says of
   * when it was written, except while the host first catches up on a space:
   * then what says it is older than the window is its history.
   */
  const counted = (spaceId: string, version: Version) => {
    if (!meter || !limits) return;
    const account = version.proof?.payload.iss ?? version.author;
    const written = Date.parse(version.createdAt) / 1000;
    const old = Number.isFinite(written) && written < now() - limits.space.windowDays * DAY;
    void (async () => {
      if (old && now() - (await meter.firstSeen(spaceId)) < CATCH_UP_SECONDS) return;
      if (!(await config.ignore?.(account))) await meter.wrote(spaceId, account);
    })().catch(() => {});
  };
  /** The accounts that are members of a carried space now: only their writes count */
  const membersOf = async (spaceId: string): Promise<ReadonlyArray<string> | undefined> => {
    const entry = core.carried.get(spaceId);
    if (!entry) return undefined;
    return (await entry.runtime.access()).members.map((member) => member.did);
  };

  // A fresh disk: the subscriptions come back from the bucket, and the spaces with them.
  if (config.mirror && (await store.list(SUBSCRIPTION_PREFIX)).length === 0) {
    for (const key of await config.mirror.list(BUCKET_PREFIX)) {
      const bytes = await config.mirror.get(key);
      if (!bytes) continue;
      const subscription: unknown = JSON.parse(utf8Decode(bytes));
      if (isRecord(subscription) && typeof subscription.id === 'string')
        await store.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, bytes);
    }
  }

  /** The subscription an account's carry space belongs to, when it wrote `carry:closed` */
  let closing: Promise<void> = Promise.resolve();
  /** Whether the carry core below is made, so its events may look at it */
  let opened = false;
  const core = await createCarryCore({
    key: config.key,
    stores: config.stores,
    ...(config.network ? { network: config.network } : {}),
    provider,
    ...(config.watchIntervalMs !== undefined ? { watchIntervalMs: config.watchIntervalMs } : {}),
    emit: (event) => {
      // A space newly carried: what arrives over the next minutes is it catching up.
      if (event.type === 'spaces' && meter && opened)
        for (const spaceId of core.carried.keys())
          if (!core.carries.has(spaceId)) void meter.firstSeen(spaceId).catch(() => {});
      events.emit(event);
    },
    ...(config.full ? { full: config.full } : {}),
    ...(limits ? { skip: (spaceId: string) => skipped.has(spaceId), onArrived: counted } : {}),
    ...(config.mirror
      ? {
          mirror: config.mirror,
          // One stopped for being over the line is kept a while, so a fund brings it back as it was.
          onRelease: async (spaceId: string) => {
            if (!skipped.has(spaceId)) await deleteMirrored(config.mirror!, spaceId);
          },
        }
      : {}),
    onClosed: (carrySpace) => {
      // The account stopped using this host: forget its carry space; the subscription stays paid.
      closing = closing.then(async () => {
        for (const subscription of await list()) {
          if (subscription.carry?.space !== carrySpace) continue;
          const { carry: _gone, ...rest } = subscription;
          await write(rest);
        }
        await core.removeCarry(carrySpace);
      });
    },
  });

  opened = true;

  // Carry again what was carried before a restart — the store is only a cache of the spaces, but the list is ours.
  for (const subscription of await list()) {
    if (subscription.pass !== undefined && state(subscription) !== 'lapsed') {
      await core.addPass(subscription.pass).catch((error: unknown) => {
        console.error(`Could not carry for subscription ${subscription.id}:`, error);
      });
      continue;
    }
    // An account taken off the list since is not carried again.
    if (!subscription.carry || state(subscription) === 'lapsed' || !allowed(subscription.carry.account))
      continue;
    await core.addCarry(subscription.carry.account, subscription.carry.invite).catch((error: unknown) => {
      console.error(`Could not carry for subscription ${subscription.id}:`, error);
    });
  }

  /** Whether another subscription still carries this carry space */
  const carriedByOther = async (carrySpace: string, except: string) =>
    (await list()).some((other) => other.id !== except && other.carry?.space === carrySpace);

  /** Whether a space's own subscription pays for it now: the free line does not apply then */
  const paysItself = async (spaceId: string) => {
    const own = await read(`${SPACE_SUBSCRIPTION_PREFIX}${spaceId}`);
    return !!own && state(own) === 'active';
  };

  /** The spaces the free line is about: those accounts' passes name, and those carried for themselves; never a carry space */
  const metered = (): ReadonlySet<string> => {
    const found = new Set<string>();
    for (const entry of core.carries.values()) for (const spaceId of entry.named) found.add(spaceId);
    for (const spaceId of core.carried.keys()) if (!core.carries.has(spaceId)) found.add(spaceId);
    return found;
  };

  /** Where one space stands now: its counts, its size, and the line it is held to */
  async function standing(spaceId: string, before: Line | undefined, own: boolean): Promise<Line | null> {
    if (!limits || !meter) return null;
    const t = now();
    const window = limits.space.windowDays * DAY;
    const keep = (limits.keepDays ?? 0) * DAY;
    // Members stopped carrying it, so nothing it does reaches here: it stays as it was, and is forgotten after a while.
    if (before?.stopped !== undefined && !own) return before.stopped + keep <= t ? null : before;
    const counts = await meter.usage(spaceId, await membersOf(spaceId));
    const bytes = (await config.measure?.(spaceId).catch(() => 0)) ?? 0;
    const shared = counts.writers >= 2;
    const reasons: Reason[] = [];
    if (counts.writers > limits.space.writers) reasons.push('writers');
    if (shared && bytes > limits.space.bytes) reasons.push('bytes');
    const wellUnder =
      counts.writers <= limits.space.writers * UNDER && (!shared || bytes <= limits.space.bytes * UNDER);
    let line: Line | null = before ?? null;
    // Stopped once before and forgotten since: over again, it is past its grace at once.
    const again = struck.has(spaceId) && !before ? t - lineGrace : t;
    if (reasons.length > 0) line = { since: before?.since ?? t, from: before?.from ?? again, reasons };
    else if (line && wellUnder) {
      const under = line.under ?? t;
      // Free again only after a whole window well under, so a busy week does not flip it.
      if (t - under >= window) return null;
      line = { ...line, under };
    } else if (line) {
      const { under: _gone, ...rest } = line;
      line = rest;
    }
    if (!line) return null;
    // While it pays for itself the line does not apply. Its grace is given once: paying for
    // a while does not buy it again, so once the fund stops, what is left of it is all it has.
    if (own) {
      const { stopped: _paid, ...rest } = line;
      return rest;
    }
    // Stopped only while it is over: one that went back under before its grace ran out
    // keeps its notice, and is stopped only should it go over again after.
    return reasons.length > 0 && line.from + lineGrace <= t && line.stopped === undefined
      ? { ...line, reasons, stopped: t }
      : line;
  }

  /**
   * Each space against the free line, and members' subscriptions let go of
   * those past it. Run now and then. Says which spaces went over, stopped
   * being carried for members, or came back under.
   */
  async function evaluate(): Promise<{ over: string[]; stopped: string[]; under: string[] }> {
    const changed: { over: string[]; stopped: string[]; under: string[] } = {
      over: [],
      stopped: [],
      under: [],
    };
    if (!limits || !meter) return changed;
    await meter.prune();
    const spaces = metered();
    for (const spaceId of new Set([...spaces, ...lines.keys()])) {
      const before = lines.get(spaceId);
      const own = await paysItself(spaceId);
      const after =
        spaces.has(spaceId) || before?.stopped !== undefined ? await standing(spaceId, before, own) : null;
      if (JSON.stringify(after) !== JSON.stringify(before ?? null)) await writeLine(spaceId, after);
      if (after && !before) changed.over.push(spaceId);
      if (after?.stopped !== undefined && before?.stopped === undefined) {
        changed.stopped.push(spaceId);
        await strike(spaceId, after.stopped);
      }
      if (before && !after) changed.under.push(spaceId);
      const skip = after?.stopped !== undefined && !own;
      if (skip) skipped.add(spaceId);
      else skipped.delete(spaceId);
      // Forgotten after it was kept a while: what the host held of it goes too, unless something carries it.
      if (before?.stopped !== undefined && !after) {
        await meter.forget(spaceId);
        if (config.mirror && !core.carried.has(spaceId))
          await deleteMirrored(config.mirror, spaceId).catch(() => {});
      }
    }
    await core.refresh();
    return changed;
  }

  /** The spaces over the line among these, as a status says them */
  const overOf = (spaceIds: Iterable<string>): ReadonlyArray<OverSpace> =>
    [...spaceIds].flatMap((spaceId) => {
      const line = lines.get(spaceId);
      return line
        ? [{ space: spaceId, since: line.since, until: line.from + lineGrace, reasons: line.reasons }]
        : [];
    });

  /** Makes a subscription if there is none by this id, and returns it */
  const subscribe = async (id: string): Promise<Subscription> => {
    if (!id.startsWith('did:key:') && !spaceIdOf(id))
      throw new Error('A subscription is named by its key, or by the space it is for');
    return (await read(id)) ?? write({ id, paidUntil: 0, since: now() });
  };

  return Object.freeze({
    did: core.did,
    subscribe,
    get: read,
    list,
    /** Whether a subscription is paid, in its grace period, or lapsed */
    state,
    /** At a host with limits, which room an account's subscription has: null at one without */
    plan,
    /** The limits it keeps to, or null when it has none */
    limits,

    /** A device of the subscription made a signed call: kept to the day, so an idle free one can be dropped */
    async seen(id: string): Promise<void> {
      const subscription = await read(id);
      if (!subscription || (subscription.seen !== undefined && now() - subscription.seen < DAY)) return;
      await write({ ...subscription, seen: now() });
    },

    /** A session key proved it reads a carried space: counted, though readers only ever hint */
    read(spaceId: string, session: string): void {
      if (core.carried.has(spaceId) && !core.carries.has(spaceId)) meter?.read(spaceId, session);
    },

    evaluate,

    /** The spaces over the free line that a subscription names, or its own space when it is one */
    async overFor(id: string): Promise<ReadonlyArray<OverSpace>> {
      const own = spaceIdOf(id);
      if (own) return overOf([own]);
      const space = (await read(id))?.carry?.space;
      const named = space ? [...(core.carries.get(space)?.named ?? [])] : [];
      // One its own fund pays for is nothing its members need to hear about.
      const unpaid: string[] = [];
      for (const spaceId of named)
        if (lines.has(spaceId) && !(await paysItself(spaceId))) unpaid.push(spaceId);
      return overOf(unpaid);
    },

    /** How a space is used, as a status says it; null at a host without limits */
    async usage(spaceId: string): Promise<SpaceUsage | null> {
      if (!meter) return null;
      const counts = await meter.usage(spaceId, await membersOf(spaceId));
      const bytes = core.carried.has(spaceId) ? ((await config.measure?.(spaceId).catch(() => 0)) ?? 0) : 0;
      return { writers: counts.writers, readers: counts.readers, bytes, windowDays: counts.windowDays };
    },

    /** Whether a space pays for itself now, so no account's room counts it */
    paysItself,

    /** Moves a subscription's paid-until date — the one thing payments do */
    async extend(id: string, until: number, customer?: string): Promise<Subscription> {
      const subscription = await subscribe(id);
      const extended = {
        ...subscription,
        paidUntil: Math.max(subscription.paidUntil, until),
        ...(customer ? { customer } : {}),
      };
      await write(extended);
      // Paid again in time: carry again what the grace period had kept.
      if (extended.carry && !core.carries.has(extended.carry.space)) {
        await core.addCarry(extended.carry.account, extended.carry.invite);
      }
      if (extended.pass !== undefined) await core.addPass(extended.pass).catch(() => {});
      return extended;
    },

    /** Sets a paid-until date outright, earlier too: what a fund's estimate says as it is spent */
    async setPaidUntil(id: string, until: number): Promise<Subscription> {
      const subscription = await subscribe(id);
      if (subscription.paidUntil === until) return subscription;
      const set = { ...subscription, paidUntil: until };
      await write(set);
      // Money came back in time: carry again what the grace period had kept.
      if (set.pass !== undefined && state(set) !== 'lapsed') await core.addPass(set.pass).catch(() => {});
      return set;
    },

    /** Keeps a wallet payment asked for, or drops it (null) once it arrived */
    async setInvoice(id: string, invoice: Invoice | null) {
      const { invoice: _before, ...subscription } = await subscribe(id);
      return write(invoice ? { ...subscription, invoice } : subscription);
    },

    /**
     * Starts carrying an account's spaces for a subscription: its carry space,
     * and every space its passes name. Replaces what the subscription carried.
     * @throws When the subscription is lapsed, or the invite is not a carry space's
     */
    async attach(id: string, account: string, invite: string) {
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed')
        throw new Error('That subscription is not paid for');
      if (!account.startsWith('did:key:')) throw new Error('An account is named by its DID');
      if (!allowed(account)) throw new NotAllowedError();
      const space = await core.addCarry(account, invite);
      const before = subscription.carry;
      const attached = await write({ ...subscription, carry: { account, space, invite } });
      if (before && before.space !== space && !(await carriedByOther(before.space, id)))
        await core.removeCarry(before.space);
      return attached;
    },

    /** Stops carrying for a subscription; the subscription stays */
    async detach(id: string) {
      const subscription = await read(id);
      if (!subscription?.carry) return;
      const { carry, ...rest } = subscription;
      await write(rest);
      if (!(await carriedByOther(carry.space, id))) await core.removeCarry(carry.space);
    },

    /**
     * Carries a space for its own subscription, from a pass. A later pass (the
     * space's key changed) replaces the one before.
     * @throws When the subscription is lapsed, or the pass is not for its space
     */
    async carrySpace(id: string, pass: unknown) {
      const spaceId = spaceIdOf(id);
      if (!spaceId) throw new Error('Only a space’s own subscription carries a space from a pass');
      const subscription = await read(id);
      if (!subscription || state(subscription) === 'lapsed') throw new Error('That space is not paid for');
      const opened = await openPass(pass, provider);
      if (!opened || opened.space.id !== spaceId) throw new Error('That is not a pass for this space');
      await core.addPass(pass);
      return write({ ...subscription, pass });
    },

    /** The read key a space's own subscription carries it with, as a DID: null when public or not carried */
    readKeyOf(id: string) {
      const spaceId = spaceIdOf(id);
      return spaceId ? core.readKeyOf(spaceId) : null;
    },

    /** Drops what lapsed past its grace period, and free subscriptions idle too long. Run now and then. */
    async sweep(): Promise<ReadonlyArray<string>> {
      const dropped: string[] = [];
      const idle = limits?.idleDays !== undefined ? limits.idleDays * DAY : null;
      for (let subscription of await list()) {
        // One from before idle subscriptions were dropped counts from now, not from when it was made.
        if (idle !== null && plan(subscription) === 'free' && subscription.seen === undefined)
          subscription = await write({ ...subscription, seen: now() });
        const idled =
          idle !== null && plan(subscription) === 'free' && (subscription.seen ?? now()) + idle < now();
        if (state(subscription) !== 'lapsed' && !idled) continue;
        await forget(subscription.id);
        const spaceId = spaceIdOf(subscription.id);
        if (spaceId) await core.removePass(spaceId);
        if (subscription.carry && !(await carriedByOther(subscription.carry.space, subscription.id))) {
          await core.removeCarry(subscription.carry.space);
        }
        dropped.push(subscription.id);
      }
      return dropped;
    },

    spaces: core.spaces,
    /** Reads every account's passes again, taking a space that waited for room: after what `full` says changed */
    recheck: () => core.refresh(),

    /** Every space a subscription's carry space names, carried or not */
    async namedFor(id: string): Promise<ReadonlyArray<string>> {
      const space = (await read(id))?.carry?.space;
      return [...(space ? (core.carries.get(space)?.named ?? []) : [])];
    },

    /** How many spaces a subscription's account asks the host to carry */
    async carriedFor(id: string) {
      const space = (await read(id))?.carry?.space;
      return space ? (core.carries.get(space)?.wants.size ?? 0) : 0;
    },

    /** The spaces a subscription is carried for now: its carry space and those its passes name, or a space's own */
    async spacesOf(id: string): Promise<ReadonlyArray<string>> {
      const subscription = await read(id);
      const own = spaceIdOf(id);
      if (own) return subscription?.pass !== undefined ? [own] : [];
      const space = subscription?.carry?.space;
      return space ? [space, ...(core.carries.get(space)?.wants ?? [])] : [];
    },

    /** For a server taking sockets: checks a connecting peer against the space's history. Null for a space not carried. */
    async authenticator(spaceId: string) {
      const entry = core.carried.get(spaceId);
      if (!entry) return null;
      const read = entry.record.space.visibility === 'private' ? entry.runtime.readAccess() : null;
      return createServerAuth(spaceId, read, config.key.privateKey, provider);
    },

    subscribeEvents: events.subscribe,

    async close() {
      await closing;
      await core.close();
      await store.close();
      events.clear();
    },
  });
}
